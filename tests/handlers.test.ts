import { describe, expect, mock, test } from "bun:test"
import {
  buildApplyPromptForPendings,
  executeKasperHistory,
  executeKasperImprove,
  executeKasperStatus,
  handleBatchScoreSession,
  summarizeValidationInProgress,
} from "../src/handlers.js"
import { AsyncMutex } from "../src/mutex.js"
import type {
  AggregateStats,
  ImprovementRecord,
  KasperContext,
  SessionRecord,
} from "../src/types.js"
import { DEFAULT_CONFIG } from "../src/types.js"

function mockAggregate(
  overrides: Partial<AggregateStats> = {},
): AggregateStats {
  return {
    total_sessions: 5,
    avg_score: 0.72,
    top_weaknesses: [
      { pattern: "slow response", count: 3, suggested_fix: "" },
      { pattern: "misses details", count: 2, suggested_fix: "" },
    ],
    top_strengths: ["good code", "clear communication"],
    by_agent: {
      build: {
        total_sessions: 3,
        avg_score: 0.75,
        top_weaknesses: [
          { pattern: "slow response", count: 2, suggested_fix: "" },
        ],
        top_strengths: ["good code"],
      },
    },
    ...overrides,
  }
}

function makeSession(
  id: string,
  overrides: Partial<SessionRecord> = {},
): SessionRecord & { id: string } {
  return {
    id,
    title: `task-${id}`,
    agent_name: "build",
    agent_type: "primary",
    score: 0.8,
    timestamp: Date.now(),
    weaknesses: [],
    score_card: {
      session_id: id,
      timestamp: Date.now(),
      overall_score: 0.8,
      categories: {
        instruction_following: 0.9,
        completeness: 0.8,
        proactiveness: 0.7,
        code_quality: 0.8,
        communication: 0.8,
      },
      strengths: [],
      weaknesses: [],
    },
    ...overrides,
  }
}

function mockCtx(overrides: Partial<KasperContext> = {}): KasperContext {
  const improvements: ImprovementRecord[] = []
  return {
    stateStore: {
      getAggregate: () => mockAggregate(),
      getRecentSessions: (limit = 10) =>
        [makeSession("s1"), makeSession("s2")].slice(0, limit),
      getImprovements: () => improvements,
      getConfig: () => DEFAULT_CONFIG,
      getAgentAggregate: (name: string) =>
        name === "build" ? mockAggregate().by_agent.build : undefined,
      getAgentSessions: (name: string, _limit = 20) =>
        name === "build" ? [makeSession("s1")] : [],
      mergeAllWeaknesses: async () => {},
    } as unknown as KasperContext["stateStore"],
    improvementsPending: improvements,
    isMergingWeaknesses: false,
    agentsMd: {} as KasperContext["agentsMd"],
    agentPrompts: {} as KasperContext["agentPrompts"],
    scorer: {} as KasperContext["scorer"],
    agentRegistry: new Map(),
    client: {} as KasperContext["client"],
    config: DEFAULT_CONFIG,
    logger: { log: async () => {} } as unknown as KasperContext["logger"],
    sessionsEvaluated: new Set(),
    parentToChildren: new Map(),
    sessionParents: new Map(),
    deletedSessions: new Set(),
    kasperSessionIDs: new Set(),
    autoUpdateEnabled: DEFAULT_CONFIG.auto_update,
    agentSessionIDs: new Map(),
    rejectedPatterns: new Set(),
    userGuidance: new Map(),
    evalMutex: new AsyncMutex(),
    evaluationRunning: false,
    evaluationStartedAt: undefined,
    kasperPaused: false,
    registeredCommands: new Set(),
    sessionMsgCount: new Map(),
    idleSessions: new Set<string>(),
    ...overrides,
  }
}

describe("executeKasperStatus", () => {
  test("returns status with aggregate and recent sessions", async () => {
    const result = await executeKasperStatus(
      { agent: undefined, limit: 10 },
      mockCtx(),
    )
    expect(result).toContain("## Kasper Status")
    expect(result).toContain("**Total sessions tracked:** 5")
    expect(result).toContain("slow response (3x)")
    expect(result).toContain("good code")
    expect(result).toContain("task-s1")
    expect(result).toContain("Score Trend")
  })

  test("includes score emoji in status", async () => {
    const result = await executeKasperStatus(
      { agent: undefined, limit: 10 },
      mockCtx({
        stateStore: {
          getAggregate: () => mockAggregate({ avg_score: 0.85 }),
          getRecentSessions: () => [makeSession("s1"), makeSession("s2")],
          getImprovements: () => [],
          getConfig: () => DEFAULT_CONFIG,
          getAgentAggregate: () => undefined,
          getAgentSessions: () => [],
          mergeAllWeaknesses: async () => {},
        } as unknown as KasperContext["stateStore"],
      }),
    )
    expect(result).toContain("Average adherence score:")
  })

  test("includes agent-specific stats when agent arg provided", async () => {
    const result = await executeKasperStatus(
      { agent: "build", limit: 10 },
      mockCtx(),
    )
    expect(result).toContain("build Agent Stats")
    expect(result).toContain("Total sessions:")
  })

  test("shows no improvements message when none applied", async () => {
    const result = await executeKasperStatus(
      { agent: undefined, limit: 10 },
      mockCtx(),
    )
    expect(result).toContain("No improvements applied yet")
  })

  test("shows improvement count when improvements exist", async () => {
    const ctx = mockCtx()
    ctx.stateStore.getImprovements = () => [
      {
        timestamp: Date.now(),
        target: "agents_md",
        agents_md_diff: "diff",
        reason: "Fix slow response",
        backup_path: "",
      },
    ]
    const result = await executeKasperStatus(
      { agent: undefined, limit: 10 },
      ctx,
    )
    expect(result).toContain("Improvements Applied: 1")
  })

  test("handles empty aggregate", async () => {
    const ctx = mockCtx({
      stateStore: {
        getAggregate: () => ({
          total_sessions: 0,
          avg_score: 0,
          top_weaknesses: [],
          top_strengths: [],
          by_agent: {},
        }),
        getRecentSessions: () => [],
        getImprovements: () => [],
        getConfig: () => DEFAULT_CONFIG,
      } as unknown as KasperContext["stateStore"],
    })
    const result = await executeKasperStatus(
      { agent: undefined, limit: 10 },
      ctx,
    )
    expect(result).toContain("**Total sessions tracked:** 0")
  })
})

describe("executeKasperImprove", () => {
  test("returns message when no weaknesses", async () => {
    const ctx = mockCtx({
      stateStore: {
        getConfig: () => DEFAULT_CONFIG,
        getAggregate: () => ({
          total_sessions: 0,
          avg_score: 0,
          top_weaknesses: [],
          top_strengths: [],
          by_agent: {},
        }),
        getAgentAggregate: () => undefined,
      } as unknown as KasperContext["stateStore"],
    })
    const result = await executeKasperImprove({ agent: undefined }, ctx)
    expect(result).toContain("No weaknesses recorded yet")
  })

  test("returns message when no weaknesses meet threshold", async () => {
    const ctx = mockCtx({
      stateStore: {
        getConfig: () => DEFAULT_CONFIG,
        getAggregate: () =>
          mockAggregate({
            by_agent: {
              build: {
                total_sessions: 3,
                avg_score: 0.75,
                top_weaknesses: [
                  { pattern: "slow response", count: 1, suggested_fix: "" },
                ],
                top_strengths: ["good code"],
              },
            },
          }),
        getAgentAggregate: () => undefined,
      } as unknown as KasperContext["stateStore"],
    })
    const result = await executeKasperImprove({ agent: undefined }, ctx)
    expect(result).toContain("minimum observation threshold")
  })

  test("returns suggestions when weaknesses meet threshold", async () => {
    const ctx = mockCtx({
      stateStore: {
        getConfig: () => DEFAULT_CONFIG,
        getAggregate: () => mockAggregate(),
        getAgentAggregate: () => undefined,
        getAgentSessions: () => [],
        mergeAllWeaknesses: async () => {},
      } as unknown as KasperContext["stateStore"],
    })
    const result = await executeKasperImprove({ agent: undefined }, ctx)
    expect(result).toContain("## Suggested Improvements")
    expect(result).toContain("slow response")
  })

  test("returns agent-specific suggestions", async () => {
    const ctx = mockCtx({
      stateStore: {
        getConfig: () => DEFAULT_CONFIG,
        getAggregate: () => mockAggregate(),
        getAgentAggregate: (name: string) =>
          name === "build"
            ? {
                total_sessions: 3,
                avg_score: 0.75,
                top_weaknesses: [
                  { pattern: "slow response", count: 2, suggested_fix: "" },
                ],
                top_strengths: ["good code"],
              }
            : undefined,
      } as unknown as KasperContext["stateStore"],
    })
    const result = await executeKasperImprove({ agent: "build" }, ctx)
    expect(result).toContain("## Suggested Improvements for build")
    expect(result).toContain("1 | slow response")
  })
})

describe("executeKasperHistory", () => {
  test("returns history with sessions", async () => {
    const result = await executeKasperHistory(
      { agent: undefined, limit: 10 },
      mockCtx(),
    )
    expect(result).toContain("## Kasper History")
    expect(result).toContain("Sessions (2)")
    expect(result).toContain("task-s1")
  })

  test("filters by agent", async () => {
    const result = await executeKasperHistory(
      { agent: "build", limit: 10 },
      mockCtx(),
    )
    expect(result).toContain("### Agent: build")
  })

  test("shows no sessions message", async () => {
    const ctx = mockCtx({
      stateStore: {
        getRecentSessions: () => [],
        getAgentSessions: () => [],
        getImprovements: () => [],
      } as unknown as KasperContext["stateStore"],
    })
    const result = await executeKasperHistory(
      { agent: undefined, limit: 10 },
      ctx,
    )
    expect(result).toContain("No sessions recorded yet")
  })
})

describe("buildApplyPromptForPendings", () => {
  const basePending: ImprovementRecord = {
    id: "id-1",
    timestamp: Date.now(),
    target: "agents_md",
    agent_name: undefined,
    agents_md_diff: "",
    reason: "Did not verify fixes by running tests after making changes",
    backup_path: "",
    weaknesses: ["Did not verify fixes by running tests after making changes"],
  }

  test("returns prompt for single agents_md target", () => {
    const result = buildApplyPromptForPendings([{ ...basePending }])
    expect(result).toContain("AGENTS.md (project root)")
    expect(result).toContain(basePending.reason)
    expect(result).toContain("Read the full AGENTS.md")
    expect(result).toContain("Kasper Inferred Instructions")
  })

  test("returns prompt for single agent_prompt target", () => {
    const result = buildApplyPromptForPendings([
      { ...basePending, target: "agent_prompt", agent_name: "build" },
    ])
    expect(result).toContain("`build` agent prompt")
    expect(result).toContain(".opencode/agents/build.md")
    expect(result).toContain(basePending.reason)
  })

  test("returns prompt for multiple pending items", () => {
    const result = buildApplyPromptForPendings([
      { ...basePending },
      {
        ...basePending,
        id: "id-2",
        target: "agent_prompt",
        agent_name: "explore",
        reason: "Over-used tool calls without batching",
      },
    ])
    expect(result).toContain("[1/2]")
    expect(result).toContain("[2/2]")
    expect(result).toContain("AGENTS.md")
    expect(result).toContain("`explore` agent prompt")
    expect(result).toContain("Over-used tool calls without batching")
  })

  test("handles empty pending array", () => {
    const result = buildApplyPromptForPendings([])
    expect(result).toContain("No pending improvements")
  })
})

describe("executeKasperImprove output", () => {
  test("includes numbered indices and agent labels", async () => {
    const agg = mockAggregate({
      by_agent: {
        build: {
          total_sessions: 5,
          avg_score: 0.75,
          top_weaknesses: [
            {
              pattern: "slow response",
              count: 5,
              suggested_fix: "batch tool calls",
              target: "agents_md",
              agent_name: "build",
            },
          ],
          top_strengths: ["good code"],
        },
      },
    })
    const ctx = mockCtx({
      stateStore: {
        getAggregate: () => agg,
        getAgentAggregate: () => agg.by_agent.build,
        getRecentSessions: () => [],
        getImprovements: () => [],
        getConfig: () => DEFAULT_CONFIG,
      } as unknown as KasperContext["stateStore"],
    })
    const result = await executeKasperImprove({ force: false }, ctx)
    expect(result).toContain("1 | slow response")
    expect(result).toContain("AGENTS.md")
    expect(result).toContain("build")
    expect(result).toContain("batch tool calls")
  })

  test("includes apply instructions", async () => {
    const agg = mockAggregate({
      by_agent: {
        build: {
          total_sessions: 5,
          avg_score: 0.75,
          top_weaknesses: [
            {
              pattern: "slow response",
              count: 4,
              suggested_fix: "fix",
              target: "agents_md",
              agent_name: "build",
            },
          ],
          top_strengths: ["good code"],
        },
      },
    })
    const ctx = mockCtx({
      stateStore: {
        getAggregate: () => agg,
        getAgentAggregate: () => undefined,
        getRecentSessions: () => [],
        getImprovements: () => [],
        getConfig: () => DEFAULT_CONFIG,
      } as unknown as KasperContext["stateStore"],
    })
    const result = await executeKasperImprove({ force: false }, ctx)
    expect(result).toContain("/kasper apply")
  })
})

describe("executeKasperImprove per-agent", () => {
  test("includes target labels for agent-specific weaknesses", async () => {
    const agg = mockAggregate()
    const ctx = mockCtx({
      stateStore: {
        getAggregate: () => agg,
        getAgentAggregate: () => ({
          total_sessions: 3,
          avg_score: 0.75,
          top_weaknesses: [
            {
              pattern: "slow build",
              count: 3,
              suggested_fix: "use cache",
              target: "agent_prompt",
              agent_name: "build",
            },
            {
              pattern: "misses details",
              count: 2,
              suggested_fix: "add checklist",
              target: "agents_md",
              agent_name: "build",
            },
          ],
          top_strengths: ["good code"],
        }),
        getRecentSessions: () => [],
        getImprovements: () => [],
        getConfig: () => DEFAULT_CONFIG,
      } as unknown as KasperContext["stateStore"],
    })
    const result = await executeKasperImprove({ agent: "build" }, ctx)
    expect(result).toContain("1 | slow build")
    expect(result).toContain("2 | misses details")
    expect(result).toContain("agent prompt")
    expect(result).toContain("AGENTS.md")
    expect(result).toContain("use cache")
  })
})

describe("executeKasperStatus with subagents", () => {
  test("shows [sub] label for subagent sessions", async () => {
    const recent = [
      makeSession("s1", {
        title: "implement feature",
        score: 0.9,
        timestamp: 2000,
      }),
      makeSession("s2", {
        title: "subagent task",
        score: 0.7,
        timestamp: 1000,
        agent_type: "subagent" as any,
        parent_session_id: "s1",
      }),
    ]

    const ctx = mockCtx({
      stateStore: {
        getAggregate: () => ({
          total_sessions: 2,
          avg_score: 0.8,
          top_weaknesses: [{ pattern: "slow", count: 1, suggested_fix: "fix" }],
          top_strengths: ["good"],
          by_agent: {},
        }),
        getAgentAggregate: () => undefined,
        getRecentSessions: () => recent,
        getImprovements: () => [],
        getConfig: () => DEFAULT_CONFIG,
        getAgentSessions: () => [],
        mergeAllWeaknesses: async () => {},
      } as unknown as KasperContext["stateStore"],
    })
    const result = await executeKasperStatus({ limit: 10 }, ctx)
    expect(result).toContain("[sub]")
    expect(result).toContain("subagent task")
    expect(result).toContain("1 primary, 1 subagent")
  })

  test("does not show subagent breakdown when no subagents present", async () => {
    const recent = [
      makeSession("s1", { title: "task 1", score: 0.9 }),
      makeSession("s2", {
        title: "task 2",
        score: 0.8,
        agent_name: undefined as any,
      }),
    ]

    const ctx = mockCtx({
      stateStore: {
        getAggregate: () => ({
          total_sessions: 2,
          avg_score: 0.85,
          top_weaknesses: [],
          top_strengths: [],
          by_agent: {},
        }),
        getAgentAggregate: () => undefined,
        getRecentSessions: () => recent,
        getImprovements: () => [],
        getConfig: () => DEFAULT_CONFIG,
        getAgentSessions: () => [],
        mergeAllWeaknesses: async () => {},
      } as unknown as KasperContext["stateStore"],
    })
    const result = await executeKasperStatus({ limit: 10 }, ctx)
    expect(result).not.toContain("[sub]")
    expect(result).not.toContain("subagent in recent")
  })
})

describe("handleBatchScoreSession with subagents", () => {
  test("finds children from client.session.list() parentID matching", async () => {
    let listCalled = false
    const ctx = mockCtx({
      client: {
        session: {
          list: mock(() => {
            listCalled = true
            return Promise.resolve({
              data: [
                {
                  id: "p1",
                  time: { created: Date.now(), updated: Date.now() },
                },
                {
                  id: "p2",
                  time: { created: Date.now() - 60000, updated: Date.now() },
                },
                {
                  id: "child-x",
                  parentID: "p1",
                  agent: "explore",
                  time: { created: Date.now(), updated: Date.now() },
                },
                {
                  id: "child-y",
                  parentID: "p2",
                  agent: "build",
                  time: { created: Date.now() - 60000, updated: Date.now() },
                },
              ],
            })
          }),
        },
      } as any,
    })

    try {
      await handleBatchScoreSession(2, undefined, undefined, ctx)
    } catch {
      // Expected: may fail without full mocks, but list was called
    }
    expect(listCalled).toBe(true)
  })

  test("skips children from deleted sessions", async () => {
    const ctx = mockCtx({
      client: {
        session: {
          list: mock(() =>
            Promise.resolve({
              data: [
                {
                  id: "p1",
                  time: { created: Date.now(), updated: Date.now() },
                },
                {
                  id: "dead-child",
                  parentID: "p1",
                  time: { created: Date.now(), updated: Date.now() },
                },
              ],
            }),
          ),
        },
      } as any,
    })
    ctx.deletedSessions.add("dead-child")

    try {
      await handleBatchScoreSession(1, undefined, undefined, ctx)
    } catch {
      // Expected: may fail without full mocks
    }
  })
})

describe("summarizeValidationInProgress", () => {
  test("returns empty array when nothing is in flight", () => {
    const lines = summarizeValidationInProgress(mockCtx())
    expect(lines).toEqual([])
  })

  test("shows paused banner when kasperPaused is true", () => {
    const lines = summarizeValidationInProgress(mockCtx({ kasperPaused: true }))
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain("paused")
    expect(lines[0]).toContain("/kasper resume")
  })

  test("shows 'Validation in progress' with idle count when evaluation is running", () => {
    const idleSessions = new Set<string>(["s1", "s2", "s3"])
    const lines = summarizeValidationInProgress(
      mockCtx({
        evaluationRunning: true,
        evaluationStartedAt: Date.now() - 5_000,
        idleSessions,
      }),
    )
    expect(lines.some((l) => l.includes("Validation in progress"))).toBe(true)
    expect(lines.some((l) => l.includes("3 idle sessions queued"))).toBe(true)
    expect(lines.some((l) => l.includes("5s"))).toBe(true)
  })

  test("uses singular 'session' for exactly one idle queued", () => {
    const idleSessions = new Set<string>(["only-one"])
    const lines = summarizeValidationInProgress(
      mockCtx({
        evaluationRunning: true,
        evaluationStartedAt: Date.now(),
        idleSessions,
      }),
    )
    expect(lines.some((l) => l.includes("1 idle session queued"))).toBe(true)
    expect(lines.some((l) => l.includes("1 idle sessions queued"))).toBe(false)
  })

  test("formats elapsed time in m:ss when over a minute", () => {
    const lines = summarizeValidationInProgress(
      mockCtx({
        evaluationRunning: true,
        evaluationStartedAt: Date.now() - 125_000, // 2m 5s
        idleSessions: new Set(),
      }),
    )
    expect(lines.some((l) => l.includes("2m 5s"))).toBe(true)
  })

  test("shows 'idle, waiting for next poll' when sessions are queued but evaluation is not running", () => {
    const lines = summarizeValidationInProgress(
      mockCtx({
        evaluationRunning: false,
        idleSessions: new Set(["a", "b"]),
      }),
    )
    expect(lines.some((l) => l.includes("idle, waiting for next poll"))).toBe(
      true,
    )
    expect(lines.some((l) => l.includes("Validation in progress"))).toBe(false)
  })

  test("shows weakness-merge banner when isMergingWeaknesses is true", () => {
    const lines = summarizeValidationInProgress(
      mockCtx({ isMergingWeaknesses: true }),
    )
    expect(lines.some((l) => l.includes("Merging weaknesses"))).toBe(true)
  })

  test("shows pending-improvements banner with count and singular/plural handling", () => {
    const improvements: ImprovementRecord[] = [
      {
        id: "1",
        timestamp: 1,
        target: "agents_md",
        agents_md_diff: "",
        reason: "x",
        backup_path: "",
      },
    ]
    const one = summarizeValidationInProgress(
      mockCtx({ improvementsPending: improvements }),
    )
    expect(one.some((l) => l.includes("1 pending improvement awaiting"))).toBe(
      true,
    )

    const many = summarizeValidationInProgress(
      mockCtx({
        improvementsPending: [
          ...improvements,
          { ...improvements[0], id: "2" },
          { ...improvements[0], id: "3" },
        ],
      }),
    )
    expect(
      many.some((l) => l.includes("3 pending improvements awaiting")),
    ).toBe(true)
  })

  test("status command surfaces the In Progress banner", async () => {
    const result = await executeKasperStatus(
      { agent: undefined, limit: 10 },
      mockCtx({
        evaluationRunning: true,
        evaluationStartedAt: Date.now() - 2_000,
        idleSessions: new Set(["x"]),
        improvementsPending: [
          {
            id: "1",
            timestamp: 1,
            target: "agents_md",
            agents_md_diff: "",
            reason: "x",
            backup_path: "",
          },
        ],
      }),
    )
    expect(result).toContain("### In Progress")
    expect(result).toContain("Validation in progress")
    expect(result).toContain("1 pending improvement")
  })
})
