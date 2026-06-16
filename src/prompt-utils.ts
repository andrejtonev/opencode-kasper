import { randomBytes } from "node:crypto"
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { dirname } from "node:path"

export function timestampFilename(label: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 22)
  const suffix = randomBytes(3).toString("hex")
  return `${ts}--${suffix}--${label}.md`
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export function parseTimestampFromFilename(name: string): number {
  const parts = name.split("--")
  if (parts.length < 1) return 0
  const tsPart = parts[0]
  if (tsPart.length < 19) return 0
  const timePart = tsPart.slice(11, 19).replace(/-/g, ":")
  const normalized = `${tsPart.slice(0, 10)}T${timePart}`
  const parsed = new Date(normalized).getTime()
  return Number.isNaN(parsed) ? 0 : parsed
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

const writeLocks = new Map<string, Promise<void>>()

export function clearWriteLocks(): void {
  writeLocks.clear()
}

export async function withPathWriteLock<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = writeLocks.get(filePath) ?? Promise.resolve()
  let release!: () => void
  const next = new Promise<void>((r) => {
    release = r
  })
  writeLocks.set(
    filePath,
    prev.then(() => next),
  )
  try {
    await prev
    return await fn()
  } finally {
    release()
    if (writeLocks.get(filePath) === next) {
      writeLocks.delete(filePath)
    }
  }
}

export async function writeTextAtomic(
  filePath: string,
  content: string,
): Promise<void> {
  await withPathWriteLock(filePath, async () => {
    await mkdir(dirname(filePath), { recursive: true })

    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`
    let lastError: unknown

    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const handle = await open(tmpPath, "w")
        try {
          await handle.writeFile(content, "utf-8")
          await handle.sync()
        } finally {
          await handle.close()
        }
        await rename(tmpPath, filePath)
        return
      } catch (err: unknown) {
        lastError = err
        const errCode = (err as { code?: string }).code
        if (
          process.platform === "win32" &&
          (errCode === "EPERM" || errCode === "EBUSY")
        ) {
          try {
            const data = await readFile(tmpPath, "utf-8")
            await writeFile(filePath, data, "utf-8")
            return
          } catch {
            /* fall through */
          }
        }
        const waitMs = 10 * (attempt + 1)
        await new Promise((resolve) => setTimeout(resolve, waitMs))
      }
    }

    await rm(tmpPath, { force: true }).catch(() => {})
    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError ?? "atomic write failed"))
  })
}

/**
 * Inject content into a markdown section. If the section already exists, the
 * existing body is preserved and the new content is appended after a blank
 * line. A provenance comment `<!-- kasper: ISO -->` is always written directly
 * after the section header so the section's "last updated" timestamp is
 * visible without scanning the body.
 *
 * Always produces a file that ends with a single trailing newline.
 *
 * Pure function (no I/O) so it is trivially testable.
 */
export function injectSectionContent(
  existing: string,
  sectionName: string,
  newContent: string,
  now: Date = new Date(),
): { updated: string; existed: boolean } {
  const sectionRegex = new RegExp(
    `((?:^|\\n)##\\s*${escapeRegex(sectionName)})[\\s\\S]*?(?=\\r?\\n##|$)`,
  )
  const provenance = `<!-- kasper: ${now.toISOString()} -->\n`

  const match = existing.match(sectionRegex)
  if (match) {
    // match[1] is the captured header (including the optional leading \n).
    // Slice it off the front of match[0] to get the body — this is robust to
    // the body starting with a newline (when the section is not at the start
    // of the file) or directly after the header (EOF case).
    const headerMatched = match[1]
    const body = match[0].slice(headerMatched.length)
    // Strip the optional provenance line at the start of the body so we
    // don't stack timestamps on every apply.
    const bodyStripped = body.replace(/^\r?\n(?:<!-- kasper:.*?-->\r?\n)?/, "")
    const existingBody = bodyStripped.trim()
    const finalContent = existingBody
      ? `${existingBody}\n\n${newContent.trim()}`
      : newContent.trim()
    const updated = existing.replace(
      sectionRegex,
      `${headerMatched}\n${provenance}${finalContent}\n`,
    )
    return { updated, existed: true }
  }

  // Section does not exist — append it at the end of the file.
  const header = `## ${sectionName}`
  const sectionBlock = `${header}\n${provenance}${newContent.trim()}\n`
  const trimmed = existing.trimEnd()
  const updated = trimmed ? `${trimmed}\n\n${sectionBlock}` : sectionBlock
  return { updated, existed: false }
}
