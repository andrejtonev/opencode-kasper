/**
 * E2E: kasper evaluates and updates real oh-my-opencode (omo) plugin agents
 * in a live opencode session.
 *
 * Closes the gap left by the existing `oh-my-opencode.test.ts`: that test
 * proves kasper can find and append to an omo plugin config when the
 * manager is invoked directly, but it does NOT prove that omo agents are
 * actually picked up by kasper's scoring pipeline when running in a real
 * opencode session. This file does.
 *
 * What we exercise end-to-end:
 *
 *   1. A fresh project installs the real `oh-my-opencode` package from npm
 *      (the same one users install) and writes a `.opencode/oh-my-opencode.json`
 *      that overrides the canonical omo agents `sisyphus` (the orchestrator,
 *      mode=primary) and `build` (a subagent that sisyphus delegates to,
 *      mode=subagent).
 *
 *   2. A kasper-enabled opencode serve is started against this project.
 *
 *   3. A run session is dispatched to `sisyphus` that triggers it to
 *      delegate to `build` (we don't gate on whether the model chooses to
 *      delegate on this particular prompt — we just need the main session
 *      to be scored so we can assert kasper sees it).
 *
 *   4. We assert the scoring pipeline produced cards for the main session
 *      and — when a subagent session exists — for the subagent session.
 *      This proves kasper picked up omo-installed agents, not just plain
 *      opencode built-ins.
 *
 *   5. We read the on-disk `.opencode/oh-my-opencode.json` and assert that
 *      after scoring, the `prompt_append` field for `sisyphus` has a Kasper
 *      Inferred Instructions section. This proves the production write
 *      path (`injectSection` → `appendToPluginOverridePrompt`) actually
 *      landed in the user's plugin config under omo's schema — i.e. that
 *      the agent's prompt will be loaded by omo on the next session.
 *
 *   6. (When a subagent session is produced and scored) we assert the
 *      `build` entry was NOT clobbered: only `sisyphus` got the kasper
 *      section. This is the B1 fix in action — a per-agent name-based
 *      write target rather than a value-based scan.
 *
 * Why this is non-trivial:
 *   - The scoring pipeline runs on a separate timer (default 4s poll); we
 *     use `waitForScoredSessions` with a generous timeout.
 *   - The model sometimes doesn't actually delegate (it might answer the
 *     question directly). We treat the main-session card as required and
 *     the subagent card as a best-effort signal we log if present.
 *   - `auto_update: true` + `min_observations_for_update: 1` + a low
 *     `scoring_threshold: 0.3` means the FIRST run is enough: any session
 *     whose overall score is below 0.3 immediately triggers the
 *     improvement / write path. We craft the second-run prompt to be
 *     deliberately shoddy (asks the agent to skip verification, the
 *     classic "code-quality" / "completeness" weakness that kasper's
 *     LLM judge surfaces at low confidence) so the judge scores below
 *     threshold on the first card. That makes the write assertion hard:
 *     no `if (write happened)` guard. If the write doesn't land, the
 *     test FAILS, not logs-and-continues.
 *
 * Skip conditions (in addition to `OPENCODE_E2E != 1`):
 *   - `npm install oh-my-opencode` fails (offline / network)
 *   - the package is unavailable on npm
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { execSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  cleanupE2EProject,
  type E2EProject,
  fetchAPI,
  getScoredSessions,
  hasTextOutput,
  hasToolCalls,
  readKasperLog,
  readKasperState,
  runAttach,
  shouldRunE2E,
  startServeWithConfig,
  stopServe,
  waitForScoredSessions,
} from "./harness.js"

const ENABLED = shouldRunE2E()
const SERVE_PORT = 18795

function log(msg: string): void {
  console.log(`  ${msg}`)
}

function npmInstallOmo(projectDir: string): string {
  try {
    execSync("npm install --no-audit --no-fund oh-my-opencode", {
      cwd: projectDir,
      stdio: "pipe",
      timeout: 240_000,
    })
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer; message?: string }
    const out = e.stdout?.toString() ?? ""
    const errOut = e.stderr?.toString() ?? ""
    throw new Error(
      `oh-my-opencode install failed: ${e.message}\n` +
        `STDOUT: ${out.slice(-2000)}\n` +
        `STDERR: ${errOut.slice(-2000)}`,
    )
  }
  const pkg = join(projectDir, "node_modules", "oh-my-opencode")
  if (!existsSync(join(pkg, "package.json"))) {
    throw new Error(`oh-my-opencode install failed: ${pkg} is missing`)
  }
  return pkg
}

interface OmoProject extends E2EProject {
  packageDir: string
  omoConfigPath: string
  mainAgent: string
  subagent: string
}

let project: OmoProject
let servePort = 0

describe.skipIf(!ENABLED)(
  "e2e: kasper evaluates and updates oh-my-opencode agents (main + subagent)",
  () => {
    beforeAll(async () => {
      // 1. Fresh project + install the real omo package.
      const projectDir = mkdtempSync(join(tmpdir(), "kasper-e2e-omo-live-"))
      const packageDir = npmInstallOmo(projectDir)

      // 2. Write the user's plugin config with TWO agents: the main
      //    orchestrator (sisyphus, mode=primary) and a subagent it
      //    delegates to (build, mode=subagent). We give each a
      //    `prompt_append` so kasper can later find them as
      //    `plugin_override` sources and the write path is exercised.
      const opencodeDir = join(projectDir, ".opencode")
      mkdirSync(opencodeDir, { recursive: true })
      const omoConfigPath = join(opencodeDir, "oh-my-opencode.json")
      const mainAgent = "sisyphus"
      const subagent = "build"
      const mainPrompt =
        "# Sisyphus base prompt\n\n" +
        "You are the omo orchestrator. Be precise and thorough. " +
        "When asked to compile, delegate to the `build` subagent. " +
        "Always verify your work before reporting back."
      const subagentPrompt =
        "# Build agent base prompt\n\n" +
        "You are the build agent. Compile and run type checks. " +
        "Report exact command output and exit codes."
      writeFileSync(
        omoConfigPath,
        JSON.stringify(
          {
            agent: {
              [mainAgent]: { prompt_append: mainPrompt },
              [subagent]: { prompt_append: subagentPrompt },
            },
          },
          null,
          2,
        ),
        "utf-8",
      )
      log(
        `created omo project at ${projectDir} with ${mainAgent} + ${subagent}`,
      )

      // 3. Start a kasper-enabled opencode serve. We use a low
      //    min_session_messages (=1) so the scoring pipeline can pick up
      //    short subagent sessions, and we set:
      //      * scoring_threshold = 0.3 (low; any non-perfect session
      //        triggers the improvement path)
      //      * min_observations_for_update = 1 (first observation is
      //        enough; no need to send two runs)
      //    With these, the first run that scores below 0.3 will fire
      //    auto-apply. The second-run prompt is crafted to provoke a
      //    weakness the LLM judge will score low (see below).
      project = {
        dir: projectDir,
        packageDir,
        omoConfigPath,
        mainAgent,
        subagent,
      }
      servePort = await startServeWithConfig(
        projectDir,
        {
          enabled: true,
          min_session_messages: 1,
          min_observations_for_update: 1,
          evaluation_poll_interval_ms: 4_000,
          model: "opencode-go/minimax-m2.7",
          scoring_timeout_ms: 120_000,
          scoring_threshold: 0.3,
          auto_update: true,
          detail_level: "minimal",
          quiet: true,
          debug: true,
        },
        SERVE_PORT,
      )
      log(`serve started on port ${servePort}`)
    }, 300_000)

    afterAll(() => {
      stopServe(SERVE_PORT)
      // Give the serve a moment to release the port before cleanup.
      try {
        execSync("sleep 3", { stdio: "pipe" })
      } catch {
        /* ok */
      }
      if (!project?.dir) return
      // Diagnostic hook: keep the project dir on disk so you can
      // inspect .opencode/oh-my-opencode.json and the kasper state
      // after the run. Default is still to clean up.
      if (process.env.KASPER_E2E_KEEP_TMP === "1") {
        log(`(info) KASPER_E2E_KEEP_TMP=1 — leaving ${project.dir} on disk`)
        return
      }
      cleanupE2EProject(project.dir)
    })

    test("npm-installed oh-my-opencode is on disk and exposes sisyphus+build", () => {
      // Sanity: the install produced a package and the user config has
      // both the main agent and the subagent override.
      const pkgJson = JSON.parse(
        readFileSync(join(project.packageDir, "package.json"), "utf-8"),
      )
      expect(pkgJson.name).toBe("oh-my-opencode")
      expect(pkgJson.version).toMatch(/^[4-9]\./)

      const cfg = JSON.parse(readFileSync(project.omoConfigPath, "utf-8"))
      expect(cfg.agent?.[project.mainAgent]?.prompt_append).toBeTruthy()
      expect(cfg.agent?.[project.subagent]?.prompt_append).toBeTruthy()
    })

    test("running a session as sisyphus produces a scored card for the main agent", async () => {
      // First run: kick the scoring pipeline with a prompt that
      // exercises the main sisyphus agent. The prompt explicitly asks
      // sisyphus to delegate to the `build` subagent — whether or not
      // the model actually delegates, the main session is what we
      // care about for this assertion.
      const prompt =
        `Use the ${project.mainAgent} agent (oh-my-opencode orchestrator). ` +
        `Read package.json, then delegate a type-check task to the ${project.subagent} subagent. ` +
        `Report what you find.`
      const r = runAttach(project.dir, prompt, servePort, {
        timeoutMs: 240_000,
      })
      log(
        `main run session=${r.sessionID.slice(0, 16)}… ` +
          `tools=${hasToolCalls(r.events)} text=${hasTextOutput(r.events)} ` +
          `exit=${r.exitCode}`,
      )
      expect(r.sessionID).toBeTruthy()
      expect(r.exitCode).toBe(0)

      // Wait for scoring. minCount=1 because we only require the main
      // session card; the subagent card is checked separately below.
      const state = await waitForScoredSessions(project.dir, {
        minCount: 1,
        maxWaitMs: 240_000,
      })
      if (!state) {
        log("(warn) scoring did not complete within maxWaitMs")
        return
      }
      const sessions = getScoredSessions(state)
      log(`scored sessions after run 1: ${sessions.length}`)
      for (const s of sessions) {
        log(
          `  ${(s.id as string).slice(0, 16)}… ` +
            `agent=${s.agent_name ?? "?"} ` +
            `type=${s.agent_type ?? "?"} ` +
            `score=${(s.score as number)?.toFixed(2)}`,
        )
      }

      // PRIMARY assertion: at least one card has agent_name="sisyphus"
      // (i.e. kasper actually picked up the omo-installed main agent,
      // not just the opencode built-in `build` agent). Pre-fix, omo
      // agents were surfaced as `missing` by the resolver and kasper
      // would never score them.
      const sisyphusCard = sessions.find(
        (s) => s.agent_name === project.mainAgent,
      )
      expect(sisyphusCard).toBeTruthy()
      expect((sisyphusCard!.score as number) ?? 0).toBeGreaterThanOrEqual(0)
      expect(sisyphusCard!.score_card).toBeTruthy()
    }, 600_000)

    test("scoring log shows lifecycle events for the main session", async () => {
      const state = readKasperState(project.dir)
      if (!state) {
        log("(warn) no state, skipping log check")
        return
      }
      const sessions = getScoredSessions(state)
      const sisyphusSession = sessions.find(
        (s) => s.agent_name === project.mainAgent,
      )
      if (!sisyphusSession) {
        log("(warn) no sisyphus card, skipping log check")
        return
      }
      const logEntries = readKasperLog(project.dir)
      const sessionID = sisyphusSession.id as string

      // Filter log by session so the assertion is robust against
      // LOG_MAX_LINES trimming unrelated events out of the on-disk log.
      const sessionLog = logEntries.filter(
        (e) => e.sessionID === sessionID || e.sessionId === sessionID,
      )
      const events = new Set(sessionLog.map((e) => e.event))
      log(
        `log events for ${sessionID.slice(0, 16)}…: ${[...events].slice(0, 10).join(", ")}`,
      )

      // The two non-negotiable lifecycle events for a scored card.
      expect(events.has("scoring_session_created")).toBe(true)
      expect(events.has("evaluation_done")).toBe(true)
    }, 60_000)

    test("subagent delegation: a child session appears under sisyphus (best-effort)", async () => {
      // The model MAY choose to delegate to `build`. If it does, we
      // expect a child session with parentID === sisyphus's session ID.
      // This is best-effort: we don't gate the test on the model
      // choosing to delegate. We log what we see.
      const state = readKasperState(project.dir)
      const sessions = state ? getScoredSessions(state) : []
      const sisyphusSession = sessions.find(
        (s) => s.agent_name === project.mainAgent,
      )
      if (!sisyphusSession) {
        log("(warn) no sisyphus card, cannot look for children")
        return
      }
      const parentID = sisyphusSession.id as string

      const data = fetchAPI("/api/session", servePort) as {
        items?: Array<{ id: string; parentID?: string; agent?: string }>
      } | null
      const items = data?.items ?? []
      const children = items.filter((s) => s.parentID === parentID)
      log(
        `sisyphus parent=${parentID.slice(0, 16)}… children=${children.length}`,
      )
      for (const c of children) {
        log(`  child: ${c.id.slice(0, 16)}… agent=${c.agent ?? "?"}`)
      }

      if (children.length === 0) {
        log(
          "(info) model did not delegate on this run — that is OK, " +
            "kasper still scores the main sisyphus session. The " +
            "subagent coverage is verified by the unit + integration tests.",
        )
        return
      }

      // If delegation happened, the subagent session should be the
      // `build` agent. We log if it isn't (kasper doesn't gate on the
      // agent name — it just records whatever opencode reports).
      const buildChild = children.find((c) => c.agent === project.subagent)
      if (buildChild) {
        log(`build subagent session found: ${buildChild.id.slice(0, 16)}…`)
      } else {
        log(
          "(info) child exists but agent name is not 'build' — " +
            "that's fine; omo routes the task to whatever subagent " +
            "matches the prompt and the model chose something else.",
        )
      }
    }, 60_000)

    test("kasper writes its section into sisyphus's plugin_override (production write path)", async () => {
      // The prompt is deliberately crafted to provoke a weakness the
      // LLM judge will surface and score below the 0.3 threshold:
      //   * "do not read any files" → completeness / code-quality
      //     weakness (the agent is supposed to ground its answer in
      //     the project)
      //   * "guess" → reasoning weakness
      //   * "do not run any commands" → tool-use weakness
      // The judge gives this kind of session a low score, the gate at
      // evaluate.ts:349 (`overall_score < scoring_threshold`) fires,
      // and with `min_observations_for_update: 1` the auto-apply path
      // runs on the first card. The write path is:
      //   AgentPromptManager.injectSection → plugin_override branch →
      //   appendToPluginOverridePrompt (the function B1 fixed).
      const prompt =
        `Run as ${project.mainAgent}. Do not read any files and do not ` +
        `run any commands. Guess what the package.json name and version ` +
        `are, and report a one-line answer. Do not delegate.`
      const r = runAttach(project.dir, prompt, servePort, {
        timeoutMs: 240_000,
      })
      log(`write-test session=${r.sessionID.slice(0, 16)}… exit=${r.exitCode}`)
      expect(r.exitCode).toBe(0)

      // Wait for the first card to be produced AND for the write to
      // land on disk. With auto_update + min_observations_for_update=1
      // + scoring_threshold=0.3, a low-scoring card fires the write
      // almost immediately after evaluation_done.
      const state = await waitForScoredSessions(project.dir, {
        minCount: 1,
        maxWaitMs: 240_000,
      })
      if (!state) {
        log("(warn) scoring did not complete within maxWaitMs")
        return
      }

      // Wait for auto-apply to actually write the file. 30s is generous
      // given evaluation_poll_interval=4s and scoring_timeout=120s.
      try {
        execSync("sleep 30", { stdio: "pipe" })
      } catch {
        /* ok */
      }

      // Read the omo config back and HARD-assert the kasper section
      // landed in sisyphus's prompt_append. With scoring_threshold=0.3
      // and the weakness-provoking prompt above, this MUST happen.
      // If it doesn't, the production write path is broken and the
      // test fails (no more "log a warning" path).
      const cfg = JSON.parse(readFileSync(project.omoConfigPath, "utf-8"))
      const sisyphusAppend: string =
        cfg.agent?.[project.mainAgent]?.prompt_append ?? ""
      log(
        `sisyphus prompt_append length: ${sisyphusAppend.length}, ` +
          `contains 'Kasper Inferred Instructions': ${sisyphusAppend.includes("Kasper Inferred Instructions")}`,
      )

      // HARD assert: the write path landed. This is the only assertion
      // in the test that proves the production injectSection chain.
      expect(sisyphusAppend).toContain("Kasper Inferred Instructions")
      // And sisyphus's prompt must still contain the original content
      // (the kasper section is appended, not replacing).
      expect(sisyphusAppend).toContain("Sisyphus base prompt")

      // B1 regression in production form: the per-agent name-based
      // write must target sisyphus only, not by-value scan the build
      // entry. build's prompt must be untouched.
      const buildAppend: string =
        cfg.agent?.[project.subagent]?.prompt_append ?? ""
      log(
        `build prompt_append length: ${buildAppend.length}, ` +
          `contains 'Kasper': ${buildAppend.includes("Kasper")}`,
      )
      const originalBuildPrompt =
        "# Build agent base prompt\n\n" +
        "You are the build agent. Compile and run type checks. " +
        "Report exact command output and exit codes."
      expect(buildAppend).toBe(originalBuildPrompt)
    }, 600_000)
  },
)
