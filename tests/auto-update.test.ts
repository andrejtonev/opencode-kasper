import { describe, expect, mock, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import KasperPlugin from "../src/index.js"
import { flushKasperState } from "../src/registry.js"

function tmpDir(): string {
  return join(tmpdir(), `kasper-au-${randomBytes(6).toString("hex")}`)
}

function makeClient(structuredOutput?: Record<string, unknown>) {
  const output = structuredOutput ?? {
    overall_score: 0.85,
    categories: {
      instruction_following: 0.9,
      completeness: 0.8,
      proactiveness: 0.7,
      code_quality: 0.9,
      communication: 0.8,
    },
    strengths: ["clear code", "good explanation"],
    weaknesses: ["response could be faster"],
  }
  const json = JSON.stringify(output)
  return {
    session: {
      create: mock(() => Promise.resolve({ data: { id: "scoring-session" } })),
      prompt: mock(() =>
        Promise.resolve({
          data: {
            parts: [{ type: "text", text: json }],
          },
        }),
      ),
      delete: mock(() => Promise.resolve()),
      list: mock(() => Promise.resolve({ data: [] })),
      messages: mock((args: any) => {
        const sid = args?.path?.id || "unknown"
        return Promise.resolve({
          data: [
            {
              info: { id: `${sid}-u1`, role: "user", sessionID: sid },
              parts: [{ type: "text", text: "original request" }],
            },
            {
              info: { id: `${sid}-a1`, role: "assistant", sessionID: sid },
              parts: [{ type: "text", text: "response" }],
            },
          ],
        })
      }),
    },
    tui: { showToast: mock(() => {}) },
  }
}

function makeLowScoreClient(overrides?: Partial<Record<string, unknown>>) {
  const base: Record<string, unknown> = {
    overall_score: 0.4,
    categories: {
      instruction_following: 0.5,
      completeness: 0.4,
      proactiveness: 0.3,
      code_quality: 0.4,
      communication: 0.4,
    },
    strengths: ["clear code"],
    weaknesses: ["does not write tests", "missing error handling"],
  }
  const output = { ...base, ...overrides }
  return makeClient(output)
}

async function fullSession(
  dir: string,
  hooks: any,
  sessionID: string,
  agentName?: string,
  userMsg = "implement feature X",
): Promise<void> {
  const event: any = { properties: { info: {} } }
  if (agentName) event.properties.info.agent = agentName
  await hooks["session.created"]({ sessionID, event })

  await hooks["chat.message"](
    { sessionID },
    { message: { role: "user", parts: [{ type: "text", text: userMsg }] } },
  )
  await hooks["chat.message"](
    { sessionID },
    {
      message: {
        role: "assistant",
        parts: [{ type: "text", text: "here is the implementation" }],
      },
    },
  )
  await hooks.event({ event: { type: "session.idle", sessionID } })

  const scoreOut: any = {}
  await hooks["command.execute.before"](
    { command: "kasper", argument: `score session ${sessionID}`, sessionID },
    scoreOut,
  )

  await flushKasperState(dir)
}

async function setupTestDir(opts?: {
  autoUpdate?: boolean
  scoringThreshold?: number
}): Promise<string> {
  const dir = tmpDir()
  await mkdir(join(dir, ".opencode"), { recursive: true })
  const autoUpdate = opts?.autoUpdate ?? true
  const threshold = opts?.scoringThreshold ?? 0.6
  const obsConfig: Record<string, unknown> = {
    enabled: true,
    auto_update: autoUpdate,
    scoring_threshold: threshold,
    min_session_messages: 1,
    min_observations_for_update: 2,
    // Pin inject mode to "section" so the assertions against
    // `## Kasper Inferred Instructions` are not overridden by a
    // developer's global kasper.jsonc that sets "inline".
    agent_prompt_inject_mode: "section",
  }
  await writeFile(
    join(dir, "opencode.json"),
    JSON.stringify({ kasper: obsConfig }),
    "utf-8",
  )
  return dir
}

describe("auto-update integration", () => {
  test("auto-update modifies AGENTS.md when no agent prompt exists", async () => {
    const dir = await setupTestDir({ autoUpdate: true, scoringThreshold: 0.6 })
    await writeFile(join(dir, "AGENTS.md"), "# Project Rules\nBe helpful.\n")

    // Client returns low score with AGENTS.md suggestion
    let _callCount = 0
    const client = makeClient()
    client.session.prompt = mock(() => {
      _callCount++
      const output = {
        overall_score: 0.4,
        categories: {
          instruction_following: 0.5,
          completeness: 0.4,
          proactiveness: 0.3,
          code_quality: 0.4,
          communication: 0.4,
        },
        strengths: ["clear code"],
        weaknesses: ["does not write tests", "missing error handling"],
        suggested_agents_md_update:
          "Always write unit tests for new functions.",
      }
      return Promise.resolve({
        data: {
          parts: [{ type: "text", text: JSON.stringify(output) }],
        },
      })
    })

    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    // Run 2 sessions to build weakness count to 2 (min_observations is hardcoded)
    await fullSession(
      dir,
      hooks,
      "au-test-1a",
      undefined,
      "write a hello world",
    )
    await fullSession(
      dir,
      hooks,
      "au-test-1b",
      undefined,
      "write a hello world 2",
    )

    await hooks.close()

    // Verify AGENTS.md was modified
    const agentsMd = await readFile(join(dir, "AGENTS.md"), "utf-8")
    expect(agentsMd).toContain("## Kasper Inferred Instructions")
    expect(agentsMd).toContain("Always write unit tests for new functions.")

    // Verify improvement was recorded in state
    const statePath = join(dir, ".opencode", "kasper", "state.json")
    const state = JSON.parse(await readFile(statePath, "utf-8"))
    expect(state.improvements_applied.length).toBeGreaterThanOrEqual(1)
    expect(state.improvements_applied[0].target).toBe("agents_md")

    // Verify backup was created
    const backupsDir = join(dir, ".opencode", "kasper", "backups", "AGENTS.md")
    const { readdir } = await import("node:fs/promises")
    const backupFiles = await readdir(backupsDir)
    const backupContent = await readFile(
      join(backupsDir, backupFiles[0]),
      "utf-8",
    )
    expect(backupContent).toContain("# Project Rules")

    await rm(dir, { recursive: true, force: true })
  })

  test("auto-update modifies agent prompt when it exists (priority over AGENTS.md)", async () => {
    const dir = await setupTestDir({ autoUpdate: true, scoringThreshold: 0.6 })
    await mkdir(join(dir, ".opencode", "agents"), { recursive: true })
    await writeFile(
      join(dir, ".opencode", "agents", "build.md"),
      "# Build Agent\nYou are a build agent.\n",
    )

    let _callCount = 0
    const client = makeClient()
    client.session.prompt = mock(() => {
      _callCount++
      const output = {
        overall_score: 0.4,
        categories: {
          instruction_following: 0.5,
          completeness: 0.4,
          proactiveness: 0.3,
          code_quality: 0.4,
          communication: 0.4,
        },
        strengths: ["clear code"],
        weaknesses: ["does not write tests", "missing error handling"],
        suggested_agent_prompt_update:
          "Always verify the build succeeds before reporting completion.",
        suggested_agents_md_update: "This should not be used.",
      }
      return Promise.resolve({
        data: {
          parts: [{ type: "text", text: JSON.stringify(output) }],
        },
      })
    })

    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    // Use a unique agent name so the test does not collide with any agent
    // defined in the developer's global opencode.json (the resolver now
    // honours {file:...} directives in global config).
    const buildAgent = `build-${randomBytes(4).toString("hex")}`
    await fullSession(
      dir,
      hooks,
      "au-test-2a",
      buildAgent,
      "build this project",
    )
    await fullSession(
      dir,
      hooks,
      "au-test-2b",
      buildAgent,
      "build this project 2",
    )

    await hooks.close()

    // Verify agent prompt was modified, not AGENTS.md
    const promptPath = join(dir, ".opencode", "agents", `${buildAgent}.md`)
    const promptContent = await readFile(promptPath, "utf-8")
    expect(promptContent).toContain("## Kasper Inferred Instructions")
    expect(promptContent).toContain(
      "Always verify the build succeeds before reporting completion.",
    )

    // Verify AGENTS.md was NOT created/modified
    try {
      await stat(join(dir, "AGENTS.md"))
      const agentsMd = await readFile(join(dir, "AGENTS.md"), "utf-8")
      expect(agentsMd).not.toContain(
        "Always verify the build succeeds before reporting completion.",
      )
    } catch {
      // AGENTS.md doesn't exist — that's fine
    }

    // Verify improvement recorded correctly
    const statePath = join(dir, ".opencode", "kasper", "state.json")
    const state = JSON.parse(await readFile(statePath, "utf-8"))
    expect(state.improvements_applied.length).toBeGreaterThanOrEqual(1)
    expect(state.improvements_applied[0].target).toBe("agent_prompt")
    expect(state.improvements_applied[0].agent_name).toBe(buildAgent)

    await rm(dir, { recursive: true, force: true })
  })

  test("auto_update: false queues improvements instead of applying", async () => {
    const dir = await setupTestDir({
      autoUpdate: false,
      scoringThreshold: 0.6,
    })
    await writeFile(join(dir, "AGENTS.md"), "# Project Rules\nBe helpful.\n")

    const client = makeLowScoreClient({
      suggested_agents_md_update: "Always write tests.",
    })

    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    await fullSession(dir, hooks, "au-test-3", undefined, "write some code")
    await hooks.close()

    // AGENTS.md should NOT be modified
    const agentsMd = await readFile(join(dir, "AGENTS.md"), "utf-8")
    expect(agentsMd).not.toContain("## Kasper Inferred Instructions")
    expect(agentsMd).not.toContain("Always write tests.")

    // State should have no improvements
    const statePath = join(dir, ".opencode", "kasper", "state.json")
    const state = JSON.parse(await readFile(statePath, "utf-8"))
    expect(state.improvements_applied.length).toBe(0)

    await rm(dir, { recursive: true, force: true })
  })

  test("/kasper auto on|off toggles session auto-update", async () => {
    const dir = await setupTestDir({
      autoUpdate: false,
      scoringThreshold: 0.6,
    })
    await writeFile(join(dir, "AGENTS.md"), "# Project Rules\nBe helpful.\n")

    const client = makeLowScoreClient({
      suggested_agents_md_update: "Always write tests.",
    })

    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    // Enable auto-update via command
    const out1: any = {}
    await hooks["command.execute.before"](
      { command: "kasper", argument: "auto on", sessionID: "toggle-test" },
      out1,
    )
    expect(out1.message).toContain("Auto-update enabled")

    // Run 2 sessions to build weakness count to 2
    await fullSession(dir, hooks, "au-test-4a", undefined, "write some code")
    await fullSession(dir, hooks, "au-test-4b", undefined, "write some code 2")
    await hooks.close()

    // AGENTS.md SHOULD be modified now
    const agentsMd = await readFile(join(dir, "AGENTS.md"), "utf-8")
    expect(agentsMd).toContain("## Kasper Inferred Instructions")
    expect(agentsMd).toContain("Always write tests.")

    // Verify improvement recorded
    const statePath = join(dir, ".opencode", "kasper", "state.json")
    const state = JSON.parse(await readFile(statePath, "utf-8"))
    expect(state.improvements_applied.length).toBeGreaterThanOrEqual(1)

    await rm(dir, { recursive: true, force: true })
  })

  test("auto-update creates agent prompt with frontmatter when none exists", async () => {
    const dir = await setupTestDir({ autoUpdate: true, scoringThreshold: 0.6 })
    // No agent prompt file exists

    let _callCount = 0
    const client = makeClient()
    client.session.prompt = mock(() => {
      _callCount++
      const output = {
        overall_score: 0.4,
        categories: {
          instruction_following: 0.5,
          completeness: 0.4,
          proactiveness: 0.3,
          code_quality: 0.4,
          communication: 0.4,
        },
        strengths: ["clear code"],
        weaknesses: ["does not write tests"],
        suggested_agent_prompt_update: "Include build logs in every response.",
      }
      return Promise.resolve({
        data: {
          parts: [{ type: "text", text: JSON.stringify(output) }],
        },
      })
    })

    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    // Use a unique agent name so the test does not collide with any agent
    // defined in the developer's global opencode.json (the resolver now
    // honours {file:...} directives in global config).
    const newBuildAgent = `build-${randomBytes(4).toString("hex")}`
    await fullSession(
      dir,
      hooks,
      "au-test-5a",
      newBuildAgent,
      "build this project",
    )
    await fullSession(
      dir,
      hooks,
      "au-test-5b",
      newBuildAgent,
      "build this project 2",
    )
    await hooks.close()

    // New agent prompt should be created with frontmatter
    const promptPath = join(dir, ".opencode", "agents", `${newBuildAgent}.md`)
    const promptContent = await readFile(promptPath, "utf-8")
    expect(promptContent).toContain("---")
    expect(promptContent).toContain("mode: subagent")
    expect(promptContent).toContain("## Kasper Inferred Instructions")
    expect(promptContent).toContain("Include build logs in every response.")

    await rm(dir, { recursive: true, force: true })
  })

  test("auto-update requires min_observations to trigger", async () => {
    const dir = await setupTestDir({
      autoUpdate: true,
      scoringThreshold: 0.6,
    })
    await writeFile(join(dir, "AGENTS.md"), "# Project Rules\nBe helpful.\n")

    const client = makeLowScoreClient({
      suggested_agents_md_update: "Write more tests.",
    })

    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    // First session — weakness count = 1, not enough (threshold is hardcoded to 2)
    await fullSession(dir, hooks, "au-test-6a", undefined, "code 1")

    // AGENTS.md should NOT be modified yet
    let agentsMd = await readFile(join(dir, "AGENTS.md"), "utf-8")
    expect(agentsMd).not.toContain("## Kasper Inferred Instructions")

    // Second session — weakness count = 2, now it triggers
    await fullSession(dir, hooks, "au-test-6b", undefined, "code 2")
    await hooks.close()

    agentsMd = await readFile(join(dir, "AGENTS.md"), "utf-8")
    expect(agentsMd).toContain("## Kasper Inferred Instructions")
    expect(agentsMd).toContain("Write more tests.")

    await rm(dir, { recursive: true, force: true })
  })

  test("auto-update does not apply rejected pattern weaknesses", async () => {
    const dir = await setupTestDir({ autoUpdate: true, scoringThreshold: 0.6 })
    await writeFile(join(dir, "AGENTS.md"), "# Project Rules\nBe helpful.\n")

    const client = makeLowScoreClient({
      suggested_agents_md_update: "Always handle edge cases.",
    })

    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    // Run 2 sessions to build weakness count to 2 and trigger auto-update
    await fullSession(dir, hooks, "au-test-7a", undefined, "simple code")
    await fullSession(dir, hooks, "au-test-7b", undefined, "simple code 2")
    await hooks.close()

    const agentsMd = await readFile(join(dir, "AGENTS.md"), "utf-8")
    expect(agentsMd).toContain("## Kasper Inferred Instructions")

    await rm(dir, { recursive: true, force: true })
  })

  test("auto-update respects subagent agentType and updates parent agent prompt", async () => {
    const dir = await setupTestDir({ autoUpdate: true, scoringThreshold: 0.6 })
    // Use a unique agent name so the test does not collide with any agent
    // defined in the developer's global opencode.json (the resolver now
    // honours {file:...} directives in global config).
    const agentName = `code-quality-${randomBytes(4).toString("hex")}`
    await mkdir(join(dir, ".opencode", "agents"), { recursive: true })
    await writeFile(
      join(dir, ".opencode", "agents", `${agentName}.md`),
      "# Code Quality Agent\nYou review code.\n",
    )

    const client = makeLowScoreClient({
      suggested_agent_prompt_update: "Flag all security issues.",
    })

    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    // Simulate two subagent sessions with the same agent to build count
    for (const sid of ["sub-1", "sub-2"]) {
      await hooks["session.created"]({
        sessionID: sid,
        event: {
          properties: {
            info: {
              agent: agentName,
              agentType: "subagent",
              parentSessionID: "parent-1",
            },
          },
        },
      })

      await hooks["chat.message"](
        { sessionID: sid },
        {
          message: {
            role: "user",
            parts: [{ type: "text", text: "review this code" }],
          },
        },
      )
      await hooks["chat.message"](
        { sessionID: sid },
        {
          message: {
            role: "assistant",
            parts: [{ type: "text", text: "code looks fine" }],
          },
        },
      )
      await hooks.event({ event: { type: "session.idle", sessionID: sid } })

      const scoreOut: any = {}
      await hooks["command.execute.before"](
        {
          command: "kasper",
          argument: `score session ${sid}`,
          sessionID: sid,
        },
        scoreOut,
      )
    }

    await flushKasperState(dir)
    await hooks.close()

    // Agent prompt should be updated
    const promptPath = join(dir, ".opencode", "agents", `${agentName}.md`)
    const promptContent = await readFile(promptPath, "utf-8")
    expect(promptContent).toContain("## Kasper Inferred Instructions")
    expect(promptContent).toContain("Flag all security issues.")

    await rm(dir, { recursive: true, force: true })
  })

  test("auto-update preserves existing content in AGENTS.md", async () => {
    const dir = await setupTestDir({ autoUpdate: true, scoringThreshold: 0.6 })
    const originalContent = `# Project Rules

## Existing Section
Some existing rules here.

## Another Section
More content.
`
    await writeFile(join(dir, "AGENTS.md"), originalContent)

    const client = makeLowScoreClient({
      suggested_agents_md_update: "Always validate inputs.",
    })

    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    await fullSession(dir, hooks, "au-test-8a", undefined, "write code")
    await fullSession(dir, hooks, "au-test-8b", undefined, "write code 2")
    await hooks.close()

    const agentsMd = await readFile(join(dir, "AGENTS.md"), "utf-8")
    // Existing sections should be preserved
    expect(agentsMd).toContain("## Existing Section")
    expect(agentsMd).toContain("## Another Section")
    // New section should be added
    expect(agentsMd).toContain("## Kasper Inferred Instructions")
    expect(agentsMd).toContain("Always validate inputs.")

    await rm(dir, { recursive: true, force: true })
  })

  test("auto-update reroutes built-in 'build' agent prompt to AGENTS.md (no dead .opencode/agents/build.md)", async () => {
    // Regression: the default opencode 'build' agent has a hard-coded
    // prompt shipped with opencode. A bare markdown file at
    // `.opencode/agents/build.md` is NOT consulted by opencode — the file
    // is only loaded when `agent.build.prompt` in `opencode.json` is set
    // to `{file:...}` or an inline string. If kasper blindly writes a
    // file at the conventional path, the improvement is silently
    // ignored. The fix reroutes to AGENTS.md (the rules file the
    // built-in agents actually read).
    const dir = await setupTestDir({ autoUpdate: true, scoringThreshold: 0.6 })
    await writeFile(join(dir, "AGENTS.md"), "# Project Rules\nBe helpful.\n")
    // No `.opencode/agents/build.md` and no `agent.build` in opencode.json.

    const client = makeClient()
    client.session.prompt = mock(() => {
      const output = {
        overall_score: 0.4,
        categories: {
          instruction_following: 0.5,
          completeness: 0.4,
          proactiveness: 0.3,
          code_quality: 0.4,
          communication: 0.4,
        },
        strengths: ["clear code"],
        weaknesses: ["does not write tests"],
        weakness_suggestions: [
          {
            weakness: "does not write tests",
            suggested_fix:
              "Always run the test suite before reporting completion.",
            target: "agent_prompt",
          },
        ],
      }
      return Promise.resolve({
        data: {
          parts: [{ type: "text", text: JSON.stringify(output) }],
        },
      })
    })

    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    // Two sessions on the literal built-in "build" agent — no mocked
    // global config, no `agent.build` entry in opencode.json.
    await fullSession(dir, hooks, "builtin-1a", "build", "build this project")
    await fullSession(dir, hooks, "builtin-1b", "build", "build this project 2")
    await hooks.close()

    // AGENTS.md should contain the improvement.
    const agentsMd = await readFile(join(dir, "AGENTS.md"), "utf-8")
    expect(agentsMd).toContain("## Kasper Inferred Instructions")
    expect(agentsMd).toContain(
      "Always run the test suite before reporting completion.",
    )

    // The dead agent prompt file MUST NOT be created — opencode would
    // not load it and the user would think the improvement was lost.
    const deadPath = join(dir, ".opencode", "agents", "build.md")
    let deadExists = true
    try {
      await stat(deadPath)
    } catch {
      deadExists = false
    }
    expect(deadExists).toBe(false)

    // The improvement record should be rewritten to target="agents_md"
    // so state, history, and rollback all reflect the actual outcome.
    const statePath = join(dir, ".opencode", "kasper", "state.json")
    const state = JSON.parse(await readFile(statePath, "utf-8"))
    const applied = state.improvements_applied ?? []
    expect(applied.length).toBeGreaterThanOrEqual(1)
    const rerouted = applied.find(
      (r: { target: string; reason: string }) =>
        r.target === "agents_md" &&
        r.reason.includes(
          "Always run the test suite before reporting completion.",
        ),
    )
    expect(rerouted).toBeDefined()

    await rm(dir, { recursive: true, force: true })
  })

  test("auto-update honors custom agent build override (opencode.json agent.build.prompt = {file:...})", async () => {
    // When the user explicitly defines `agent.build.prompt` in
    // opencode.json (e.g. to override the built-in prompt), kasper must
    // respect that file instead of rerouting to AGENTS.md. The reroute
    // is only for the *default* built-in prompt, not for user overrides.
    const dir = await setupTestDir({ autoUpdate: true, scoringThreshold: 0.6 })
    await writeFile(join(dir, "AGENTS.md"), "# Project Rules\nBe helpful.\n")

    // User-defined override prompt for the built-in "build" agent.
    const overridePromptPath = join(dir, ".opencode", "prompts", "build.md")
    await mkdir(join(dir, ".opencode", "prompts"), { recursive: true })
    await writeFile(
      overridePromptPath,
      "# Build Agent (override)\nCustom build instructions.\n",
      "utf-8",
    )

    // Wire up opencode.json with `agent.build.prompt = {file:...}`
    const opencodeJson = {
      $schema: "https://opencode.ai/config.json",
      agent: {
        build: {
          prompt: `{file:${overridePromptPath}}`,
        },
      },
      kasper: {
        enabled: true,
        auto_update: true,
        scoring_threshold: 0.6,
        min_session_messages: 1,
        min_observations_for_update: 2,
        agent_prompt_inject_mode: "section",
      },
    }
    await writeFile(
      join(dir, "opencode.json"),
      JSON.stringify(opencodeJson),
      "utf-8",
    )

    const client = makeClient()
    client.session.prompt = mock(() => {
      const output = {
        overall_score: 0.4,
        categories: {
          instruction_following: 0.5,
          completeness: 0.4,
          proactiveness: 0.3,
          code_quality: 0.4,
          communication: 0.4,
        },
        strengths: ["clear code"],
        weaknesses: ["does not write tests"],
        weakness_suggestions: [
          {
            weakness: "does not write tests",
            suggested_fix:
              "Always run the test suite before reporting completion.",
            target: "agent_prompt",
          },
        ],
      }
      return Promise.resolve({
        data: {
          parts: [{ type: "text", text: JSON.stringify(output) }],
        },
      })
    })

    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    await fullSession(dir, hooks, "override-1a", "build", "build this project")
    await fullSession(
      dir,
      hooks,
      "override-1b",
      "build",
      "build this project 2",
    )
    await hooks.close()

    // The override file should be updated, NOT AGENTS.md.
    const overrideContent = await readFile(overridePromptPath, "utf-8")
    expect(overrideContent).toContain("## Kasper Inferred Instructions")
    expect(overrideContent).toContain(
      "Always run the test suite before reporting completion.",
    )

    const agentsMd = await readFile(join(dir, "AGENTS.md"), "utf-8")
    expect(agentsMd).not.toContain("## Kasper Inferred Instructions")
    expect(agentsMd).not.toContain(
      "Always run the test suite before reporting completion.",
    )

    const statePath = join(dir, ".opencode", "kasper", "state.json")
    const state = JSON.parse(await readFile(statePath, "utf-8"))
    const applied = state.improvements_applied ?? []
    expect(applied.length).toBeGreaterThanOrEqual(1)
    const asAgentPrompt = applied.find(
      (r: { target: string; agent_name?: string }) =>
        r.target === "agent_prompt" && r.agent_name === "build",
    )
    expect(asAgentPrompt).toBeDefined()

    await rm(dir, { recursive: true, force: true })
  })
})
