import { AsyncLocalStorage } from "node:async_hooks"
import { mkdir, readdir, readFile, stat, unlink } from "node:fs/promises"
import { join, parse } from "node:path"
import { backupDirNameFor } from "./agents-md-resolver.js"
import {
  commitInstructionUpdate,
  createInstructionBackup,
  finishInstructionBackup,
  type InstructionLocator,
  readInstructionText,
  rollbackInstruction,
  withInstructionLock,
} from "./instruction-transaction.js"
import {
  escapeRegex,
  injectSectionContent,
  parseTimestampFromFilename,
} from "./prompt-utils.js"
import type { BackupEntry } from "./types.js"

export class AgentsMdManager {
  private readonly kasperStateDir: string
  private backupsDir: string
  private cachedContent: string | null = null
  private cachedMtime = 0
  private resolvedPath: string
  private pendingBackups = new Map<string, string>()
  private updateContext = new AsyncLocalStorage<{
    target: InstructionLocator
    backupDir: string
  }>()

  constructor(
    /**
     * Absolute path to the resolved rules file. The caller (typically
     * `index.ts`) runs `resolveAgentsMdSource` first and passes the
     * `primary` field here. Defaults to `<projectRoot>/AGENTS.md` for
     * backward compatibility with call sites that have not yet been
     * migrated to the resolver.
     */
    resolvedPath: string,
    kasperStateDir: string,
    private maxBackups: number = 20,
  ) {
    this.kasperStateDir = kasperStateDir
    this.resolvedPath = resolvedPath
    // The backup directory is keyed on the resolved path so multiple
    // rules files (e.g. one per project) don't share a single bucket.
    this.backupsDir = join(
      kasperStateDir,
      "backups",
      backupDirNameFor(resolvedPath),
    )
  }

  /**
   * Update the resolved rules file path at runtime — used by the config
   * reload timer when the user changes `agents_md_paths` in
   * `kasper.json`. Recomputes the backup directory (which is keyed on
   * the path) and clears the in-memory content cache so the next read
   * hits the new file.
   */
  setResolvedPath(newPath: string): void {
    if (newPath === this.resolvedPath) return
    this.resolvedPath = newPath
    this.backupsDir = join(
      this.kasperStateDir,
      "backups",
      backupDirNameFor(newPath),
    )
    this.invalidateCache()
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
    const context = this.updateContext.getStore()
    const path = context?.target.path ?? this.agentsMdPath
    const backupDir = context?.backupDir ?? this.backupsDir
    const takeBackup = async (target: InstructionLocator) => {
      const dest = await createInstructionBackup(
        target,
        backupDir,
        label,
        await readInstructionText(target.path),
      )
      this.pendingBackups.set(target.path, dest)
      return dest
    }
    const result = context
      ? await takeBackup(context.target)
      : await withInstructionLock({ path }, takeBackup)
    await this.enforceMaxBackups(backupDir)
    return result
  }

  async write(content: string, assertCurrent?: () => void): Promise<void> {
    await this.lockedUpdate(async () => content, assertCurrent)
  }

  async lockedUpdate(
    updater: (existing: string) => Promise<string>,
    assertCurrent?: () => void,
  ): Promise<void> {
    const path = this.agentsMdPath
    const backupDir = this.backupsDir
    let updated = ""
    const result = await commitInstructionUpdate(
      { path },
      async (existing, target) =>
        this.updateContext.run({ target, backupDir }, async () => {
          updated = await updater(existing)
          return updated
        }),
      { assertCurrent },
    )
    const pending = this.pendingBackups.get(result.target.path)
    if (pending) {
      await finishInstructionBackup(pending, updated)
      this.pendingBackups.delete(result.target.path)
    }
    this.invalidateCache()
  }

  async applyGuidance(
    content: string,
    assertCurrent?: () => void,
  ): Promise<string | undefined> {
    const path = this.agentsMdPath
    const backupDir = this.backupsDir
    const result = await commitInstructionUpdate(
      { path },
      (existing) =>
        this.injectSection(existing, "Kasper Inferred Instructions", content),
      { backupDir, label: "manual-apply", assertCurrent },
    )
    this.invalidateCache()
    return result.backupPath
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

  async listBackups(backupDir = this.backupsDir): Promise<BackupEntry[]> {
    const files: BackupEntry[] = []
    try {
      const entries = await readdir(backupDir)
      for (const e of entries
        .filter((name) => name.endsWith(".md"))
        .sort()
        .reverse()) {
        const parsed = parse(e)
        const parts = parsed.name.split("--")
        const label =
          parts.length >= 3
            ? parts.slice(2).join("--")
            : parts.slice(1).join("--")
        files.push({
          path: join(backupDir, e),
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

  async rollback(backupPath?: string): Promise<boolean> {
    const backupDir = this.backupsDir
    const backups = await this.listBackups()
    if (!backupPath && backups.length === 0) return false
    const result = await rollbackInstruction(
      backupPath ?? backups[0].path,
      backupDir,
    )
    this.invalidateCache()
    return result
  }

  private async enforceMaxBackups(backupDir = this.backupsDir): Promise<void> {
    const backups = await this.listBackups(backupDir)
    if (backups.length <= this.maxBackups) return
    const toDelete = backups.slice(this.maxBackups)
    for (const b of toDelete) {
      try {
        await unlink(b.path)
        await unlink(`${b.path}.json`).catch(() => {})
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
