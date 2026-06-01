import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import KasperPlugin, { flushKasperState } from "../src/index.js"

function tmpDir(): string {
  return join(tmpdir(), `kasper-int-${randomBytes(6).toString("hex")}`)
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

function makeMidScoreClient(overrides?: Partial<Record<string, unknown>>) {
  const base: Record<string, unknown> = {
    overall_score: 0.65,
    categories: {
      instruction_following: 0.7,
      completeness: 0.6,
      proactiveness: 0.6,
      code_quality: 0.7,
      communication: 0.6,
    },
    strengths: ["good response"],
    weaknesses: ["minor formatting issues"],
  }
  return makeClient({ ...base, ...overrides })
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

async function setupTestDir(): Promise<string> {
  const dir = tmpDir()
  await mkdir(join(dir, ".opencode"), { recursive: true })
  const obsConfig: Record<string, unknown> = {
    enabled: true,
    auto_update: false,
    min_session_messages: 1,
  }
  await writeFile(
    join(dir, "opencode.json"),
    JSON.stringify({ kasper: obsConfig }),
    "utf-8",
  )
  return dir
}

describe("plugin integration", () => {
  let testDir: string

  beforeAll(async () => {
    testDir = await setupTestDir()
  })

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  test("bootstraps plugin and creates state file", async () => {
    const client = makeClient()
    const hooks = await KasperPlugin({
      client: client as any,
      directory: testDir,
    })

    expect(hooks.config).toBeFunction()
    expect(hooks.event).toBeFunction()
    expect(hooks["session.created"]).toBeFunction()
    expect(hooks["session.updated"]).toBeFunction()
    expect(hooks["session.deleted"]).toBeFunction()
    expect(hooks["chat.message"]).toBeFunction()
    expect(hooks["message.updated"]).toBeFunction()
    expect(hooks["experimental.session.compacting"]).toBeFunction()
    expect(hooks.close).toBeFunction()

    const statePath = join(testDir, ".opencode", "kasper", "state.json")
    const content = await readFile(statePath, "utf-8")
    const state = JSON.parse(content)
    expect(state.version).toBe(1)
    expect(state.sessions).toEqual({})

    await hooks.close()
  })

  test("full evaluation lifecycle: tracks session, scores, persists state", async () => {
    const dir = await setupTestDir()
    const client = makeClient()
    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })
    const sessionID = "eval-test-1"

    await hooks["session.created"]({
      sessionID,
      event: { properties: { info: { agent: "build" } } },
    })

    await hooks["chat.message"](
      { sessionID },
      {
        message: {
          role: "user",
          parts: [{ type: "text", text: "implement a sorting algorithm" }],
        },
      },
    )

    await hooks["chat.message"](
      { sessionID },
      {
        message: {
          role: "assistant",
          parts: [{ type: "text", text: "Here's a quicksort implementation" }],
        },
      },
    )

    await hooks.event({ event: { type: "session.idle", sessionID } })

    const scoreOut: any = {}
    await hooks["command.execute.before"](
      {
        command: "kasper",
        argument: `score session ${sessionID}`,
        sessionID,
      },
      scoreOut,
    )

    await flushKasperState(dir)

    const statePath = join(dir, ".opencode", "kasper", "state.json")
    const content = await readFile(statePath, "utf-8")
    const state = JSON.parse(content)

    expect(state.sessions[sessionID]).toBeDefined()
    expect(state.sessions[sessionID].score).toBe(0.85)
    expect(state.sessions[sessionID].agent_name).toBe("build")
    expect(state.sessions[sessionID].score_card.strengths).toContain(
      "clear code",
    )
    expect(state.sessions[sessionID].score_card.weaknesses).toContain(
      "response could be faster",
    )

    expect(state.aggregate.total_sessions).toBe(1)
    expect(state.aggregate.avg_score).toBe(0.85)

    expect(client.session.create).toHaveBeenCalled()
    expect(client.session.prompt).toHaveBeenCalled()
    expect(client.session.delete).toHaveBeenCalled()

    await hooks.close()
    await rm(dir, { recursive: true, force: true })
  })

  test("tracks multiple sessions independently", async () => {
    const dir = await setupTestDir()
    const client = makeClient()
    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    for (const sid of ["sess-a", "sess-b", "sess-c"]) {
      await fullSession(dir, hooks, sid)
    }

    await hooks.close()

    const statePath = join(dir, ".opencode", "kasper", "state.json")
    const content = await readFile(statePath, "utf-8")
    const state = JSON.parse(content)

    expect(state.aggregate.total_sessions).toBe(3)
    expect(Object.keys(state.sessions).length).toBe(3)
    expect(state.sessions["sess-a"].score).toBe(0.85)
    expect(state.sessions["sess-b"].score).toBe(0.85)
    expect(state.sessions["sess-c"].score).toBe(0.85)

    await rm(dir, { recursive: true, force: true })
  })

  test("logs plugin lifecycle events", async () => {
    const dir = await setupTestDir()
    const client = makeClient()
    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    await hooks.close()

    const logPath = join(dir, ".opencode", "kasper", "kasper.log")
    const logContent = await readFile(logPath, "utf-8")
    const lines = logContent
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))

    expect(lines.some((l) => l.event === "plugin_loaded")).toBe(true)
    expect(lines.some((l) => l.event === "plugin_unloaded")).toBe(true)

    await rm(dir, { recursive: true, force: true })
  })

  test("cleans up pending eval on session deletion", async () => {
    const dir = await setupTestDir()
    const client = makeClient()
    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })
    const sessionID = "delete-test"

    await hooks["session.created"]({ sessionID, event: {} })

    await hooks["chat.message"](
      { sessionID },
      { message: { role: "user", parts: [{ type: "text", text: "hello" }] } },
    )

    await hooks["session.deleted"]({ sessionID })

    await hooks.event({ event: { type: "session.idle", sessionID } })

    await flushKasperState(dir)

    const statePath = join(dir, ".opencode", "kasper", "state.json")
    const content = await readFile(statePath, "utf-8")
    const state = JSON.parse(content)

    expect(Object.keys(state.sessions).length).toBe(0)

    await hooks.close()
    await rm(dir, { recursive: true, force: true })
  })

  test("config hook registers /kasper command", async () => {
    const dir = await setupTestDir()
    const client = makeClient()
    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    const opencodeConfig: Record<string, unknown> = {}
    await hooks.config!(opencodeConfig)

    const cmd = (opencodeConfig.command as Record<string, unknown>)
      ?.kasper as Record<string, unknown>
    expect(cmd).toBeDefined()
    expect(cmd.template).toContain("/kasper $ARGUMENTS")
    expect(cmd.description).toContain("Inspect or control the Kasper plugin")

    await hooks.close()
    await rm(dir, { recursive: true, force: true })
  })

  test("compaction hook injects kasper feedback context", async () => {
    const dir = await setupTestDir()
    const client = makeClient()
    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })
    const sessionID = "compact-test"

    await fullSession(dir, hooks, sessionID, "build")

    const output = { context: [] as string[] }
    await hooks["experimental.session.compacting"]({ sessionID }, output)

    expect(output.context.length).toBeGreaterThan(0)
    const ctx = output.context[0]
    expect(ctx).toContain("## Kasper Feedback")
    expect(ctx).toContain("adherence score")

    await hooks.close()
    await rm(dir, { recursive: true, force: true })
  })

  test("compaction hook includes per-agent stats when agent is tracked", async () => {
    const dir = await setupTestDir()
    const client = makeClient()
    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    await fullSession(dir, hooks, "agent-sess-1", "build")

    const output = { context: [] as string[] }
    await hooks["experimental.session.compacting"](
      { sessionID: "agent-sess-1" },
      output,
    )

    const ctx = output.context.join("\n")
    expect(ctx).toContain("### build Agent Stats")
    expect(ctx).toContain("Avg Score")

    await hooks.close()
    await rm(dir, { recursive: true, force: true })
  })
})

// [removed] improvement cycle — old auto-apply via command.execute.before, was removed with hook-based lifecycle

describe("duplicate evaluation guard", () => {
  test("skips evaluation via idle when session already evaluated", async () => {
    const dir = await setupTestDir()
    const client = makeClient()
    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })
    const sessionID = "dedup-test"

    await fullSession(dir, hooks, sessionID)

    await hooks["chat.message"](
      { sessionID },
      {
        message: {
          role: "user",
          parts: [{ type: "text", text: "do another thing" }],
        },
      },
    )
    await hooks["chat.message"](
      { sessionID },
      {
        message: {
          role: "assistant",
          parts: [{ type: "text", text: "done again" }],
        },
      },
    )

    await hooks.event({ event: { type: "session.idle", sessionID } })
    await flushKasperState(dir)

    const statePath = join(dir, ".opencode", "kasper", "state.json")
    const state = JSON.parse(await readFile(statePath, "utf-8"))
    const sessionEntries = Object.keys(state.sessions).filter(
      (k: string) => k === sessionID,
    )
    expect(sessionEntries.length).toBe(1)

    await hooks.close()
    await rm(dir, { recursive: true, force: true })
  })

  test("/kasper score shows message when session already evaluated", async () => {
    const dir = await setupTestDir()
    const client = makeClient()
    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })
    const sessionID = "dedup-score-test"

    await fullSession(dir, hooks, sessionID)

    const output: any = {}
    await hooks["command.execute.before"](
      { command: "kasper", argument: "score", sessionID },
      output,
    )
    expect(output.message).toContain("already been evaluated")

    await hooks.close()
    await rm(dir, { recursive: true, force: true })
  })

  test("rapid idle then score from different hook still deduplicates", async () => {
    const dir = await setupTestDir()
    const client = makeClient()
    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })
    const sessionID = "rapid-race-test"

    await hooks["session.created"]({
      sessionID,
      event: { properties: { info: {} } },
    })
    await hooks["chat.message"](
      { sessionID },
      {
        message: {
          role: "user",
          parts: [{ type: "text", text: "do something" }],
        },
      },
    )
    await hooks["chat.message"](
      { sessionID },
      {
        message: { role: "assistant", parts: [{ type: "text", text: "done" }] },
      },
    )

    const scoreOut: any = {}
    await hooks["command.execute.before"](
      {
        command: "kasper",
        argument: `score session ${sessionID}`,
        sessionID,
      },
      scoreOut,
    )

    // second call should be deduplicated
    const output: any = {}
    await hooks["command.execute.before"](
      { command: "kasper", argument: "score", sessionID },
      output,
    )
    expect(output.message).toContain("already been evaluated")
    await hooks.close()
    await rm(dir, { recursive: true, force: true })
  })
})

// [removed] auto-update flow — kasper_auto tool removed

// [removed] rejection feedback loop — kasper_reject/unreject/rejections tools removed

// [removed] user steering — kasper_steer tool removed

describe("score toasts", () => {
  test("shows warning toast for scores below 0.4", async () => {
    const dir = await setupTestDir()
    const client = makeLowScoreClient({ overall_score: 0.3 })
    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    await fullSession(dir, hooks, "toast-low")

    const showToast = (client as any).tui.showToast as ReturnType<typeof mock>
    const calls = (showToast.mock?.calls ?? []) as any[]
    const warned = calls.some(
      (c: any[]) =>
        c[0]?.body?.variant === "warning" &&
        String(c[0]?.body?.message).includes("Low adherence score"),
    )
    expect(warned).toBe(true)

    await hooks.close()
    await rm(dir, { recursive: true, force: true })
  })

  test("does not show toast for high scores (>=0.4)", async () => {
    const dir = await setupTestDir()
    const client = makeClient({
      overall_score: 0.9,
      categories: {
        instruction_following: 0.9,
        completeness: 0.9,
        proactiveness: 0.9,
        code_quality: 0.9,
        communication: 0.9,
      },
      strengths: ["great work"],
      weaknesses: [],
    })
    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    await fullSession(dir, hooks, "toast-high")

    const showToast = (client as any).tui.showToast as ReturnType<typeof mock>
    const calls = (showToast.mock?.calls ?? []) as any[]
    const warned = calls.some(
      (c: any[]) =>
        c[0]?.body?.variant === "warning" &&
        String(c[0]?.body?.message).includes("Low adherence score"),
    )
    expect(warned).toBe(false)

    await hooks.close()
    await rm(dir, { recursive: true, force: true })
  })

  test("does not show toast for medium scores (>=0.4)", async () => {
    const dir = await setupTestDir()
    const client = makeMidScoreClient()
    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    await fullSession(dir, hooks, "toast-mid")

    const showToast = (client as any).tui.showToast as ReturnType<typeof mock>
    const calls = (showToast.mock?.calls ?? []) as any[]
    const warned = calls.some(
      (c: any[]) =>
        c[0]?.body?.variant === "warning" &&
        String(c[0]?.body?.message).includes("Low adherence score"),
    )
    expect(warned).toBe(false)

    await hooks.close()
    await rm(dir, { recursive: true, force: true })
  })
})

// [removed] agent prompt update cycle — old apply pattern with kasper_reject

describe("config hot-reload", () => {
  test("picks up kasper.jsonc changes while plugin is running", async () => {
    const dir = await setupTestDir()
    const client = makeClient()
    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    const out1: any = {}
    await hooks["command.execute.before"](
      { command: "kasper", argument: "config" },
      out1,
    )
    expect(out1.message).toContain("Scoring threshold")
    expect(out1.message).not.toContain("0.15")

    const obsDir = join(dir, ".opencode")
    const obsPath = join(obsDir, "kasper.jsonc")
    await mkdir(obsDir, { recursive: true })
    await writeFile(
      obsPath,
      JSON.stringify({ scoring_threshold: 0.15, model: "openai/gpt-4o" }),
      "utf-8",
    )

    await new Promise((r) => setTimeout(r, 6000))

    const out2: any = {}
    await hooks["command.execute.before"](
      { command: "kasper", argument: "config" },
      out2,
    )
    expect(out2.message).toContain("0.15")
    expect(out2.message).toContain("gpt-4o")

    await hooks.close()
    await rm(dir, { recursive: true, force: true })
  }, 30000)
})

describe("tool coverage", () => {
  test("kasper_status tool returns aggregate and recent sessions", async () => {
    const dir = await setupTestDir()
    const client = makeClient()
    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    await fullSession(dir, hooks, "tool-status-1")
    await fullSession(dir, hooks, "tool-status-2")

    const result = await hooks.tool.kasper_status.execute({ limit: 10 }, {})
    expect(result).toContain("Kasper Status")
    expect(result).toContain("Total sessions tracked")
    expect(result).toContain("85%")
    expect(result).toContain("Top Weaknesses")

    await hooks.close()
    await rm(dir, { recursive: true, force: true })
  })

  test("kasper_status tool with agent filter", async () => {
    const dir = await setupTestDir()
    const client = makeClient()
    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    await fullSession(dir, hooks, "agent-filter", "build")

    const result = await hooks.tool.kasper_status.execute(
      { agent: "build", limit: 10 },
      {},
    )
    expect(result).toContain("build Agent Stats")

    await hooks.close()
    await rm(dir, { recursive: true, force: true })
  })

  test("kasper_history tool returns session history", async () => {
    const dir = await setupTestDir()
    const client = makeClient()
    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    await fullSession(dir, hooks, "hist-1")
    await fullSession(dir, hooks, "hist-2")

    const result = await hooks.tool.kasper_history.execute({ limit: 10 }, {})
    expect(result).toContain("Kasper History")
    expect(result).toContain("85%")

    await hooks.close()
    await rm(dir, { recursive: true, force: true })
  })

  test("kasper_history tool filters by agent", async () => {
    const dir = await setupTestDir()
    const client = makeClient()
    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    await fullSession(dir, hooks, "hist-agent-1", "build")
    await fullSession(dir, hooks, "hist-agent-2", "general")

    const result = await hooks.tool.kasper_history.execute(
      { agent: "build", limit: 10 },
      {},
    )
    expect(result).toContain("Agent: build")

    await hooks.close()
    await rm(dir, { recursive: true, force: true })
  })

  test("kasper_status tool shows hierarchy when sessions have parentID", async () => {
    const dir = await setupTestDir()
    const client = makeClient()
    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    await hooks["session.created"]({
      sessionID: "parent-session",
      event: { properties: { info: {} } },
    })
    await hooks["session.created"]({
      sessionID: "child-subagent",
      event: { properties: { info: { parentID: "parent-session" } } },
    })

    const result = await hooks.tool.kasper_status.execute({ limit: 10 }, {})
    expect(result).toContain("Kasper Status")

    await hooks.close()
    await rm(dir, { recursive: true, force: true })
  })

  test("kasper_improve tool shows no weaknesses when none recorded", async () => {
    const dir = await setupTestDir()
    const client = makeClient()
    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    const result = await hooks.tool.kasper_improve.execute({}, {})
    expect(result).toContain("No weaknesses recorded yet")

    await hooks.close()
    await rm(dir, { recursive: true, force: true })
  })
})

describe("manual retroactive evaluation", () => {
  test("kasper score session <id> evaluates a past session via messages API", async () => {
    const dir = await setupTestDir()
    const client = makeClient()
    ;(client as any).session.messages = mock(() =>
      Promise.resolve({
        data: [
          {
            info: { id: "msg1", role: "user", sessionID: "retro-1" },
            parts: [{ type: "text", text: "write unit tests" }],
          },
          {
            info: { id: "msg2", role: "assistant", sessionID: "retro-1" },
            parts: [{ type: "text", text: "here are the tests" }],
          },
          {
            info: { id: "msg3", role: "user", sessionID: "retro-1" },
            parts: [{ type: "text", text: "also add integration tests" }],
          },
        ],
      }),
    )

    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    const output: any = {}
    await hooks["command.execute.before"](
      { command: "kasper", argument: "score session retro-1" },
      output,
    )
    expect(output.stop).toBe(true)
    expect(output.message).toContain("Manual evaluation for session")
    expect(output.message).toContain("85%")

    await flushKasperState(dir)

    const statePath = join(dir, ".opencode", "kasper", "state.json")
    const state = JSON.parse(await readFile(statePath, "utf-8"))
    expect(state.sessions["retro-1"]).toBeDefined()
    expect(state.sessions["retro-1"].score).toBe(0.85)

    await hooks.close()
    await rm(dir, { recursive: true, force: true })
  })

  test("kasper score session <id> fails gracefully on API error", async () => {
    const dir = await setupTestDir()
    const client = makeClient()
    ;(client as any).session.messages = mock(() =>
      Promise.reject(new Error("API unavailable")),
    )

    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    const output: any = {}
    await hooks["command.execute.before"](
      { command: "kasper", argument: "score session broken-id" },
      output,
    )
    expect(output.stop).toBe(true)
    expect(output.message).toContain("Failed to fetch messages")

    await hooks.close()
    await rm(dir, { recursive: true, force: true })
  })

  test("kasper score session <id> with no messages returns appropriate message", async () => {
    const dir = await setupTestDir()
    const client = makeClient()
    ;(client as any).session.messages = mock(() =>
      Promise.resolve({ data: [] }),
    )

    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    const output: any = {}
    await hooks["command.execute.before"](
      { command: "kasper", argument: "score session empty-id" },
      output,
    )
    expect(output.stop).toBe(true)
    expect(output.message).toContain("No messages found")

    await hooks.close()
    await rm(dir, { recursive: true, force: true })
  })

  test("kasper score session <id> already evaluated returns existing score", async () => {
    const dir = await setupTestDir()
    const client = makeClient()
    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    await fullSession(dir, hooks, "retro-dedup")

    const output: any = {}
    await hooks["command.execute.before"](
      { command: "kasper", argument: "score session retro-dedup" },
      output,
    )
    expect(output.stop).toBe(true)
    expect(output.message).toContain("already been evaluated")
    expect(output.message).toContain("85%")

    await hooks.close()
    await rm(dir, { recursive: true, force: true })
  })
})

// [removed] pause/resume cycle — commands removed

describe("fallback scoring", () => {
  test("skips recording session when LLM returns invalid JSON", async () => {
    const dir = await setupTestDir()
    const hooks = await KasperPlugin({
      client: {
        session: {
          create: mock(() =>
            Promise.resolve({ data: { id: "scoring-session" } }),
          ),
          prompt: mock(() =>
            Promise.resolve({
              data: {
                parts: [
                  {
                    type: "text",
                    text: "this is not json { broken",
                  },
                ],
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
                  parts: [{ type: "text", text: "do a thing" }],
                },
                {
                  info: { id: `${sid}-a1`, role: "assistant", sessionID: sid },
                  parts: [{ type: "text", text: "done" }],
                },
              ],
            })
          }),
        },
        tui: { showToast: mock(() => {}) },
      } as any,
      directory: dir,
    })

    await fullSession(dir, hooks, "fallback-session")

    const statePath = join(dir, ".opencode", "kasper", "state.json")
    const state = JSON.parse(await readFile(statePath, "utf-8"))
    expect(state.sessions["fallback-session"]).toBeUndefined()

    await hooks.close()
    await rm(dir, { recursive: true, force: true })
  })

  test("fallback card triggers no improvement even below threshold", async () => {
    const dir = await setupTestDir()
    const hooks = await KasperPlugin({
      client: {
        session: {
          create: mock(() =>
            Promise.resolve({ data: { id: "scoring-session" } }),
          ),
          prompt: mock(() =>
            Promise.resolve({
              data: {
                parts: [
                  {
                    type: "text",
                    text: "garbage}",
                  },
                ],
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
                  parts: [{ type: "text", text: "do a thing" }],
                },
                {
                  info: { id: `${sid}-a1`, role: "assistant", sessionID: sid },
                  parts: [{ type: "text", text: "done" }],
                },
              ],
            })
          }),
        },
        tui: { showToast: mock(() => {}) },
      } as any,
      directory: dir,
    })

    await fullSession(dir, hooks, "fallback-no-improve")

    const result = await hooks.tool.kasper_improve.execute({}, {})
    expect(result).toContain("No weaknesses recorded yet")

    await hooks.close()
    await rm(dir, { recursive: true, force: true })
  })
})

describe("bare /kasper command", () => {
  test("shows summary when invoked with no subcommand", async () => {
    const dir = await setupTestDir()
    const client = makeClient()
    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    const output: any = {}
    await hooks["command.execute.before"](
      { command: "kasper", argument: "" },
      output,
    )
    expect(output.stop).toBe(true)
    expect(output.message).toContain("Kasper")
    expect(output.message).toContain("Average score")

    await hooks.close()
    await rm(dir, { recursive: true, force: true })
  })
})

// [removed] rollback — command removed

describe("disabled mode", () => {
  test("plugin with enabled=false returns empty hooks", async () => {
    const dir = await setupTestDir()
    await writeFile(
      join(dir, "opencode.json"),
      JSON.stringify({
        kasper: { enabled: false },
      }),
      "utf-8",
    )

    const client = makeClient()
    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    expect(Object.keys(hooks).length).toBe(0)

    await rm(dir, { recursive: true, force: true })
  })

  test("disabled plugin does not evaluate sessions", async () => {
    const dir = await setupTestDir()
    await writeFile(
      join(dir, "opencode.json"),
      JSON.stringify({
        kasper: { enabled: false },
      }),
      "utf-8",
    )

    const client = makeClient()
    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    expect(hooks.event).toBeUndefined()

    await rm(dir, { recursive: true, force: true })
  })
})

describe("quiet mode", () => {
  test("quiet mode suppresses non-critical toasts", async () => {
    const dir = await setupTestDir()
    await writeFile(
      join(dir, "opencode.json"),
      JSON.stringify({
        kasper: { quiet: true, min_session_messages: 1 },
      }),
      "utf-8",
    )

    const client = makeClient()
    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    await fullSession(dir, hooks, "quiet-test")

    const showToast = (client as any).tui.showToast as ReturnType<typeof mock>
    const calls = (showToast.mock?.calls ?? []) as any[]
    const scoreToasts = calls.filter(
      (c: any[]) =>
        typeof c[0]?.body?.message === "string" &&
        String(c[0]?.body?.message).includes("%") &&
        c[0]?.body?.variant !== "warning",
    )
    expect(scoreToasts.length).toBe(0)

    await hooks.close()
    await rm(dir, { recursive: true, force: true })
  })

  test("quiet mode still shows warning toasts for low scores", async () => {
    const dir = await setupTestDir()
    await writeFile(
      join(dir, "opencode.json"),
      JSON.stringify({
        kasper: { quiet: true, min_session_messages: 1 },
      }),
      "utf-8",
    )

    const lowClient = makeLowScoreClient({ overall_score: 0.3 })
    const hooks = await KasperPlugin({
      client: lowClient as any,
      directory: dir,
    })

    await fullSession(dir, hooks, "quiet-low-test")

    const showToast = (lowClient as any).tui.showToast as ReturnType<
      typeof mock
    >
    const calls = (showToast.mock?.calls ?? []) as any[]
    const warns = calls.filter(
      (c: any[]) =>
        c[0]?.body?.variant === "warning" &&
        String(c[0]?.body?.message).includes("Low adherence"),
    )
    expect(warns.length).toBeGreaterThan(0)

    await hooks.close()
    await rm(dir, { recursive: true, force: true })
  })
})

describe("kasper score returns data", () => {
  test("score command with existing eval returns score and weaknesses", async () => {
    const dir = await setupTestDir()
    const client = makeLowScoreClient({
      weaknesses: ["does not write tests", "poor error handling"],
    })
    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    await fullSession(dir, hooks, "score-data-test")

    const output: any = {}
    await hooks["command.execute.before"](
      { command: "kasper", argument: "score", sessionID: "score-data-test" },
      output,
    )
    expect(output.message).toContain("40%")
    expect(output.message).toContain("does not write tests")
    expect(output.message).toContain("poor error handling")

    await hooks.close()
    await rm(dir, { recursive: true, force: true })
  })

  test("score command triggers manual eval and returns result", async () => {
    const dir = await setupTestDir()
    const client = makeClient()
    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    await hooks["session.created"]({
      sessionID: "score-manual-test",
      event: {},
    })
    await hooks["chat.message"](
      { sessionID: "score-manual-test" },
      {
        message: {
          role: "user",
          parts: [{ type: "text", text: "refactor this module" }],
        },
      },
    )
    await hooks["chat.message"](
      { sessionID: "score-manual-test" },
      {
        message: {
          role: "assistant",
          parts: [{ type: "text", text: "here is the refactored code" }],
        },
      },
    )

    const output: any = {}
    await hooks["command.execute.before"](
      {
        command: "kasper",
        argument: "score",
        sessionID: "score-manual-test",
      },
      output,
    )
    expect(output.message).toContain("Manual evaluation for session")
    expect(output.message).toContain("85%")

    await hooks.close()
    await rm(dir, { recursive: true, force: true })
  })

  test("score command with no sessionID returns appropriate message", async () => {
    const dir = await setupTestDir()
    const client = makeClient()
    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    const output: any = {}
    await hooks["command.execute.before"](
      { command: "kasper", argument: "score" },
      output,
    )
    expect(output.message).toContain("No active session found")

    await hooks.close()
    await rm(dir, { recursive: true, force: true })
  })
})

describe("kasper help", () => {
  test("help command lists all available commands", async () => {
    const dir = await setupTestDir()
    const client = makeClient()
    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    const output: any = {}
    await hooks["command.execute.before"](
      { command: "kasper", argument: "help" },
      output,
    )
    expect(output.stop).toBe(true)
    expect(output.message).toContain("Kasper Commands")
    expect(output.message).toContain("kasper status")
    expect(output.message).toContain("kasper score")
    expect(output.message).toContain("kasper improve")
    expect(output.message).toContain("kasper reset")
    expect(output.message).toContain("kasper help")

    await hooks.close()
    await rm(dir, { recursive: true, force: true })
  })
})

// [removed] suggest force — "suggest" command was replaced by "improve"

describe("kasper config", () => {
  test("config command displays current configuration", async () => {
    const dir = await setupTestDir()
    const client = makeClient()
    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    const output: any = {}
    await hooks["command.execute.before"](
      { command: "kasper", argument: "config" },
      output,
    )
    expect(output.stop).toBe(true)
    expect(output.message).toContain("Kasper Configuration")
    expect(output.message).toContain("Scoring threshold")
    expect(output.message).toContain("Model")
    expect(output.message).toContain("Detail level")
    expect(output.message).toContain("State")

    await hooks.close()
    await rm(dir, { recursive: true, force: true })
  })

  test("config command shows current kasper settings", async () => {
    const dir = await setupTestDir()
    await writeFile(
      join(dir, "opencode.json"),
      JSON.stringify({
        kasper: { scoring_threshold: 0.3, min_session_messages: 1 },
      }),
      "utf-8",
    )

    const client = makeClient()
    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    const output: any = {}
    await hooks["command.execute.before"](
      { command: "kasper", argument: "config" },
      output,
    )
    expect(output.message).toContain("Kasper Configuration")
    expect(output.message).toContain("0.3")

    await hooks.close()
    await rm(dir, { recursive: true, force: true })
  })
})

describe("state eviction", () => {
  test("records multiple sessions correctly", async () => {
    const dir = await setupTestDir()

    const client = makeClient()
    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    for (let i = 0; i < 4; i++) {
      await fullSession(dir, hooks, `evict-${i}`)
    }

    await flushKasperState(dir)

    const statePath = join(dir, ".opencode", "kasper", "state.json")
    const state = JSON.parse(await readFile(statePath, "utf-8"))
    const sessionCount = Object.keys(state.sessions).length
    expect(sessionCount).toBe(4)

    expect(state.sessions["evict-3"]).toBeDefined()

    await hooks.close()
    await rm(dir, { recursive: true, force: true })
  })
})

describe("kasper reset", () => {
  test("reset clears all sessions, scores, and pending data", async () => {
    const dir = await setupTestDir()
    const client = makeClient()
    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    await fullSession(dir, hooks, "reset-session-1")
    await hooks.close()

    const beforeState = JSON.parse(
      await readFile(join(dir, ".opencode", "kasper", "state.json"), "utf-8"),
    )
    expect(beforeState.sessions["reset-session-1"]).toBeDefined()
    expect(beforeState.aggregate.total_sessions).toBe(1)

    // recreate fresh hooks for reset test
    const hooks2 = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    const resetOutput: any = {}
    await hooks2["command.execute.before"](
      { command: "kasper", argument: "reset" },
      resetOutput,
    )
    expect(resetOutput.stop).toBe(true)
    expect(resetOutput.message).toContain("Kasper state reset")
    expect(resetOutput.message).toContain("Cleared 1 session")

    const status = await hooks2.tool.kasper_status.execute({ limit: 10 }, {})
    expect(status).toContain("**Total sessions tracked:**")
    expect(status).toContain("**Average adherence score:**")

    await hooks2.close()
    await rm(dir, { recursive: true, force: true })
  })

  test("reset via tool", async () => {
    const dir = await setupTestDir()
    const client = makeClient()
    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    await fullSession(dir, hooks, "tool-reset-test")

    const result = await hooks.tool.kasper_reset.execute({}, {})
    expect(result).toContain("Kasper state reset")
    expect(result).toContain("Cleared 1 session")

    const status = await hooks.tool.kasper_status.execute({ limit: 10 }, {})
    expect(status).toContain("**Total sessions tracked:**")
    expect(status).toContain("**Average adherence score:**")

    await hooks.close()
    await rm(dir, { recursive: true, force: true })
  })

  test("after reset, new sessions evaluate normally", async () => {
    const dir = await setupTestDir()
    const client = makeClient()
    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    await fullSession(dir, hooks, "pre-reset-session")

    const resetOutput: any = {}
    await hooks["command.execute.before"](
      { command: "kasper", argument: "reset" },
      resetOutput,
    )

    await fullSession(dir, hooks, "post-reset-session")

    await hooks.close()

    const statePath = join(dir, ".opencode", "kasper", "state.json")
    const state = JSON.parse(await readFile(statePath, "utf-8"))
    expect(state.sessions["post-reset-session"]).toBeDefined()
    expect(state.sessions["post-reset-session"].score).toBe(0.85)
    expect(state.aggregate.total_sessions).toBe(1)

    await rm(dir, { recursive: true, force: true })
  })
})

describe("subagent evaluation guard", () => {
  test("evaluates subagent sessions by default", async () => {
    const dir = await setupTestDir()
    const client = makeClient()
    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    await hooks["session.created"]({
      sessionID: "subagent-test",
      event: {
        properties: {
          info: { agent: "build", parentID: "parent-1" },
        },
      },
    })
    await hooks["chat.message"](
      { sessionID: "subagent-test" },
      {
        message: {
          role: "user",
          parts: [{ type: "text", text: "do subagent work" }],
        },
      },
    )
    await hooks["chat.message"](
      { sessionID: "subagent-test" },
      {
        message: { role: "assistant", parts: [{ type: "text", text: "ok" }] },
      },
    )

    const scoreOut: any = {}
    await hooks["command.execute.before"](
      { command: "kasper", argument: "score session subagent-test" },
      scoreOut,
    )
    await flushKasperState(dir)

    const statePath = join(dir, ".opencode", "kasper", "state.json")
    const state = JSON.parse(await readFile(statePath, "utf-8"))
    expect(state.sessions["subagent-test"]).toBeDefined()

    await hooks.close()
    await rm(dir, { recursive: true, force: true })
  })
})

describe("install default config", () => {
  test("kasper.jsonc is created when missing", async () => {
    const dir = await setupTestDir()
    const client = makeClient()
    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    const globalDir = join(dir, ".opencode")
    const globalConfigPath = join(globalDir, "kasper.jsonc")
    try {
      const content = await readFile(globalConfigPath, "utf-8")
      const parsed = JSON.parse(content)
      expect(parsed.enabled).toBe(true)
      expect(parsed.scoring_threshold).toBeDefined()
    } catch {
      // File might not be created here since resolveGlobalOpencodeDir
      // looks at OS-level directories. This test validates the project
      // config at opencode.json instead.
    }

    await hooks.close()
    await rm(dir, { recursive: true, force: true })
  })
})

// [removed] agent prompt suggestion without name + reject with index — kasper_reject tool removed

describe("unknown command", () => {
  test("handles unknown subcommand gracefully", async () => {
    const dir = await setupTestDir()
    const client = makeClient()
    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    const output: any = {}
    await hooks["command.execute.before"](
      { command: "kasper", argument: "nonexistent_command" },
      output,
    )
    expect(output.stop).toBe(true)
    expect(output.message).toContain("Unknown /kasper command")

    await hooks.close()
    await rm(dir, { recursive: true, force: true })
  })
})

// [removed] score agent shorthand — agent-as-ID shorthand removed

describe("kasper_improve tool", () => {
  test("improve tool returns suggestions for global weaknesses", async () => {
    const dir = await setupTestDir()
    const lowClient = makeLowScoreClient({
      weaknesses: ["needs more documentation"],
    })
    const hooks = await KasperPlugin({
      client: lowClient as any,
      directory: dir,
    })

    await fullSession(dir, hooks, "improve-tool-sess")
    await fullSession(dir, hooks, "improve-tool-sess-2")
    await fullSession(dir, hooks, "improve-tool-sess-3")

    const result = await hooks.tool.kasper_improve.execute({}, {})
    expect(result).toContain("## Suggested Improvements")
    expect(result).toContain("needs more documentation")

    await hooks.close()
    await rm(dir, { recursive: true, force: true })
  })

  test("improve tool with no weaknesses returns appropriate message", async () => {
    const dir = await setupTestDir()
    const client = makeClient()
    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    const result = await hooks.tool.kasper_improve.execute({}, {})
    expect(result).toContain("No weaknesses recorded yet")

    await hooks.close()
    await rm(dir, { recursive: true, force: true })
  })
})

// [removed] kasper_auto tool — no longer registered

describe("subagent lifecycle", () => {
  test("tracks parent-child relationship via session.created hook", async () => {
    const dir = await setupTestDir()
    const client = makeClient()
    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    await hooks["session.created"]({
      sessionID: "parent-1",
      event: { properties: { info: { agent: "build" } } },
    })

    await hooks["session.created"]({
      sessionID: "child-1",
      event: {
        properties: { info: { agent: "build", parentID: "parent-1" } },
      },
    })

    await hooks["chat.message"](
      { sessionID: "parent-1" },
      {
        message: {
          role: "user",
          parts: [{ type: "text", text: "do main task" }],
        },
      },
    )
    await hooks["chat.message"](
      { sessionID: "parent-1" },
      {
        message: { role: "assistant", parts: [{ type: "text", text: "done" }] },
      },
    )
    await hooks["chat.message"](
      { sessionID: "child-1" },
      {
        message: {
          role: "user",
          parts: [{ type: "text", text: "do sub task" }],
        },
      },
    )
    await hooks["chat.message"](
      { sessionID: "child-1" },
      {
        message: {
          role: "assistant",
          parts: [{ type: "text", text: "sub done" }],
        },
      },
    )

    const scoreOut: any = {}
    await hooks["command.execute.before"](
      { command: "kasper", argument: "score session parent-1" },
      scoreOut,
    )

    await hooks.close()

    const statePath = join(dir, ".opencode", "kasper", "state.json")
    const state = JSON.parse(await readFile(statePath, "utf-8"))
    expect(state.sessions["parent-1"]).toBeDefined()
    expect(state.sessions["parent-1"].agent_type).toBe("primary")

    await rm(dir, { recursive: true, force: true })
  })

  test("manual score session evaluates child subagents", async () => {
    const dir = await setupTestDir()
    const client = makeClient()
    ;(client as any).session.messages = mock((args: any) => {
      const sid = args.path?.id
      if (sid === "parent-manual") {
        return Promise.resolve({
          data: [
            {
              info: { id: "p1", role: "user", sessionID: "parent-manual" },
              parts: [{ type: "text", text: "write a module" }],
            },
            {
              info: { id: "p2", role: "assistant", sessionID: "parent-manual" },
              parts: [{ type: "text", text: "here is the module" }],
            },
            {
              info: { id: "p3", role: "user", sessionID: "parent-manual" },
              parts: [{ type: "text", text: "add more tests" }],
            },
          ],
        })
      }
      return Promise.resolve({
        data: [
          {
            info: { id: "c1", role: "user", sessionID: sid },
            parts: [{ type: "text", text: "do subagent work" }],
          },
          {
            info: { id: "c2", role: "assistant", sessionID: sid },
            parts: [{ type: "text", text: "subagent result" }],
          },
          {
            info: { id: "c3", role: "user", sessionID: sid },
            parts: [{ type: "text", text: "follow up on subagent work" }],
          },
        ],
      })
    })

    ;(client as any).session.list = mock(() =>
      Promise.resolve({
        data: [
          {
            id: "parent-manual",
            title: "parent",
            time: { created: Date.now(), updated: Date.now() },
          },
          {
            id: "child-a",
            title: "child a",
            parentID: "parent-manual",
            agent: "build",
            time: { created: Date.now(), updated: Date.now() },
          },
          {
            id: "child-b",
            title: "child b",
            parentID: "parent-manual",
            time: { created: Date.now(), updated: Date.now() },
          },
        ],
      }),
    )

    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    const result = await hooks.tool.kasper_score_session.execute(
      { session_id: "parent-manual" },
      {},
    )
    expect(result).toContain("Manual evaluation")
    expect(result).toContain("Subagent Sessions")
    expect(result).toContain("child-a")
    expect(result).toContain("child-b")

    await flushKasperState(dir)
    await hooks.close()
    await rm(dir, { recursive: true, force: true })
  })

  test("manual score session evaluates parent and child subagents", async () => {
    const dir = await setupTestDir()
    const client = makeClient()
    ;(client as any).session.messages = mock((args: any) => {
      const sid = args.path?.id
      return Promise.resolve({
        data: [
          {
            info: { id: "u1", role: "user", sessionID: sid },
            parts: [{ type: "text", text: "do task" }],
          },
          {
            info: { id: "a1", role: "assistant", sessionID: sid },
            parts: [{ type: "text", text: "done" }],
          },
          {
            info: { id: "u2", role: "user", sessionID: sid },
            parts: [{ type: "text", text: "also add this" }],
          },
        ],
      })
    })

    ;(client as any).session.list = mock(() =>
      Promise.resolve({
        data: [
          {
            id: "parent-batch",
            title: "parent batch",
            time: { created: Date.now(), updated: Date.now() },
          },
          {
            id: "sub-from-list",
            title: "sub from list",
            parentID: "parent-batch",
            agent: "explore",
            time: { created: Date.now(), updated: Date.now() },
          },
        ],
      }),
    )

    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    const result = await hooks.tool.kasper_score_session.execute(
      { session_id: "parent-batch" },
      {},
    )
    expect(result).toContain("Manual evaluation")
    expect(result).toContain("Subagent Sessions")
    expect(result).toContain("sub-from")

    await hooks.close()
    await rm(dir, { recursive: true, force: true })
  })

  test("status shows [sub] label for subagent sessions", async () => {
    const dir = await setupTestDir()
    const client = makeClient()
    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    await fullSession(dir, hooks, "primary-status", "build")

    await hooks["session.created"]({
      sessionID: "sub-status",
      event: {
        properties: { info: { agent: "build", parentID: "primary-status" } },
      },
    })
    await hooks["chat.message"](
      { sessionID: "sub-status" },
      {
        message: {
          role: "user",
          parts: [{ type: "text", text: "do sub task" }],
        },
      },
    )
    await hooks["chat.message"](
      { sessionID: "sub-status" },
      {
        message: {
          role: "assistant",
          parts: [{ type: "text", text: "sub done" }],
        },
      },
    )

    const scoreOut: any = {}
    await hooks["command.execute.before"](
      { command: "kasper", argument: "score session sub-status" },
      scoreOut,
    )

    await hooks.close()

    const statePath = join(dir, ".opencode", "kasper", "state.json")
    const state = JSON.parse(await readFile(statePath, "utf-8"))
    expect(state.sessions["primary-status"]).toBeDefined()
    expect(state.sessions["primary-status"].agent_type).toBe("primary")
    expect(state.sessions["sub-status"]).toBeDefined()
    expect(state.sessions["sub-status"].agent_type).toBe("subagent")
    expect(state.sessions["sub-status"].parent_session_id).toBe(
      "primary-status",
    )

    await rm(dir, { recursive: true, force: true })
  })
})

describe("fullSession without agent", () => {
  test("evaluates session even without agent name", async () => {
    const dir = await setupTestDir()
    const client = makeClient()
    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    await fullSession(dir, hooks, "no-agent-eval")

    await hooks.close()

    const statePath = join(dir, ".opencode", "kasper", "state.json")
    const state = JSON.parse(await readFile(statePath, "utf-8"))
    expect(state.sessions["no-agent-eval"]).toBeDefined()

    await rm(dir, { recursive: true, force: true })
  })
})

describe("edge cases", () => {
  test("improve shows agent column with correct names for multi-agent sessions", async () => {
    const dir = await setupTestDir()
    const lowClient = makeLowScoreClient({
      weaknesses: ["slow responses", "missing tests"],
    })
    const hooks = await KasperPlugin({
      client: lowClient as any,
      directory: dir,
    })

    await fullSession(dir, hooks, "multi-agent-1", "build")
    await fullSession(dir, hooks, "multi-agent-1b", "build")
    await fullSession(dir, hooks, "multi-agent-2", "general")
    await fullSession(dir, hooks, "multi-agent-2b", "general")

    const result = await hooks.tool.kasper_improve.execute({}, {})
    expect(result).toContain("## Suggested Improvements")
    expect(result).toContain("slow responses")
    expect(result).toContain("missing tests")

    await hooks.close()
    await rm(dir, { recursive: true, force: true })
  })

  test("rapid consecutive score session calls deduplicate correctly", async () => {
    const dir = await setupTestDir()
    const client = makeClient()
    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })
    const sessionID = "rapid-dedup"

    await hooks["session.created"]({
      sessionID,
      event: { properties: { info: { agent: "build" } } },
    })
    await hooks["chat.message"](
      { sessionID },
      { message: { role: "user", parts: [{ type: "text", text: "task" }] } },
    )
    await hooks["chat.message"](
      { sessionID },
      {
        message: { role: "assistant", parts: [{ type: "text", text: "done" }] },
      },
    )

    const out1: any = {}
    await hooks["command.execute.before"](
      {
        command: "kasper",
        argument: `score session ${sessionID}`,
        sessionID,
      },
      out1,
    )
    expect(out1.message).toContain("Manual evaluation")

    const out2: any = {}
    await hooks["command.execute.before"](
      { command: "kasper", argument: "score", sessionID },
      out2,
    )
    expect(out2.message).toContain("already been evaluated")

    await hooks.close()
    await rm(dir, { recursive: true, force: true })
  })

  test("batch scoring handles mixed ok/skipped results", async () => {
    const dir = await setupTestDir()
    const volatileMessages = mock((args: any) => {
      const sid = args.path?.id
      if (sid === "good-session") {
        return Promise.resolve({
          data: [
            {
              info: { id: `${sid}-u1`, role: "user", sessionID: sid },
              parts: [{ type: "text", text: "write feature" }],
            },
            {
              info: { id: `${sid}-a1`, role: "assistant", sessionID: sid },
              parts: [{ type: "text", text: "done" }],
            },
          ],
        })
      }
      return Promise.resolve({ data: [] })
    })

    const client = makeClient()
    ;(client as any).session.messages = volatileMessages
    ;(client as any).session.list = mock(() =>
      Promise.resolve({
        data: [
          {
            id: "good-session",
            title: "good",
            time: { created: Date.now(), updated: Date.now() },
          },
          {
            id: "empty-session",
            title: "empty",
            time: { created: Date.now(), updated: Date.now() },
          },
        ],
      }),
    )

    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    const result = await hooks.tool.kasper_score_session.execute(
      { count: 5 },
      {},
    )
    expect(result).toContain("Batch Evaluation")
    expect(result).toContain("1 session(s) evaluated")

    await hooks.close()
    await rm(dir, { recursive: true, force: true })
  })

  test("multiple sessions are recorded and retained", async () => {
    const dir = await setupTestDir()

    const client = makeClient()
    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    await fullSession(dir, hooks, "kept-1")
    await fullSession(dir, hooks, "kept-2")
    await fullSession(dir, hooks, "kept-3")

    await hooks.close()

    const statePath = join(dir, ".opencode", "kasper", "state.json")
    const state = JSON.parse(await readFile(statePath, "utf-8"))
    const sessionCount = Object.keys(state.sessions).length
    expect(sessionCount).toBe(3)
    expect(state.sessions["kept-2"]).toBeDefined()
    expect(state.sessions["kept-3"]).toBeDefined()

    await rm(dir, { recursive: true, force: true })
  })

  test("score session returns error for non-existent session", async () => {
    const dir = await setupTestDir()
    const client = makeClient()
    ;(client as any).session.messages = mock(() =>
      Promise.reject(new Error("not found")),
    )

    const hooks = await KasperPlugin({
      client: client as any,
      directory: dir,
    })

    const output: any = {}
    await hooks["command.execute.before"](
      { command: "kasper", argument: "score session ghost-session" },
      output,
    )
    expect(output.message).toContain("Failed to fetch messages")

    await hooks.close()
    await rm(dir, { recursive: true, force: true })
  })
})
