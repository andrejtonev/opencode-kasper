import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, unlink } from "node:fs/promises"
import { basename, join } from "node:path"
import {
  type AgentPromptSource,
  appendToPluginOverridePrompt,
  defaultAgentFilePath,
  resolveAgentPromptSource,
} from "./agent-prompt-resolver.js"
import {
  commitInstructionUpdate,
  createInstructionBackup,
  finishInstructionBackup,
  readInstructionText,
  rollbackInstruction,
  withInstructionLock,
} from "./instruction-transaction.js"
import { escapeRegex, injectSectionContent } from "./prompt-utils.js"

function sanitizeAgentName(name: string): string {
  return basename(name.replace(/[\\/]/g, "_"))
}

const INLINE_BEGIN = "<!-- kasper-injected:begin -->"
const INLINE_END = "<!-- kasper-injected:end -->"
const INLINE_BLOCK = new RegExp(
  `${escapeRegex(INLINE_BEGIN)}[\\s\\S]*?${escapeRegex(INLINE_END)}\\n?`,
  "g",
)

/**
 * Append a kasper improvement to a prompt file in "inline" mode: no `## `
 * section header, no visible provenance comment. The improvement is wrapped
 * in a `<!-- kasper-injected:begin/end -->` block so subsequent runs can
 * locate, dedupe, and roll it back. If the exact text is already present
 * anywhere in the file (case-insensitive, whitespace-normalised), this is
 * a no-op.
 */
export function appendInlineImprovement(
  existing: string,
  content: string,
): string {
  const trimmed = content.trim()
  if (!trimmed) return existing

  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim()
  if (norm(existing).includes(norm(trimmed))) return existing

  const block = `${INLINE_BEGIN}\n${trimmed}\n${INLINE_END}\n`
  const trimmedExisting = existing.trimEnd()
  return trimmedExisting ? `${trimmedExisting}\n\n${block}` : block
}

export const _inlineInjectionMarkers = {
  INLINE_BEGIN,
  INLINE_END,
  INLINE_BLOCK,
}

/**
 * Error raised when the caller tries to write or mutate an agent prompt
 * whose source is an inline string in opencode.json. Callers should
 * surface the `migration` hint to the user.
 */
export class InlinePromptError extends Error {
  readonly agentName: string
  readonly migration: string
  constructor(agentName: string) {
    super(
      `Agent "${agentName}" prompt is defined inline in opencode.json. ` +
        `Run \`/kasper migrate ${agentName}\` to extract it to a file, then retry.`,
    )
    this.name = "InlinePromptError"
    this.agentName = agentName
    this.migration = `kasper migrate ${agentName}`
  }
}

export class AgentPromptManager {
  private readonly backupsDir: string
  private pendingBackups = new Map<string, string>()
  private sourceCache = new Map<
    string,
    { source: AgentPromptSource; ts: number }
  >()
  private static readonly SOURCE_CACHE_TTL_MS = 30_000
  private globalOpencodeDir: string | undefined
  private customPromptPaths: readonly string[] | undefined

  constructor(
    private readonly projectRoot: string,
    readonly kasperStateDir: string,
    globalOpencodeDir?: string,
    customPromptPaths?: readonly string[],
  ) {
    this.backupsDir = join(kasperStateDir, "backups", "agents")
    this.globalOpencodeDir = globalOpencodeDir
    this.customPromptPaths = customPromptPaths
  }

  async init(): Promise<void> {
    await mkdir(this.backupsDir, { recursive: true })
  }

  /**
   * Update the resolver inputs that come from `kasper.json` at runtime.
   * Used by the config reload timer when the user edits `prompt_paths`
   * or the global opencode dir config. Clears the source cache so the
   * next `resolve()` call re-resolves against the new inputs.
   */
  setResolverInputs(
    globalOpencodeDir: string | undefined,
    customPromptPaths: readonly string[] | undefined,
  ): void {
    this.globalOpencodeDir = globalOpencodeDir
    this.customPromptPaths = customPromptPaths
    this.invalidateSourceCache()
  }

  /**
   * Resolve the agent's prompt source. Cached for 30s per agent to avoid
   * hammering the filesystem on every improvement.
   */
  async resolve(agentName: string, force = false): Promise<AgentPromptSource> {
    const cached = this.sourceCache.get(agentName)
    if (
      !force &&
      cached &&
      Date.now() - cached.ts < AgentPromptManager.SOURCE_CACHE_TTL_MS
    ) {
      return cached.source
    }
    const source = await resolveAgentPromptSource(
      agentName,
      this.projectRoot,
      this.globalOpencodeDir,
      this.customPromptPaths,
    )
    this.sourceCache.set(agentName, { source, ts: Date.now() })
    return source
  }

  invalidateSourceCache(agentName?: string): void {
    if (agentName) this.sourceCache.delete(agentName)
    else this.sourceCache.clear()
  }

  /**
   * The file path kasper will read from and write to for this agent.
   * - external_file / project_file / global_file: the actual file
   * - plugin_override with file/file_uri target: the referenced file
   * - plugin_override with config target: the file the value would be
   *   redirected to (or the conventional default if not yet redirected)
   * - inline: not applicable (callers should check `resolve` first)
   * - missing: the conventional default where a new file would be created
   */
  async getAgentPath(agentName: string): Promise<string> {
    const source = await this.resolve(agentName)
    if (source.kind === "external_file") return source.path
    if (source.kind === "project_file") return source.path
    if (source.kind === "global_file") return source.path
    if (source.kind === "plugin_override") {
      if (source.path) return source.path
      return defaultAgentFilePath(this.projectRoot, agentName)
    }
    if (source.kind === "inline") {
      // Reading/writing an inline prompt is not supported; return the path
      // where it WOULD be if materialized, for diagnostic display.
      return defaultAgentFilePath(this.projectRoot, agentName)
    }
    return defaultAgentFilePath(this.projectRoot, agentName)
  }

  /**
   * True when an agent prompt is reachable (file on disk, {file:...} reference,
   * or inline string in opencode.json).
   */
  async exists(agentName: string): Promise<boolean> {
    const source = await this.resolve(agentName)
    return source.kind !== "missing"
  }

  /**
   * Read the current prompt content. Returns the inline string verbatim if
   * the source is inline; returns the file body if the source is a file;
   * returns the override value for a `plugin_override` with config target;
   * returns "" if no source can be found.
   */
  async read(agentName: string): Promise<string> {
    const source = await this.resolve(agentName)
    if (source.kind === "missing") return ""
    if (source.kind === "inline") return source.prompt
    if (source.kind === "plugin_override") {
      if (source.target === "config") return source.value ?? ""
      // file or file_uri: read the referenced file
      if (source.path) {
        try {
          return await readFile(source.path, "utf-8")
        } catch {
          return ""
        }
      }
      return ""
    }
    try {
      return await readFile(source.path, "utf-8")
    } catch {
      return ""
    }
  }

  /**
   * Write the entire prompt body, replacing the previous content. Throws
   * InlinePromptError for inline sources and for `plugin_override` sources
   * that fully replace the upstream prompt — use /kasper migrate first.
   *
   * For `plugin_override` sources with a `prompt_append` field, this appends
   * the new content to the `prompt_append` value in the source config file
   * (the canonical "extend the existing override" operation for plugin-shipped
   * agents). For `plugin_override` sources targeting a real file
   * (`{file:...}` or `file://...`), the file is overwritten verbatim.
   */
  async write(agentName: string, content: string): Promise<void> {
    const source = await this.resolve(agentName, true)
    if (source.kind === "inline") {
      throw new InlinePromptError(agentName)
    }
    if (source.kind === "plugin_override" && source.target === "config") {
      if (!source.isAppend) {
        // `prompt` (not `prompt_append`) fully replaces the upstream prompt.
        // Treat it like inline: refuse to overwrite directly.
        throw new InlinePromptError(agentName)
      }
      await appendToPluginOverridePrompt(
        source,
        content,
        this.agentDir(agentName),
      )
      await this.enforceMaxBackups(agentName, 20)
      this.invalidateSourceCache(agentName)
      return
    }
    const filePath =
      source.kind === "missing"
        ? defaultAgentFilePath(this.projectRoot, agentName)
        : source.kind === "plugin_override"
          ? source.path
          : source.path
    if (!filePath) throw new Error("Agent prompt source has no file path")
    const result = await commitInstructionUpdate(
      { path: filePath },
      () => content,
    )
    const pending = this.pendingBackups.get(result.target.path)
    if (pending) {
      await finishInstructionBackup(pending, content)
      this.pendingBackups.delete(result.target.path)
    }
    this.invalidateSourceCache(agentName)
  }

  private agentDir(agentName: string): string {
    const id = createHash("sha256").update(agentName).digest("hex").slice(0, 12)
    return join(this.backupsDir, `${sanitizeAgentName(agentName)}--${id}`)
  }

  /**
   * Snapshot the current prompt to a timestamped backup file. No-op for
   * inline and missing sources. Config overrides back up exact JSONC bytes
   * and record the owned field for conflict-aware rollback.
   */
  async backup(
    agentName: string,
    label: string,
    maxBackups = 20,
  ): Promise<string | undefined> {
    const source = await this.resolve(agentName, true)
    if (source.kind === "missing" || source.kind === "inline") return undefined
    const path =
      source.kind === "plugin_override" && source.target === "config"
        ? source.configPath
        : source.path
    if (!path) return undefined
    const backupDir = this.agentDir(agentName)
    const jsonPath =
      source.kind === "plugin_override" && source.target === "config"
        ? source.jsonPath
        : undefined
    const result = await withInstructionLock(
      { path, jsonPath },
      async (target) => {
        const backup = await createInstructionBackup(
          target,
          backupDir,
          label,
          await readInstructionText(target.path),
        )
        this.pendingBackups.set(target.path, backup)
        return backup
      },
    )
    await this.enforceMaxBackups(agentName, maxBackups)
    return result
  }

  async rollback(agentName: string, backupPath?: string): Promise<boolean> {
    const entries = await this.listBackups(agentName)
    if (!backupPath && !entries.length) return false
    const dir = this.agentDir(agentName)
    const result = await rollbackInstruction(
      backupPath ?? join(dir, entries[0]),
      dir,
    )
    this.invalidateSourceCache(agentName)
    return result
  }

  async injectSection(
    agentName: string,
    sectionName: string,
    content: string,
    backupEnabled = true,
    maxBackups = 20,
    mode = "subagent",
    injectMode: "section" | "inline" = "section",
    assertCurrent?: () => void,
  ): Promise<string | undefined> {
    const source = await this.resolve(agentName, true)
    if (source.kind === "inline") {
      throw new InlinePromptError(agentName)
    }

    // `plugin_override` with a config target and a `prompt_append` field
    // is a flat raw string in the source config file. We don't have a
    // markdown section to write into, so we append the new content to the
    // `prompt_append` value directly (idempotent, whitespace-normalised
    // dedupe). For `prompt` (not append) the field fully replaces the
    // upstream prompt and we refuse to mutate it directly.
    if (source.kind === "plugin_override" && source.target === "config") {
      if (!source.isAppend) {
        throw new InlinePromptError(agentName)
      }
      const sectionBody = `## ${sectionName}\n${content.trim()}`
      const result = await appendToPluginOverridePrompt(
        source,
        sectionBody,
        backupEnabled ? this.agentDir(agentName) : undefined,
        assertCurrent,
      )
      const backupPath = result.backupPath
      this.invalidateSourceCache(agentName)
      await this.enforceMaxBackups(agentName, maxBackups)
      return backupPath
    }

    // `inline`, `missing`, and `plugin_override (config)` are all handled
    // in earlier branches. The remaining shapes (`external_file`,
    // `project_file`, `global_file`, and `plugin_override` with a file
    // target) all carry a `path` field. Use a switch on `source.kind`
    // so TypeScript checks exhaustiveness — adding a new source kind
    // will fail the build here until the new case is handled.
    const filePath: string = (() => {
      switch (source.kind) {
        case "missing":
          return defaultAgentFilePath(this.projectRoot, agentName)
        case "external_file":
        case "project_file":
        case "global_file":
          return source.path
        case "plugin_override":
          // `plugin_override` with a `file` or `file_uri` target
          // always has a `path` (set by the resolver). The
          // `target === "config"` case is handled above.
          if (source.path) return source.path
          throw new Error(
            `injectSection: plugin_override for ${agentName} has no path ` +
              `(target=${source.target})`,
          )
      }
    })()
    const result = await commitInstructionUpdate(
      { path: filePath },
      (existing) => {
        let updated: string
        if (injectMode === "inline") {
          updated = appendInlineImprovement(existing, content.trim())
        } else if (!existing.trim()) {
          // Empty file: create with frontmatter + a fresh section.
          const sectionBlock = `## ${sectionName}\n<!-- kasper: ${new Date().toISOString()} -->\n${content.trim()}\n`
          const frontmatter = `---\nmode: ${mode}\n---\n\n`
          updated = `${frontmatter + sectionBlock}\n`
        } else {
          // Section-mode on a non-empty file: delegate to the shared helper.
          // The helper handles accumulation when the section already exists and
          // appends a new section when it does not. In both cases the file ends
          // with a trailing newline.
          const result = injectSectionContent(
            existing,
            sectionName,
            content.trim(),
          )
          updated = result.updated
        }

        return updated
      },
      {
        backupDir: backupEnabled ? this.agentDir(agentName) : undefined,
        assertCurrent,
      },
    )
    this.invalidateSourceCache(agentName)
    await this.enforceMaxBackups(agentName, maxBackups)
    return result.backupPath
  }

  async listBackups(agentName: string): Promise<string[]> {
    const agentBackupDir = this.agentDir(agentName)
    try {
      const entries = (await readdir(agentBackupDir)).filter((e) =>
        e.endsWith(".md"),
      )
      return entries
        .filter((e) => e.endsWith(".md"))
        .sort()
        .reverse()
    } catch {
      return []
    }
  }

  async enforceMaxBackups(agentName: string, max: number): Promise<void> {
    const agentBackupDir = this.agentDir(agentName)
    let entries: string[] = []
    try {
      entries = (await readdir(agentBackupDir)).filter((e) => e.endsWith(".md"))
    } catch {
      return
    }
    if (entries.length <= max) return
    entries.sort()
    const toDelete = entries.slice(0, entries.length - max)
    for (const e of toDelete) {
      try {
        await unlink(join(agentBackupDir, e))
        await unlink(join(agentBackupDir, `${e}.json`)).catch(() => {})
      } catch {
        /* ignore */
      }
    }
  }
}
