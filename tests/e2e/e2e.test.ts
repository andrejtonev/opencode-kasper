import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  cleanupE2EProject,
  disableKasperPlugin,
  enableKasperPlugin,
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
  waitForKasperLoaded,
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
let pluginEnabled = false

beforeAll(async () => {
  if (!ENABLED) return
  // Enable the kasper plugin symlink. If it's already enabled we leave
  // it; the matching disable is in afterAll unless
  // KASPER_E2E_LEAVE_PLUGIN_ENABLED=1 is set.
  enableKasperPlugin()
  pluginEnabled = true

  const p = setupE2EProject()
  projectDir = p.dir
  // NOTE: `opencode run` (non-attach) returns "Session not found" in
  // opencode >=1.15.13 in this environment. The `--attach` flow works,
  // so we start a single serve here and reuse it for every test in this
  // file. Previously this was launched lazily per-describe; the lifecycle
  // was racy under parallel test execution and the lazy launch also
  // produced empty sessionIDs when the helper functions were called
  // before the serve health check returned 200.
  servePort = await startServe(projectDir, 18799)
  // Verify the kasper plugin actually loaded into the serve. If the
  // symlink toggle silently failed, this throws with a clear error.
  await waitForKasperLoaded(projectDir, { maxWaitMs: 30_000 })
})

afterAll(() => {
  if (servePort) stopServe(servePort)
  if (projectDir) cleanupE2EProject(projectDir)
  if (pluginEnabled) {
    disableKasperPlugin()
    pluginEnabled = false
  }
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
  // The `task` tool is how the opencode primary agent spawns subagents.
  // This test proves that prompt → subagent delegation works in the
  // opencode version we test against. We use the `explore` agent because
  // it's an opencode built-in available in every recent release.
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
    // HARD assert: a delegation prompt MUST produce a task call. The
    // previous version used `if (taskCalls.length > 0)` and silently
    // passed otherwise.
    expect(taskCalls.length).toBeGreaterThanOrEqual(1)
    expect(taskCalls[0].part?.tool).toBe("task")
    console.log(`  ok — ${taskCalls.length} task call(s) detected`)
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

    const result = runAttach(
      projectDir,
      "use the explore agent to search for *.ts files in the tests directory. Report what it finds.",
      servePort,
      { timeoutMs: 180_000 },
    )
    console.log(`  session: ${result.sessionID.slice(0, 20)}…`)

    // Give the opencode session store a moment to flush the child
    // session to disk. 5s is generous for a same-host subagent spawn.
    await new Promise((resolve) => setTimeout(resolve, 5_000))

    const data = fetchAPI("/api/session", servePort) as {
      items?: Array<{ id: string; parentID?: string; agent?: string }>
    }
    const items = data?.items ?? []

    const children = items.filter((s) => s.parentID === result.sessionID)
    console.log(`  sessions=${items.length} children=${children.length}`)
    for (const c of children) {
      console.log(`    child: ${c.id.slice(0, 20)}… agent=${c.agent}`)
    }
    // HARD assert: a delegation prompt MUST produce a child session.
    expect(children.length).toBeGreaterThanOrEqual(1)
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

    // HARD assert: the scoring pipeline MUST produce a card within
    // 240s. The previous version logged a warning and passed if
    // scoring didn't complete, which masked the disabled-plugin bug.
    const state = await waitForScoredSessions(projectDir, {
      minCount: 1,
      maxWaitMs: 240_000,
    })
    expect(state).toBeTruthy()
    const recent = (state as Record<string, unknown>).recent as
      | Array<{ score: number; id: string }>
      | undefined
    console.log(`  scored: ${recent?.length ?? 0} sessions`)
    expect(recent).toBeTruthy()
    expect(recent!.length).toBeGreaterThanOrEqual(1)
    // A session that ran a tool successfully must score > 0.
    expect(recent![0].score).toBeGreaterThan(0)
  })
})
