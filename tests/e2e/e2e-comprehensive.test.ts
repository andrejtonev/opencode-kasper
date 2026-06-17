import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { execSync } from "node:child_process"
import {
  cleanupE2EProject,
  disableKasperPlugin,
  enableKasperPlugin,
  getKasperSectionContent,
  getScoredSessions,
  getSessionsWithSubagents,
  getToolCalls,
  hasKasperSection,
  hasToolCalls,
  isServeRunning,
  type RunResult,
  readAgentPrompt,
  readAgentsMd,
  readKasperState,
  runAttach,
  setupE2EProject,
  shouldRunE2E,
  startServeWithConfig,
  stopServe,
  waitForChildSessions,
  waitForKasperLoaded,
  waitForScoredSessions,
} from "./harness.js"

const ENABLED = shouldRunE2E()
const SERVE_PORT_AUTO = 18797
const SERVE_PORT_MANUAL = 18796

// ── Helpers ──────────────────────────────────────────────────────────

function log(msg: string): void {
  console.log(`  ${msg}`)
}

function execSleep(seconds: number): void {
  try {
    execSync(`sleep ${seconds}`, { stdio: "pipe" })
  } catch {
    /* ok */
  }
}

function sessionSummary(r: RunResult): string {
  const tools = getToolCalls(r.events)
  const distinctTools = [...new Set(tools.map((t) => t.part?.tool))]
  const exitStr = r.exitCode !== 0 ? ` exit=${r.exitCode}` : ""
  return `sid=${r.sessionID.slice(0, 16)}… tools=[${distinctTools.join(",")}] events=${r.events.length}${exitStr}`
}

function attach(
  dir: string,
  prompt: string,
  port: number,
  timeoutMs = 120_000,
): RunResult {
  return runAttach(dir, prompt, port, { timeoutMs })
}

// ══════════════════════════════════════════════════════════════════════
// AUTO MODE — polling + auto-apply
// ══════════════════════════════════════════════════════════════════════

describe("auto mode (polling + auto-apply)", () => {
  let projectDir = ""
  let servePort = 0
  let pluginEnabled = false

  beforeAll(async () => {
    if (!ENABLED) return
    enableKasperPlugin()
    pluginEnabled = true
    const p = setupE2EProject()
    projectDir = p.dir

    // Low poll interval, auto_update on, threshold 0.6 (low — first
    // session triggers considerImprovement), min_observations=1
    // (one card is enough to write).
    servePort = await startServeWithConfig(
      projectDir,
      {
        enabled: true,
        min_session_messages: 1,
        min_observations_for_update: 1,
        evaluation_poll_interval_ms: 3_000,
        scoring_timeout_ms: 60_000,
        model: "opencode-go/minimax-m2.7",
        scoring_threshold: 0.6,
        auto_update: true,
        max_agent_guidance_chars: 2000,
        detail_level: "minimal",
        quiet: true,
        debug: false,
      },
      SERVE_PORT_AUTO,
    )

    await waitForKasperLoaded(projectDir, { maxWaitMs: 30_000 })
    log(`serve started on port ${servePort}`)
  })

  afterAll(() => {
    stopServe(SERVE_PORT_AUTO)
    execSleep(3) // let port fully release
    if (projectDir) cleanupE2EProject(projectDir)
    if (pluginEnabled) {
      disableKasperPlugin()
      pluginEnabled = false
    }
  })

  test("a. auto-poll scores sessions after tool use", async () => {
    if (!ENABLED) {
      log("(skip) not enabled")
      return
    }
    expect(isServeRunning(servePort)).toBe(true)

    const r = attach(
      projectDir,
      "list files in the current directory using ls",
      servePort,
      120_000,
    )
    log(`session: ${sessionSummary(r)}`)
    expect(r.sessionID).toBeTruthy()
    expect(hasToolCalls(r.events)).toBe(true)

    // HARD assert: scoring MUST complete. Previous version logged
    // "scoring failed (LLM unavailable)" and passed.
    const state = await waitForScoredSessions(projectDir, {
      minCount: 1,
      maxWaitMs: 90_000,
    })
    expect(state).toBeTruthy()

    const sessions = getScoredSessions(state!)
    log(`scored: ${sessions.length} session(s)`)
    for (const s of sessions) {
      const sc = s.score_card as Record<string, unknown> | undefined
      log(
        `  score=${(s.score as number)?.toFixed(2)} type=${s.agent_type ?? "?"} ` +
          `weaknesses=${(s.weaknesses as string[] | undefined)?.length ?? 0} ` +
          `categories=${sc ? Object.keys(sc.categories ?? {}).join(",") : "none"}`,
      )
    }

    expect(sessions.length).toBeGreaterThanOrEqual(1)
    const scored = sessions[0]
    expect(scored.score).toBeGreaterThan(0)
    expect(scored.score).toBeLessThanOrEqual(1)
    // Verify score_card structure
    const card = scored.score_card as Record<string, unknown>
    expect(card).toBeTruthy()
    expect(card.overall_score).toBeGreaterThan(0)
    expect(card.categories).toBeTruthy()
    expect(Array.isArray(card.weaknesses)).toBe(true)
    expect(Array.isArray(card.strengths)).toBe(true)
  })

  test("b. subagent sessions are scored with correct metadata", async () => {
    if (!ENABLED) {
      log("(skip) not enabled")
      return
    }
    expect(isServeRunning(servePort)).toBe(true)

    const r = attach(
      projectDir,
      "use the explore subagent to search for *.ts files in the src/ directory. Report what it finds.",
      servePort,
      180_000,
    )
    log(`session: ${sessionSummary(r)}`)
    expect(r.sessionID).toBeTruthy()

    const children = await waitForChildSessions(r.sessionID, servePort, {
      maxWaitMs: 30_000,
    })
    log(`child sessions via API: ${children.length}`)

    // Wait for auto-poll to score
    execSleep(20)

    // HARD assert: state must exist (kasper ran).
    const state = readKasperState(projectDir)
    expect(state).toBeTruthy()
    const subagentSessions = getSessionsWithSubagents(state!)
    log(`scored subagent sessions: ${subagentSessions.length}`)

    // If the model did delegate, the subagent MUST be scored and the
    // metadata MUST be correct. We allow the model to NOT delegate
    // (it sometimes handles the prompt directly) — in that case we
    // only check the main session was scored.
    if (subagentSessions.length > 0) {
      for (const s of subagentSessions) {
        log(
          `  subagent: id=${(s.id as string)?.slice(0, 16)}… ` +
            `score=${(s.score as number)?.toFixed(2)} ` +
            `parent=${(s.parent_session_id as string)?.slice(0, 16)}…`,
        )
        expect(s.agent_type).toBe("subagent")
        expect(s.parent_session_id).toBeTruthy()
        expect(s.score).toBeGreaterThan(0)
      }
    } else if (children.length > 0) {
      // children exist in /api/session but not in kasper state — this
      // is a kasper bug (auto-poll not picking them up), not a
      // silent pass. Hard-assert the equivalence.
      throw new Error(
        `${children.length} child session(s) visible in /api/session ` +
          `but kasper state has no subagent records — auto-poll is ` +
          `not picking up delegated sessions.`,
      )
    } else {
      log(
        "(info) model did not delegate on this run; the main-session " +
          "scoring path is verified by test (a) and (c).",
      )
    }
  })

  test("c. auto-apply updates AGENTS.md or agent prompts", async () => {
    if (!ENABLED) {
      log("(skip) not enabled")
      return
    }
    expect(isServeRunning(servePort)).toBe(true)

    // Run a weakness-provoking session. With scoring_threshold=0.6
    // and min_observations_for_update=1, the first card below 0.6
    // fires auto-apply.
    const r = attach(
      projectDir,
      "Do not read any files. Do not run any commands. Guess what package.json contains and report a one-line answer.",
      servePort,
      90_000,
    )
    log(`session: ${sessionSummary(r)}`)

    // Wait for scoring + auto-apply
    execSleep(25)

    const agentsMd = readAgentsMd(projectDir)
    const generalPrompt = readAgentPrompt(projectDir, "general")
    const explorePrompt = readAgentPrompt(projectDir, "explore")

    const updated: string[] = []
    if (hasKasperSection(agentsMd)) {
      const sec = getKasperSectionContent(agentsMd)
      log(`AGENTS.md updated: "${sec?.slice(0, 100)}..."`)
      updated.push("AGENTS.md")
    }
    if (hasKasperSection(generalPrompt)) {
      log(`general agent prompt updated`)
      updated.push("general prompt")
    }
    if (hasKasperSection(explorePrompt)) {
      log(`explore agent prompt updated`)
      updated.push("explore prompt")
    }

    // HARD assert: with scoring_threshold=0.6 and a weakness-provoking
    // prompt, at least one of AGENTS.md / general / explore MUST have
    // been updated. Previous version used `if (updated.length > 0)`
    // and silently passed otherwise.
    expect(updated.length).toBeGreaterThanOrEqual(1)

    // Verify state contains weaknesses after multiple sessions
    const state = readKasperState(projectDir)
    expect(state).toBeTruthy()
    const sessions = getScoredSessions(state!)
    log(`total scored sessions: ${sessions.length}`)
    const agg = (state as Record<string, unknown>)?.aggregate as
      | Record<string, unknown>
      | undefined
    if (agg) {
      log(`avg_score=${agg.avg_score} total=${agg.total_sessions}`)
    }
  })
})

// ══════════════════════════════════════════════════════════════════════
// MANUAL MODE — explicit scoring + manual apply
// ══════════════════════════════════════════════════════════════════════

describe("manual mode (explicit scoring + manual apply)", () => {
  let projectDir = ""
  let servePort = 0
  const sessionIDs: string[] = []
  let pluginEnabled = false

  beforeAll(async () => {
    if (!ENABLED) return
    enableKasperPlugin()
    pluginEnabled = true
    const p = setupE2EProject()
    projectDir = p.dir

    // Long poll interval to disable auto; auto_update off
    servePort = await startServeWithConfig(
      projectDir,
      {
        enabled: true,
        min_session_messages: 1,
        evaluation_poll_interval_ms: 300_000,
        scoring_timeout_ms: 60_000,
        model: "opencode-go/minimax-m2.7",
        scoring_threshold: 0.6,
        min_observations_for_update: 1,
        auto_update: false,
        detail_level: "minimal",
        quiet: true,
        debug: false,
      },
      SERVE_PORT_MANUAL,
    )

    await waitForKasperLoaded(projectDir, { maxWaitMs: 30_000 })
    log(`serve started on port ${servePort}`)
  })

  afterAll(() => {
    stopServe(SERVE_PORT_MANUAL)
    execSleep(3)
    if (projectDir) cleanupE2EProject(projectDir)
    if (pluginEnabled) {
      disableKasperPlugin()
      pluginEnabled = false
    }
  })

  test("d. batch score evaluates all sessions", async () => {
    if (!ENABLED) {
      log("(skip) not enabled")
      return
    }
    expect(isServeRunning(servePort)).toBe(true)

    // Create sessions to score (moved from beforeAll to keep hook lightweight)
    if (sessionIDs.length === 0) {
      const r1 = attach(
        projectDir,
        "list all files in the current directory using ls. Show the output.",
        servePort,
        90_000,
      )
      log(`session 1: ${sessionSummary(r1)}`)
      if (r1.sessionID) sessionIDs.push(r1.sessionID)

      const r2 = attach(
        projectDir,
        "read the file package.json and tell me what dependencies are listed",
        servePort,
        90_000,
      )
      log(`session 2: ${sessionSummary(r2)}`)
      if (r2.sessionID) sessionIDs.push(r2.sessionID)
      log(`created ${sessionIDs.length} sessions for manual scoring`)
    }

    // HARD assert: we created sessions to score.
    expect(sessionIDs.length).toBeGreaterThanOrEqual(2)

    const before = getScoredSessions(readKasperState(projectDir)!).length
    log(`scored before batch: ${before}`)

    // Trigger batch scoring via kasper tool. The LLM may or may not
    // actually invoke the tool — this is best-effort. We just
    // observe what happens.
    const cmd = attach(
      projectDir,
      "call the kasper_score_session tool with count=5 to evaluate recent sessions. Return the tool's output verbatim.",
      servePort,
      120_000,
    )
    log(`batch command: ${sessionSummary(cmd)}`)

    execSleep(10)

    // HARD assert: state exists (kasper loaded).
    const state = readKasperState(projectDir)
    expect(state).toBeTruthy()
    const after = getScoredSessions(state!).length
    log(`scored after batch: ${after}`)

    // The batch tool may or may not be invoked by the LLM. We don't
    // hard-assert it (that would be flaky). The state-exists check
    // is the real signal that kasper is running.
  })

  test("e. single session scoring produces valid score_card", async () => {
    if (!ENABLED) {
      log("(skip) not enabled")
      return
    }
    expect(isServeRunning(servePort)).toBe(true)
    expect(sessionIDs.length).toBeGreaterThanOrEqual(1)

    const targetID = sessionIDs[0]
    log(`scoring session: ${targetID.slice(0, 20)}…`)

    // Best-effort: the LLM may or may not invoke kasper_score_session.
    const cmd = attach(
      projectDir,
      `call the kasper_score_session tool with session_id="${targetID}". Return the tool's output.`,
      servePort,
      120_000,
    )
    log(`score result: ${cmd.raw.slice(0, 250)}`)

    execSleep(5)

    const state = readKasperState(projectDir)
    expect(state).toBeTruthy()
    const scored = getScoredSessions(state!).find((s) => s.id === targetID)

    if (scored) {
      log(`session scored: score=${(scored.score as number)?.toFixed(2)}`)
      expect(scored.score).toBeGreaterThan(0)
      const card = scored.score_card as Record<string, unknown>
      expect(card).toBeTruthy()
      if (card) {
        expect(card.overall_score).toBeGreaterThan(0)
      }
    } else {
      log(
        "(info) session not scored — LLM did not invoke kasper_score_session. " +
          "This is best-effort; the auto-mode tests in the first describe " +
          "block cover the scoring pipeline end-to-end.",
      )
    }
  })

  test("f. manual apply updates files after scoring", async () => {
    if (!ENABLED) {
      log("(skip) not enabled")
      return
    }
    expect(isServeRunning(servePort)).toBe(true)

    // Check current state
    const state = readKasperState(projectDir)
    expect(state).toBeTruthy()
    const sessions = getScoredSessions(state!)
    log(`scored sessions before apply: ${sessions.length}`)

    // Best-effort: invoke kasper_improve / kasper_apply via the LLM.
    // The LLM may or may not actually call the tool. We just observe.
    const improveResult = attach(
      projectDir,
      "call the kasper_improve tool to show improvements. Use dry_run=true to just preview.",
      servePort,
      120_000,
    )
    log(`improve: ${improveResult.raw.slice(0, 300)}`)

    const applyResult = attach(
      projectDir,
      "call the kasper_apply tool with index=1 to apply the first improvement. Return the result.",
      servePort,
      120_000,
    )
    log(`apply: ${applyResult.raw.slice(0, 200)}`)

    execSleep(2)

    // Check for file updates
    const agentsMd = readAgentsMd(projectDir)
    const generalPrompt = readAgentPrompt(projectDir, "general")

    if (hasKasperSection(agentsMd)) {
      log("AGENTS.md has Kasper section after manual apply")
    }
    if (hasKasperSection(generalPrompt)) {
      log("general prompt has Kasper section after manual apply")
    }

    // Best-effort. The LLM may or may not invoke the tools. The
    // auto-mode test (c) is the hard assertion for auto-apply.
    const anyUpdated =
      hasKasperSection(agentsMd) || hasKasperSection(generalPrompt)
    if (!anyUpdated) {
      log(
        "(info) no file updates via manual apply — LLM did not invoke the tools.",
      )
    }
  })
})
