import { createHash } from "node:crypto"
import { mkdir, readdir, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative } from "node:path"
import { Agent } from "@opencode/schema/agent"
import type { Config } from "@opencode/schema/config"
import { ConfigAgent } from "@opencode/schema/config/agent"
import { Schema } from "effect"
import { glob } from "glob"
import matter from "gray-matter"
import { appendInlineImprovement } from "../agent-prompts.js"
import { AgentsMdManager } from "../agents-md.js"
import {
  canonicalInstructionPath,
  commitInstructionUpdate,
  InstructionConflictError,
  type InstructionLocator,
  instructionHash,
  instructionJsonValue,
  parseInstructionJson,
  readInstructionText,
  replaceInstructionJson,
  rollbackInstruction,
} from "../instruction-transaction.js"
import { injectSectionContent } from "../prompt-utils.js"

/** Promise ports deliberately exclude Effect ownership and transport details. */
export interface V2AgentCatalogPort {
  list(): Promise<readonly Pick<Agent.Info, "id" | "system">[]>
  get(id: Agent.ID): Promise<Pick<Agent.Info, "id" | "system"> | undefined>
  reload?(): Promise<void>
}

export interface V2InstructionOptions {
  projectRoot: string
  directory: string
  stateDir: string
  globalConfigDir?: string
  home?: string
  projectDiscovery?: boolean
  globalDiscovery?: boolean
  catalog: V2AgentCatalogPort
  /** Host config.get entries in their authoritative low-to-high order. */
  configEntries?: () => Promise<readonly Config.Entry[]>
  /** Explicit opt-in identity, never inferred from equal effective text. */
  editableAgents?: Readonly<Record<string, InstructionLocator>>
  /** Explicit Kasper-owned append overlay; C10 applies it in agent.transform. */
  overlays?: Readonly<Record<string, string>>
  /** Host-fetched URL text can be supplied without a second HTTP fetch. */
  remoteInstructions?: () => Promise<ReadonlyMap<string, string>>
}

export interface V2InstructionRead {
  text: string
  complete: boolean
  issues: string[]
  sources: Array<{ path: string; revision: string }>
  /** Fresh disk discovery is not proof of host/session activation (nested entries may be cached). */
  activation: "unconfirmed"
}

export interface V2AgentSource {
  kind: "editable" | "overlay" | "readonly" | "unknown"
  agentID: Agent.ID
  effectiveText: string
  candidate?: InstructionLocator
  revision?: string
  complete: boolean
  issues: string[]
}

function contains(root: string, path: string): boolean {
  const rel = relative(root, path)
  return (
    !isAbsolute(rel) &&
    rel !== ".." &&
    !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  )
}

function agentID(name: string): Agent.ID {
  // Native IDs are slash-preserving branded strings, not basename/sanitized names.
  return Schema.decodeUnknownSync(Agent.ID)(name)
}

/** Same YAML fallback as pinned OpenCode ConfigMarkdown, preserving original bytes on write. */
function markdown(raw: string): {
  body: string
  prefix: string
  valid: boolean
} {
  // Gray-matter has an executable JavaScript engine. Source attribution is a
  // read operation, so reject other languages before entering any parser.
  const normalized = raw.replace(/^\uFEFF/, "")
  if (normalized.startsWith("---") && normalized[3] !== "-") {
    const language = normalized.slice(3).split(/\r?\n/, 1)[0].trim()
    if (!["", "yaml", "json"].includes(language))
      throw new Error("Agent frontmatter supports only YAML or JSON")
  }
  const options = {
    engines: {
      javascript: {
        parse: () => {
          throw new Error("Executable agent frontmatter is disabled")
        },
      },
    },
  }
  let parsed: ReturnType<typeof matter>
  try {
    parsed = matter(raw, options)
  } catch {
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (!match) throw new Error("Invalid agent frontmatter")
    const sanitized = match[1]
      .split(/\r?\n/)
      .flatMap((line) => {
        if (!line.trim() || line.trim().startsWith("#") || /^\s/.test(line))
          return [line]
        const item = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/)
        const value = item?.[2].trim()
        return item && value?.includes(":") && !/^["'|>]/.test(value)
          ? [`${item[1]}: |-`, `  ${value}`]
          : [line]
      })
      .join("\n")
    parsed = matter(
      raw.replace(match[1], () => sanitized),
      options,
    )
  }
  const body = parsed.content.trim()
  const data = parsed.data
  const keys = new Set(Object.keys(ConfigAgent.Info.fields))
  const unsupported = Object.keys(data).filter(
    (key) => !keys.has(key) && key !== "variant",
  )
  const native = ["permissions", "request", "system", "disabled"].some(
    (key) => key in data,
  )
  // Legacy conversion is host-owned; unresolved legacy documents block write attribution.
  const valid =
    (unsupported.length === 0 || native) &&
    Schema.decodeUnknownOption(ConfigAgent.Info)({ ...data, system: body })
      ._tag === "Some"
  const header =
    raw.match(
      /^\uFEFF?---(?:[ \t]*(?:yaml|json))?[ \t]*\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,
    )?.[0] ?? ""
  return { body, prefix: header, valid: valid && data.disabled !== true }
}

async function agentCandidates(
  directory: string,
  name: string,
): Promise<string[]> {
  if (
    isAbsolute(name) ||
    name.includes("\\") ||
    name.split(/[\\/]/).some((part) => part === ".." || !part)
  )
    return []
  const files = [
    join(directory, "agent", `${name}.md`),
    join(directory, "agents", `${name}.md`),
  ].sort()
  if (!name.includes("/"))
    files.push(
      ...[
        join(directory, "mode", `${name}.md`),
        join(directory, "modes", `${name}.md`),
      ].sort(),
    )
  return files
}

export class V2AgentPrompts {
  private readonly backupsDir: string
  readonly refreshStatus = new Map<string, "pending" | "confirmed">()
  readonly maintenanceIssues: string[] = []
  constructor(private readonly options: V2InstructionOptions) {
    this.backupsDir = join(options.stateDir, "backups", "v2-agents")
  }
  async init(): Promise<void> {
    await mkdir(this.backupsDir, { recursive: true })
  }
  invalidateSourceCache(): void {} // Every resolution rereads authoritative entries and exact bytes.
  setResolverInputs(): void {} // Native targets are explicit options, never V1 guessed directories.
  async getAllAgentNames(): Promise<string[]> {
    return (await this.options.catalog.list()).map((item) => item.id)
  }
  async exists(name: string): Promise<boolean> {
    return !!(await this.options.catalog.get(agentID(name)))
  }
  async read(name: string): Promise<string> {
    return (await this.resolve(name)).effectiveText
  }
  async readCoverage(name: string): Promise<V2InstructionRead> {
    const source = await this.resolve(name)
    const guidance = await readV2ApplicableInstructions(this.options)
    return {
      ...guidance,
      text: [source.effectiveText, guidance.text].filter(Boolean).join("\n\n"),
      complete: source.complete && guidance.complete,
      issues: [...source.issues, ...guidance.issues],
    }
  }

  async resolve(name: string): Promise<V2AgentSource> {
    const id = agentID(name)
    const agent = await this.options.catalog.get(id)
    const result: V2AgentSource = {
      kind: agent ? "readonly" : "unknown",
      agentID: id,
      effectiveText: agent?.system ?? "",
      complete: true,
      issues: [],
    }
    if (!agent) {
      result.complete = false
      result.issues.push("Agent is absent from the native catalog")
      return result
    }
    if (agent.system === undefined) {
      result.complete = false
      result.issues.push(
        "Native catalog does not expose the provider-selected system prompt",
      )
    }
    const overlay = this.options.overlays?.[name]
    if (overlay) {
      result.candidate = { path: await canonicalInstructionPath(overlay) }
      if (
        !contains(
          await canonicalInstructionPath(this.options.stateDir),
          result.candidate.path,
        )
      ) {
        result.candidate = undefined
        result.issues.push(
          "Kasper overlay must be owned by its state directory",
        )
        return result
      }
      result.kind = "overlay"
      result.revision = instructionHash(
        await readInstructionText(result.candidate.path),
      )
      return result
    }
    if (!this.options.configEntries) {
      result.complete = false
      result.issues.push("Authoritative config entries are unavailable")
      return result
    }
    let entries: readonly Config.Entry[]
    try {
      entries = await this.options.configEntries()
    } catch (error) {
      result.complete = false
      result.issues.push(String(error))
      return result
    }
    let candidateText: string | undefined
    for (const entry of entries) {
      if (entry.type === "document") {
        const item = entry.info.agents?.[name]
        if (item?.disabled) {
          result.candidate = undefined
          candidateText = undefined
          continue
        }
        if (item?.system === undefined) continue
        candidateText = item.system
        result.candidate = undefined
        result.revision = undefined
        if (!entry.path) {
          result.issues.push("Highest system source is virtual")
          continue
        }
        try {
          const path = await canonicalInstructionPath(entry.path)
          const raw = await readInstructionText(path)
          if (raw === undefined) throw new Error("Source disappeared")
          const value = instructionJsonValue(parseInstructionJson(raw), [
            "agents",
            name,
            "system",
          ])
          // Variable/file substitutions are composite sources and must remain read-only.
          if (
            value !== item.system ||
            typeof value !== "string" ||
            /\{(?:file|env):/.test(value)
          ) {
            result.issues.push(`Expanded or changed config source: ${path}`)
            continue
          }
          result.candidate = { path, jsonPath: ["agents", name, "system"] }
          result.revision = instructionHash(raw)
        } catch (error) {
          result.complete = false
          result.issues.push(String(error))
        }
      } else {
        for (const file of await agentCandidates(entry.path, name)) {
          try {
            const raw = await readInstructionText(file)
            if (raw === undefined) continue
            const parsed = markdown(raw)
            if (!parsed.valid) {
              result.complete = false
              result.issues.push(
                `Unsupported or disabled Markdown source: ${file}`,
              )
              continue
            }
            candidateText = parsed.body
            result.candidate = { path: await canonicalInstructionPath(file) }
            result.revision = instructionHash(raw)
          } catch (error) {
            result.complete = false
            result.issues.push(String(error))
          }
        }
      }
    }
    const explicit = this.options.editableAgents?.[name]
    if (
      explicit &&
      result.candidate &&
      result.complete &&
      candidateText === result.effectiveText &&
      (await canonicalInstructionPath(explicit.path)) ===
        result.candidate.path &&
      JSON.stringify(explicit.jsonPath ?? []) ===
        JSON.stringify(result.candidate.jsonPath ?? [])
    ) {
      result.kind = "editable"
    } else
      result.issues.push(
        "Effective system origin is not explicitly authorized and verified",
      )
    return result
  }

  async injectSection(
    name: string,
    section: string,
    content: string,
    backupEnabled = true,
    maxBackups = 20,
    _mode = "subagent",
    injectMode: "section" | "inline" = "section",
    assertCurrent?: () => void,
  ): Promise<string | undefined> {
    const source = await this.resolve(name)
    const coverage = await readV2ApplicableInstructions(this.options)
    if (!source.complete || !coverage.complete)
      throw new InstructionConflictError(
        `Instruction coverage is incomplete: ${[...source.issues, ...coverage.issues].join("; ")}`,
      )
    if (!source.candidate || !["editable", "overlay"].includes(source.kind))
      throw new InstructionConflictError(
        `Agent ${name} has no verified editable source: ${source.issues.join("; ")}`,
      )
    const bucket = join(
      this.backupsDir,
      createHash("sha256").update(name).digest("hex"),
    )
    const result = await commitInstructionUpdate(
      source.candidate,
      async (raw) => {
        if (source.kind === "editable") {
          const fresh = await this.resolve(name)
          if (
            fresh.kind !== "editable" ||
            fresh.revision !== source.revision ||
            JSON.stringify(fresh.candidate) !== JSON.stringify(source.candidate)
          )
            throw new InstructionConflictError(
              "Agent source precedence changed before commit",
            )
        }
        const text = source.candidate?.jsonPath
          ? instructionJsonValue(
              parseInstructionJson(raw),
              source.candidate.jsonPath,
            )
          : source.kind === "overlay"
            ? raw
            : markdown(raw).body
        if (typeof text !== "string")
          throw new InstructionConflictError("Agent system is no longer text")
        const updated =
          injectMode === "inline"
            ? appendInlineImprovement(text, content)
            : injectSectionContent(text, section, content).updated
        return source.candidate?.jsonPath
          ? replaceInstructionJson(raw, source.candidate.jsonPath, updated)
          : source.kind === "overlay"
            ? updated
            : markdown(raw).prefix + updated
      },
      {
        expectedHash: source.revision,
        backupDir: backupEnabled ? bucket : undefined,
        label: "v2-improvement",
        assertCurrent,
      },
    )
    this.refreshStatus.set(name, "pending")
    await this.prune(bucket, maxBackups).catch((error) =>
      this.maintenanceIssues.push(String(error)),
    )
    return result.backupPath
  }

  /** Reload requests alone are never confirmation; compare a fresh catalog read to intended text. */
  async confirmRefresh(
    name: string,
    expectedEffectiveText: string,
  ): Promise<boolean> {
    const current = await this.options.catalog.get(agentID(name))
    const confirmed = !!current && current.system === expectedEffectiveText
    if (confirmed) this.refreshStatus.set(name, "confirmed")
    return confirmed
  }
  async rollback(
    name: string,
    backupPath?: string,
    assertCurrent?: () => void,
  ): Promise<boolean> {
    const bucket = join(
      this.backupsDir,
      createHash("sha256").update(name).digest("hex"),
    )
    const path = backupPath ?? (await this.backups(bucket))[0]
    if (!path) return false
    const restored = await rollbackInstruction(path, bucket, { assertCurrent })
    if (restored) this.refreshStatus.set(name, "pending")
    return restored
  }
  private async backups(bucket: string): Promise<string[]> {
    try {
      return (await readdir(bucket))
        .filter((name) => name.endsWith(".md"))
        .sort()
        .reverse()
        .map((name) => join(bucket, name))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }
  }
  private async prune(bucket: string, max: number): Promise<void> {
    for (const path of (await this.backups(bucket)).slice(Math.max(1, max))) {
      await unlink(path)
      await unlink(`${path}.json`)
    }
  }
}

/** Ambient global, then nearest-first ancestor AGENTS; exact host stop rules. No CLAUDE fallback. */
export async function readV2ApplicableInstructions(
  options: V2InstructionOptions,
): Promise<V2InstructionRead> {
  const result: V2InstructionRead = {
    text: "",
    complete: true,
    issues: [],
    sources: [],
    activation: "unconfirmed",
  }
  const seen = new Set<string>()
  const texts: string[] = []
  const read = async (file: string) => {
    try {
      const path = await canonicalInstructionPath(file)
      if (seen.has(path)) return
      seen.add(path)
      const raw = await readInstructionText(path)
      if (raw === undefined) return
      texts.push(raw)
      result.sources.push({ path, revision: instructionHash(raw) })
    } catch (error) {
      result.complete = false
      result.issues.push(`${file}: ${String(error)}`)
    }
  }
  const home = await canonicalInstructionPath(options.home ?? homedir())
  const root = await canonicalInstructionPath(options.projectRoot)
  const start = await canonicalInstructionPath(options.directory)
  if (options.globalDiscovery !== false && options.globalConfigDir)
    await read(join(options.globalConfigDir, "AGENTS.md"))
  else if (options.globalDiscovery !== false) {
    result.complete = false
    result.issues.push("Global AGENTS directory is unavailable")
  }
  const project = options.projectDiscovery !== false && contains(root, start)
  if (project) {
    const stop = contains(home, start) ? home : root
    for (
      let directory = start;
      contains(stop, directory);
      directory = dirname(directory)
    ) {
      await read(join(directory, "AGENTS.md"))
      if (directory === stop || dirname(directory) === directory) break
    }
  }
  if (!options.configEntries) {
    result.complete = false
    result.issues.push(
      "Configured instructions unavailable without authoritative config entries",
    )
  } else {
    let remote: ReadonlyMap<string, string> | undefined
    let entries: readonly Config.Entry[] = []
    try {
      remote = await options.remoteInstructions?.()
      entries = await options.configEntries()
    } catch (error) {
      result.complete = false
      result.issues.push(String(error))
    }
    for (const entry of entries) {
      if (entry.type !== "document") continue
      for (const pattern of entry.info.instructions ?? []) {
        if (/^https?:\/\//.test(pattern)) {
          if (seen.has(pattern)) continue
          seen.add(pattern)
          const text = remote?.get(pattern)
          if (text !== undefined) texts.push(text)
          else {
            result.complete = false
            result.issues.push(
              `Host-cached remote instruction unavailable: ${pattern}`,
            )
          }
          continue
        }
        const expanded = pattern.startsWith("~/")
          ? join(home, pattern.slice(2))
          : pattern
        const bases: string[] = []
        if (isAbsolute(expanded)) bases.push(dirname(expanded))
        else if (project) {
          for (let dir = start; contains(root, dir); dir = dirname(dir)) {
            bases.push(dir)
            if (dir === root) break
          }
        } else if (options.globalDiscovery !== false && options.globalConfigDir)
          bases.push(options.globalConfigDir)
        const matches: string[] = []
        for (const base of bases) {
          try {
            matches.push(
              ...(await glob(
                isAbsolute(expanded)
                  ? expanded.replaceAll("\\", "/")
                  : expanded,
                {
                  cwd: base,
                  absolute: true,
                  dot: true,
                  nodir: true,
                  follow: false,
                },
              )),
            )
          } catch (error) {
            result.complete = false
            result.issues.push(`${pattern}: ${String(error)}`)
          }
        }
        for (const file of matches.sort()) await read(file)
      }
    }
  }
  result.text = texts.join("\n\n")
  return result
}

/** Shared core reads combined guidance; writes always operate on the owned local file. */
export function createV2AgentsMd(options: V2InstructionOptions) {
  const local = new AgentsMdManager(
    join(options.directory, "AGENTS.md"),
    options.stateDir,
  )
  const guardOwned = async () => {
    const coverage = await readV2ApplicableInstructions(options)
    if (!coverage.complete)
      throw new InstructionConflictError(
        `Instruction coverage is incomplete: ${coverage.issues.join("; ")}`,
      )
    const root = await canonicalInstructionPath(options.projectRoot)
    const path = await canonicalInstructionPath(local.agentsMdPath)
    if (options.projectDiscovery === false || !contains(root, path))
      throw new InstructionConflictError(
        "No project-owned applicable AGENTS target",
      )
  }
  let refreshStatus: "pending" | undefined
  return {
    get refreshStatus() {
      return refreshStatus
    },
    init: () => local.init(),
    read: async () => (await readV2ApplicableInstructions(options)).text,
    readSnapshot: () => readV2ApplicableInstructions(options),
    backup: async (label: string) => {
      await guardOwned()
      return local.backup(label)
    },
    injectSection: local.injectSection.bind(local),
    lockedUpdate: async (
      updater: (existing: string) => Promise<string>,
      assertCurrent?: () => void,
    ) => {
      await guardOwned()
      await local.lockedUpdate(updater, assertCurrent)
      refreshStatus = "pending"
    },
    applyGuidance: async (text: string, assertCurrent?: () => void) => {
      await guardOwned()
      const backup = await local.applyGuidance(text, assertCurrent)
      refreshStatus = "pending"
      return backup
    },
    rollback: async (backupPath?: string, assertCurrent?: () => void) => {
      const restored = await local.rollback(backupPath, assertCurrent)
      if (restored) refreshStatus = "pending"
      return restored
    },
    setResolvedPath: (_path: string) => {
      throw new InstructionConflictError(
        "Native V2 rules target is fixed by explicit project options",
      )
    },
  }
}

/** Load outside synchronous agent.transform; replay this snapshot by appending to factory system. */
export async function loadV2AgentOverlays(
  options: V2InstructionOptions,
): Promise<ReadonlyMap<Agent.ID, string>> {
  const owned = await canonicalInstructionPath(options.stateDir)
  const overlays = new Map<Agent.ID, string>()
  for (const [name, file] of Object.entries(options.overlays ?? {})) {
    const id = agentID(name)
    const path = await canonicalInstructionPath(file)
    if (!contains(owned, path))
      throw new InstructionConflictError(
        "Kasper overlay must be owned by its state directory",
      )
    if (!(await options.catalog.get(id))) continue
    const text = await readInstructionText(path)
    if (text?.trim()) overlays.set(id, text.trim())
  }
  return overlays
}
