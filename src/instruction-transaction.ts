import { createHash } from "node:crypto"
import { mkdir, readFile, realpath, rename, rm } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { applyEdits, modify, parse } from "jsonc-parser"
import { acquireLock } from "./lock.js"
import { timestampFilename, writeTextAtomic } from "./prompt-utils.js"

export interface InstructionLocator {
  path: string
  jsonPath?: readonly string[]
}

export interface InstructionReceipt {
  version: 1
  target: InstructionLocator
  beforeHash: string
  afterHash: string
  beforeExists: boolean
  backupPath: string
  status: "prepared" | "applied" | "rolledBack"
  afterValue?: string
  afterText?: string
  createdAt: string
  label: string
}

export class InstructionConflictError extends Error {
  constructor(message: string) {
    super(`Instruction conflict: ${message}`)
    this.name = "InstructionConflictError"
  }
}

export function instructionHash(text: string | undefined): string {
  return createHash("sha256")
    .update(text === undefined ? "missing:" : `text:${text}`)
    .digest("hex")
}

export async function canonicalInstructionPath(path: string): Promise<string> {
  const absolute = resolve(path)
  try {
    return await realpath(absolute)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    // Resolve existing parent symlinks even for a new target.
    const parent = dirname(absolute)
    if (parent === absolute) throw error
    return join(await canonicalInstructionPath(parent), basename(absolute))
  }
}

export async function readInstructionText(
  path: string,
): Promise<string | undefined> {
  try {
    return await readFile(path, "utf-8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

export function parseInstructionJson(text: string): Record<string, unknown> {
  const errors: Array<{ error: number; offset: number; length: number }> = []
  const value = parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  })
  if (
    errors.length ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new InstructionConflictError("invalid JSONC; source left unchanged")
  }
  return value as Record<string, unknown>
}

export function instructionJsonValue(
  raw: Record<string, unknown>,
  path: readonly string[],
): unknown {
  let value: unknown = raw
  for (const key of path) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return undefined
    value = (value as Record<string, unknown>)[key]
  }
  return value
}

export function replaceInstructionJson(
  text: string,
  path: readonly string[],
  value: string,
): string {
  parseInstructionJson(text)
  return applyEdits(
    text,
    modify(text, [...path], value, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    }),
  )
}

export async function withInstructionLock<T>(
  locator: InstructionLocator,
  fn: (target: InstructionLocator) => Promise<T>,
): Promise<T> {
  const target = {
    ...locator,
    path: await canonicalInstructionPath(locator.path),
  }
  const unlock = await acquireLock(`${target.path}.lock`)
  try {
    return await fn(target)
  } finally {
    await unlock()
  }
}

export async function writeGuardedInstruction(
  path: string,
  text: string,
  assertCurrent?: () => void,
  options: { expectedHash?: string; beforeReplace?: () => Promise<void> } = {},
): Promise<void> {
  const expectedHash =
    options.expectedHash ?? instructionHash(await readInstructionText(path))
  await writeTextAtomic(path, text, async (from, to) => {
    // Staging/fsync is asynchronous. Recheck at the actual replacement,
    // rather than only before entering the atomic writer.
    await options.beforeReplace?.()
    if (instructionHash(await readInstructionText(path)) !== expectedHash)
      throw new InstructionConflictError(
        "source changed while staging replacement",
      )
    assertCurrent?.()
    await rename(from, to)
  })
}

export async function createInstructionBackup(
  target: InstructionLocator,
  backupDir: string,
  label: string,
  before: string | undefined,
  after: string | undefined = before,
): Promise<string> {
  await mkdir(backupDir, { recursive: true })
  const backupPath = join(backupDir, timestampFilename(label))
  await writeTextAtomic(backupPath, before ?? "")
  const receipt: InstructionReceipt = {
    version: 1,
    target,
    beforeHash: instructionHash(before),
    afterHash: instructionHash(after),
    beforeExists: before !== undefined,
    backupPath,
    status: "prepared",
    afterText: after,
    createdAt: new Date().toISOString(),
    label,
  }
  if (target.jsonPath && after !== undefined) {
    const value = instructionJsonValue(
      parseInstructionJson(after),
      target.jsonPath,
    )
    if (typeof value !== "string")
      throw new InstructionConflictError("target field must be a string")
    receipt.afterValue = value
  }
  await writeTextAtomic(`${backupPath}.json`, JSON.stringify(receipt, null, 2))
  return backupPath
}

export async function readInstructionReceipt(
  backupPath: string,
): Promise<InstructionReceipt> {
  let receipt: InstructionReceipt
  try {
    receipt = JSON.parse(
      await readFile(`${backupPath}.json`, "utf-8"),
    ) as InstructionReceipt
  } catch {
    throw new InstructionConflictError(
      "backup has no valid source receipt; use explicit manual recovery",
    )
  }
  if (
    !receipt ||
    receipt.version !== 1 ||
    !receipt.target ||
    typeof receipt.target.path !== "string" ||
    !isAbsolute(receipt.target.path) ||
    (receipt.target.jsonPath !== undefined &&
      (!Array.isArray(receipt.target.jsonPath) ||
        !receipt.target.jsonPath.every(
          (key) => typeof key === "string" && key.length > 0,
        ))) ||
    typeof receipt.beforeHash !== "string" ||
    typeof receipt.afterHash !== "string" ||
    typeof receipt.beforeExists !== "boolean" ||
    receipt.backupPath !== backupPath
  ) {
    throw new InstructionConflictError(
      "backup lacks valid source provenance; use explicit manual recovery",
    )
  }
  return receipt
}

export async function finishInstructionBackup(
  backupPath: string,
  after: string | undefined,
): Promise<void> {
  const receipt = await readInstructionReceipt(backupPath)
  receipt.afterHash = instructionHash(after)
  receipt.afterText = after
  receipt.status = "applied"
  if (receipt.target.jsonPath && after !== undefined) {
    const value = instructionJsonValue(
      parseInstructionJson(after),
      receipt.target.jsonPath,
    )
    if (typeof value !== "string")
      throw new InstructionConflictError("target field must be a string")
    receipt.afterValue = value
  }
  await writeTextAtomic(`${backupPath}.json`, JSON.stringify(receipt, null, 2))
}

export async function commitInstructionUpdate(
  locator: InstructionLocator,
  updater: (
    before: string,
    target: InstructionLocator,
  ) => string | Promise<string>,
  options: {
    backupDir?: string
    label?: string
    expectedHash?: string
    assertCurrent?: () => void
    /** Optional staging-boundary integration probe; runs before final source validation. */
    beforeReplace?: () => Promise<void>
  } = {},
): Promise<{
  target: InstructionLocator
  backupPath?: string
  beforeHash: string
  afterHash: string
}> {
  return withInstructionLock(locator, async (target) => {
    const before = await readInstructionText(target.path)
    const beforeHash = instructionHash(before)
    if (options.expectedHash && beforeHash !== options.expectedHash)
      throw new InstructionConflictError("source revision changed")
    const after = await updater(before ?? "", target)
    if (after === before) {
      options.assertCurrent?.()
      return { target, beforeHash, afterHash: beforeHash }
    }
    const backupPath = options.backupDir
      ? await createInstructionBackup(
          target,
          options.backupDir,
          options.label ?? "pre-improvement",
          before,
          after,
        )
      : undefined
    if (instructionHash(await readInstructionText(target.path)) !== beforeHash)
      throw new InstructionConflictError("source changed during update")
    options.assertCurrent?.()
    await writeGuardedInstruction(target.path, after, options.assertCurrent, {
      expectedHash: beforeHash,
      beforeReplace: options.beforeReplace,
    })
    if (backupPath) await finishInstructionBackup(backupPath, after)
    return { target, backupPath, beforeHash, afterHash: instructionHash(after) }
  })
}

export async function rollbackInstruction(
  backupPath: string,
  backupDir: string,
  options: {
    assertCurrent?: () => void
    beforeReplace?: () => Promise<void>
  } = {},
): Promise<boolean> {
  const receipt = await readInstructionReceipt(backupPath)
  return withInstructionLock(receipt.target, async (target) => {
    const current = await readInstructionText(target.path)
    const original = await readFile(backupPath, "utf-8")
    if (
      instructionHash(receipt.beforeExists ? original : undefined) !==
      receipt.beforeHash
    )
      throw new InstructionConflictError("backup bytes changed")
    let restored = original
    if (receipt.target.jsonPath) {
      // Restore exactly the field we owned, preserving later edits elsewhere
      // in the same config. Changed target field is an explicit conflict.
      if (current === undefined)
        throw new InstructionConflictError("target config was removed")
      const beforeValue = instructionJsonValue(
        parseInstructionJson(original),
        receipt.target.jsonPath,
      )
      if (typeof beforeValue !== "string")
        throw new InstructionConflictError("backup field is no longer a string")
      // afterHash covers whole bytes; field hash stored separately below permits
      // unrelated configuration changes without restoring the entire document.
      if (
        receipt.afterValue === undefined ||
        instructionJsonValue(
          parseInstructionJson(current),
          receipt.target.jsonPath,
        ) !== receipt.afterValue
      )
        throw new InstructionConflictError("target field changed after apply")
      restored = replaceInstructionJson(
        current,
        receipt.target.jsonPath,
        beforeValue,
      )
    } else if (instructionHash(current) !== receipt.afterHash) {
      throw new InstructionConflictError(
        "target changed after apply; later edits preserved",
      )
    }
    const reverse = await createInstructionBackup(
      target,
      backupDir,
      "pre-rollback",
      current,
      receipt.beforeExists ? restored : undefined,
    )
    if (
      instructionHash(await readInstructionText(target.path)) !==
      instructionHash(current)
    )
      throw new InstructionConflictError("target changed during rollback")
    if (!receipt.beforeExists) {
      // Restore absence without deleting an external edit made during backup awaits.
      await options.beforeReplace?.()
      if (
        instructionHash(await readInstructionText(target.path)) !==
        instructionHash(current)
      )
        throw new InstructionConflictError(
          "source changed before rollback removal",
        )
      options.assertCurrent?.()
      await rm(target.path)
    } else
      await writeGuardedInstruction(
        target.path,
        restored,
        options.assertCurrent,
        {
          expectedHash: instructionHash(current),
          beforeReplace: options.beforeReplace,
        },
      )
    await finishInstructionBackup(
      reverse,
      receipt.beforeExists ? restored : undefined,
    )
    receipt.status = "rolledBack"
    await writeTextAtomic(
      `${backupPath}.json`,
      JSON.stringify(receipt, null, 2),
    )
    return true
  })
}
