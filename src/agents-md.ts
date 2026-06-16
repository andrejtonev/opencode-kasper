import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  stat,
  unlink,
} from "node:fs/promises"
import { join, parse } from "node:path"
import { backupDirNameFor } from "./agents-md-resolver.js"
import { acquireLock } from "./lock.js"
import {
  escapeRegex,
  exists,
  injectSectionContent,
  parseTimestampFromFilename,
  timestampFilename,
  writeTextAtomic,
} from "./prompt-utils.js"
import type { BackupEntry } from "./types.js"

export class AgentsMdManager {
  private readonly backupsDir: string
  private cachedContent: string | null = null
  private cachedMtime = 0

  constructor(
    /**
     * Absolute path to the resolved rules file. The caller (typically
     * `index.ts`) runs `resolveAgentsMdSource` first and passes the
     * `primary` field here. Defaults to `<projectRoot>/AGENTS.md` for
     * backward compatibility with call sites that have not yet been
     * migrated to the resolver.
     */
    private readonly resolvedPath: string,
    kasperStateDir: string,
    private maxBackups: number = 20,
  ) {
    // The backup directory is keyed on the resolved path so multiple
    // rules files (e.g. one per project) don't share a single bucket.
    const dirName = backupDirNameFor(resolvedPath)
    this.backupsDir = join(kasperStateDir, "backups", dirName)
  }

  invalidateCache(): void {
    this.cachedContent = null
    this.cachedMtime = 0
  }

  async init(): Promise<void> {
    await mkdir(this.backupsDir, { recursive: true })
  }

  setMaxBackups(n: number): void {
    this.maxBackups = n
  }

  get agentsMdPath(): string {
    return this.resolvedPath
  }

  async backup(label: string): Promise<string> {
    const name = timestampFilename(label)
    const dest = join(this.backupsDir, name)
    if (await exists(this.agentsMdPath)) {
      await copyFile(this.agentsMdPath, dest)
    }
    await this.enforceMaxBackups()
    return dest
  }

  async write(content: string): Promise<void> {
    const lockPath = `${this.agentsMdPath}.lock`
    const unlock = await acquireLock(lockPath)
    try {
      await writeTextAtomic(this.agentsMdPath, content)
      this.invalidateCache()
    } finally {
      await unlock()
    }
  }

  async lockedUpdate(
    updater: (existing: string) => Promise<string>,
  ): Promise<void> {
    const lockPath = `${this.agentsMdPath}.lock`
    const unlock = await acquireLock(lockPath)
    try {
      const existing = await this.read()
      const updated = await updater(existing)
      await writeTextAtomic(this.agentsMdPath, updated)
      this.invalidateCache()
    } finally {
      await unlock()
    }
  }

  async read(): Promise<string> {
    try {
      const st = await stat(this.agentsMdPath)
      if (st.mtimeMs === this.cachedMtime && this.cachedContent !== null) {
        return this.cachedContent
      }
      const content = await readFile(this.agentsMdPath, "utf-8")
      this.cachedContent = content
      this.cachedMtime = st.mtimeMs
      return content
    } catch {
      this.cachedContent = ""
      this.cachedMtime = 0
      return ""
    }
  }

  async listBackups(): Promise<BackupEntry[]> {
    const files: BackupEntry[] = []
    try {
      const entries = await readdir(this.backupsDir)
      for (const e of entries.sort().reverse()) {
        const parsed = parse(e)
        const parts = parsed.name.split("--")
        const label =
          parts.length >= 3
            ? parts.slice(2).join("--")
            : parts.slice(1).join("--")
        files.push({
          path: join(this.backupsDir, e),
          timestamp: parseTimestampFromFilename(parsed.name),
          label: label || "unknown",
        })
      }
      files.sort((a, b) => b.timestamp - a.timestamp)
    } catch {
      /* no backups yet */
    }
    return files
  }

  async rollback(): Promise<boolean> {
    const lockPath = `${this.agentsMdPath}.lock`
    let unlock: (() => Promise<void>) | undefined
    try {
      unlock = await acquireLock(lockPath)

      const backups = await this.listBackups()
      if (backups.length === 0) return false
      const latest = backups[0]

      if (await exists(this.agentsMdPath)) {
        await this.backup("pre-rollback")
      }

      const content = await readFile(latest.path, "utf-8")
      await writeTextAtomic(this.agentsMdPath, content)
      return true
    } finally {
      if (unlock) {
        await unlock().catch(() => {})
      }
    }
  }

  private async enforceMaxBackups(): Promise<void> {
    const backups = await this.listBackups()
    if (backups.length <= this.maxBackups) return
    const toDelete = backups.slice(this.maxBackups)
    for (const b of toDelete) {
      try {
        await unlink(b.path)
      } catch {
        /* ignore */
      }
    }
  }

  sectionHeader(name: string): string {
    return `## ${name}`
  }

  injectSection(
    existing: string,
    sectionName: string,
    content: string,
  ): string {
    // Delegates to the shared helper. Kept as a method on AgentsMdManager
    // because the existing public API is `(existing, sectionName, content)`.
    return injectSectionContent(existing, sectionName, content).updated
  }

  removeSection(existing: string, sectionName: string): string {
    const regex = new RegExp(
      `(?:^|\\n)(##\\s*${escapeRegex(sectionName)})[\\s\\S]*?(?=\\r?\\n##|$)`,
    )
    return `${existing.replace(regex, "").trim()}\n`
  }
}
