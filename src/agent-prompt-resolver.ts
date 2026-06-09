import { readFile, stat } from "node:fs/promises"
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

function sanitizeName(name: string): string {
  // Mirror the existing sanitization in agent-prompts.ts
  return name.replace(/[\\/]/g, "_")
}

/**
 * Resolve where an agent's prompt actually lives. Project opencode.json takes
 * precedence over global. If the agent's `prompt` is a `{file:...}` or
 * `{path:...}` directive, return that file path. If it's a raw string,
 * return inline. Otherwise fall back to the conventional file locations.
 */
export async function resolveAgentPromptSource(
  agentName: string,
  projectRoot: string,
  globalOpencodeDir?: string,
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
