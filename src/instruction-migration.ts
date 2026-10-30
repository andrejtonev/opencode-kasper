import { randomUUID } from "node:crypto"
import { mkdir, rm } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, sep } from "node:path"
import {
  canonicalInstructionPath,
  createInstructionBackup,
  finishInstructionBackup,
  InstructionConflictError,
  instructionHash,
  instructionJsonValue,
  parseInstructionJson,
  readInstructionText,
  replaceInstructionJson,
  rollbackInstruction,
  withInstructionLock,
  writeGuardedInstruction,
} from "./instruction-transaction.js"
import { acquireLock } from "./lock.js"
import { writeTextAtomic } from "./prompt-utils.js"

interface MigrationJournal {
  version: 1
  configPath: string
  destinationPath: string
  destinationHash: string
  configBackup: string
  fileCreated: boolean
  status: "prepared" | "fileCreated" | "committed" | "recovered"
}

/** Two-file changes are journaled, not presented as one atomic transaction.
 * Config is changed last; a failure leaves exact recovery information and
 * never redirects to an unrelated pre-existing destination.
 */
export async function migrateInstructionSource(
  configPath: string,
  jsonPath: readonly string[] | undefined,
  agentName: string,
  field: string,
  expectedValue: string,
  destinationPath: string,
  projectRoot: string,
  mode: string,
  assertCurrent?: () => void,
): Promise<{
  filePath: string
  configPath: string
  fileCreated: boolean
  configModified: boolean
  journalPath: string
}> {
  const [config, destination, project] = await Promise.all([
    canonicalInstructionPath(configPath),
    canonicalInstructionPath(destinationPath),
    canonicalInstructionPath(projectRoot),
  ])
  const configRelative = relative(project, config)
  if (
    isAbsolute(configRelative) ||
    configRelative === ".." ||
    configRelative.startsWith(`..${sep}`)
  )
    throw new InstructionConflictError(
      "global/external config cannot be redirected to a project file implicitly",
    )
  const destinationRelative = relative(project, destination)
  if (
    isAbsolute(destinationRelative) ||
    destinationRelative === ".." ||
    destinationRelative.startsWith(`..${sep}`)
  )
    throw new InstructionConflictError(
      "migration destination must remain inside the project",
    )
  const unlocks: Array<() => Promise<void>> = []
  try {
    for (const path of [...new Set([config, destination])].sort())
      unlocks.push(await acquireLock(`${path}.lock`))
    const original = await readInstructionText(config)
    if (original === undefined)
      throw new InstructionConflictError("source config disappeared")
    const raw = parseInstructionJson(original)
    const matches = ["agent", "agents"].filter(
      (key) =>
        instructionJsonValue(raw, [key, agentName, field]) === expectedValue,
    )
    const pointer =
      jsonPath ??
      (matches.length === 1 ? [matches[0], agentName, field] : undefined)
    if (!pointer || instructionJsonValue(raw, pointer) !== expectedValue)
      throw new InstructionConflictError("inline source changed; resolve again")
    const body = `${expectedValue.trimEnd()}\n`
    const generated = `---\nmode: ${mode}\n---\n\n${body}`
    const existing = await readInstructionText(destination)
    if (
      existing !== undefined &&
      existing.trim() !== body.trim() &&
      existing.trim() !== generated.trim()
    )
      throw new InstructionConflictError(
        "migration destination already contains different instructions",
      )
    const updated = replaceInstructionJson(
      original,
      pointer,
      `{file:${relative(dirname(config), destination) || destination}}`,
    )
    const journalDir = join(project, ".opencode", "kasper", "migrations")
    await mkdir(journalDir, { recursive: true })
    const configBackup = await createInstructionBackup(
      { path: config, jsonPath: pointer },
      journalDir,
      "pre-migration",
      original,
      updated,
    )
    const journalPath = join(journalDir, `${randomUUID()}.json`)
    const journal: MigrationJournal = {
      version: 1,
      configPath: config,
      destinationPath: destination,
      destinationHash: instructionHash(existing ?? generated),
      configBackup,
      fileCreated: existing === undefined,
      status: "prepared",
    }
    await writeTextAtomic(journalPath, JSON.stringify(journal, null, 2))
    assertCurrent?.()
    if (
      instructionHash(await readInstructionText(destination)) !==
      instructionHash(existing)
    )
      throw new InstructionConflictError("destination changed during migration")
    if (existing === undefined) {
      await writeGuardedInstruction(destination, generated, assertCurrent)
      journal.status = "fileCreated"
      await writeTextAtomic(journalPath, JSON.stringify(journal, null, 2))
    }
    assertCurrent?.()
    if (
      instructionHash(await readInstructionText(config)) !==
      instructionHash(original)
    )
      throw new InstructionConflictError(
        `config changed; recover using ${journalPath}`,
      )
    await writeGuardedInstruction(config, updated, assertCurrent)
    await finishInstructionBackup(configBackup, updated)
    journal.status = "committed"
    await writeTextAtomic(journalPath, JSON.stringify(journal, null, 2))
    return {
      filePath: destination,
      configPath: config,
      fileCreated: journal.fileCreated,
      configModified: updated !== original,
      journalPath,
    }
  } finally {
    for (const unlock of unlocks.reverse()) await unlock()
  }
}

/** Explicit recovery, including failures after destination creation. Restore
 * the config field first; only remove a destination created by this journal
 * if its bytes are still exactly ours. Never delete later user edits.
 */
export async function recoverInstructionMigration(
  journalPath: string,
): Promise<void> {
  const journal = JSON.parse(
    (await readInstructionText(journalPath)) ?? "null",
  ) as MigrationJournal
  if (
    !journal ||
    journal.version !== 1 ||
    typeof journal.configBackup !== "string" ||
    typeof journal.destinationPath !== "string"
  )
    throw new InstructionConflictError("invalid migration journal")
  if (journal.status === "recovered") return
  const current = await readInstructionText(journal.configPath)
  const original = await readInstructionText(journal.configBackup)
  if (instructionHash(current) !== instructionHash(original))
    await rollbackInstruction(journal.configBackup, dirname(journalPath))
  if (journal.fileCreated) {
    await withInstructionLock(
      { path: journal.destinationPath },
      async (target) => {
        const text = await readInstructionText(target.path)
        if (text !== undefined) {
          if (instructionHash(text) !== journal.destinationHash)
            throw new InstructionConflictError(
              "destination changed; config restored, destination preserved",
            )
          await rm(target.path)
        }
      },
    )
  }
  journal.status = "recovered"
  await writeTextAtomic(journalPath, JSON.stringify(journal, null, 2))
}
