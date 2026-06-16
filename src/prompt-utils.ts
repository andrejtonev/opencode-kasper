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
 * existing body is preserved and the new content is appended as a new entry
 * (preceded by a blank line and a `<!-- kasper: ISO -->` provenance comment
 * recording when THIS entry was added).
 *
 * Shape after N applies:
 *
 *     ## {sectionName}
 *     old rule
 *
 *     <!-- kasper: 2026-06-15T10:00:00Z -->
 *     rule added on the 15th
 *
 *     <!-- kasper: 2026-06-16T07:00:00Z -->
 *     rule added on the 16th
 *
 * Migration note: files written by older versions of kasper have a single
 * section-level `<!-- kasper: ISO -->` line directly under the header. That
 * line is preserved verbatim (it now reads as the timestamp for the
 * pre-existing rules block). New applies attach their own per-entry
 * provenance line as described above.
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
  // Per-addition provenance. We attach this to each new entry, not to the
  // section header, so a future reader can see WHEN each rule was added.
  const entry = `<!-- kasper: ${now.toISOString()} -->\n${newContent.trim()}\n`

  const match = existing.match(sectionRegex)
  if (match) {
    // match[1] is the captured header (including the optional leading \n).
    // Slice it off the front of match[0] to get the body — this is robust to
    // the body starting with a newline (when the section is not at the start
    // of the file) or directly after the header (EOF case). Any pre-existing
    // section-level provenance line from older kasper versions is preserved
    // verbatim as part of `body`.
    const headerMatched = match[1]
    // body is everything after the header line. It may start with \n and end
    // with trailing whitespace. Normalize it to "just the content" so we can
    // rebuild a stable shape every apply (otherwise the gap between header
    // and the first rule grows by 1 newline on every apply).
    const body = match[0].slice(headerMatched.length)
    const bodyContent = body.replace(/^[\r\n]+|[\r\n]+$/g, "")
    const finalContent = bodyContent ? `${bodyContent}\n\n${entry}` : entry
    const updated = existing.replace(
      sectionRegex,
      `${headerMatched}\n${finalContent}`,
    )
    return { updated, existed: true }
  }

  // Section does not exist — create it with a single per-entry provenance
  // line, identical in shape to the accumulate case.
  const header = `## ${sectionName}`
  const sectionBlock = `${header}\n\n${entry}`
  const trimmed = existing.trimEnd()
  const updated = trimmed ? `${trimmed}\n\n${sectionBlock}` : sectionBlock
  return { updated, existed: false }
}
