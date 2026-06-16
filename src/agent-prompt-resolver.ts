import { readdir, readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative } from "node:path"
import { applyEdits, type ModificationOptions, modify } from "jsonc-parser"
import { writeTextAtomic } from "./prompt-utils.js"

/**
 * Resolved source of an agent's prompt.
 *
 * Opencode supports four prompt forms (per https://opencode.ai/docs/agents
 * and the opencode.json schema):
 *   1. Project markdown file:  <projectRoot>/.opencode/agent(s)/<name>.md
 *   2. Global markdown file:   <globalOpencodeDir>/agent(s)/<name>.md
 *   3. External file via directive: opencode.json agent.<name>.prompt = "{file:/abs/path}"
 *   4. Inline string:          opencode.json agent.<name>.prompt = "You are..."
 *
 * The previous implementation only checked (1) and (2), so any agent
 * configured via (3) or (4) was silently treated as missing, which caused
 * kasper to create an empty `.opencode/agents/<name>.md` instead of editing
 * the real prompt. This module performs the full resolution and exposes the
 * result so the AgentPromptManager can read/write the correct file.
 *
 * Plugins (e.g. oh-my-opencode) ship agents whose prompt lives inside
 * `node_modules/<plugin>/.../src/agents/<name>.ts`. The user customises
 * these built-ins by adding an `agentOverrides.<name>.prompt` or
 * `prompt_append` field to the plugin's own config file (e.g.
 * `.opencode/oh-my-opencode.json`). To handle these layouts without
 * hardcoding plugin names, kasper scans every `.opencode/*.json[c]` at
 * the project (walked up) and global locations for an `agent` or `agents`
 * map containing a `prompt` or `prompt_append` field for the requested
 * name, and exposes the result as a `plugin_override` source.
 */
export type AgentPromptSource =
  | {
      kind: "external_file"
      /** Absolute path to the prompt file referenced via {file:...}. */
      path: string
      /** Path of the opencode.json that declared the directive. */
      configPath: string
    }
  | {
      kind: "project_file"
      /** Path of the project's <root>/.opencode/agent(s)/<name>.md file. */
      path: string
    }
  | {
      kind: "global_file"
      /** Path of the global ~/.config/opencode/agent(s)/<name>.md file. */
      path: string
    }
  | {
      kind: "inline"
      /** The full inline prompt string. */
      prompt: string
      /** Path of the opencode.json that holds the inline string. */
      configPath: string
    }
  | {
      /**
       * Plugin-defined override (e.g. oh-my-opencode's `agentOverrides`,
       * opencode.json's `agent.<name>.prompt`/`prompt_append`, or any
       * `.opencode/*.json[c]` that defines an `agent`/`agents` map with
       * a `prompt` or `prompt_append` field for this name).
       *
       * The `target` discriminates how the prompt is reachable:
       *   - `file`:      resolves to a real file on disk. The agent's
       *                  `prompt` or `prompt_append` is a `{file:...}` or
       *                  `{path:...}` directive. kasper reads/writes that
       *                  file as the canonical prompt.
       *   - `file_uri`:  resolves to a real file on disk via a `file://`
       *                  URI. kasper reads/writes that file.
       *   - `config`:    the prompt is a raw string stored inside the
       *                  config file under `promptField`. If `isAppend` is
       *                  true the string is appended to the upstream
       *                  factory prompt at runtime; kasper edits the
       *                  `prompt_append` value in the config. If
       *                  `isAppend` is false the string fully replaces the
       *                  upstream prompt; kasper treats it as inline.
       */
      kind: "plugin_override"
      target: "file" | "file_uri" | "config"
      /** Absolute path to the referenced file (for `file` and `file_uri`). */
      path?: string
      /** The raw string value, when target is `config`. */
      value?: string
      /** Path of the config file (json or jsonc) that declared the override. */
      configPath: string
      /** Which key declared the override: `prompt` or `prompt_append`. */
      promptField: "prompt" | "prompt_append"
      /** True when the key is `prompt_append`; false when it is `prompt`. */
      isAppend: boolean
    }
  | { kind: "missing" }

const FILE_DIRECTIVE = /^\s*\{\s*file\s*:\s*([^}]+)\s*\}\s*$/
const PATH_DIRECTIVE = /^\s*\{\s*path\s*:\s*([^}]+)\s*\}\s*$/

function expandTilde(p: string): string {
  if (p === "~") return homedir()
  if (p.startsWith("~/")) return join(homedir(), p.slice(2))
  return p
}

function resolveDirectivePath(raw: string, baseDir: string): string {
  const expanded = expandTilde(raw.trim())
  if (isAbsolute(expanded)) return expanded
  return join(baseDir, expanded)
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const info = await stat(p)
    return info.isFile()
  } catch {
    return false
  }
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const info = await stat(p)
    return info.isDirectory()
  } catch {
    return false
  }
}

async function loadJsoncIfExists(
  path: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await readFile(path, "utf-8")
    if (!raw.trim()) return undefined
    // Local import of jsonc-parser's parse to avoid coupling to the Kasper config layer
    const { parse } = await import("jsonc-parser")
    const errors: Array<{ error: number; offset: number; length: number }> = []
    const parsed = parse(raw, errors, {
      allowTrailingComma: true,
      disallowComments: false,
      allowEmptyContent: false,
    })
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

function getAgentEntry(
  raw: Record<string, unknown> | undefined,
  name: string,
): Record<string, unknown> | undefined {
  if (!raw) return undefined
  const agent = raw.agent
  if (!agent || typeof agent !== "object" || Array.isArray(agent))
    return undefined
  const entry = (agent as Record<string, unknown>)[name]
  if (!entry || typeof entry !== "object" || Array.isArray(entry))
    return undefined
  return entry as Record<string, unknown>
}

function candidateGlobalOpencodeDirs(): string[] {
  const dirs: string[] = []
  if (process.env.XDG_CONFIG_HOME) {
    dirs.push(join(process.env.XDG_CONFIG_HOME, "opencode"))
  } else {
    dirs.push(join(homedir(), ".config", "opencode"))
  }
  if (process.platform === "win32" && process.env.APPDATA) {
    dirs.push(join(process.env.APPDATA, "opencode"))
  }
  dirs.push(join(homedir(), ".opencode"))
  return [...new Set(dirs)]
}

interface LoadedConfig {
  path: string
  raw: Record<string, unknown>
}

async function findProjectOpencodeJson(
  startDir: string,
): Promise<LoadedConfig | undefined> {
  let current = startDir
  while (true) {
    for (const name of ["opencode.json", "opencode.jsonc"]) {
      const p = join(current, name)
      const raw = await loadJsoncIfExists(p)
      if (raw) return { path: p, raw }
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

async function findGlobalOpencodeJson(
  preferredDir: string | undefined,
): Promise<LoadedConfig | undefined> {
  const candidates = preferredDir
    ? [
        preferredDir,
        ...candidateGlobalOpencodeDirs().filter((d) => d !== preferredDir),
      ]
    : candidateGlobalOpencodeDirs()
  for (const dir of candidates) {
    for (const name of ["opencode.json", "opencode.jsonc"]) {
      const p = join(dir, name)
      const raw = await loadJsoncIfExists(p)
      if (raw) return { path: p, raw }
    }
  }
  return undefined
}

function projectAgentDirCandidates(
  projectRoot: string,
  agentName: string,
): string[] {
  const safe = sanitizeName(agentName)
  return [
    join(projectRoot, ".opencode", "agent", `${safe}.md`),
    join(projectRoot, ".opencode", "agents", `${safe}.md`),
  ]
}

function globalAgentDirCandidates(
  globalOpencodeDir: string | undefined,
  agentName: string,
): string[] {
  if (!globalOpencodeDir) return []
  const safe = sanitizeName(agentName)
  return [
    join(globalOpencodeDir, "agent", `${safe}.md`),
    join(globalOpencodeDir, "agents", `${safe}.md`),
  ]
}

/**
 * Expand a user-configured prompt path. Supports absolute paths, `~/...`
 * home-relative paths, and paths relative to the project root (anything
 * that isn't absolute and doesn't start with `~`).
 */
function expandCustomPromptPath(raw: string, projectRoot: string): string {
  const expanded = expandTilde(raw.trim())
  if (isAbsolute(expanded)) return expanded
  return join(projectRoot, expanded)
}

function customPromptPathCandidates(
  customPaths: readonly string[] | undefined,
  projectRoot: string,
  agentName: string,
): string[] {
  if (!customPaths || customPaths.length === 0) return []
  const safe = sanitizeName(agentName)
  const out: string[] = []
  for (const raw of customPaths) {
    if (typeof raw !== "string" || raw.trim().length === 0) continue
    const dir = expandCustomPromptPath(raw, projectRoot)
    out.push(join(dir, "agent", `${safe}.md`))
    out.push(join(dir, "agents", `${safe}.md`))
  }
  return out
}

function sanitizeName(name: string): string {
  // Mirror the existing sanitization in agent-prompts.ts
  return name.replace(/[\\/]/g, "_")
}

/**
 * Try to extract a `prompt` or `prompt_append` override entry for `agentName`
 * from any of the standard `agent`/`agents` map locations in a config object.
 * Returns the first hit with the field name, or undefined.
 */
function readPluginOverrideEntry(
  raw: Record<string, unknown> | undefined,
  agentName: string,
):
  | { entry: Record<string, unknown>; promptField: "prompt" | "prompt_append" }
  | undefined {
  if (!raw) return undefined
  // Prefer the standard `agent` map (opencode.json + most plugins).
  for (const key of ["agent", "agents"] as const) {
    const map = raw[key]
    if (!map || typeof map !== "object" || Array.isArray(map)) continue
    const entry = (map as Record<string, unknown>)[agentName]
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue
    const e = entry as Record<string, unknown>
    if (typeof e.prompt_append === "string" && e.prompt_append.length > 0) {
      return { entry: e, promptField: "prompt_append" }
    }
    if (typeof e.prompt === "string" && e.prompt.length > 0) {
      return { entry: e, promptField: "prompt" }
    }
  }
  return undefined
}

/**
 * Classify a `prompt` or `prompt_append` string into one of the three
 * `plugin_override.target` shapes and produce a complete source object.
 */
function buildPluginOverride(
  value: string,
  promptField: "prompt" | "prompt_append",
  configPath: string,
): AgentPromptSource {
  const isAppend = promptField === "prompt_append"
  // `{file:...}` / `{path:...}` directive → target a real file on disk.
  const fileMatch = value.match(FILE_DIRECTIVE) ?? value.match(PATH_DIRECTIVE)
  if (fileMatch) {
    const path = resolveDirectivePath(fileMatch[1], dirname(configPath))
    return {
      kind: "plugin_override",
      target: "file",
      path,
      configPath,
      promptField,
      isAppend,
    }
  }
  // `file://...` URI (used by oh-my-opencode and others) → target a real
  // file on disk. We resolve `./` and `~/` forms against the config's
  // directory and `homedir()` respectively; absolute URIs are kept verbatim.
  const fileUri = value.match(/^file:\/\/(.+)$/)
  if (fileUri) {
    const raw = fileUri[1]
    if (raw.startsWith("/")) {
      return {
        kind: "plugin_override",
        target: "file_uri",
        path: raw,
        configPath,
        promptField,
        isAppend,
      }
    }
    if (raw.startsWith("~/")) {
      return {
        kind: "plugin_override",
        target: "file_uri",
        path: join(homedir(), raw.slice(2)),
        configPath,
        promptField,
        isAppend,
      }
    }
    if (raw.startsWith("./") || raw.startsWith("../")) {
      return {
        kind: "plugin_override",
        target: "file_uri",
        path: join(dirname(configPath), raw),
        configPath,
        promptField,
        isAppend,
      }
    }
    // Unknown file:// form — degrade to config-raw to avoid a bad path.
    return {
      kind: "plugin_override",
      target: "config",
      value,
      configPath,
      promptField,
      isAppend,
    }
  }
  // Anything else is a raw string in the config file.
  return {
    kind: "plugin_override",
    target: "config",
    value,
    configPath,
    promptField,
    isAppend,
  }
}

/**
 * Walk up the directory tree starting at `startDir` collecting every
 * `.opencode/` directory encountered. Used by the plugin-config scanner to
 * find candidate config files without hardcoding a single project root.
 */
async function collectOpencodeDirsUp(startDir: string): Promise<string[]> {
  const out: string[] = []
  let current = startDir
  const seen = new Set<string>()
  while (true) {
    if (!seen.has(current)) {
      seen.add(current)
      const dotDir = join(current, ".opencode")
      if (await dirExists(dotDir)) out.push(dotDir)
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return out
}

/**
 * Enumerate every `*.json[c]` in a directory (non-recursive). The list is
 * sorted for determinism so the resolver picks the same config every run.
 */
async function listOpencodeJsonFiles(dir: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  return entries
    .filter((e) => e.endsWith(".json") || e.endsWith(".jsonc"))
    .sort()
    .map((e) => join(dir, e))
}

/**
 * Scan a single `.opencode/` directory for a plugin override. Skips the
 * standard `opencode.json`/`opencode.jsonc` (already handled by the caller)
 * to avoid double-counting.
 */
async function findOverrideInDir(
  dir: string,
  agentName: string,
): Promise<AgentPromptSource | undefined> {
  const files = await listOpencodeJsonFiles(dir)
  for (const file of files) {
    const base = file.split("/").pop() ?? ""
    if (base === "opencode.json" || base === "opencode.jsonc") continue
    const raw = await loadJsoncIfExists(file)
    const hit = readPluginOverrideEntry(raw, agentName)
    if (hit)
      return buildPluginOverride(
        hit.entry[hit.promptField] as string,
        hit.promptField,
        file,
      )
  }
  return undefined
}

/**
 * Scan plugin config files for an agent override. Resolution order:
 *   1. Project `.opencode/` (walked from `projectRoot` upward to `/`), the
 *      first `.opencode/` containing a matching override wins.
 *   2. Each candidate global opencode dir, scanned directly AND inside its
 *      `.opencode/` subdir. The direct scan covers real-world layouts like
 *      `~/.config/opencode/oh-my-opencode.json`; the nested scan is kept
 *      for symmetry with the project layout.
 *
 * `opencode.json`/`opencode.jsonc` are excluded because the caller already
 * handled them via `findProjectOpencodeJson`/`findGlobalOpencodeJson`.
 */
async function findPluginConfigOverride(
  agentName: string,
  projectRoot: string,
  globalOpencodeDir?: string,
): Promise<AgentPromptSource | undefined> {
  const projectDirs = await collectOpencodeDirsUp(projectRoot)
  for (const dir of projectDirs) {
    const hit = await findOverrideInDir(dir, agentName)
    if (hit) return hit
  }
  const globalCandidates = globalOpencodeDir
    ? [
        globalOpencodeDir,
        ...candidateGlobalOpencodeDirs().filter((d) => d !== globalOpencodeDir),
      ]
    : candidateGlobalOpencodeDirs()
  for (const dir of globalCandidates) {
    const hit = await findOverrideInDir(dir, agentName)
    if (hit) return hit
    const inner = join(dir, ".opencode")
    const hitInner = await findOverrideInDir(inner, agentName)
    if (hitInner) return hitInner
  }
  return undefined
}

/**
 * Resolve where an agent's prompt actually lives. Project opencode.json takes
 * precedence over global. If the agent's `prompt` is a `{file:...}` or
 * `{path:...}` directive, return that file path. If it's a raw string,
 * return inline. Otherwise fall back to the conventional file locations.
 *
 * Then scan plugin-specific config files (`.opencode/*.json[c]`) at the
 * project (walked up) and global locations for a `prompt` or `prompt_append`
 * override for this agent, and return it as a `plugin_override` source. This
 * covers layouts like oh-my-opencode where the canonical agent prompt is in
 * `node_modules` and the user redirects it via the plugin's own config file.
 *
 * Finally, if `customPromptPaths` is non-empty, look for the agent's markdown
 * file in `<dir>/agent/<name>.md` and `<dir>/agents/<name>.md` for each
 * configured directory. This lets users redirect kasper to any number of
 * additional prompt locations (e.g. a separate `prompts/` directory or a
 * shared per-team prompt repo) without changing opencode's own behaviour.
 */
export async function resolveAgentPromptSource(
  agentName: string,
  projectRoot: string,
  globalOpencodeDir?: string,
  customPromptPaths?: readonly string[],
): Promise<AgentPromptSource> {
  const projectConfig = await findProjectOpencodeJson(projectRoot)
  const globalConfig = await findGlobalOpencodeJson(globalOpencodeDir)

  // Project wins over global. If both define the agent, prefer the project
  // entry — that matches opencode's deep-merge semantics where the project
  // config overrides the global.
  const projectEntry = getAgentEntry(projectConfig?.raw, agentName)
  const globalEntry = getAgentEntry(globalConfig?.raw, agentName)
  const entry = projectEntry ?? globalEntry
  const entryConfig = projectEntry
    ? projectConfig
    : globalEntry
      ? globalConfig
      : undefined

  if (entry && entryConfig) {
    const prompt = entry.prompt
    if (typeof prompt === "string") {
      const fileMatch =
        prompt.match(FILE_DIRECTIVE) ?? prompt.match(PATH_DIRECTIVE)
      if (fileMatch) {
        const path = resolveDirectivePath(
          fileMatch[1],
          dirname(entryConfig.path),
        )
        return { kind: "external_file", path, configPath: entryConfig.path }
      }
      if (prompt.trim().length > 0) {
        return { kind: "inline", prompt, configPath: entryConfig.path }
      }
    }
  }

  // Fall back to conventional file locations
  for (const p of projectAgentDirCandidates(projectRoot, agentName)) {
    if (await fileExists(p)) return { kind: "project_file", path: p }
  }
  for (const p of globalAgentDirCandidates(globalOpencodeDir, agentName)) {
    if (await fileExists(p)) return { kind: "global_file", path: p }
  }

  // Plugin override scan: some plugins (e.g. oh-my-opencode) ship agent
  // prompts inside node_modules and let users override them via
  // `agent.<name>.prompt` or `agent.<name>.prompt_append` in a non-opencode
  // config file under `.opencode/`. We scan every `.opencode/*.json[c]` for
  // any top-level `agent` or `agents` map with a `prompt`/`prompt_append`
  // field for this agent, and surface it as a `plugin_override` source.
  const pluginOverride = await findPluginConfigOverride(
    agentName,
    projectRoot,
    globalOpencodeDir,
  )
  if (pluginOverride) return pluginOverride

  // User-configured extra prompt directories. Each entry is a directory
  // (absolute, project-relative, or `~/...`); we look for the agent's
  // markdown file under `<dir>/agent/` and `<dir>/agents/`.
  for (const p of customPromptPathCandidates(
    customPromptPaths,
    projectRoot,
    agentName,
  )) {
    if (await fileExists(p)) return { kind: "project_file", path: p }
  }

  return { kind: "missing" }
}

/**
 * Compute the file path where a new agent prompt would be created, given
 * the conventional defaults. Used by AgentPromptManager when the source is
 * `missing` and the user asks kasper to write something for the first time.
 */
export function defaultAgentFilePath(
  projectRoot: string,
  agentName: string,
): string {
  const safe = sanitizeName(agentName)
  return join(projectRoot, ".opencode", "agents", `${safe}.md`)
}

/**
 * Result of `appendToPluginOverridePrompt`.
 */
export interface PluginOverrideAppendResult {
  /** Absolute path of the config file that was modified. */
  configPath: string
  /** The full `agents.<name>` object key in the config (e.g. `agent` or `agents`). */
  mapKey: "agent" | "agents"
  /** The prompt field that was updated (`prompt` or `prompt_append`). */
  promptField: "prompt" | "prompt_append"
  /** New value of the field after appending. */
  newValue: string
}

/**
 * Append a block of text to the `prompt_append` (or `prompt`) field of a
 * plugin override. Idempotent: if the exact block is already present
 * (case-insensitive, whitespace-normalised) the file is left untouched and
 * `applied: false` is returned via `newValue` matching the previous value.
 *
 * Walks the config object looking for the first `agent` or `agents` map
 * that contains the agent name with the requested field. The map key
 * discovered during the write is returned so the caller can keep the
 * resolver and the writer in sync.
 */
export async function appendToPluginOverridePrompt(
  source: Extract<AgentPromptSource, { kind: "plugin_override" }>,
  content: string,
): Promise<PluginOverrideAppendResult> {
  const trimmed = content.trim()
  if (!trimmed) {
    return {
      configPath: source.configPath,
      mapKey: "agent",
      promptField: source.promptField,
      newValue: source.value ?? "",
    }
  }
  const original = await readFile(source.configPath, "utf-8")
  // Find which top-level map the agent lives in. The resolver already
  // prefers `agent`, but we re-scan to be robust to the value being
  // present under either key in the same file.
  const parsed = await (async () => {
    const { parse } = await import("jsonc-parser")
    const errors: Array<{ error: number; offset: number; length: number }> = []
    return parse(original, errors, {
      allowTrailingComma: true,
      disallowComments: false,
      allowEmptyContent: false,
    })
  })()
  const raw = (parsed && typeof parsed === "object" ? parsed : {}) as Record<
    string,
    unknown
  >

  // Resolve the agent name by scanning both top-level maps for an entry
  // whose `prompt` or `prompt_append` matches `source.value`. The agent
  // name is not carried on the source object itself.
  let mapKey: "agent" | "agents" = "agent"
  let agentName: string | undefined
  for (const key of ["agent", "agents"] as const) {
    const m = raw[key]
    if (!m || typeof m !== "object" || Array.isArray(m)) continue
    for (const [name, entry] of Object.entries(m as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue
      const e = entry as Record<string, unknown>
      if (
        typeof e[source.promptField] === "string" &&
        e[source.promptField] === source.value
      ) {
        agentName = name
        mapKey = key
        break
      }
    }
    if (agentName) break
  }
  if (!agentName) {
    throw new Error(
      `appendToPluginOverridePrompt: could not locate agent entry in ${source.configPath}`,
    )
  }

  // Idempotency check: case-insensitive, whitespace-normalised.
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim()
  if (norm(source.value ?? "").includes(norm(trimmed))) {
    return {
      configPath: source.configPath,
      mapKey,
      promptField: source.promptField,
      newValue: source.value ?? "",
    }
  }

  const newValue = source.value
    ? `${source.value.trimEnd()}\n\n${trimmed}\n`
    : `${trimmed}\n`

  const modOptions: ModificationOptions = {
    formattingOptions: {
      insertSpaces: true,
      tabSize: 2,
    },
  }
  const edits = modify(
    original,
    [mapKey, agentName, source.promptField],
    newValue,
    modOptions,
  )
  const updated = applyEdits(original, edits)
  if (updated !== original) {
    await writeTextAtomic(source.configPath, updated)
  }
  return {
    configPath: source.configPath,
    mapKey,
    promptField: source.promptField,
    newValue,
  }
}

/**
 * Materialize a `plugin_override` (config target) into a real file. Creates
 * `<projectRoot>/.opencode/agents/<name>.md` with the current override value
 * and rewrites the config so the field becomes a `{file:...}` directive
 * pointing at the new file. Returns the path of the new file and the
 * absolute path to the config entry (so the caller can update its cache).
 */
export async function materializePluginOverrideToFile(
  agentName: string,
  source: Extract<AgentPromptSource, { kind: "plugin_override" }>,
  projectRoot: string,
  options: { mode?: "primary" | "subagent" } = {},
): Promise<MaterializeResult> {
  const filePath = defaultAgentFilePath(projectRoot, agentName)
  const mode = options.mode ?? "subagent"

  let fileCreated = false
  if (!(await fileExists(filePath))) {
    const frontmatter = `---\nmode: ${mode}\n---\n\n`
    const body = `${(source.value ?? "").trimEnd()}\n`
    await writeTextAtomic(filePath, frontmatter + body)
    fileCreated = true
  }

  const configPath = source.configPath
  const configDir = dirname(configPath)
  const relPath = isAbsolute(filePath)
    ? relative(configDir, filePath) || filePath
    : filePath
  const newPromptValue = `{file:${relPath}}`

  const original = await readFile(configPath, "utf-8")
  const { parse } = await import("jsonc-parser")
  const errors: Array<{ error: number; offset: number; length: number }> = []
  const parsed = parse(original, errors, {
    allowTrailingComma: true,
    disallowComments: false,
    allowEmptyContent: false,
  })
  const raw = (parsed && typeof parsed === "object" ? parsed : {}) as Record<
    string,
    unknown
  >
  let mapKey: "agent" | "agents" = "agent"
  // Discover the map key by scanning for the agent's entry.
  for (const key of ["agent", "agents"] as const) {
    const m = raw[key]
    if (m && typeof m === "object" && !Array.isArray(m)) {
      if ((m as Record<string, unknown>)[agentName]) {
        mapKey = key
        break
      }
    }
  }
  const modOptions: ModificationOptions = {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  }
  const edits = modify(
    original,
    [mapKey, agentName, source.promptField],
    newPromptValue,
    modOptions,
  )
  const updated = applyEdits(original, edits)
  const configModified = updated !== original
  if (configModified) {
    await writeTextAtomic(configPath, updated)
  }
  return { filePath, configPath, fileCreated, configModified }
}

/**
 * Materialize an inline prompt to a file. Writes the body to
 * `<projectRoot>/.opencode/agents/<name>.md`, then replaces the inline
 * `prompt` field in the source opencode.json with a `{file:...}` directive
 * pointing at the new file. Both files are written atomically; the source
 * config is rewritten via jsonc-parser so comments and formatting survive.
 */
export interface MaterializeResult {
  filePath: string
  configPath: string
  fileCreated: boolean
  configModified: boolean
}

export async function materializeInlinePrompt(
  agentName: string,
  projectRoot: string,
  globalOpencodeDir?: string,
  options: { mode?: "primary" | "subagent" } = {},
): Promise<MaterializeResult> {
  const source = await resolveAgentPromptSource(
    agentName,
    projectRoot,
    globalOpencodeDir,
  )
  if (source.kind !== "inline") {
    throw new Error(
      `Agent "${agentName}" prompt is not inline (source: ${source.kind}); nothing to materialize.`,
    )
  }

  const filePath = defaultAgentFilePath(projectRoot, agentName)
  const mode = options.mode ?? "subagent"

  // Build the file body. If the file already exists (rare — would mean
  // inline and file both defined), preserve the existing body and only
  // touch the config.
  let fileCreated = false
  if (!(await fileExists(filePath))) {
    const frontmatter = `---\nmode: ${mode}\n---\n\n`
    const body = `${source.prompt.trimEnd()}\n`
    await writeTextAtomic(filePath, frontmatter + body)
    fileCreated = true
  }

  // Rewrite the config: replace `prompt` with `{file:...}` pointing at the
  // new file. Use a path relative to the config file's directory so the
  // rewrite is portable.
  const configPath = source.configPath
  const configDir = dirname(configPath)
  let relPath: string
  if (isAbsolute(filePath)) {
    relPath = relative(configDir, filePath) || filePath
  } else {
    relPath = filePath
  }
  const newPromptValue = `{file:${relPath}}`

  const original = await readFile(configPath, "utf-8")
  const modOptions: ModificationOptions = {
    formattingOptions: {
      insertSpaces: true,
      tabSize: 2,
    },
  }
  const edits = modify(
    original,
    ["agent", agentName, "prompt"],
    newPromptValue,
    modOptions,
  )
  const updated = applyEdits(original, edits)
  const configModified = updated !== original
  if (configModified) {
    await writeTextAtomic(configPath, updated)
  }

  return { filePath, configPath, fileCreated, configModified }
}
