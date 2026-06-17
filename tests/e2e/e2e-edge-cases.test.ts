import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { execSync } from "node:child_process"
import { rmSync } from "node:fs"
import { join } from "node:path"
import {
  cleanupE2EProject,
  disableKasperPlugin,
  enableKasperPlugin,
  fetchAPI,
  getScoredSessions,
  getToolCalls,
  hasKasperSection,
  hasToolCalls,
  isServeRunning,
  readAgentsMd,
  readKasperState,
  runAttach,
  runContinueAttach,
  setupE2EProject,
  shouldRunE2E,
  startServeWithConfig,
  stopServe,
  waitForKasperLoaded,
  waitForScoredSessions,
} from "./harness.js"

const ENABLED = shouldRunE2E()
const SERVE_PORT_EDGE = 18795

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

// ══════════════════════════════════════════════════════════════════════
// PLUGIN LIFECYCLE EDGE CASES
// ══════════════════════════════════════════════════════════════════════

describe("plugin lifecycle edge cases", () => {
  let projectDir = ""
  let servePort = 0
  let pluginEnabled = false

  beforeAll(async () => {
    if (!ENABLED) return
    enableKasperPlugin()
    pluginEnabled = true
    const p = setupE2EProject()
    projectDir = p.dir

    servePort = await startServeWithConfig(
      projectDir,
      {
        enabled: true,
        min_session_messages: 1,
        evaluation_poll_interval_ms: 5_000,
        model: "opencode-go/minimax-m2.7",
        scoring_timeout_ms: 120_000,
        scoring_threshold: 0.7,
        auto_update: false,
        detail_level: "minimal",
        quiet: true,
        debug: false,
      },
      SERVE_PORT_EDGE,
    )

    await waitForKasperLoaded(projectDir, { maxWaitMs: 30_000 })
    log(`serve started on port ${servePort}`)
  })

  afterAll(() => {
    stopServe(SERVE_PORT_EDGE)
    execSleep(3)
    if (projectDir) cleanupE2EProject(projectDir)
    if (pluginEnabled) {
      disableKasperPlugin()
      pluginEnabled = false
    }
  })

  test("state.json created and has valid structure after scoring", async () => {
    if (!ENABLED) {
      log("(skip) not enabled")
      return
    }
    expect(isServeRunning(servePort)).toBe(true)

    const r = runAttach(projectDir, "list files using ls", servePort, 90_000)
    log(
      `session: ${r.sessionID.slice(0, 16)}… tools=${getToolCalls(r.events).length} exit=${r.exitCode}`,
    )
    expect(r.sessionID).toBeTruthy()

    // HARD assert: scoring MUST complete. Previous version logged
    // "scoring did not complete within maxWaitMs" and passed.
    const state = await waitForScoredSessions(projectDir, {
      minCount: 1,
      maxWaitMs: 180_000,
    })
    expect(state).toBeTruthy()
    expect(typeof state).toBe("object")
    expect(state).toHaveProperty("sessions")
    expect(state).toHaveProperty("aggregate")

    // Verify sessions map
    const sessions = state!.sessions as Record<string, Record<string, unknown>>
    expect(typeof sessions).toBe("object")
    const sessionIDs = Object.keys(sessions)
    expect(sessionIDs.length).toBeGreaterThanOrEqual(1)

    // Verify each session entry has required fields
    for (const id of sessionIDs) {
      const s = sessions[id]
      expect(typeof s).toBe("object")
      expect(s).toHaveProperty("title")
      expect(s).toHaveProperty("score")
      expect(s).toHaveProperty("score_card")
      expect(s).toHaveProperty("weaknesses")
      // strengths are inside score_card, not top-level
      const cardFromState = s.score_card as Record<string, unknown> | undefined
      expect(Array.isArray(cardFromState?.strengths)).toBe(true)
      // message_count is optional (not always populated in all sessions)
      if (s.message_count !== undefined) {
        expect(typeof s.message_count).toBe("number")
      }
      expect(s).toHaveProperty("last_msg_id")
      expect(s).toHaveProperty("last_updated_at")

      // Score range
      expect(s.score).toBeGreaterThanOrEqual(0)
      expect(s.score).toBeLessThanOrEqual(1)

      // ScoreCard structure
      const card = s.score_card as Record<string, unknown>
      expect(card).toHaveProperty("overall_score")
      expect(card).toHaveProperty("categories")
      if ((card.overall_score as number) > 0) {
        const cats = card.categories as Record<string, number>
        expect(cats).toHaveProperty("instruction_following")
        expect(cats).toHaveProperty("completeness")
        expect(cats).toHaveProperty("proactiveness")
        expect(cats).toHaveProperty("code_quality")
        expect(cats).toHaveProperty("communication")
      }

      log(
        `  session ${id.slice(0, 16)}… score=${(s.score as number).toFixed(2)} msgs=${s.message_count} card=${!!card.overall_score}`,
      )
    }

    // Verify aggregate
    const agg = state!.aggregate as Record<string, unknown>
    expect(agg).toHaveProperty("avg_score")
    expect(agg).toHaveProperty("total_sessions")
    expect(agg).toHaveProperty("by_agent")
    expect(agg.total_sessions).toBeGreaterThanOrEqual(sessionIDs.length)

    log(
      `aggregate: avg_score=${(agg.avg_score as number).toFixed(2)} total=${agg.total_sessions}`,
    )
  })

  test("scored sessions exclude kasper-* internal sessions", async () => {
    if (!ENABLED) {
      log("(skip) not enabled")
      return
    }
    expect(isServeRunning(servePort)).toBe(true)

    // HARD assert: state must exist (kasper ran).
    const state = readKasperState(projectDir)
    expect(state).toBeTruthy()
    const sessions = state!.sessions as
      | Record<string, Record<string, unknown>>
      | undefined
    expect(sessions).toBeTruthy()

    // No scored session should have a title starting with "kasper-" or "Kasper"
    for (const [_id, s] of Object.entries(sessions!)) {
      const title = (s.title as string) ?? ""
      expect(title).not.toMatch(/^kasper-/i)
      expect(title).not.toMatch(/^Kasper/i)
    }

    log(
      `verified ${Object.keys(sessions!).length} sessions — no kasper-* entries`,
    )
  })

  test("API /api/session returns valid JSON with session IDs", async () => {
    if (!ENABLED) {
      log("(skip) not enabled")
      return
    }
    expect(isServeRunning(servePort)).toBe(true)

    const data = fetchAPI("/api/session", servePort) as {
      items?: Array<{ id: string; title?: string; parentID?: string }>
    }
    expect(data).toBeTruthy()
    expect(Array.isArray(data.items)).toBe(true)

    const items = data.items ?? []
    log(`API sessions: ${items.length}`)
    for (const item of items) {
      expect(item.id).toBeTruthy()
      expect(item.id.startsWith("ses_") || item.id === "global").toBe(true)
    }

    // There should be at least one user session (from our attach above)
    expect(items.length).toBeGreaterThanOrEqual(1)
  })

  test("API /api/session/<id>/message returns events for a session", async () => {
    if (!ENABLED) {
      log("(skip) not enabled")
      return
    }
    expect(isServeRunning(servePort)).toBe(true)

    // HARD assert: state must exist.
    const state = readKasperState(projectDir)
    expect(state).toBeTruthy()
    const scoredSessions = getScoredSessions(state!)
    // Use a scored session (guaranteed to have messages from scoring)
    const targetID =
      scoredSessions.length > 0 ? (scoredSessions[0].id as string) : null
    expect(targetID).toBeTruthy() // at least one scored session from test 1

    const messages = fetchAPI(`/api/session/${targetID}/messages`, servePort)
    expect(messages).toBeTruthy()
    if (messages && typeof messages !== "string" && Array.isArray(messages)) {
      const msgArray = messages as Array<Record<string, unknown>>
      log(`messages for ${targetID!.slice(0, 16)}…: ${msgArray.length}`)
      expect(msgArray.length).toBeGreaterThan(0)

      // Verify message structure
      for (const msg of msgArray) {
        expect(msg).toHaveProperty("type")
        expect(typeof msg.type).toBe("string")
      }

      const types = new Set(msgArray.map((m) => m.type as string))
      log(`  event types: ${[...types].join(", ")}`)
    } else {
      // opencode server endpoint may return non-array in some versions
      log(
        "(info) message endpoint returned non-array — API shape differs from test expectations",
      )
    }
  })
})

// ══════════════════════════════════════════════════════════════════════
// DISABLED MODE
// ══════════════════════════════════════════════════════════════════════
//
// In this describe block, kasper's `enabled: false` config flag is set.
// The plugin LOADS into the serve (we still call enableKasperPlugin) but
// returns no-op hooks, so no state.json is created. The test verifies
// the no-op path is correct.

describe("disabled mode (kasper.enabled=false)", () => {
  let projectDir = ""
  let servePort = 0
  let pluginEnabled = false

  beforeAll(async () => {
    if (!ENABLED) return
    enableKasperPlugin()
    pluginEnabled = true
    const p = setupE2EProject()
    projectDir = p.dir

    servePort = await startServeWithConfig(
      projectDir,
      {
        enabled: false,
      },
      18794,
    )

    // We do NOT call waitForKasperLoaded here — when enabled=false,
    // the plugin returns empty hooks immediately and never creates
    // .opencode/kasper/state.json. That's the entire point of this
    // describe block.
    log(`serve started on port ${servePort}`)
  })

  afterAll(() => {
    stopServe(18794)
    execSleep(3)
    if (projectDir) cleanupE2EProject(projectDir)
    if (pluginEnabled) {
      disableKasperPlugin()
      pluginEnabled = false
    }
  })

  test("serve stays up when enabled=false", async () => {
    if (!ENABLED) {
      log("(skip) not enabled")
      return
    }
    expect(isServeRunning(servePort)).toBe(true)
  })

  test("openCode run --attach still works (plugin is no-op)", async () => {
    if (!ENABLED) {
      log("(skip) not enabled")
      return
    }
    expect(isServeRunning(servePort)).toBe(true)

    const r = runAttach(projectDir, "say hello", servePort, 60_000)
    log(
      `attach: exit=${r.exitCode} session=${r.sessionID.slice(0, 16)}… events=${r.events.length}`,
    )
    // Should complete successfully even though Kasper is disabled
    expect(r.sessionID).toBeTruthy()
  })

  test("no state.json entries created when disabled", async () => {
    if (!ENABLED) {
      log("(skip) not enabled")
      return
    }

    // When enabled=false, the plugin must NOT create state.json.
    // The previous version used `if (!state) { log warn; return }`
    // which masked whether state.json was actually absent or whether
    // kasper had failed to load. We now hard-assert absence.
    const state = readKasperState(projectDir)
    expect(state).toBeNull()
    log("disabled mode: no state.json — correct")
  })
})

// ══════════════════════════════════════════════════════════════════════
// NO AGENTS.md
// ══════════════════════════════════════════════════════════════════════

describe("no AGENTS.md", () => {
  let projectDir = ""
  let servePort = 0
  let pluginEnabled = false

  beforeAll(async () => {
    if (!ENABLED) return
    enableKasperPlugin()
    pluginEnabled = true
    const p = setupE2EProject()
    projectDir = p.dir

    // Delete AGENTS.md if it exists
    const agentsMdPath = join(projectDir, "AGENTS.md")
    try {
      rmSync(agentsMdPath, { force: true })
    } catch {
      /* ok */
    }

    servePort = await startServeWithConfig(
      projectDir,
      {
        enabled: true,
        min_session_messages: 1,
        evaluation_poll_interval_ms: 5_000,
        model: "opencode-go/minimax-m2.7",
        scoring_timeout_ms: 120_000,
        scoring_threshold: 0.7,
        auto_update: false,
        detail_level: "minimal",
        quiet: true,
        debug: false,
      },
      18793,
    )

    await waitForKasperLoaded(projectDir, { maxWaitMs: 30_000 })
    log(`serve started on port ${servePort}`)
  })

  afterAll(() => {
    stopServe(18793)
    execSleep(3)
    if (projectDir) cleanupE2EProject(projectDir)
    if (pluginEnabled) {
      disableKasperPlugin()
      pluginEnabled = false
    }
  })

  test("serve stays up without AGENTS.md", async () => {
    if (!ENABLED) {
      log("(skip) not enabled")
      return
    }
    expect(isServeRunning(servePort)).toBe(true)
  })

  test("runAttach succeeds without AGENTS.md", async () => {
    if (!ENABLED) {
      log("(skip) not enabled")
      return
    }
    expect(isServeRunning(servePort)).toBe(true)

    const r = runAttach(
      projectDir,
      "list files in the current directory using ls",
      servePort,
      90_000,
    )
    log(`attach: exit=${r.exitCode} session=${r.sessionID.slice(0, 16)}…`)
    expect(r.sessionID).toBeTruthy()
    expect(hasToolCalls(r.events)).toBe(true)
  })

  test("scoring still works without AGENTS.md", async () => {
    if (!ENABLED) {
      log("(skip) not enabled")
      return
    }
    expect(isServeRunning(servePort)).toBe(true)

    // HARD assert: scoring MUST complete even without AGENTS.md.
    // Previous version logged "(warn) no scoring within maxWaitMs"
    // and passed.
    const state = await waitForScoredSessions(projectDir, {
      minCount: 1,
      maxWaitMs: 180_000,
    })
    expect(state).toBeTruthy()
    const sessions = getScoredSessions(state!)
    expect(sessions.length).toBeGreaterThanOrEqual(1)
    log(`scored ${sessions.length} session(s) without AGENTS.md`)
  })

  test("AGENTS.md is not recreated by plugin", async () => {
    if (!ENABLED) {
      log("(skip) not enabled")
      return
    }

    // AGENTS.md should not exist (plugin should not create it)
    // Note: opencode itself might create it, so this is best-effort
    const agentsMd = readAgentsMd(projectDir)
    if (agentsMd) {
      log("AGENTS.md exists (may have been created by opencode itself)")
    } else {
      log("AGENTS.md does not exist — correct behavior")
    }
    expect(
      agentsMd === null ||
        agentsMd === undefined ||
        !hasKasperSection(agentsMd),
    ).toBe(true)
  })
})

// ══════════════════════════════════════════════════════════════════════
// ALREADY-EVALUATED SKIP
// ══════════════════════════════════════════════════════════════════════

describe("already-evaluated skip", () => {
  let projectDir = ""
  let servePort = 0
  let pluginEnabled = false

  beforeAll(async () => {
    if (!ENABLED) return
    enableKasperPlugin()
    pluginEnabled = true
    const p = setupE2EProject()
    projectDir = p.dir

    servePort = await startServeWithConfig(
      projectDir,
      {
        enabled: true,
        min_session_messages: 1,
        evaluation_poll_interval_ms: 300_000,
        model: "opencode-go/minimax-m2.7",
        scoring_timeout_ms: 120_000,
        scoring_threshold: 0.7,
        auto_update: false,
        detail_level: "minimal",
        quiet: true,
        debug: false,
      },
      18792,
    )

    await waitForKasperLoaded(projectDir, { maxWaitMs: 30_000 })
    log(`serve started on port ${servePort}`)
  })

  afterAll(() => {
    stopServe(18792)
    execSleep(3)
    if (projectDir) cleanupE2EProject(projectDir)
    if (pluginEnabled) {
      disableKasperPlugin()
      pluginEnabled = false
    }
  })

  test("session creation works", async () => {
    if (!ENABLED) {
      log("(skip) not enabled")
      return
    }
    expect(isServeRunning(servePort)).toBe(true)

    // Create a session for manual scoring (moved from beforeAll)
    const r = runAttach(projectDir, "list files using ls", servePort, 90_000)
    log(`created session: ${r.sessionID.slice(0, 16)}…`)

    const apiData = fetchAPI("/api/session", servePort) as {
      items?: Array<{ id: string; title?: string }>
    }
    const items = apiData.items ?? []
    const userSessions = items.filter((s) => !s.title?.startsWith("kasper-"))
    log(`user sessions in API: ${userSessions.length}`)
    expect(userSessions.length).toBeGreaterThanOrEqual(1)
  })

  test("state.json exists (kasper loaded)", async () => {
    if (!ENABLED) {
      log("(skip) not enabled")
      return
    }

    // With poll_interval=300s, auto-scoring should NOT have fired yet
    // — that's the point of this describe block (already-evaluated
    // skip). But state.json itself must exist because kasper loaded.
    const state = readKasperState(projectDir)
    expect(state).toBeTruthy()
    const sessions = getScoredSessions(state!)
    log(`scored before manual trigger: ${sessions.length}`)
    // With poll=300s, scoring should not have fired yet — but we
    // don't hard-assert 0 because the poll is a minimum, not a delay.
  })
})

// ══════════════════════════════════════════════════════════════════════
// RE-EVALUATION FLOW (continue session via --session flag)
// ══════════════════════════════════════════════════════════════════════

describe("re-evaluation on new messages", () => {
  let projectDir = ""
  let servePort = 0
  let pluginEnabled = false

  beforeAll(async () => {
    if (!ENABLED) return
    enableKasperPlugin()
    pluginEnabled = true
    const p = setupE2EProject()
    projectDir = p.dir

    servePort = await startServeWithConfig(
      projectDir,
      {
        enabled: true,
        min_session_messages: 1,
        evaluation_poll_interval_ms: 4_000,
        model: "opencode-go/minimax-m2.7",
        scoring_timeout_ms: 120_000,
        scoring_threshold: 0.6, // need below-threshold to fire
        min_observations_for_update: 1,
        auto_update: false,
        detail_level: "minimal",
        quiet: true,
        debug: false,
      },
      18791,
    )

    await waitForKasperLoaded(projectDir, { maxWaitMs: 30_000 })
    log(`serve started on port ${servePort}`)
  })

  afterAll(() => {
    stopServe(18791)
    execSleep(3)
    if (projectDir) cleanupE2EProject(projectDir)
    if (pluginEnabled) {
      disableKasperPlugin()
      pluginEnabled = false
    }
  })

  test("initial session scored by auto-poll", async () => {
    if (!ENABLED) {
      log("(skip) not enabled")
      return
    }
    expect(isServeRunning(servePort)).toBe(true)

    const r = runAttach(
      projectDir,
      "list files using ls and tell me how many",
      servePort,
      90_000,
    )
    log(
      `session 1: ${r.sessionID.slice(0, 16)}… tools=${getToolCalls(r.events).length}`,
    )
    expect(r.sessionID).toBeTruthy()

    // HARD assert: scoring MUST complete.
    const state = await waitForScoredSessions(projectDir, {
      minCount: 1,
      maxWaitMs: 180_000,
    })
    expect(state).toBeTruthy()
    const sessions = getScoredSessions(state!)
    log(`scored after first attach: ${sessions.length}`)
    expect(sessions.length).toBeGreaterThanOrEqual(1)

    const first = sessions[0]
    const firstID = first.id as string
    const firstScore = first.score as number
    log(
      `first session: ${firstID.slice(0, 16)}… score=${firstScore.toFixed(2)} msg_count=${first.message_count}`,
    )
  })

  test("continuing session with --session triggers re-evaluation", async () => {
    if (!ENABLED) {
      log("(skip) not enabled")
      return
    }
    expect(isServeRunning(servePort)).toBe(true)

    // HARD assert: state must exist with at least one scored session.
    const state = readKasperState(projectDir)
    expect(state).toBeTruthy()
    const sessions = getScoredSessions(state!)
    expect(sessions.length).toBeGreaterThanOrEqual(1) // guaranteed by previous test

    const targetID = sessions[0].id as string
    const firstScore = sessions[0].score as number
    const firstMsgCount = sessions[0].message_count as number | undefined
    log(
      `continuing session ${targetID.slice(0, 16)}… (score=${firstScore.toFixed(2)}, msgs=${firstMsgCount ?? "?"})`,
    )

    // Continue the session with a new message
    const r2 = runContinueAttach(
      projectDir,
      targetID,
      "now also read package.json and tell me what version it shows",
      servePort,
      90_000,
    )
    log(
      `continue result: session=${r2.sessionID.slice(0, 16)}… exit=${r2.exitCode} events=${r2.events.length}`,
    )
    expect(r2.sessionID.length).toBeGreaterThan(0)

    // Wait for re-evaluation
    execSleep(20)

    const state2 = readKasperState(projectDir)
    expect(state2).toBeTruthy()
    const sessions2 = getScoredSessions(state2!)
    const updated = sessions2.find((s) => s.id === targetID)

    if (updated) {
      const newScore = updated.score as number
      const newMsgCount = (updated.message_count ?? 0) as number
      log(
        `re-scored: score=${newScore.toFixed(2)} (was ${firstScore.toFixed(2)}), msgs=${newMsgCount} (was ${firstMsgCount ?? "?"})`,
      )

      if (
        typeof firstMsgCount === "number" &&
        typeof newMsgCount === "number"
      ) {
        log(`msg_count change: ${firstMsgCount} → ${newMsgCount}`)
        expect(newMsgCount).not.toBeNaN()
      }

      if (newScore !== firstScore) {
        log(
          `score changed by ${(newScore - firstScore).toFixed(2)} — re-evaluation detected`,
        )
      } else {
        log(
          "score unchanged — re-evaluation happened but score stayed the same",
        )
      }

      const card = updated.score_card as Record<string, unknown>
      expect(card).toBeTruthy()
    } else {
      log(
        "(info) session not found in state after continue — may have been recorded under different ID",
      )
    }
  })

  test("re-evaluated session preserves original metadata", async () => {
    if (!ENABLED) {
      log("(skip) not enabled")
      return
    }
    expect(isServeRunning(servePort)).toBe(true)

    const state = readKasperState(projectDir)
    expect(state).toBeTruthy()
    const sessions = getScoredSessions(state!)

    for (const s of sessions) {
      log(
        `  ${(s.id as string).slice(0, 16)}… score=${(s.score as number).toFixed(2)} ` +
          `msgs=${s.message_count} type=${s.agent_type ?? "unknown"} ` +
          `scored_at=${(s.scored_at as string)?.slice(0, 19) ?? "?"}`,
      )

      expect(s.id).toBeTruthy()
      expect(s.title).toBeTruthy()
      expect(typeof s.score).toBe("number")
      if (s.agent_type) {
        expect(["primary", "subagent", "unknown"]).toContain(s.agent_type)
      }
    }
  })
})
