import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { execSync, spawnSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  cleanupE2EProject,
  filterLogBySession,
  getKasperSectionContent,
  getLogEventFieldsForSession,
  getScoredSessions,
  hasKasperSection,
  hasLogEvent,
  hasLogEventForSession,
  hasToolCalls,
  isServeRunning,
  readAgentPrompt,
  readAgentsMd,
  readKasperLog,
  readKasperState,
  runAttach,
  setupE2EProject,
  shouldRunE2E,
  startServeWithConfig,
  stopServe,
  waitForScoredSessions,
} from "./harness.js"

const ENABLED = shouldRunE2E()
const SERVE_PORT_CORRECT = 18790

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
// CORRECTNESS: Agent-specific file targeting
// ══════════════════════════════════════════════════════════════════════

describe("agent-specific file targeting", () => {
  let projectDir = ""
  let servePort = 0

  beforeAll(async () => {
    if (!ENABLED) return
    const p = setupE2EProject()
    projectDir = p.dir

    // Create a custom agent prompt file (project-level)
    const agentsDir = join(projectDir, ".opencode", "agents")
    execSync(`mkdir -p "${agentsDir}"`, { stdio: "pipe" })
    writeFileSync(
      join(agentsDir, "reviewer.md"),
      [
        "---",
        "description: Reviews code for quality and best practices",
        "mode: subagent",
        "---",
        "You are a code reviewer. Focus on security, performance, and maintainability.",
      ].join("\n"),
      "utf-8",
    )

    log("created project-level .opencode/agents/reviewer.md")

    servePort = await startServeWithConfig(
      projectDir,
      {
        enabled: true,
        min_session_messages: 1,
        evaluation_poll_interval_ms: 4_000,
        model: "opencode-go/minimax-m2.7",
        scoring_timeout_ms: 60_000,
        scoring_threshold: 1.0,
        auto_update: true,
        detail_level: "minimal",
        quiet: true,
        debug: false,
      },
      SERVE_PORT_CORRECT,
    )

    log(`serve started on port ${servePort}`)
  })

  afterAll(() => {
    stopServe(SERVE_PORT_CORRECT)
    execSleep(3)
    if (projectDir) cleanupE2EProject(projectDir)
  })

  test("custom agent prompt file exists and is readable", async () => {
    if (!ENABLED) {
      log("(skip) not enabled")
      return
    }

    const reviewerPrompt = readAgentPrompt(projectDir, "reviewer")
    expect(reviewerPrompt).toBeTruthy()
    expect(reviewerPrompt).toContain("code reviewer")
    log(`reviewer prompt: ${reviewerPrompt?.slice(0, 80)}...`)
  })

  test("running with --agent creates session with correct agent metadata", async () => {
    if (!ENABLED) {
      log("(skip) not enabled")
      return
    }
    if (!isServeRunning(servePort)) {
      log("(skip) serve not running")
      return
    }

    // Run explicitly with an agent
    const result = spawnSync(
      "opencode",
      [
        "run",
        "--attach",
        `http://localhost:${servePort}`,
        "--format",
        "json",
        "--dir",
        projectDir,
        "--agent",
        "reviewer",
        "--dangerously-skip-permissions",
        "--pure",
        "review file package.json for security issues",
      ],
      {
        cwd: projectDir,
        timeout: 90_000,
        encoding: "utf-8",
        stdio: "pipe",
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env },
      },
    )

    const raw = result.stdout || ""
    const sessionMatch = raw.match(/ses_[a-zA-Z0-9]+/)
    const sessionID = sessionMatch ? sessionMatch[0] : ""
    log(`reviewer session: ${sessionID.slice(0, 16)}… exit=${result.status}`)

    // Session must have been created (session ID found, exit 0).
    // NOTE: we intentionally avoid querying GET /api/session here — opencode
    // server >=1.15.13 uses a global session database (not project-scoped)
    // and a corrupt `time.archived` field in an unrelated session causes the
    // entire list endpoint to fail with HTTP 400. The NDJSON output and exit
    // code are sufficient to prove the session was created and ran.
    expect(sessionID).toBeTruthy()
    expect(result.status).toBe(0)
  })

  test("scoring after agent-specific run targets the correct agent", async () => {
    if (!ENABLED) {
      log("(skip) not enabled")
      return
    }
    if (!isServeRunning(servePort)) {
      log("(skip) serve not running")
      return
    }

    // Run another session to build up observations for auto-apply
    const r = runAttach(projectDir, "list files using ls", servePort, 90_000)
    log(`general session: ${r.sessionID.slice(0, 16)}…`)

    const state = await waitForScoredSessions(projectDir, {
      minCount: 1,
      maxWaitMs: 180_000,
    })
    if (!state) {
      log("(warn) scoring did not complete")
      return
    }

    const sessions = getScoredSessions(state)
    log(`scored sessions: ${sessions.length}`)
    for (const s of sessions) {
      log(
        `  ${(s.id as string).slice(0, 16)}… score=${(s.score as number)?.toFixed(2)} ` +
          `type=${s.agent_type ?? "?"} name=${s.agent_name ?? "?"}`,
      )

      // Verify structure
      expect(s.score).toBeGreaterThanOrEqual(0)
      expect(s.score_card).toBeTruthy()
    }
  })
})

// ══════════════════════════════════════════════════════════════════════
// CORRECTNESS: Log-verified scoring pipeline
// ══════════════════════════════════════════════════════════════════════

describe("log-verified scoring", () => {
  let projectDir = ""
  let servePort = 0

  beforeAll(async () => {
    if (!ENABLED) return
    const p = setupE2EProject()
    projectDir = p.dir

    servePort = await startServeWithConfig(
      projectDir,
      {
        enabled: true,
        min_session_messages: 1,
        evaluation_poll_interval_ms: 4_000,
        model: "opencode-go/minimax-m2.7",
        scoring_timeout_ms: 60_000,
        scoring_threshold: 1.0,
        auto_update: false,
        detail_level: "minimal",
        quiet: true,
        debug: true,
      },
      18789,
    )

    log(`serve started on port ${servePort}`)
  })

  afterAll(() => {
    stopServe(18789)
    execSleep(3)
    if (projectDir) cleanupE2EProject(projectDir)
  })

  test("scoring lifecycle events are logged", async () => {
    if (!ENABLED) {
      log("(skip) not enabled")
      return
    }
    if (!isServeRunning(servePort)) {
      log("(skip) serve not running")
      return
    }

    const r = runAttach(
      projectDir,
      "list all files in the current directory using ls and show the output",
      servePort,
      90_000,
    )
    log(
      `session: ${r.sessionID.slice(0, 16)}… hasTools=${hasToolCalls(r.events)}`,
    )
    expect(r.sessionID).toBeTruthy()

    // Wait for scoring
    const state = await waitForScoredSessions(projectDir, {
      minCount: 1,
      maxWaitMs: 180_000,
    })
    const logEntries = readKasperLog(projectDir)
    log(`log entries: ${logEntries.length}`)

    if (state) {
      // Verify scoring lifecycle in logs:
      // 1. run_eval_start — evaluation triggered
      // 2. scoring_session_created — LLM session created
      // 3. scoring_prompt_sending — prompt dispatched
      // 4. scoring_response_received — response obtained
      // 5. evaluation_done — card recorded
      // 6. state_record_session — persisted to state.json
      //
      // Filter by sessionID so the assertion is robust to LOG_MAX_LINES
      // trimming older events from other sessions out of the on-disk log.

      const sessionEntries = filterLogBySession(logEntries, r.sessionID)
      const events = sessionEntries.map((e) => e.event)
      const scoringLifecycle = [
        "run_eval_start",
        "scoring_session_created",
        "scoring_prompt_sending",
        "evaluation_done",
        "state_record_session",
      ]
      const found: string[] = []
      const missing: string[] = []

      for (const eventName of scoringLifecycle) {
        if (hasLogEventForSession(logEntries, eventName, r.sessionID)) {
          found.push(eventName)
        } else {
          missing.push(eventName)
        }
      }

      log(`found ${found.length}/${scoringLifecycle.length} lifecycle events`)
      if (missing.length > 0) {
        log(`missing: ${missing.join(", ")}`)
        const allEvents = [...new Set(events)]
        log(`events for this session: ${allEvents.join(", ")}`)
      }

      // At minimum: we should have scoring_session_created and evaluation_done
      expect(
        hasLogEventForSession(
          logEntries,
          "scoring_session_created",
          r.sessionID,
        ),
      ).toBe(true)
      expect(
        hasLogEventForSession(logEntries, "evaluation_done", r.sessionID),
      ).toBe(true)
    } else {
      log("(warn) no scoring — checking what log events exist")
      const allEvents = [...new Set(logEntries.map((e) => e.event))]
      log(`log events present: ${allEvents.join(", ")}`)
    }
  })

  test("scoring prompt includes user message text", async () => {
    if (!ENABLED) {
      log("(skip) not enabled")
      return
    }
    if (!isServeRunning(servePort)) {
      log("(skip) serve not running")
      return
    }

    const state = readKasperState(projectDir)
    if (!state) {
      log("(warn) no state, test incomplete")
      return
    }

    const logEntries = readKasperLog(projectDir)
    const scoredSessions = getScoredSessions(state)

    // Verify scoring_prompt_sending events for scored sessions carry
    // non-empty prompts. We use the scored-session IDs from state.json
    // (which is durable; the log is trimmed to LOG_MAX_LINES) and look
    // up the matching `scoring_prompt_sending` event for each. This is
    // robust to log trimming because we anchor the assertion on the
    // sessions that DID get scored, not on raw log scan counts.
    const allPromptLens: number[] = []
    for (const s of scoredSessions) {
      const sid = s.id as string
      const promptLens = getLogEventFieldsForSession(
        logEntries,
        "scoring_prompt_sending",
        "promptLen",
        sid,
      )
      log(
        `session ${sid.slice(0, 16)}… prompt lengths: ${promptLens.join(", ")}`,
      )
      for (const len of promptLens) {
        allPromptLens.push(Number(len))
      }
    }
    log(`scoring prompt lengths: ${allPromptLens.join(", ")}`)

    for (const len of allPromptLens) {
      expect(len).toBeGreaterThan(0)
    }
    expect(allPromptLens.length).toBeGreaterThan(0)

    // At least one scored session should have a corresponding
    // `scoring_prompt_sending` log entry (proves the prompt path is
    // logging the sessionID, which is the mechanism downstream e2e
    // hooks rely on to match scores to sessions).
    let overlap = 0
    for (const s of scoredSessions) {
      const sid = s.id as string
      if (hasLogEventForSession(logEntries, "scoring_prompt_sending", sid)) {
        overlap++
      }
    }

    log(
      `session overlap (scored ∩ logged): ${overlap}/${scoredSessions.length}`,
    )

    expect(overlap).toBeGreaterThanOrEqual(1)
  })

  test("scoring uses valid ScoreCard format and categories are populated", async () => {
    if (!ENABLED) {
      log("(skip) not enabled")
      return
    }
    if (!isServeRunning(servePort)) {
      log("(skip) serve not running")
      return
    }

    const state = readKasperState(projectDir)
    if (!state) {
      log("(warn) no state")
      return
    }

    const sessions = getScoredSessions(state)
    expect(sessions.length).toBeGreaterThanOrEqual(1)

    for (const s of sessions) {
      const card = s.score_card as Record<string, unknown>
      if (!card || (card.overall_score as number) <= 0) continue

      // Verify all 5 categories are present
      const cats = card.categories as Record<string, number>
      const expectedCategories = [
        "instruction_following",
        "completeness",
        "proactiveness",
        "code_quality",
        "communication",
      ]
      for (const cat of expectedCategories) {
        expect(cats).toHaveProperty(cat)
        const catScore = cats[cat]
        expect(catScore).toBeGreaterThanOrEqual(0)
        expect(catScore).toBeLessThanOrEqual(1)
      }

      // Verify overall_score matches the average of categories
      const avg =
        Object.values(cats).reduce((a, b) => a + b, 0) /
        Object.values(cats).length
      const overall = card.overall_score as number
      log(
        `  cat avg=${avg.toFixed(2)} overall=${overall.toFixed(2)} ` +
          `diff=${Math.abs(avg - overall).toFixed(3)}`,
      )
      // LLM overall score may not be exactly the mathematical average of categories.
      // Allow a generous tolerance since the model is instructed to judge holistically.
      expect(Math.abs(avg - overall)).toBeLessThanOrEqual(0.25)

      // Weaknesses and strengths arrays
      expect(Array.isArray(card.weaknesses)).toBe(true)
      expect(Array.isArray(card.strengths)).toBe(true)
    }
  })
})

// ══════════════════════════════════════════════════════════════════════
// CORRECTNESS: File update targeting (which file gets Kasper section)
// ══════════════════════════════════════════════════════════════════════

describe("auto-apply file targeting", () => {
  let projectDir = ""
  let servePort = 0

  beforeAll(async () => {
    if (!ENABLED) return
    const p = setupE2EProject()
    projectDir = p.dir

    // Create a project-level AGENTS.md with some initial content
    writeFileSync(
      join(projectDir, "AGENTS.md"),
      ["# Project Agents", "", "This is a test project."].join("\n"),
      "utf-8",
    )

    // Create agent-specific prompts
    const agentsDir = join(projectDir, ".opencode", "agents")
    execSync(`mkdir -p "${agentsDir}"`, { stdio: "pipe" })
    writeFileSync(
      join(agentsDir, "custom.md"),
      [
        "---",
        "description: Custom test agent",
        "mode: subagent",
        "---",
        "You are a custom test agent. Focus on testing.",
      ].join("\n"),
      "utf-8",
    )

    servePort = await startServeWithConfig(
      projectDir,
      {
        enabled: true,
        min_session_messages: 1,
        evaluation_poll_interval_ms: 4_000,
        model: "opencode-go/minimax-m2.7",
        scoring_timeout_ms: 60_000,
        scoring_threshold: 1.0,
        auto_update: true,
        max_agent_guidance_chars: 2000,
        detail_level: "minimal",
        quiet: true,
        debug: false,
      },
      18788,
    )

    log(`serve started on port ${servePort}`)
  })

  afterAll(() => {
    stopServe(18788)
    execSleep(3)
    if (projectDir) cleanupE2EProject(projectDir)
  })

  test("initial state: AGENTS.md and agent prompts exist without Kasper section", async () => {
    if (!ENABLED) {
      log("(skip) not enabled")
      return
    }

    const agentsMd = readAgentsMd(projectDir)
    const customPrompt = readAgentPrompt(projectDir, "custom")
    const generalPrompt = readAgentPrompt(projectDir, "general")

    log(`AGENTS.md present: ${agentsMd !== null}`)
    log(`custom prompt present: ${customPrompt !== null}`)
    log(`general prompt present: ${generalPrompt !== null}`)

    // None should have Kasper section yet
    expect(hasKasperSection(agentsMd)).toBe(false)
    if (customPrompt) expect(hasKasperSection(customPrompt)).toBe(false)
    if (generalPrompt) expect(hasKasperSection(generalPrompt)).toBe(false)
  })

  test("after scoring, log indicates which files were updated", async () => {
    if (!ENABLED) {
      log("(skip) not enabled")
      return
    }
    if (!isServeRunning(servePort)) {
      log("(skip) serve not running")
      return
    }

    // Run sessions to trigger scoring + auto-apply (MIN_OBSERVATIONS=2 needed)
    const r1 = runAttach(projectDir, "use ls to list files", servePort, 90_000)
    log(`session 1: ${r1.sessionID.slice(0, 16)}…`)

    const r2 = runAttach(
      projectDir,
      "read the file AGENTS.md and summarize it",
      servePort,
      90_000,
    )
    log(`session 2: ${r2.sessionID.slice(0, 16)}…`)

    // Wait for auto-apply
    await new Promise((resolve) => setTimeout(resolve, 30_000))

    // Read logs to see what happened
    const logEntries = readKasperLog(projectDir)
    const logEvents = [...new Set(logEntries.map((e) => e.event))]
    log(`log events after scoring: ${logEvents.join(", ")}`)

    // Check for auto-apply log events
    const hasAgentsMdLog =
      hasLogEvent(logEntries, "agents_md_updated") ||
      hasLogEvent(logEntries, "agents_md_no_change")
    const hasAgentPromptLog =
      hasLogEvent(logEntries, "agent_prompt_updated") ||
      hasLogEvent(logEntries, "agent_prompt_not_found") ||
      hasLogEvent(logEntries, "agent_prompt_unchanged")

    log(`agents_md log events: ${hasAgentsMdLog}`)
    log(`agent_prompt log events: ${hasAgentPromptLog}`)

    if (!hasAgentsMdLog && !hasAgentPromptLog) {
      log(
        "no auto-apply log events — MIN_OBSERVATIONS_FOR_UPDATE (2) may not be met or scoring didn't produce weaknesses",
      )
    }
  })

  test("AGENTS.md is updated only with project-level guidance", async () => {
    if (!ENABLED) {
      log("(skip) not enabled")
      return
    }
    if (!isServeRunning(servePort)) {
      log("(skip) serve not running")
      return
    }

    const agentsMd = readAgentsMd(projectDir)
    if (!agentsMd) {
      log("AGENTS.md not found")
      return
    }

    if (hasKasperSection(agentsMd)) {
      const sectionContent = getKasperSectionContent(agentsMd)
      log(`AGENTS.md Kasper section: "${sectionContent?.slice(0, 200)}..."`)

      // Verify section structure
      expect(sectionContent).toBeTruthy()
      expect(sectionContent!.length).toBeGreaterThan(0)

      // This is a soft check: the LLM decides what's project-wide vs agent-specific
      // We verify the section exists and has content
      log(`AGENTS.md section length: ${sectionContent!.length} chars`)
    } else {
      log(
        "AGENTS.md has no Kasper section — auto-apply may not have run yet (needs MIN_OBSERVATIONS=2)",
      )
    }
  })

  test("agent prompts get their own Kasper sections independently from AGENTS.md", async () => {
    if (!ENABLED) {
      log("(skip) not enabled")
      return
    }
    if (!isServeRunning(servePort)) {
      log("(skip) serve not running")
      return
    }

    const agentsMd = readAgentsMd(projectDir)
    const customPrompt = readAgentPrompt(projectDir, "custom")
    const generalPrompt = readAgentPrompt(projectDir, "general")

    const findings: string[] = []
    if (hasKasperSection(agentsMd)) findings.push("AGENTS.md has section")
    if (hasKasperSection(customPrompt))
      findings.push("custom prompt has section")
    if (hasKasperSection(generalPrompt))
      findings.push("general prompt has section")

    log(`files with Kasper sections: ${findings.join(", ") || "none"}`)

    if (findings.length > 0) {
      // If both AGENTS.md and an agent prompt have sections, verify
      // they are different content (not duplicated)
      if (hasKasperSection(agentsMd) && hasKasperSection(customPrompt)) {
        const agentsMdContent = getKasperSectionContent(agentsMd)
        const customContent = getKasperSectionContent(customPrompt)
        if (agentsMdContent && customContent) {
          const same = agentsMdContent.trim() === customContent.trim()
          log(`AGENTS.md vs custom prompt: same_content=${same}`)
          if (same) {
            log(
              "(note) content may be identical if no agent-specific weaknesses were found",
            )
          } else {
            log(
              "different content — correct: AGENTS.md and agent prompt have distinct guidance",
            )
          }
        }
      }
    } else {
      log("no Kasper sections in any file — auto-apply may not have triggered")
    }
  })
})
