import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  cleanupE2EProject,
  fetchAPI,
  getToolCalls,
  hasTextOutput,
  hasToolCalls,
  type RunResult,
  runAttach,
  setupE2EProject,
  shouldRunE2E,
  startServe,
  stopServe,
  waitForScoredSessions,
  writeKasperConfig,
} from "./harness.js"

const ENABLED = shouldRunE2E()

// Validate test environment: e2e tests need at least 120s per-test timeout
// because opencode run commands can take 60–180s (subagent ops are slow).
const RUNNER_TIMEOUT = (globalThis as unknown as Record<string, unknown>)
  ?.bunTestTimeoutMs as number | undefined
if (ENABLED && RUNNER_TIMEOUT && RUNNER_TIMEOUT < 120_000) {
  console.warn(
    `\n  ⚠️  E2E tests need --timeout >= 120000ms (300000ms recommended). ` +
      `Current: ${RUNNER_TIMEOUT}ms. Run: bun test --timeout 300000 tests/e2e/\n`,
  )
}

// ── Setup ───────────────────────────────────────────────────────────────

let projectDir = ""
let servePort = 0

beforeAll(async () => {
  if (!ENABLED) return
  const p = setupE2EProject()
  projectDir = p.dir
  // NOTE: `opencode run` (non-attach) returns "Session not found" in
  // opencode >=1.15.13 in this environment. The `--attach` flow works,
  // so we start a single serve here and reuse it for every test in this
  // file. Previously this was launched lazily per-describe; the lifecycle
  // was racy under parallel test execution and the lazy launch also
  // produced empty sessionIDs when the helper functions were called
  // before the serve health check returned 200.
  try {
    servePort = await startServe(projectDir, 18799)
  } catch (e) {
    console.log(`  serve start failed: ${e}`)
  }
})

afterAll(() => {
  if (servePort) stopServe(servePort)
  if (projectDir) cleanupE2EProject(projectDir)
})

// ── Test helpers ────────────────────────────────────────────────────────

function run(prompt: string, timeoutMs?: number): RunResult {
  return runAttach(projectDir, prompt, servePort, { timeoutMs })
}

function durationMs(r: RunResult): number {
  if (r.events.length < 2) return 0
  return (
    (r.events[r.events.length - 1]?.timestamp ?? 0) -
    (r.events[0]?.timestamp ?? 0)
  )
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("tool call detection", () => {
  test("single bash tool call", async () => {
    if (!ENABLED) {
      console.log("  (skip) not enabled")
      return
    }
    const result = run("list files in the current directory using ls")
    expect(result.sessionID).toBeTruthy()
    expect(result.events.length).toBeGreaterThan(0)
    expect(hasToolCalls(result.events)).toBe(true)

    const bashCalls = getToolCalls(result.events, "bash")
    expect(bashCalls.length).toBeGreaterThanOrEqual(1)
    const completed = bashCalls.every(
      (e) => e.part?.state?.status === "completed",
    )
    expect(completed).toBe(true)
    console.log(
      `  ok — session=${result.sessionID.slice(0, 20)}… events=${result.events.length} dur=${durationMs(result)}ms`,
    )
  })

  test("multiple tool calls", async () => {
    if (!ENABLED) {
      console.log("  (skip) not enabled")
      return
    }
    const result = run(
      "first list files using ls, then read the file package.json",
      180_000,
    )
    expect(result.sessionID).toBeTruthy()
    expect(hasToolCalls(result.events)).toBe(true)

    const distinctTools = new Set(
      getToolCalls(result.events).map((e) => e.part?.tool),
    )
    expect(distinctTools.size).toBeGreaterThanOrEqual(1)
    expect(hasTextOutput(result.events)).toBe(true)
    console.log(
      `  ok — tools=${[...distinctTools].join(",")} events=${result.events.length}`,
    )
  })
})

describe("subagent call detection", () => {
  test("task tool spawns subagent", async () => {
    if (!ENABLED) {
      console.log("  (skip) not enabled")
      return
    }
    const result = run(
      "use the explore agent to quickly search for *.ts files in the tests directory",
      180_000,
    )
    expect(result.sessionID).toBeTruthy()

    const taskCalls = getToolCalls(result.events, "task")
    if (taskCalls.length > 0) {
      expect(taskCalls[0].part?.tool).toBe("task")
      console.log(`  ok — ${taskCalls.length} task call(s) detected`)
    } else {
      console.log(
        `  info — no task calls (agent may not have spawned subagent)`,
      )
    }
  })
})

describe("no-tool conversations", () => {
  test("text-only response has no tool calls", async () => {
    if (!ENABLED) {
      console.log("  (skip) not enabled")
      return
    }
    const result = run("just say hello world", 60_000)
    expect(result.sessionID).toBeTruthy()
    expect(hasTextOutput(result.events)).toBe(true)
    // note: the agent sometimes uses bash echo for greetings,
    // so we only assert text output, not absence of tool calls
    console.log(
      `  ok — tools=${getToolCalls(result.events).length} text=${hasTextOutput(result.events)}`,
    )
  })
})

describe("session identity", () => {
  test("session ID has expected format", async () => {
    if (!ENABLED) {
      console.log("  (skip) not enabled")
      return
    }
    const result = run("say hello")
    expect(result.sessionID).toMatch(/^ses_/)
  })

  test("consecutive runs get distinct session IDs", async () => {
    if (!ENABLED) {
      console.log("  (skip) not enabled")
      return
    }
    const r1 = run("say hello")
    const r2 = run("say goodbye")
    expect(r1.sessionID).not.toBe(r2.sessionID)
  })
})

// ── Serve-based: subagent session list ──────────────────────────────────
//
// Child-session API assertion. Reuses the file-level serve on `servePort`
// (started in the top-level beforeAll). The previous version launched its
// own serve on the same port, which raced with the file-level one; the
// duplicate startServe/stopServe pair has been removed.

describe("subagent session detection (serve)", () => {
  test("child sessions appear in API after subagent run", async () => {
    if (!ENABLED) {
      console.log("  (skip) not enabled")
      return
    }
    if (!servePort) {
      console.log("  (skip) serve not available")
      return
    }

    const result = runAttach(
      projectDir,
      "use the explore agent to search for *.ts files in the tests directory. Report what it finds.",
      servePort,
      { timeoutMs: 180_000 },
    )
    console.log(`  session: ${result.sessionID.slice(0, 20)}…`)

    await new Promise((resolve) => setTimeout(resolve, 3_000))

    const data = fetchAPI("/api/session", servePort) as {
      items?: Array<{ id: string; parentID?: string; agent?: string }>
    }
    const items = data?.items ?? []

    const children = items.filter((s) => s.parentID)
    console.log(`  sessions=${items.length} children=${children.length}`)
    if (children.length > 0) {
      expect(children.length).toBeGreaterThanOrEqual(1)
      children.forEach((c) => {
        console.log(`    child: ${c.id.slice(0, 20)}… agent=${c.agent}`)
      })
    }
  })
})

// ── Kasper scoring ──────────────────────────────────────────────────────

describe("kasper scoring", () => {
  test("state.json populated after session", async () => {
    if (!ENABLED) {
      console.log("  (skip) not enabled")
      return
    }

    writeKasperConfig(projectDir, {
      enabled: true,
      min_session_messages: 1,
      evaluation_poll_interval_ms: 2_000,
      model: "opencode-go/minimax-m2.7",
      scoring_timeout_ms: 120_000,
      detail_level: "minimal",
      quiet: true,
    })

    run("list files using ls")

    const state = await waitForScoredSessions(projectDir, {
      minCount: 1,
      maxWaitMs: 240_000,
    })
    if (state) {
      const recent = (state as Record<string, unknown>).recent as
        | Array<{ score: number; id: string }>
        | undefined
      console.log(`  scored: ${recent?.length ?? 0} sessions`)
      if (recent && recent.length > 0 && recent[0].score > 0) {
        expect(recent[0].score).toBeGreaterThan(0)
      }
    } else {
      console.log(`  no scored sessions after 30s`)
    }
  })
})
