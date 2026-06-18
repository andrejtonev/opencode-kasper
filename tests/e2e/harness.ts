import {
  type ChildProcess,
  execSync,
  spawn,
  spawnSync,
} from "node:child_process"
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// ── Types ───────────────────────────────────────────────────────────────

export interface OpencodeEvent {
  type: string
  timestamp: number
  part?: {
    type?: string
    tool?: string
    text?: string
    callID?: string
    state?: {
      status?: string
      input?: Record<string, unknown>
      output?: string
    }
    [key: string]: unknown
  }
}

export interface RunResult {
  sessionID: string
  events: OpencodeEvent[]
  raw: string
  exitCode: number | null
}

export interface E2EProject {
  dir: string
}

// ── Config ──────────────────────────────────────────────────────────────

const PLUGIN_DIR = join(
  process.env.HOME ?? "/home/user",
  ".config",
  "opencode",
  "plugins",
)
const PLUGIN_ENABLED_PATH = join(PLUGIN_DIR, "opencode-kasper.ts")
const PLUGIN_DISABLED_PATH = join(PLUGIN_DIR, "opencode-kasper.ts.disabled")

const DEFAULT_OPENCODE_CONFIG: Record<string, unknown> = {
  // The kasper plugin is loaded from the global plugins directory
  // (~/.config/opencode/plugins/opencode-kasper.ts). Each e2e test is
  // responsible for calling enableKasperPlugin() in beforeAll and
  // disableKasperPlugin() in afterAll so we don't clobber a developer's
  // local plugin state. See enableKasperPlugin in this file for details.
}

// Auth credentials for opencode serve (opencode >=1.15.x requires HTTP Basic
// Auth on all API endpoints). Read from environment — never hardcode real
// credentials in source. The spawned serve process inherits these from env;
// the curl-based health-check helpers use them for the Authorization header.
const _SERVER_USER = process.env.OPENCODE_SERVER_USERNAME ?? ""
const _SERVER_PASS = process.env.OPENCODE_SERVER_PASSWORD ?? ""

const RUN_TIMEOUT_MS = process.env.KASPER_E2E_TIMEOUT
  ? parseInt(process.env.KASPER_E2E_TIMEOUT, 10)
  : 180_000

const SERVE_PORT = 18799

// ── Skip condition ──────────────────────────────────────────────────────

export function isOpenCodeAvailable(): boolean {
  try {
    execSync("opencode --version", { stdio: "pipe" })
    return true
  } catch {
    return false
  }
}

export function shouldRunE2E(): boolean {
  if (process.env.OPENCODE_E2E !== "1") return false
  return isOpenCodeAvailable()
}

// ── Project setup / cleanup ────────────────────────────────────────────

export function setupE2EProject(): E2EProject {
  const dir = mkdtempSync(join(tmpdir(), "kasper-e2e-"))
  writeFileSync(
    join(dir, "opencode.json"),
    JSON.stringify(DEFAULT_OPENCODE_CONFIG, null, 2),
    "utf-8",
  )
  return { dir }
}

export function cleanupE2EProject(dir: string): void {
  // Diagnostic hook: keep the project dir on disk so callers can
  // inspect .opencode/oh-my-opencode.json, the kasper state, and
  // any other durable artifacts the test produced. Default is still
  // to clean up.
  if (process.env.KASPER_E2E_KEEP_TMP === "1") {
    // biome-ignore lint/suspicious/noConsole: diagnostic
    console.log(`(info) KASPER_E2E_KEEP_TMP=1 — leaving ${dir} on disk`)
    return
  }
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // best-effort
  }
}

// ── Plugin toggle (Kasper plugin symlink) ───────────────────────────────
//
// The kasper plugin lives at ~/.config/opencode/plugins/opencode-kasper.ts
// (a symlink to src/index.ts). The convention in this repo is to keep the
// plugin .ts.disabled (skip loading) by default; e2e tests that need the
// plugin loaded call `enableKasperPlugin()` in beforeAll and
// `disableKasperPlugin()` in afterAll. We do NOT touch this when the env
// var KASPER_E2E_LEAVE_PLUGIN_ENABLED=1 is set, in case a developer has
// already enabled the plugin and wants their state preserved.
//
// Why this is needed: opencode's plugin loader SKIPS files with the
// .disabled suffix. If the plugin stays .disabled, `opencode serve` runs
// without kasper loaded, every kasper-driven assertion is moot, and
// `waitForScoredSessions` times out — historically the e2e suite masked
// this with `if (!state) return` paths that silently passed. With these
// helpers, the test can detect the missing-plugin case at beforeAll time
// and fail loudly.

const _pluginToggleStack: Array<"enabled" | "disabled"> = []

export function isKasperPluginEnabled(): boolean {
  return existsSync(PLUGIN_ENABLED_PATH)
}

export function isKasperPluginDisabled(): boolean {
  return existsSync(PLUGIN_DISABLED_PATH)
}

export function enableKasperPlugin(): void {
  if (existsSync(PLUGIN_ENABLED_PATH)) {
    _pluginToggleStack.push("enabled")
    return
  }
  if (!existsSync(PLUGIN_DISABLED_PATH)) {
    throw new Error(
      `Kasper plugin not found at ${PLUGIN_DISABLED_PATH}. ` +
        `Expected a symlink to src/index.ts. Did the install step run?`,
    )
  }
  renameSync(PLUGIN_DISABLED_PATH, PLUGIN_ENABLED_PATH)
  _pluginToggleStack.push("disabled")
}

export function disableKasperPlugin(): void {
  if (existsSync(PLUGIN_DISABLED_PATH)) {
    _pluginToggleStack.push("enabled")
    return
  }
  if (!existsSync(PLUGIN_ENABLED_PATH)) {
    // already gone
    _pluginToggleStack.push("disabled")
    return
  }
  if (process.env.KASPER_E2E_LEAVE_PLUGIN_ENABLED === "1") {
    // Developer opted in to leaving the plugin enabled across test runs.
    _pluginToggleStack.push("enabled")
    return
  }
  renameSync(PLUGIN_ENABLED_PATH, PLUGIN_DISABLED_PATH)
  _pluginToggleStack.push("enabled")
}

// Pop the toggle stack — call in afterAll to restore original state.
export function restoreKasperPlugin(): void {
  const last = _pluginToggleStack.pop()
  if (last === undefined) return
  if (last === "enabled" && existsSync(PLUGIN_ENABLED_PATH)) {
    if (process.env.KASPER_E2E_LEAVE_PLUGIN_ENABLED === "1") return
    if (!existsSync(PLUGIN_DISABLED_PATH)) {
      renameSync(PLUGIN_ENABLED_PATH, PLUGIN_DISABLED_PATH)
    }
  }
  // If last === "disabled" we previously enabled and the afterAll caller
  // is responsible for the matching disable; this is a no-op here.
}

/**
 * Poll for evidence that kasper actually loaded inside the opencode
 * serve. The .opencode/kasper/state.json file is created on plugin init
 * (src/index.ts:321 — `new KasperStateStore` followed by `stateStore.init()`).
 * If the plugin is .disabled, this file is NEVER created, so the timeout
 * is the real "plugin not loaded" signal.
 *
 * Returns the absolute path of the state file, or throws on timeout.
 */
export async function waitForKasperLoaded(
  projectDir: string,
  opts?: { maxWaitMs?: number; pollMs?: number; port?: number },
): Promise<string> {
  const maxWaitMs = opts?.maxWaitMs ?? 30_000
  const pollMs = opts?.pollMs ?? 500
  const statePath = join(projectDir, ".opencode", "kasper", "state.json")
  const port = opts?.port ?? SERVE_PORT
  // Warm up the per-project instance: in opencode >=1.15.13, the `serve`
  // command (instance: false) does not load plugins at startup. Plugins are
  // only loaded when a per-project InstanceContext is created, which happens
  // when a request with `x-opencode-directory: <dir>` reaches the server —
  // i.e. when `opencode run --attach --dir <dir>` runs a session.
  // We send a trivial attach-driven session so the serve instantiates the
  // project and the global `~/.config/opencode/plugins/` symlink is resolved.
  // (The reply contents don't matter; we only need the request to land.)
  if (isServeRunning(port)) {
    spawnSync(
      "opencode",
      [
        "run",
        "--attach",
        `http://localhost:${port}`,
        "--format",
        "json",
        "--model",
        KASPER_E2E_MODEL,
        "--dir",
        projectDir,
        "--dangerously-skip-permissions",
        "ping",
      ],
      {
        cwd: projectDir,
        timeout: 30_000,
        encoding: "utf-8",
        stdio: "pipe",
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env },
      },
    )
  }
  const deadline = Date.now() + maxWaitMs
  while (Date.now() < deadline) {
    if (existsSync(statePath)) return statePath
    await new Promise((r) => setTimeout(r, pollMs))
  }
  throw new Error(
    `Kasper plugin did not load within ${maxWaitMs / 1000}s — ` +
      `${statePath} was never created. This usually means the plugin ` +
      `symlink is .disabled. Run \`mv ~/.config/opencode/plugins/opencode-kasper.ts.disabled ~/.config/opencode/plugins/opencode-kasper.ts\` ` +
      `or set KASPER_E2E_LEAVE_PLUGIN_ENABLED=1 in the environment.`,
  )
}

// ── NDJSON helpers ──────────────────────────────────────────────────────

function parseNDJSON(raw: string): OpencodeEvent[] {
  const events: OpencodeEvent[] = []
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      events.push(JSON.parse(trimmed))
    } catch {
      // skip non-JSON lines
    }
  }
  return events
}

export function hasToolCalls(
  events: OpencodeEvent[],
  toolName?: string,
): boolean {
  return events.some(
    (e) =>
      e.type === "tool_use" &&
      (toolName ? e.part?.tool === toolName : !!e.part?.tool),
  )
}

export function getToolCalls(
  events: OpencodeEvent[],
  toolName?: string,
): OpencodeEvent[] {
  return events.filter(
    (e) =>
      e.type === "tool_use" &&
      (toolName ? e.part?.tool === toolName : !!e.part?.tool),
  )
}

export function hasSubagentCalls(events: OpencodeEvent[]): boolean {
  return hasToolCalls(events, "task")
}

export function hasTextOutput(events: OpencodeEvent[]): boolean {
  return events.some(
    (e) => e.type === "text" && typeof e.part?.text === "string",
  )
}

// ── opencode run (spawnSync, NDJSON) ────────────────────────────────────

/**
 * Default model for e2e tests. Smaller, faster, and more reliable in CI
 * environments than `opencode/gemini-3-flash` (which the project originally
 * targeted). Set the `KASPER_E2E_MODEL` env var to override.
 */
export const KASPER_E2E_MODEL =
  process.env.KASPER_E2E_MODEL ?? "opencode-go/minimax-m2.7"

export function runOpenCode(
  dir: string,
  prompt: string,
  opts?: { timeoutMs?: number; model?: string },
): RunResult {
  const args = [
    "run",
    "--format",
    "json",
    "--model",
    opts?.model ?? KASPER_E2E_MODEL,
    "--dir",
    dir,
    "--dangerously-skip-permissions",
  ]

  const result = spawnSync("opencode", [...args, prompt], {
    cwd: dir,
    timeout: opts?.timeoutMs ?? RUN_TIMEOUT_MS,
    encoding: "utf-8",
    stdio: "pipe",
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, OPENCODE_E2E: "1" },
  })

  const raw = result.stdout
  const events = parseNDJSON(raw)
  const sessionID = events.find((e) => e.sessionID)?.sessionID ?? ""

  return { sessionID, events, raw, exitCode: result.status }
}

// ── opencode serve (background process) ─────────────────────────────────

// Track serve processes per port so multiple suites can run independently
const _serveProcesses = new Map<number, ChildProcess>()

export function startServe(
  dir: string,
  port = SERVE_PORT,
  opts?: { serveTimeoutMs?: number },
): Promise<number> {
  // Stop any existing serve on this specific port first
  stopServe(port)

  return new Promise((resolve, reject) => {
    const proc = spawn("opencode", ["serve", "--port", String(port)], {
      cwd: dir,
      stdio: "ignore",
      detached: false,
      env: { ...process.env },
    })

    let settled = false

    const settle = (ok: boolean, val: number | Error) => {
      if (settled) return
      settled = true
      if (ok) {
        _serveProcesses.set(port, proc)
        resolve(val as number)
      } else {
        proc.kill("SIGTERM")
        _serveProcesses.delete(port)
        reject(val)
      }
    }

    proc.on("error", (err) => settle(false, err))

    const serveStartupMs = opts?.serveTimeoutMs ?? 120_000
    const deadline = Date.now() + serveStartupMs

    const check = () => {
      if (isServeRunning(port)) {
        settle(true, port)
        return
      }

      if (Date.now() > deadline) {
        settle(
          false,
          new Error(
            `Serve on port ${port} did not start within ${serveStartupMs / 1000}s`,
          ),
        )
        return
      }
      setTimeout(check, 500)
    }

    setTimeout(check, 1_500)
  })
}

export function stopServe(port?: number): void {
  const targetPort = port ?? SERVE_PORT
  const proc = _serveProcesses.get(targetPort)
  if (proc) {
    try {
      proc.kill("SIGTERM")
    } catch {
      // already dead
    }
    _serveProcesses.delete(targetPort)
  }
  // Also kill any lingering process on the port
  try {
    execSync(`fuser -k ${targetPort}/tcp 2>/dev/null || true`, {
      stdio: "pipe",
    })
  } catch {
    // ignore
  }
}

export function isServeRunning(port = SERVE_PORT): boolean {
  try {
    const authFlag =
      _SERVER_USER && _SERVER_PASS ? `-u "${_SERVER_USER}:${_SERVER_PASS}"` : ""
    // Use root `/` (returns 200 with HTML) rather than `/api/session` which
    // requires a `?limit=N` query parameter in opencode >=1.15.x.
    const resp = execSync(
      `curl -s -o /dev/null -w "%{http_code}" ${authFlag} http://localhost:${port}/`,
      {
        stdio: "pipe",
        encoding: "utf-8",
        timeout: 5_000,
      },
    )
    return resp.trim().startsWith("2")
  } catch {
    return false
  }
}

/**
 * Call the opencode HTTP REST API and parse the JSON response.
 *
 * Known upstream issue (opencode server 1.15.x): `GET /api/session` lists
 * sessions from **all** projects (not just the current directory). If any
 * session in the global database has corrupt timestamp fields the entire
 * response fails with HTTP 400 / `InvalidRequestError`. We detect this and
 * return `null` so callers degrade gracefully (empty results) instead of
 * crashing on a malformed upstream response.
 */
export function fetchAPI(path: string, port = SERVE_PORT): unknown {
  const authFlag =
    _SERVER_USER && _SERVER_PASS ? `-u "${_SERVER_USER}:${_SERVER_PASS}"` : ""
  // opencode >=1.15.x requires a `?limit=N` query parameter on the
  // `/api/session` list endpoint (default limit=0 causes a 400 error).
  // If the caller requests the bare list endpoint, add a reasonable limit.
  const resolvedPath = path === "/api/session" ? "/api/session?limit=100" : path
  const url = `http://localhost:${port}${resolvedPath}`
  const raw = execSync(`curl -s ${authFlag} "${url}"`, {
    stdio: "pipe",
    encoding: "utf-8",
    timeout: 5_000,
  })
  try {
    const parsed = JSON.parse(raw)
    // Detect opencode error response and return null instead
    if (parsed && typeof parsed === "object" && "_tag" in parsed) {
      return null
    }
    return parsed
  } catch {
    return raw
  }
}

// ── opencode run --attach (connect to running serve) ────────────────────

export function runAttach(
  dir: string,
  prompt: string,
  port = SERVE_PORT,
  opts?: { timeoutMs?: number; model?: string },
): RunResult {
  const result = spawnSync(
    "opencode",
    [
      "run",
      "--attach",
      `http://localhost:${port}`,
      "--format",
      "json",
      "--model",
      opts?.model ?? KASPER_E2E_MODEL,
      "--dir",
      dir,
      "--dangerously-skip-permissions",
      prompt,
    ],
    {
      cwd: dir,
      timeout: opts?.timeoutMs ?? RUN_TIMEOUT_MS,
      encoding: "utf-8",
      stdio: "pipe",
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env },
    },
  )

  const raw = result.stdout || ""
  const events = parseNDJSON(raw)
  const sessionID = events.find((e) => e.sessionID)?.sessionID ?? ""
  const exitCode = result.status

  if (result.error && !sessionID) {
    // Include stderr in raw for diagnostics
    const errRaw = `ERROR: ${result.error.message}\nSTDERR: ${result.stderr ?? ""}\nSTDOUT: ${raw}`
    return { sessionID, events, raw: errRaw, exitCode }
  }

  return { sessionID, events, raw, exitCode }
}

// ── opencode run --attach --session (continue existing session) ──────────

export function runContinueAttach(
  dir: string,
  sessionID: string,
  prompt: string,
  port = SERVE_PORT,
  opts?: { timeoutMs?: number },
): RunResult {
  const result = spawnSync(
    "opencode",
    [
      "run",
      "--attach",
      `http://localhost:${port}`,
      "--session",
      sessionID,
      "--format",
      "json",
      "--dir",
      dir,
      "--dangerously-skip-permissions",
      "--replay-limit",
      "50",
      prompt,
    ],
    {
      cwd: dir,
      timeout: opts?.timeoutMs ?? RUN_TIMEOUT_MS,
      encoding: "utf-8",
      stdio: "pipe",
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env },
    },
  )

  const raw = result.stdout || ""
  const events = parseNDJSON(raw)
  const outSessionID = events.find((e) => e.sessionID)?.sessionID ?? sessionID
  const exitCode = result.status

  if (result.error && !outSessionID) {
    const errRaw = `ERROR: ${result.error.message}\nSTDERR: ${result.stderr ?? ""}\nSTDOUT: ${raw}`
    return { sessionID: outSessionID, events, raw: errRaw, exitCode }
  }

  return { sessionID: outSessionID, events, raw, exitCode }
}

// ── Kasper command runner (via attach, returns text result) ─────────────

export function runKasperCommand(
  dir: string,
  kasperCmd: string,
  port = SERVE_PORT,
  opts?: { timeoutMs?: number },
): string {
  const result = runAttach(
    dir,
    `use the kasper tools to run this kasper command: /kasper ${kasperCmd}.
Just call the appropriate kasper tool and return its output verbatim. Do not add commentary.`,
    port,
    { timeoutMs: opts?.timeoutMs ?? 120_000 },
  )

  return result.raw
}

// ── Kasper config helpers ──────────────────────────────────────────────

export function writeKasperConfig(
  dir: string,
  config: Record<string, unknown>,
): void {
  const opencodeDir = join(dir, ".opencode")
  execSync(`mkdir -p "${opencodeDir}"`, { stdio: "pipe" })
  const entries = Object.entries(config).map(
    ([k, v]) => `"${k}": ${JSON.stringify(v)}`,
  )
  const jsonc = `{\n  // E2E test kasper configuration\n  ${entries.join(",\n  ")}\n}\n`
  writeFileSync(join(opencodeDir, "kasper.jsonc"), jsonc, "utf-8")
}

// ── Kasper state helpers ───────────────────────────────────────────────

export function readKasperState(dir: string): Record<string, unknown> | null {
  try {
    const statePath = join(dir, ".opencode", "kasper", "state.json")
    const raw = readFileSync(statePath, "utf-8")
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function waitForScoredSessions(
  dir: string,
  opts?: { minCount?: number; maxWaitMs?: number; sessionID?: string },
): Promise<Record<string, unknown> | null> {
  const minCount = opts?.minCount ?? 1
  const maxWaitMs = opts?.maxWaitMs ?? 90_000
  const sessionID = opts?.sessionID
  const deadline = Date.now() + maxWaitMs
  let checks = 0

  while (Date.now() < deadline) {
    checks++
    const state = readKasperState(dir)
    if (state && typeof state === "object") {
      const sessions = getScoredSessions(state)
      if (sessionID) {
        // Wait for THIS specific session to land in state with a score.
        const hit = sessions.find((s) => s.id === sessionID)
        if (hit && typeof hit.score === "number") {
          return state
        }
      } else {
        const allScored =
          sessions.length >= minCount &&
          sessions.every((s) => ((s.score as number) ?? 0) > 0)
        if (allScored) {
          return state
        }
      }
    }
    await sleepMs(2_000)
  }
  console.log(
    `  (waitForScoredSessions) timed out after ${maxWaitMs}ms (${checks} checks)`,
  )
  return null
}

export function getScoredSessions(
  state: Record<string, unknown> | null,
): Array<Record<string, unknown>> {
  if (!state) return []
  const sessions = (state as Record<string, unknown>).sessions as
    | Record<string, Record<string, unknown>>
    | undefined
  if (!sessions) return []
  return Object.entries(sessions).map(([id, data]) => ({ id, ...data }))
}

export function getSessionsWithSubagents(
  state: Record<string, unknown> | null,
): Array<Record<string, unknown>> {
  return getScoredSessions(state).filter((s) => s.agent_type === "subagent")
}

// ── File helpers ────────────────────────────────────────────────────────

export function readAgentsMd(dir: string): string | null {
  try {
    return readFileSync(join(dir, "AGENTS.md"), "utf-8")
  } catch {
    return null
  }
}

export function readAgentPrompt(dir: string, agentName: string): string | null {
  try {
    return readFileSync(
      join(dir, ".opencode", "agents", `${agentName}.md`),
      "utf-8",
    )
  } catch {
    return null
  }
}

export function hasKasperSection(content: string | null): boolean {
  if (!content) return false
  return content.includes("Kasper Inferred Instructions")
}

export function getKasperSectionContent(content: string | null): string | null {
  if (!content) return null
  const match = content.match(
    /## Kasper Inferred Instructions\s*\n([\s\S]*?)(?=\n## |\n*$)/,
  )
  return match ? match[1].trim() : null
}

// ── Log helpers ─────────────────────────────────────────────────────────

export interface LogEntry {
  ts: string
  event: string
  [key: string]: unknown
}

export function readKasperLog(dir: string): LogEntry[] {
  try {
    const logPath = join(dir, ".opencode", "kasper", "kasper.log")
    const raw = readFileSync(logPath, "utf-8")
    return raw
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .filter((e): e is LogEntry => e !== null)
  } catch {
    return []
  }
}

export function getLogEvents(log: LogEntry[], event: string): LogEntry[] {
  return log.filter((e) => e.event === event)
}

export function hasLogEvent(log: LogEntry[], event: string): boolean {
  return log.some((e) => e.event === event)
}

export function getLogEventFields(
  log: LogEntry[],
  event: string,
  field: string,
): unknown[] {
  return log
    .filter((e) => e.event === event)
    .map((e) => e[field])
    .filter((v) => v !== undefined)
}

/**
 * Return only the log entries that pertain to a specific session. Kasper
 * attaches the original session's `sessionID` to most log entries (e.g.
 * `run_eval_start`, `scoring_prompt_sending`, `evaluation_done`,
 * `state_record_session`). Some entries use a different field — most
 * notably `state_record_session` uses `sessionId` (no `sessionID` suffix).
 * We match either form so a single helper covers all of them.
 *
 * This is the right primitive for e2e lifecycle assertions: rather than
 * asking "did this event ever fire in the entire log?", we ask "did the
 * lifecycle for THIS session run end-to-end?" The former is fragile
 * because the on-disk log is trimmed (LOG_MAX_LINES) and the latter is
 * stable.
 */
export function filterLogBySession(
  log: LogEntry[],
  sessionID: string,
): LogEntry[] {
  return log.filter(
    (e) => e.sessionID === sessionID || e.sessionId === sessionID,
  )
}

export function hasLogEventForSession(
  log: LogEntry[],
  event: string,
  sessionID: string,
): boolean {
  return filterLogBySession(log, sessionID).some((e) => e.event === event)
}

export function getLogEventFieldsForSession(
  log: LogEntry[],
  event: string,
  field: string,
  sessionID: string,
): unknown[] {
  return filterLogBySession(log, sessionID)
    .filter((e) => e.event === event)
    .map((e) => e[field])
    .filter((v) => v !== undefined)
}

// ── Combined helpers ────────────────────────────────────────────────────

export async function startServeWithConfig(
  dir: string,
  config: Record<string, unknown>,
  port = SERVE_PORT,
): Promise<number> {
  writeKasperConfig(dir, config)
  return startServe(dir, port)
}

export async function waitForChildSessions(
  parentID: string,
  port = SERVE_PORT,
  opts?: { maxWaitMs?: number },
): Promise<Array<{ id: string; parentID?: string; agent?: string }>> {
  const maxWaitMs = opts?.maxWaitMs ?? 60_000
  const deadline = Date.now() + maxWaitMs

  while (Date.now() < deadline) {
    const data = fetchAPI("/api/session", port) as {
      items?: Array<{ id: string; parentID?: string; agent?: string }>
    }
    const items = data?.items ?? []
    const children = items.filter((s) => s.parentID === parentID)
    if (children.length > 0) return children
    await sleepMs(2_000)
  }
  return []
}
