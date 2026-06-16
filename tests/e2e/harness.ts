import {
  type ChildProcess,
  execSync,
  spawn,
  spawnSync,
} from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// ── Types ───────────────────────────────────────────────────────────────

export interface OpencodeEvent {
  type: string
  timestamp: number
  sessionID: string
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

const _PLUGIN_PATH = join(
  process.env.HOME ?? "/home/user",
  ".config",
  "opencode",
  "plugins",
  "opencode-kasper.ts",
)

const DEFAULT_OPENCODE_CONFIG: Record<string, unknown> = {
  // Plugin is loaded from global plugins directory (~/.config/opencode/plugins/)
  // No need to duplicate here — avoids double-loading
}

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
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // best-effort
  }
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
    "--pure",
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
    const resp = execSync(
      `curl -s -o /dev/null -w "%{http_code}" http://localhost:${port}/api/session`,
      {
        stdio: "pipe",
        encoding: "utf-8",
        timeout: 3_000,
      },
    )
    return resp.trim() === "200"
  } catch {
    return false
  }
}

export function fetchAPI(path: string, port = SERVE_PORT): unknown {
  const url = `http://localhost:${port}${path}`
  const raw = execSync(`curl -s "${url}"`, {
    stdio: "pipe",
    encoding: "utf-8",
    timeout: 5_000,
  })
  try {
    return JSON.parse(raw)
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
      "--pure",
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
  opts?: { minCount?: number; maxWaitMs?: number },
): Promise<Record<string, unknown> | null> {
  const minCount = opts?.minCount ?? 1
  const maxWaitMs = opts?.maxWaitMs ?? 90_000
  const deadline = Date.now() + maxWaitMs
  let checks = 0

  while (Date.now() < deadline) {
    checks++
    const state = readKasperState(dir)
    if (state && typeof state === "object") {
      const sessions = getScoredSessions(state)
      const allScored =
        sessions.length >= minCount &&
        sessions.every((s) => ((s.score as number) ?? 0) > 0)
      if (allScored) {
        return state
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
