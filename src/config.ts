import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { parse } from "jsonc-parser"
import { z } from "zod"
import type { KasperConfig } from "./types.js"
import { DEFAULT_CONFIG } from "./types.js"

const CONFIG_FILE_CANDIDATES = ["kasper.jsonc", "kasper.json"] as const

const clamp = (min: number, max: number) => (n: number) =>
  Math.max(min, Math.min(max, n))

const numField = (min: number, max: number) =>
  z.coerce.number().transform(clamp(min, max))

const intField = (min: number, max: number) =>
  z.coerce.number().transform((n) => Math.trunc(clamp(min, max)(n)))

const boolLike = () =>
  z.union([
    z.boolean(),
    z.string().transform((s) => s.toLowerCase() === "true"),
  ])

const KasperConfigSchema = z.object({
  enabled: boolLike(),
  auto_update: boolLike(),
  scoring_threshold: numField(0, 1),
  model: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1)),
  weakness_decay_days: intField(0, 365),
  detail_level: z.enum(["minimal", "standard", "thorough"]).default("standard"),
  quiet: boolLike(),
  evaluate_subagents: boolLike(),
  min_session_messages: intField(1, 50),
  debug: boolLike(),
  state_dir: z.string().transform((s) => s.trim()),
  evaluation_poll_interval_ms: intField(1000, 300000),
  scoring_retries: intField(0, 10),
  scoring_timeout_ms: intField(10000, 600000),
  max_score_input_chars: intField(1000, 50000),
})

const fieldValidators = KasperConfigSchema.shape

export function normalizeKasperConfig(
  raw: Record<string, unknown>,
): Partial<KasperConfig> {
  const result: Record<string, unknown> = {}

  for (const [key, schema] of Object.entries(fieldValidators)) {
    if (raw[key] !== undefined) {
      const parsed = schema.safeParse(raw[key])
      if (parsed.success) {
        result[key] = parsed.data
      } else {
        process.stderr.write(
          `[kasper] Config validation warning: "${key}" = ${JSON.stringify(raw[key])} is invalid — using default. ${parsed.error.issues.map((i) => i.message).join("; ")}\n`,
        )
      }
    }
  }

  return result as Partial<KasperConfig>
}

async function loadConfigFromPath(
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
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

async function findFirstExistingConfig(
  baseDir: string,
): Promise<Record<string, unknown> | undefined> {
  for (const fileName of CONFIG_FILE_CANDIDATES) {
    const fullPath = join(baseDir, fileName)
    const parsed = await loadConfigFromPath(fullPath)
    if (parsed) return parsed
  }
  return undefined
}

function candidateGlobalConfigDirs(): string[] {
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

export function resolveGlobalOpencodeDir(): string {
  return candidateGlobalConfigDirs()[0]
}

async function findOpencodeDir(startDir: string): Promise<string | undefined> {
  let current = startDir
  while (true) {
    const candidate = join(current, ".opencode")
    try {
      const info = await stat(candidate)
      if (info.isDirectory()) return candidate
    } catch {
      /* no .opencode here */
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

async function resolveProjectOpencodeDir(baseDir?: string): Promise<string> {
  const cwd = baseDir || process.cwd()
  if (cwd.endsWith(".opencode")) return cwd
  const found = await findOpencodeDir(cwd)
  if (found) return found
  return join(cwd, ".opencode")
}

const cachedConfigs = new Map<string, { config: KasperConfig; ts: number }>()
const CONFIG_CACHE_TTL_MS = 30000

export async function loadKasperConfig(
  directory?: string,
  force = false,
): Promise<KasperConfig> {
  const cacheKey = directory || "default"
  const cached = cachedConfigs.get(cacheKey)
  if (!force && cached && Date.now() - cached.ts < CONFIG_CACHE_TTL_MS) {
    return cached.config
  }

  let merged: Record<string, unknown> = {}

  for (const globalBaseDir of candidateGlobalConfigDirs()) {
    const globalConfig = await findFirstExistingConfig(globalBaseDir)
    if (globalConfig) merged = { ...merged, ...globalConfig }
  }

  const opencodeConfigDir = process.env.OPENCODE_CONFIG_DIR
  if (opencodeConfigDir) {
    const envConfig = await findFirstExistingConfig(opencodeConfigDir)
    if (envConfig) merged = { ...merged, ...envConfig }
  }

  const projectOpencodeDir = await resolveProjectOpencodeDir(directory)
  const projectConfig = await findFirstExistingConfig(projectOpencodeDir)
  if (projectConfig) merged = { ...merged, ...projectConfig }

  if (directory) {
    const opencodeJsonPath = join(directory, "opencode.json")
    const opencodeJson = await loadConfigFromPath(opencodeJsonPath)
    if (opencodeJson?.kasper && typeof opencodeJson.kasper === "object") {
      merged = {
        ...merged,
        ...(opencodeJson.kasper as Record<string, unknown>),
      }
    }
  }

  const normalized = normalizeKasperConfig(merged)
  const config = { ...DEFAULT_CONFIG, ...normalized }
  cachedConfigs.set(cacheKey, { config, ts: Date.now() })
  return config
}

export async function ensureDefaultKasperConfigFile(
  configDir: string,
): Promise<void> {
  for (const fileName of CONFIG_FILE_CANDIDATES) {
    const fullPath = join(configDir, fileName)
    try {
      const info = await stat(fullPath)
      if (info.isFile()) return
    } catch {
      /* file doesn't exist */
    }
  }

  const defaultContent = `{
  // Enable/disable the kasper plugin without uninstalling
  "enabled": true,

  // Automatically apply improvements to AGENTS.md and agent prompts
  // Set to false to manually approve each change via /kasper improve
  "auto_update": true,

  // Score threshold (0.0–1.0). Sessions scoring below this trigger
  // weakness detection and improvement suggestions.
  "scoring_threshold": 0.6,

  // Scoring model — "provider/model-id". Pick a fast/cheap model.
  // Examples: "opencode/deepseek-v4-flash-free", "opencode/minimax-m2.5-free"
  "model": "opencode/deepseek-v4-flash-free",

  // Scoring detail level: "minimal" (cheaper), "standard", "thorough" (better)
  "detail_level": "standard",

  // How fast old weaknesses fade (days). 0 = no decay.
  "weakness_decay_days": 30,

  // Suppress non-warning toast notifications to reduce noise
  "quiet": false,

  // Polling interval for automatic session evaluation (milliseconds)
  "evaluation_poll_interval_ms": 10000,

  // Retries when the scoring model returns invalid JSON (0–10)
  "scoring_retries": 2,

  // Timeout for each scoring attempt (milliseconds)
  "scoring_timeout_ms": 120000,

  // Maximum input characters sent to the scoring model per session
  "max_score_input_chars": 10000
}
`

  await mkdir(configDir, { recursive: true })
  await writeFile(join(configDir, "kasper.jsonc"), defaultContent, "utf-8")
}
