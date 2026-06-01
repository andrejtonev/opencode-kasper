import { copyFile, mkdir, readdir, readFile, unlink } from "node:fs/promises"
import { basename, join } from "node:path"
import { acquireLock } from "./lock.js"
import {
  escapeRegex,
  exists,
  timestampFilename,
  writeTextAtomic,
} from "./prompt-utils.js"

function sanitizeAgentName(name: string): string {
  return basename(name.replace(/[\\/]/g, "_"))
}

export class AgentPromptManager {
  private readonly backupsDir: string
  private readonly globalAgentsDir: string

  constructor(
    private readonly projectRoot: string,
    readonly kasperStateDir: string,
    globalOpencodeDir?: string,
  ) {
    this.backupsDir = join(kasperStateDir, "backups", "agents")
    this.globalAgentsDir = globalOpencodeDir
      ? join(globalOpencodeDir, "agents")
      : ""
  }

  async init(): Promise<void> {
    await mkdir(this.backupsDir, { recursive: true })
  }

  getAgentPath(agentName: string): string {
    return join(
      this.projectRoot,
      ".opencode",
      "agents",
      `${sanitizeAgentName(agentName)}.md`,
    )
  }

  private getGlobalAgentPath(agentName: string): string {
    if (!this.globalAgentsDir) return ""
    return join(this.globalAgentsDir, `${sanitizeAgentName(agentName)}.md`)
  }

  async exists(agentName: string): Promise<boolean> {
    if (await exists(this.getAgentPath(agentName))) return true
    const globalPath = this.getGlobalAgentPath(agentName)
    if (globalPath) return exists(globalPath)
    return false
  }

  async read(agentName: string): Promise<string> {
    try {
      return await readFile(this.getAgentPath(agentName), "utf-8")
    } catch {
      const globalPath = this.getGlobalAgentPath(agentName)
      if (globalPath) {
        try {
          return await readFile(globalPath, "utf-8")
        } catch {
          return ""
        }
      }
      return ""
    }
  }

  async write(agentName: string, content: string): Promise<void> {
    const filePath = this.getAgentPath(agentName)
    const lockPath = `${filePath}.lock`
    const unlock = await acquireLock(lockPath)
    try {
      await writeTextAtomic(filePath, content)
    } finally {
      await unlock()
    }
  }

  private agentDir(agentName: string): string {
    return join(this.backupsDir, sanitizeAgentName(agentName))
  }

  async backup(
    agentName: string,
    label: string,
    maxBackups = 20,
  ): Promise<string> {
    const agentBackupDir = this.agentDir(agentName)
    await mkdir(agentBackupDir, { recursive: true })
    const name = timestampFilename(label)
    const dest = join(agentBackupDir, name)
    const sourcePath = this.getAgentPath(agentName)
    if (await exists(sourcePath)) {
      await copyFile(sourcePath, dest)
    }
    await this.enforceMaxBackups(agentName, maxBackups)
    return dest
  }

  async rollback(agentName: string): Promise<boolean> {
    const filePath = this.getAgentPath(agentName)
    const lockPath = `${filePath}.lock`
    const unlock = await acquireLock(lockPath)
    try {
      const agentBackupDir = this.agentDir(agentName)
      let entries: string[] = []
      try {
        entries = await readdir(agentBackupDir)
      } catch {
        return false
      }
      if (entries.length === 0) return false
      entries.sort().reverse()
      const latest = entries[0]

      if (await exists(filePath)) {
        await this.backup(agentName, "pre-rollback")
      }

      const content = await readFile(join(agentBackupDir, latest), "utf-8")
      await writeTextAtomic(filePath, content)
      return true
    } finally {
      await unlock()
    }
  }

  async injectSection(
    agentName: string,
    sectionName: string,
    content: string,
    backupEnabled = true,
    maxBackups = 20,
    mode = "subagent",
  ): Promise<string | undefined> {
    const filePath = this.getAgentPath(agentName)
    const lockPath = `${filePath}.lock`

    const unlock = await acquireLock(lockPath)
    try {
      const existing = await this.read(agentName)
      const header = `## ${sectionName}`
      const sectionRegex = new RegExp(
        `((?:^|\\n)##\\s*${escapeRegex(sectionName)})[\\s\\S]*?(?=\\r?\\n##|$)`,
      )
      const sectionBlock = `${header}\n${content.trim()}\n`

      let updated: string
      if (!existing.trim()) {
        // File doesn't exist — create with frontmatter so opencode recognizes it as an agent
        const frontmatter = `---\nmode: ${mode}\n---\n\n`
        updated = `${frontmatter + sectionBlock}\n`
      } else if (sectionRegex.test(existing)) {
        updated = existing.replace(sectionRegex, `$1\n${content.trim()}`)
      } else {
        const eofSection = `${sectionBlock}\n`
        const trimmed = existing.trimEnd()
        updated = trimmed ? `${trimmed}\n\n${eofSection}` : eofSection
      }

      let backupPath: string | undefined
      if (backupEnabled) {
        backupPath = await this.backup(agentName, "pre-improvement", maxBackups)
      }
      await writeTextAtomic(filePath, updated)
      return backupPath
    } finally {
      await unlock()
    }
  }

  async listBackups(agentName: string): Promise<string[]> {
    const agentBackupDir = this.agentDir(agentName)
    try {
      const entries = await readdir(agentBackupDir)
      return entries.sort().reverse()
    } catch {
      return []
    }
  }

  async enforceMaxBackups(agentName: string, max: number): Promise<void> {
    const agentBackupDir = this.agentDir(agentName)
    let entries: string[] = []
    try {
      entries = await readdir(agentBackupDir)
    } catch {
      return
    }
    if (entries.length <= max) return
    entries.sort()
    const toDelete = entries.slice(0, entries.length - max)
    for (const e of toDelete) {
      try {
        await unlink(join(agentBackupDir, e))
      } catch {
        /* ignore */
      }
    }
  }
}
