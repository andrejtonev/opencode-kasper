import { readdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parse } from "jsonc-parser"
import { migrateInstructionSource } from "./instruction-migration.js"
import {
  commitInstructionUpdate,
  InstructionConflictError,
  instructionJsonValue,
  parseInstructionJson,
  replaceInstructionJson,
} from "./instruction-transaction.js"
import {
  candidateGlobalOpencodeDirs,
  dirExists,
  expandTilde,
  fileExists,
} from "./path-utils.js"

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
      jsonPath?: readonly string[]
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
      jsonPath?: readonly string[]
      /**
       * The agent name this override belongs to. The resolver fills this
       * in from the JSON map key it was found under. Writers MUST use it
       * (not a value-based scan) to locate the entry — see B1 regression
       * for why a value-based scan modifies the wrong agent when two
       * agents share the same prompt text.
       */
      agentName: string
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

function resolveDirectivePath(raw: string, baseDir: string): string {
  const expanded = expandTilde(raw.trim())
  if (isAbsolute(expanded)) return expanded
  return join(baseDir, expanded)
}

async function loadJsoncIfExists(
  path: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await readFile(path, "utf-8")
    if (!raw.trim()) return undefined
    const errors: Array<{ error: number; offset: number; length: number }> = []
    const parsed = parse(raw, errors, {
      allowTrailingComma: true,
      disallowComments: false,
      allowEmptyContent: false,
    })
    if (errors.length)
      throw new InstructionConflictError(`invalid JSONC in ${path}`)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return undefined
    return parsed as Record<string, unknown>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

/**
 * Resolve a `agent.<name>` entry from a raw config object, returning both
 * the entry and the canonical config key it was found under. When the
 * caller passes a display name (e.g. "Sisyphus - ultraworker"), this
 * returns the matched key (e.g. "sisyphus") so the caller can use the
 * canonical name in subsequent operations (file paths, override sources).
 *
 * The match logic is delegated to `lookupAgentEntryWithFallback` — see
 * that function's comment for the display-name fallback rules and the
 * rationale for the space-after-key requirement.
 */
function getAgentEntryAndKey(
  raw: Record<string, unknown> | undefined,
  name: string,
): { entry: Record<string, unknown>; key: string } | undefined {
  if (!raw) return undefined
  const agent = raw.agent
  if (!agent || typeof agent !== "object" || Array.isArray(agent))
    return undefined
  return lookupAgentEntryWithFallback(agent as Record<string, unknown>, name)
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
 * Returns the first hit with the field name and the map key the entry was
 * found under, or undefined. `mapKey` is returned alongside so the writer
 * can rebuild the correct JSON path (we must not infer the map from a value
 * scan — see B1).
 */
function readPluginOverrideEntry(
  raw: Record<string, unknown> | undefined,
  agentName: string,
):
  | {
      entry: Record<string, unknown>
      promptField: "prompt" | "prompt_append"
      mapKey: "agent" | "agents"
      /** The canonical config key the entry was found under. */
      key: string
    }
  | undefined {
  if (!raw) return undefined
  // Prefer the standard `agent` map (opencode.json + most plugins).
  for (const key of ["agent", "agents"] as const) {
    const map = raw[key]
    if (!map || typeof map !== "object" || Array.isArray(map)) continue
    const hit = lookupAgentEntryWithFallback(
      map as Record<string, unknown>,
      agentName,
    )
    if (!hit) continue
    const { entry, key: actualKey } = hit
    if (!entry || !actualKey) continue
    if (
      typeof entry.prompt_append === "string" &&
      entry.prompt_append.length > 0
    ) {
      return {
        entry,
        promptField: "prompt_append",
        mapKey: key,
        key: actualKey,
      }
    }
    if (typeof entry.prompt === "string" && entry.prompt.length > 0) {
      return { entry, promptField: "prompt", mapKey: key, key: actualKey }
    }
  }
  return undefined
}

/**
 * Like {@link getAgentEntry} but for an already-extracted `agent`/`agents`
 * map value (no raw-config wrapper). Returns the entry AND the canonical
 * key it was found under, so callers can use the canonical key for
 * subsequent JSON-path operations (jsonc modify, etc.).
 */
function lookupAgentEntryWithFallback(
  map: Record<string, unknown>,
  name: string,
): { entry: Record<string, unknown>; key: string } | undefined {
  // Exact match first.
  const exact = map[name]
  if (exact && typeof exact === "object" && !Array.isArray(exact))
    return { entry: exact as Record<string, unknown>, key: name }
  // Display-name fallback (see getAgentEntry comment). The convention
  // for plugin display names is "<key> - <descriptor>" (e.g. omo's
  // AGENT_DISPLAY_NAMES maps `sisyphus` → "Sisyphus - ultraworker"), so
  // we require a SPACE (or end-of-string) immediately after the matched
  // key. We deliberately do NOT match on a hyphen alone, because a
  // hyphen-separated suffix is a common pattern for unrelated agent
  // names (e.g. a test creating `code-quality-0b16404e` would otherwise
  // false-positive against a global `code-quality` agent and silently
  // route the improvement to the wrong file). The exact-match and
  // case-insensitive paths above cover the no-separator cases.
  const lowerName = name.toLowerCase()
  let best: { key: string; len: number } | undefined
  for (const key of Object.keys(map)) {
    if (key.toLowerCase() === lowerName) {
      best = { key, len: key.length }
      break
    }
    const lowerKey = key.toLowerCase()
    if (lowerName.length > lowerKey.length && lowerName.startsWith(lowerKey)) {
      const next = lowerName[lowerKey.length]
      if (next === " " || next === undefined) {
        if (!best || key.length > best.len) best = { key, len: key.length }
      }
    }
  }
  if (!best) return undefined
  const entry = map[best.key]
  if (!entry || typeof entry !== "object" || Array.isArray(entry))
    return undefined
  return { entry: entry as Record<string, unknown>, key: best.key }
}

/**
 * Classify a `prompt` or `prompt_append` string into one of the three
 * `plugin_override.target` shapes and produce a complete source object.
 * `agentName` is the JSON map key the override lives under and MUST be
 * propagated to the source so writers can locate the entry by name (not
 * by scanning for an identical value, which is unsafe — see B1).
 */
function buildPluginOverride(
  agentName: string,
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
      agentName,
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
  //
  // Cross-platform: a `file:` URI is properly parsed via WHATWG URL. On
  // Linux/macOS, `file:///abs/path` has three slashes (host="") and the
  // pathname is the absolute path. On Windows, `file:///C:/path` has the
  // drive letter as the first path segment; `fileURLToPath` handles the
  // drive-letter round-trip correctly. We deliberately do NOT do
  // `value.startsWith("file://")` + `match(/^file:\/\/(.+)$/)` because
  // that breaks on Windows paths like `file://C:\Users\foo\x.md`
  // (only two slashes, backslashes — a malformed URI that
  // `new URL()` rejects, and that the manual `startsWith("/")` /
  // `startsWith("~/")` / `startsWith("./")` ladder misclassifies).
  if (value.startsWith("file://") || value.startsWith("file:///")) {
    // Form A: `file://./...` and `file://../...` — relative to the
    // config file's directory. The host is empty; the pathname is the
    // raw `./...` or `../...` string. Detect this case BEFORE trying
    // `new URL()`, which would otherwise resolve `./` against the
    // current working directory on some platforms.
    const relMatch = value.match(/^file:\/\/(\.\.?\/.*)$/)
    if (relMatch) {
      return {
        kind: "plugin_override",
        agentName,
        target: "file_uri",
        path: join(dirname(configPath), relMatch[1]),
        configPath,
        promptField,
        isAppend,
      }
    }

    // Form B: `file://~/...` — tilde is a convention, not a URL standard.
    // Handle it explicitly so the resolver doesn't reject it on platforms
    // where `~` would not round-trip through `fileURLToPath`.
    if (value.startsWith("file://~/")) {
      return {
        kind: "plugin_override",
        agentName,
        target: "file_uri",
        path: join(homedir(), value.slice("file://~/".length)),
        configPath,
        promptField,
        isAppend,
      }
    }

    // Form C: a real file URI. `new URL()` accepts both `file:///abs/path`
    // (three slashes, host="") on POSIX and `file:///C:/path` on Windows.
    // We require three slashes so we don't accidentally classify a
    // user-supplied value like `file://example.com/foo` (a host-based
    // URI with no path) as a local file reference.
    let parsedUrl: URL
    try {
      parsedUrl = new URL(value)
    } catch {
      // Malformed URI — degrade to config-raw to avoid a bad path.
      return {
        kind: "plugin_override",
        agentName,
        target: "config",
        value,
        configPath,
        promptField,
        isAppend,
      }
    }
    if (parsedUrl.protocol === "file:") {
      let absPath: string
      try {
        absPath = fileURLToPath(parsedUrl)
      } catch {
        return {
          kind: "plugin_override",
          agentName,
          target: "config",
          value,
          configPath,
          promptField,
          isAppend,
        }
      }
      return {
        kind: "plugin_override",
        agentName,
        target: "file_uri",
        path: absPath,
        configPath,
        promptField,
        isAppend,
      }
    }
    // Some other scheme we don't recognise — degrade to config-raw.
    return {
      kind: "plugin_override",
      agentName,
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
    agentName,
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
 *
 * Use `basename()` from node:path, not a hand-rolled `split("/")` — on
 * Windows the path uses `\` as the separator, so the manual split would
 * fail to isolate the filename and the skip would never fire (B2).
 */
async function findOverrideInDir(
  dir: string,
  agentName: string,
): Promise<AgentPromptSource | undefined> {
  const files = await listOpencodeJsonFiles(dir)
  for (const file of files) {
    const base = basename(file)
    if (base === "opencode.json" || base === "opencode.jsonc") continue
    const raw = await loadJsoncIfExists(file)
    const hit = readPluginOverrideEntry(raw, agentName)
    if (hit) {
      const source = buildPluginOverride(
        // Use the canonical key the entry was found under, NOT the
        // display name the caller passed. Subsequent code in
        // appendToPluginOverridePrompt uses this name in a jsonc
        // modify() path — passing the display name would write to
        // a non-existent key, leaving the actual agent entry untouched.
        hit.key,
        hit.entry[hit.promptField] as string,
        hit.promptField,
        file,
      )
      return source.kind === "plugin_override"
        ? { ...source, jsonPath: [hit.mapKey, hit.key, hit.promptField] }
        : source
    }
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
  const projectHit = getAgentEntryAndKey(projectConfig?.raw, agentName)
  const globalHit = getAgentEntryAndKey(globalConfig?.raw, agentName)
  const entry = projectHit?.entry ?? globalHit?.entry
  const entryConfig = projectHit
    ? projectConfig
    : globalHit
      ? globalConfig
      : undefined
  // If the agentName passed in is a display name (e.g. "Sisyphus -
  // ultraworker") and the config defines the agent under the canonical key
  // (e.g. "sisyphus"), the helpers above resolve to the canonical key.
  // Subsequent fallbacks (file paths, plugin_override scan) need the
  // canonical name to find on-disk artefacts keyed by the config key.
  const effectiveName = projectHit?.key ?? globalHit?.key ?? agentName

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
        return {
          kind: "inline",
          prompt,
          configPath: entryConfig.path,
          jsonPath: ["agent", effectiveName, "prompt"],
        }
      }
    }
  }

  // Fall back to conventional file locations
  for (const p of projectAgentDirCandidates(projectRoot, effectiveName)) {
    if (await fileExists(p)) return { kind: "project_file", path: p }
  }
  for (const p of globalAgentDirCandidates(globalOpencodeDir, effectiveName)) {
    if (await fileExists(p)) return { kind: "global_file", path: p }
  }

  // Plugin override scan: some plugins (e.g. oh-my-opencode) ship agent
  // prompts inside node_modules and let users override them via
  // `agent.<name>.prompt` or `agent.<name>.prompt_append` in a non-opencode
  // config file under `.opencode/`. We scan every `.opencode/*.json[c]` for
  // any top-level `agent` or `agents` map with a `prompt`/`prompt_append`
  // field for this agent, and surface it as a `plugin_override` source.
  const pluginOverride = await findPluginConfigOverride(
    effectiveName,
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
    effectiveName,
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
  /** The agent name (map key) that was updated. */
  agentName: string
  /** New value of the field after appending. */
  newValue: string
  backupPath?: string
}

/**
 * Append a block of text to the `prompt_append` (or `prompt`) field of a
 * plugin override. Idempotent: if the exact block is already present
 * (case-insensitive, whitespace-normalised) the file is left untouched and
 * `applied: false` is returned via `newValue` matching the previous value.
 *
 * Locates the target entry by `source.agentName` + `source.promptField`,
 * NOT by scanning for an identical `value` (which was the B1 bug — when
 * two agents in the same file share the same prompt text, the first one
 * in insertion order would win and the wrong agent would be edited).
 *
 * The `mapKey` (whether the entry lives under `agent` or `agents`) is
 * discovered by scanning the parsed object for the named entry, but the
 * agent name is fixed by `source.agentName` — never inferred from values.
 */
export async function appendToPluginOverridePrompt(
  source: Extract<AgentPromptSource, { kind: "plugin_override" }>,
  content: string,
  backupDir?: string,
  assertCurrent?: () => void,
): Promise<PluginOverrideAppendResult> {
  let mapKey: "agent" | "agents" = "agent"
  let newValue = ""
  const result = await commitInstructionUpdate(
    { path: source.configPath, jsonPath: source.jsonPath },
    (original, target) => {
      const raw = parseInstructionJson(original)
      const maps = (["agent", "agents"] as const).filter(
        (key) =>
          typeof instructionJsonValue(raw, [
            key,
            source.agentName,
            source.promptField,
          ]) === "string",
      )
      if (source.jsonPath) {
        mapKey = source.jsonPath[0] as "agent" | "agents"
        if (!maps.includes(mapKey))
          throw new InstructionConflictError(
            "resolved override field was removed or changed type",
          )
      } else {
        if (maps.length !== 1)
          throw new InstructionConflictError(
            "override source is missing or ambiguous",
          )
        mapKey = maps[0]
      }
      target.jsonPath = [mapKey, source.agentName, source.promptField]
      const current = instructionJsonValue(raw, target.jsonPath) as string
      if (
        /^\s*\{(?:file|path):/.test(current) ||
        current.startsWith("file://")
      ) {
        throw new InstructionConflictError(
          "override changed to a file reference; resolve its source again",
        )
      }
      const norm = (text: string) =>
        text.toLowerCase().replace(/\s+/g, " ").trim()
      const trimmed = content.trim()
      newValue = current
      if (
        trimmed &&
        !current
          .split(/\n\s*\n+/)
          .map(norm)
          .includes(norm(trimmed))
      ) {
        newValue = current
          ? `${current.trimEnd()}\n\n${trimmed}\n`
          : `${trimmed}\n`
      }
      return replaceInstructionJson(original, target.jsonPath, newValue)
    },
    { backupDir, assertCurrent },
  )
  return {
    configPath: source.configPath,
    mapKey,
    promptField: source.promptField,
    agentName: source.agentName,
    newValue,
    backupPath: result.backupPath,
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
  options: { mode?: "primary" | "subagent"; assertCurrent?: () => void } = {},
): Promise<MaterializeResult> {
  if (source.target !== "config")
    throw new InstructionConflictError("source is already file-backed")
  return migrateInstructionSource(
    source.configPath,
    source.jsonPath,
    source.agentName,
    source.promptField,
    source.value ?? "",
    defaultAgentFilePath(projectRoot, agentName),
    projectRoot,
    options.mode ?? "subagent",
    options.assertCurrent,
  )
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
  options: { mode?: "primary" | "subagent"; assertCurrent?: () => void } = {},
): Promise<MaterializeResult> {
  const source = await resolveAgentPromptSource(
    agentName,
    projectRoot,
    globalOpencodeDir,
  )
  if (source.kind !== "inline")
    throw new Error(
      `Agent "${agentName}" prompt is not inline (source: ${source.kind}); nothing to materialize.`,
    )
  return migrateInstructionSource(
    source.configPath,
    source.jsonPath,
    agentName,
    "prompt",
    source.prompt,
    defaultAgentFilePath(projectRoot, agentName),
    projectRoot,
    options.mode ?? "subagent",
    options.assertCurrent,
  )
}
