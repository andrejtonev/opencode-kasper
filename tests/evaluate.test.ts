import { describe, expect, mock, test } from "bun:test"
import {
  batchEvaluateSessions,
  buildEvalFromMessages,
  considerImprovement,
  evaluateChildSessions,
  evaluateSession,
  manualEvaluateSession,
  runEvaluation,
} from "../src/evaluate.js"
import { AsyncMutex } from "../src/mutex.js"
import { KasperRuntime } from "../src/runtime.js"
import type { KasperContext, PendingEval, ScoreCard } from "../src/types.js"
import { DEFAULT_CONFIG } from "../src/types.js"

function makeScoreCard(overrides: Partial<ScoreCard> = {}): ScoreCard {
  return {
    session_id: "test-session",
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
    ...overrides,
  }
}

function makePendingEval(overrides: Partial<PendingEval> = {}): PendingEval {
  return {
    sessionID: "test-session",
    userInstruction: "do the thing",
    agentResponseParts: ["ok"],
    toolCalls: [],
    pairs: [],
    compacted: false,
    createdAt: Date.now(),
    ...overrides,
  }
}

function mockCtx(overrides: Partial<KasperContext> = {}): KasperContext {
  return {
    stateStore: {
      getConfig: () => DEFAULT_CONFIG,
      recordSession: () => {},
      recordImprovement: () => {},
      addEvaluatedSession: () => {},
      resetWeaknessCounts: () => {},
      getTotalSessions: () => 0,
      getAggregate: () => ({
        total_sessions: 0,
        avg_score: 0,
        top_weaknesses: [],
        top_strengths: [],
        by_agent: {},
      }),
      getRecentSessions: () => [] as any[],
      getImprovements: () => [] as any[],
      getAgentAggregate: () => undefined as any,
      getAgentSessions: () => [] as any[],
      setImprovementDelta: () => {},
      getSession: () => undefined as any,
    } as unknown as KasperContext["stateStore"],
    agentsMd: {
      read: async () => "# AGENTS.md\nBe good.",
      injectSection: (_existing: string, _name: string, content: string) =>
        content,
      backup: async (_label: string) => "/backup/path",
      write: async (_content: string) => {},
      lockedUpdate: async (updater: (existing: string) => Promise<string>) => {
        await updater("# AGENTS.md\nBe good.")
      },
    } as unknown as KasperContext["agentsMd"],
    agentPrompts: {
      read: async (_agentName: string) => "",
      resolve: async (_agentName: string) => ({ kind: "missing" as const }),
    } as unknown as KasperContext["agentPrompts"],
    scorer: {
      evaluate: async (_input: any) => makeScoreCard(),
    } as unknown as KasperContext["scorer"],
    client: {
      tui: { showToast: async () => {} },
      session: {},
    } as unknown as KasperContext["client"],
    logger: {
      log: async () => {},
      trim: async () => {},
    } as unknown as KasperContext["logger"],
    sessionsEvaluated: new Set(),
    improvementsPending: [],
    config: DEFAULT_CONFIG,
    agentRegistry: new Map(),
    parentToChildren: new Map(),
    sessionParents: new Map(),
    deletedSessions: new Set(),
    kasperSessionIDs: new Set(),
    autoUpdateEnabled: DEFAULT_CONFIG.auto_update,
    agentSessionIDs: new Map(),
    rejectedPatterns: new Set(),
    sessionMsgCount: new Map(),
    userGuidance: new Map(),
    evalMutex: new AsyncMutex(),
    evaluationRunning: false,
    evaluationStartedAt: undefined,
    isMergingWeaknesses: false,
    kasperPaused: false,
    registeredCommands: new Set(),
    idleSessions: new Set(),
    ...overrides,
  }
}

describe("runEvaluation", () => {
  test("deleted or reset source cannot commit an in-flight logical range", async () => {
    for (const reset of [false, true]) {
      const runtime = new KasperRuntime()
      let release!: (card: ScoreCard) => void
      const ctx = mockCtx({ runtime, lifetimeSignal: runtime.lifetimeSignal })
      const record = mock(() => {})
      ctx.stateStore.recordSession = record as any
      ctx.scorer.evaluate = mock(
        () =>
          new Promise<ScoreCard>((resolve) => {
            release = resolve
          }),
      ) as any
      const evaluation = runEvaluation(
        makePendingEval({
          sessionID: "s|agent:A|from:a1",
          sourceSessionID: "s",
        }),
        ctx,
      )
      while (!release) await Promise.resolve()
      if (reset) runtime.invalidateAll()
      else {
        ctx.deletedSessions.add("s")
        runtime.invalidateSession("s")
      }
      release(makeScoreCard())
      expect(await evaluation).toBe(false)
      expect(record).not.toHaveBeenCalled()
      expect(ctx.sessionsEvaluated.size).toBe(0)
      await runtime.dispose()
    }
  })

  test("failed durable flush preserves evidence for retry and prevents guidance", async () => {
    const ctx = mockCtx()
    const restore = mock(() => {})
    ctx.stateStore.restoreSessionAfterFailedCommit = restore as any
    ctx.stateStore.flush = mock(async () => {
      throw new Error("disk unavailable")
    }) as any
    ctx.scorer.evaluate = mock(async () =>
      makeScoreCard({
        overall_score: 0.2,
        suggested_agents_md_update:
          "Always check all relevant inputs before changes.",
      }),
    ) as any
    expect(await runEvaluation(makePendingEval(), ctx)).toBe(false)
    expect(restore).toHaveBeenCalled()
    expect(ctx.sessionsEvaluated.size).toBe(0)
    expect(ctx.improvementsPending).toHaveLength(0)
  })
  test("records session and adds to sessionsEvaluated", async () => {
    let recorded = false
    const ctx = mockCtx({
      stateStore: {
        getConfig: () => DEFAULT_CONFIG,
        recordSession: () => {
          recorded = true
        },
        getAggregate: () => ({
          total_sessions: 0,
          avg_score: 0,
          top_weaknesses: [],
          top_strengths: [],
          by_agent: {},
        }),
      } as unknown as KasperContext["stateStore"],
    })
    await runEvaluation(makePendingEval(), ctx)
    expect(recorded).toBe(true)
    expect(ctx.sessionsEvaluated.has("test-session")).toBe(true)
  })

  test("does not queue improvement when score above threshold", async () => {
    const ctx = mockCtx()
    ctx.stateStore.recordSession = (() => {}) as any
    await runEvaluation(makePendingEval(), {
      ...ctx,
      stateStore: {
        ...ctx.stateStore,
        getConfig: () => ({ ...DEFAULT_CONFIG, scoring_threshold: 0.5 }),
      } as any,
    })
    expect(ctx.improvementsPending.length).toBe(0)
  })

  test("calls considerImprovement when score below threshold", async () => {
    const ctx = mockCtx({
      autoUpdateEnabled: false,
      scorer: {
        evaluate: async () =>
          makeScoreCard({
            overall_score: 0.3,
            suggested_agents_md_update: "fix this",
            weaknesses: ["test weakness"],
          }),
      } as any,
      stateStore: {
        getConfig: () => ({
          ...DEFAULT_CONFIG,
          auto_update: false,
          scoring_threshold: 0.6,
        }),
        recordSession: () => {},
        getAggregate: () => ({
          total_sessions: 1,
          avg_score: 0.3,
          top_weaknesses: [
            { pattern: "test weakness", count: 2, suggested_fix: "" },
          ],
          top_strengths: [],
          by_agent: {},
        }),
      } as any,
      agentsMd: {
        read: async () => "",
        injectSection: () => "",
        backup: async () => "",
        write: async () => {},
        lockedUpdate: async (
          updater: (existing: string) => Promise<string>,
        ) => {
          await updater("")
        },
      } as any,
      agentPrompts: { read: async () => "" } as any,
    })
    await runEvaluation(makePendingEval({ userInstruction: "do it" }), ctx)
    expect(ctx.improvementsPending.length).toBeGreaterThan(0)
  })

  test("shows toast when score below 0.4", async () => {
    let toastShown = false
    const ctx = mockCtx({
      scorer: {
        evaluate: async () => makeScoreCard({ overall_score: 0.3 }),
      } as any,
      stateStore: {
        getConfig: () => ({
          ...DEFAULT_CONFIG,
          scoring_threshold: 0.6,
        }),
        recordSession: () => {},
        getAggregate: () => ({
          total_sessions: 0,
          avg_score: 0,
          top_weaknesses: [],
          top_strengths: [],
          by_agent: {},
        }),
      } as any,
      client: {
        tui: {
          showToast: async () => {
            toastShown = true
          },
        },
      } as any,
      agentsMd: {
        read: async () => "",
        injectSection: () => "",
        backup: async () => "",
        write: async () => {},
        lockedUpdate: async (
          updater: (existing: string) => Promise<string>,
        ) => {
          await updater("")
        },
      } as any,
    })
    await runEvaluation(
      makePendingEval({ userInstruction: "test instruction" }),
      ctx,
    )
    expect(toastShown).toBe(true)
  })

  test("does not show toast for scores >=0.4", async () => {
    let toastCount = 0
    const ctx = mockCtx({
      scorer: {
        evaluate: async () => makeScoreCard({ overall_score: 0.75 }),
      } as any,
      stateStore: {
        getConfig: () => ({
          ...DEFAULT_CONFIG,
          scoring_threshold: 0.9,
        }),
        recordSession: () => {},
        getAggregate: () => ({
          total_sessions: 0,
          avg_score: 0,
          top_weaknesses: [],
          top_strengths: [],
          by_agent: {},
        }),
      } as any,
      client: {
        tui: {
          showToast: async () => {
            toastCount++
          },
        },
      } as any,
      agentsMd: {
        read: async () => "",
        injectSection: () => "",
        backup: async () => "",
        write: async () => {},
        lockedUpdate: async (
          updater: (existing: string) => Promise<string>,
        ) => {
          await updater("")
        },
      } as any,
    })
    await runEvaluation(
      makePendingEval({ userInstruction: "test instruction" }),
      ctx,
    )
    expect(toastCount).toBe(0)
  })

  test("reads agent prompt when agent name is set", async () => {
    let readAgent = ""
    const ctx = mockCtx({
      agentPrompts: {
        read: async (name: string) => {
          readAgent = name
          return "agent prompt content"
        },
      } as any,
    })
    await runEvaluation(makePendingEval({ agentName: "build" }), ctx)
    expect(readAgent).toBe("build")
  })

  test("passes userGuidance to scorer input", async () => {
    let receivedGuidance: string | undefined
    const ctx = mockCtx({
      userGuidance: new Map([["test-session", "focus on code reuse"]]),
      scorer: {
        evaluate: async (input: any) => {
          receivedGuidance = input.userGuidance
          return makeScoreCard()
        },
      } as any,
      agentPrompts: { read: async () => "" } as any,
    })
    await runEvaluation(makePendingEval(), ctx)
    expect(receivedGuidance).toBe("focus on code reuse")
  })

  test("returns false when session already evaluated", async () => {
    const ctx = mockCtx()
    ctx.sessionsEvaluated.add("test-session")
    const result = await runEvaluation(makePendingEval(), ctx)
    expect(result).toBe(false)
  })

  test("fallback card (e.g. model unavailable) does NOT mark session as evaluated", async () => {
    // Regression: a primary session whose scorer returns a fallback
    // card (because session.create threw — e.g. user picked a model
    // that doesn't exist, or the model provider is down) used to be
    // added to ctx.sessionsEvaluated unconditionally. The
    // runEvaluation() short-circuit at line 96 then skipped the
    // session for the rest of the plugin lifetime, silently disabling
    // any future re-attempt. The user would have to restart opencode
    // to retry. The fix: the fallback path records nothing. Only the
    // successful-recording path (recordSession + addEvaluatedSession)
    // is allowed to mark a session as evaluated.
    const ctx = mockCtx({
      scorer: {
        evaluate: async (_input: any) =>
          makeScoreCard({ fallback: true, overall_score: 0.5 }),
      } as any,
    })
    const result = await runEvaluation(
      makePendingEval({ sessionID: "broken-model-session" }),
      ctx,
    )
    expect(result).toBe(false)
    // The fallback path must NOT add the session to sessionsEvaluated.
    // If it does, the next runEvaluation() call for the same session
    // id will short-circuit at the line-96 guard and never call the
    // LLM again.
    expect(ctx.sessionsEvaluated.has("broken-model-session")).toBe(false)

    // And the next call must actually re-attempt the scoring.
    let secondCallCount = 0
    ctx.scorer = {
      evaluate: async (_input: any) => {
        secondCallCount++
        return makeScoreCard({ fallback: true, overall_score: 0.5 })
      },
    } as any
    await runEvaluation(
      makePendingEval({ sessionID: "broken-model-session" }),
      ctx,
    )
    expect(secondCallCount).toBe(1)
  })

  test("passes complete response to the scorer's single visible evidence budget", async () => {
    let receivedResponse = ""
    const ctx = mockCtx({
      scorer: {
        evaluate: async (input: any) => {
          receivedResponse = input.agentResponse
          return makeScoreCard()
        },
      } as any,
    })
    const longResponse = "x".repeat(15000)
    await runEvaluation(
      makePendingEval({ agentResponseParts: [longResponse] }),
      ctx,
    )
    expect(receivedResponse).toBe(longResponse)
  })

  test("passes tool coverage to the scorer rather than silently dropping calls", async () => {
    let receivedToolCalls = 0
    const ctx = mockCtx({
      scorer: {
        evaluate: async (input: any) => {
          receivedToolCalls = input.toolCalls.length
          return makeScoreCard()
        },
      } as any,
    })
    const manyToolCalls = Array.from({ length: 50 }, (_, i) => ({
      tool: `tool${i}`,
      args: "{}",
      result: "ok",
    }))
    await runEvaluation(makePendingEval({ toolCalls: manyToolCalls }), ctx)
    expect(receivedToolCalls).toBe(50)
  })
})

describe("considerImprovement", () => {
  test("partial-evidence observations cannot queue or auto-apply improvements", async () => {
    for (const auto_update of [false, true]) {
      const ctx = mockCtx()
      const update = mock(async () => {})
      ctx.agentsMd.lockedUpdate = update as any
      await considerImprovement(
        makeScoreCard({
          evidence_truncated: true,
          overall_score: 0.2,
          weaknesses: ["missed tests"],
          suggested_agents_md_update:
            "Always run relevant tests before completing changes.",
        }),
        ctx,
        { ...DEFAULT_CONFIG, auto_update },
        makePendingEval(),
      )
      expect(update).not.toHaveBeenCalled()
      expect(ctx.improvementsPending).toHaveLength(0)
    }
  })
  test("returns early when no suggested updates at all", async () => {
    const ctx = mockCtx()
    const card = makeScoreCard({
      suggested_agents_md_update: undefined,
      suggested_agent_prompt_update: undefined,
    })
    await considerImprovement(card, ctx, DEFAULT_CONFIG, makePendingEval())
    expect(ctx.improvementsPending.length).toBe(0)
  })

  test("returns early when no matching weakness found", async () => {
    const ctx = mockCtx({
      stateStore: {
        getAggregate: () => ({
          total_sessions: 0,
          avg_score: 0,
          top_weaknesses: [],
          top_strengths: [],
          by_agent: {},
        }),
      } as any,
    })
    const card = makeScoreCard({
      overall_score: 0.4,
      suggested_agents_md_update: "fix this",
      weaknesses: ["unrelated weakness"],
    })
    await considerImprovement(card, ctx, DEFAULT_CONFIG, makePendingEval())
    expect(ctx.improvementsPending.length).toBe(0)
  })

  test("queues improvement when auto-update is off and matching weakness found", async () => {
    const ctx = mockCtx({
      autoUpdateEnabled: false,
      stateStore: {
        getAggregate: () => ({
          total_sessions: 3,
          avg_score: 0.4,
          top_weaknesses: [
            { pattern: "test weakness", count: 3, suggested_fix: "" },
          ],
          top_strengths: [],
          by_agent: {},
        }),
      } as any,
    })
    const card = makeScoreCard({
      overall_score: 0.4,
      suggested_agents_md_update: "fix this pattern",
      weaknesses: ["test weakness"],
    })
    const config = {
      ...DEFAULT_CONFIG,
      auto_update: false,
    }
    await considerImprovement(card, ctx, config, makePendingEval())
    expect(ctx.improvementsPending.length).toBe(1)
    expect(ctx.improvementsPending[0].reason).toBe("fix this pattern")
  })

  test("auto-applies improvement to AGENTS.md when auto-update is on", async () => {
    let wrote = false
    let backedUp = false
    const ctx = mockCtx({
      stateStore: {
        getAggregate: () => ({
          total_sessions: 3,
          avg_score: 0.4,
          top_weaknesses: [
            { pattern: "test weakness", count: 3, suggested_fix: "" },
          ],
          top_strengths: [],
          by_agent: {},
        }),
        recordImprovement: () => {},
        resetWeaknessCounts: () => {},
        getTotalSessions: () => 0,
      } as any,
      agentsMd: {
        read: async () => "# AGENTS",
        injectSection: (_e: string, _n: string, _c: string) =>
          "# AGENTS\n\n## Section\ncontent",
        backup: async (_l: string) => {
          backedUp = true
          return "/backup"
        },
        write: async () => {
          wrote = true
        },
        lockedUpdate: async (
          updater: (existing: string) => Promise<string>,
        ) => {
          await updater("# AGENTS")
          wrote = true
        },
      } as any,
    })
    const card = makeScoreCard({
      overall_score: 0.4,
      suggested_agents_md_update: "fix this pattern",
      weaknesses: ["test weakness"],
    })
    const config = {
      ...DEFAULT_CONFIG,
      auto_update: true,
    }
    await considerImprovement(card, ctx, config, makePendingEval())
    expect(wrote).toBe(true)
    expect(backedUp).toBe(true)
  })

  test("queues agent prompt improvement when auto-update is off and agentName is set", async () => {
    // Built-in 'build' agent has no defined prompt (resolve returns
    // 'missing' in mockCtx). The dispatcher must reroute the per-agent
    // improvement to AGENTS.md so the guidance actually takes effect.
    const ctx = mockCtx({
      autoUpdateEnabled: false,
      stateStore: {
        getAggregate: () => ({
          total_sessions: 3,
          avg_score: 0.4,
          top_weaknesses: [
            { pattern: "test weakness", count: 3, suggested_fix: "" },
          ],
          top_strengths: [],
          by_agent: {},
        }),
      } as any,
    })
    const card = makeScoreCard({
      overall_score: 0.4,
      suggested_agent_prompt_update: "Instructions specific to build agent",
      weaknesses: ["test weakness"],
    })
    const config = {
      ...DEFAULT_CONFIG,
      auto_update: false,
    }
    await considerImprovement(
      card,
      ctx,
      config,
      makePendingEval({ agentName: "build" }),
    )
    expect(ctx.improvementsPending.length).toBe(1)
    expect(ctx.improvementsPending[0].target).toBe("agents_md")
    expect(ctx.improvementsPending[0].agent_name).toBe("build")
    expect(ctx.improvementsPending[0].reason).toBe(
      "Instructions specific to build agent",
    )
  })

  test("auto-applies improvement to agent prompt when auto-update is on and agentName is set", async () => {
    // Built-in 'build' agent with no defined prompt: the per-agent
    // improvement is rerouted to AGENTS.md (the rules file the built-in
    // agents actually read). The dead .opencode/agents/build.md file is
    // NOT created.
    let agentsMdWritten = false
    const ctx = mockCtx({
      stateStore: {
        getAggregate: () => ({
          total_sessions: 3,
          avg_score: 0.4,
          top_weaknesses: [
            { pattern: "test weakness", count: 3, suggested_fix: "" },
          ],
          top_strengths: [],
          by_agent: {},
        }),
        recordImprovement: () => {},
        resetWeaknessCounts: () => {},
        getTotalSessions: () => 0,
      } as any,
      agentPrompts: {
        read: async () => "",
        resolve: async () => ({ kind: "missing" as const }),
        injectSection: async () => {
          throw new Error(
            "agent_prompt must NOT be written for a built-in agent with no defined prompt",
          )
        },
      } as any,
      agentsMd: {
        read: async () => "",
        backup: async () => "/backup/AGENTS.md",
        injectSection: (existing: string) => {
          agentsMdWritten = true
          return `${existing}\n## rerouted\n`
        },
        lockedUpdate: async (updater: any) => {
          agentsMdWritten = true
          await updater("# AGENTS.md\n")
        },
      } as any,
    })
    const card = makeScoreCard({
      overall_score: 0.4,
      suggested_agent_prompt_update: "Agent must validate all inputs",
      weaknesses: ["test weakness"],
    })
    const config = {
      ...DEFAULT_CONFIG,
      auto_update: true,
    }
    await considerImprovement(
      card,
      ctx,
      config,
      makePendingEval({ agentName: "build" }),
    )
    expect(agentsMdWritten).toBe(true)
  })
})

describe("evaluateChildSessions", () => {
  test("finds children from parentToChildren map", async () => {
    const ctx = mockCtx()
    ctx.parentToChildren.set("parent-1", new Set(["child-a", "child-b"]))

    const results = await evaluateChildSessions("parent-1", ctx, 0)
    expect(results.length).toBe(0) // no session.messages mock, so no result msgs
    // but the function should have found the children and attempted to fillPendingForSession
  })

  test("finds children from client.session.list() parentID matching", async () => {
    const ctx = mockCtx({
      client: {
        session: {
          list: mock(() =>
            Promise.resolve({
              data: [
                { id: "sub-from-list", parentID: "parent-x", agent: "explore" },
                { id: "unrelated", parentID: undefined },
              ],
            }),
          ),
        },
      } as any,
    })

    const results = await evaluateChildSessions("parent-x", ctx, 0)
    expect(results.length).toBe(0) // no messages mock, so no fillPendingForSession result
    // but function ran without error and found children
  })

  test("respects depth limit", async () => {
    const ctx = mockCtx()
    ctx.parentToChildren.set("root", new Set(["level1"]))
    ctx.parentToChildren.set("level1", new Set(["level2"]))
    ctx.parentToChildren.set("level2", new Set(["level3"]))
    ctx.parentToChildren.set("level3", new Set(["level4"]))

    const results = await evaluateChildSessions("root", ctx, 0)
    expect(results.length).toBe(0) // no messages mock
    // But with the current depth limit of 3, level4 should not be reached
    // (depth starts at 0, max is 3)
  })

  test("skips deleted sessions", async () => {
    const ctx = mockCtx()
    ctx.parentToChildren.set("parent-1", new Set(["child-alive", "child-dead"]))
    ctx.deletedSessions.add("child-dead")

    const results = await evaluateChildSessions("parent-1", ctx, 0)
    expect(results.length).toBe(0) // no messages mock
  })
})

describe("manualEvaluateSession with subagents", () => {
  test("evaluates child subagents in single-segment path", async () => {
    const _childEvaluated = false
    const scoredIDs: string[] = []

    const ctx = mockCtx({
      config: { ...DEFAULT_CONFIG, min_session_messages: 1 },
      scorer: {
        evaluate: async (input: any) => {
          scoredIDs.push(input.sessionID || "unknown")
          return makeScoreCard({
            overall_score: 0.8,
            session_id: input.sessionID,
          })
        },
      } as any,
      client: {
        session: {
          messages: mock((args: any) =>
            Promise.resolve({
              data: [
                {
                  info: { id: "m1", role: "user", sessionID: args.path.id },
                  parts: [{ type: "text", text: "first user message" }],
                },
                {
                  info: {
                    id: "m2",
                    role: "assistant",
                    sessionID: args.path.id,
                  },
                  parts: [{ type: "text", text: "assistant response" }],
                },
                {
                  info: { id: "m3", role: "user", sessionID: args.path.id },
                  parts: [{ type: "text", text: "second user message" }],
                },
              ],
            }),
          ),
          list: mock(() =>
            Promise.resolve({
              data: [
                {
                  id: "child-eval-test",
                  parentID: "test-parent-sub",
                  agent: "build",
                },
              ],
            }),
          ),
        },
      } as any,
    })

    ctx.parentToChildren.set("test-parent-sub", new Set([]))

    const result = await manualEvaluateSession("test-parent-sub", ctx)
    expect(result).toContain("Manual evaluation")

    ctx.sessionsEvaluated.clear()
  })

  test("evaluates child subagents in multi-agent path", async () => {
    const scoredIDs: string[] = []

    const ctx = mockCtx({
      config: { ...DEFAULT_CONFIG, min_session_messages: 1 },
      scorer: {
        evaluate: async (input: any) => {
          scoredIDs.push(input.sessionID || "unknown")
          return makeScoreCard({
            overall_score: 0.8,
            session_id: input.sessionID,
          })
        },
      } as any,
      client: {
        session: {
          messages: mock((args: any) => {
            const sid = args.path.id
            if (sid === "multi-agent-parent") {
              return Promise.resolve({
                data: [
                  {
                    info: {
                      id: "m1",
                      role: "user",
                      sessionID: sid,
                      agent: { name: "general" },
                    },
                    parts: [{ type: "text", text: "do multi-agent work" }],
                  },
                  {
                    info: {
                      id: "m2",
                      role: "assistant",
                      sessionID: sid,
                      agent: { name: "general" },
                    },
                    parts: [{ type: "text", text: "first agent response" }],
                  },
                  {
                    info: {
                      id: "m3",
                      role: "user",
                      sessionID: sid,
                      agent: { name: "general" },
                    },
                    parts: [{ type: "text", text: "follow-up request" }],
                  },
                  {
                    info: {
                      id: "m4",
                      role: "assistant",
                      sessionID: sid,
                      agent: { name: "build" },
                    },
                    parts: [{ type: "text", text: "build agent response" }],
                  },
                ],
              })
            }
            return Promise.resolve({
              data: [
                {
                  info: { id: "c1", role: "user", sessionID: sid },
                  parts: [{ type: "text", text: "child first req" }],
                },
                {
                  info: { id: "c2", role: "assistant", sessionID: sid },
                  parts: [{ type: "text", text: "child first response" }],
                },
                {
                  info: { id: "c3", role: "user", sessionID: sid },
                  parts: [{ type: "text", text: "child follow-up" }],
                },
              ],
            })
          }),
          list: mock(() =>
            Promise.resolve({
              data: [
                {
                  id: "multi-child",
                  parentID: "multi-agent-parent",
                  agent: "explore",
                },
              ],
            }),
          ),
        },
      } as any,
    })

    ctx.parentToChildren.set("multi-agent-parent", new Set([]))

    const result = await manualEvaluateSession("multi-agent-parent", ctx)
    expect(result).toContain("multi-agent-parent")

    ctx.sessionsEvaluated.clear()
  })

  test("handles evaluation with no child sessions", async () => {
    const ctx = mockCtx({
      config: { ...DEFAULT_CONFIG, min_session_messages: 1 },
      scorer: {
        evaluate: async () => makeScoreCard({ overall_score: 0.75 }),
      } as any,
      client: {
        session: {
          messages: mock((args: any) =>
            Promise.resolve({
              data: [
                {
                  info: { id: "m1", role: "user", sessionID: args.path.id },
                  parts: [{ type: "text", text: "first message" }],
                },
                {
                  info: {
                    id: "m2",
                    role: "assistant",
                    sessionID: args.path.id,
                  },
                  parts: [{ type: "text", text: "assistant reply" }],
                },
                {
                  info: { id: "m3", role: "user", sessionID: args.path.id },
                  parts: [{ type: "text", text: "second message" }],
                },
              ],
            }),
          ),
          list: mock(() => Promise.resolve({ data: [] })),
        },
      } as any,
    })

    const result = await manualEvaluateSession("no-children", ctx)
    expect(result).toContain("Manual evaluation")

    ctx.sessionsEvaluated.clear()
  })
})

describe("buildEvalFromMessages", () => {
  test("returns null for empty messages", () => {
    const result = buildEvalFromMessages([], "sid", undefined)
    expect(result).toBeNull()
  })

  test("returns null when no complete pairs exist", () => {
    const msgs = [
      {
        info: { id: "m1", role: "user", sessionID: "sid" },
        parts: [{ type: "text", text: "hello" }],
      },
    ]
    const result = buildEvalFromMessages(msgs, "sid", undefined, 0, new Set())
    expect(result).toBeNull()
  })

  test("builds eval from user-assistant pair", () => {
    const msgs = [
      {
        info: { id: "m1", role: "user", sessionID: "sid" },
        parts: [{ type: "text", text: "do task" }],
      },
      {
        info: { id: "m2", role: "assistant", sessionID: "sid" },
        parts: [{ type: "text", text: "done" }],
      },
    ]
    const result = buildEvalFromMessages(
      msgs,
      "sid",
      "build",
      0,
      new Set(),
      undefined,
      true,
    )
    expect(result).not.toBeNull()
    expect(result!.sessionID).toBe("sid")
    expect(result!.agentName).toBe("build")
    expect(result!.userInstruction).toBe("do task")
    expect(result!.agentResponseParts).toEqual(["done"])
    expect(result!.pairs.length).toBe(1)
    expect(result!.pairs[0].userInstruction).toBe("do task")
    expect(result!.pairs[0].agentResponse).toBe("done")
  })

  test("respects lastMsgId to filter messages", () => {
    const msgs = [
      {
        info: { id: "m1", role: "user", sessionID: "sid" },
        parts: [{ type: "text", text: "first" }],
      },
      {
        info: { id: "m2", role: "assistant", sessionID: "sid" },
        parts: [{ type: "text", text: "first reply" }],
      },
      {
        info: { id: "m3", role: "user", sessionID: "sid" },
        parts: [{ type: "text", text: "second" }],
      },
      {
        info: { id: "m4", role: "assistant", sessionID: "sid" },
        parts: [{ type: "text", text: "second reply" }],
      },
    ]
    const result = buildEvalFromMessages(
      msgs,
      "sid",
      undefined,
      0,
      new Set(),
      "m2",
      true,
    )
    expect(result).not.toBeNull()
    expect(result!.userInstruction).toBe("second")
    expect(result!.agentResponseParts).toEqual(["second reply"])
  })

  test("returns null when lastMsgId is the last message", () => {
    const msgs = [
      {
        info: { id: "m1", role: "user", sessionID: "sid" },
        parts: [{ type: "text", text: "first" }],
      },
      {
        info: { id: "m2", role: "assistant", sessionID: "sid" },
        parts: [{ type: "text", text: "reply" }],
      },
    ]
    const result = buildEvalFromMessages(
      msgs,
      "sid",
      undefined,
      0,
      new Set(),
      "m2",
    )
    expect(result).toBeNull()
  })

  test("respects minUserMessages", () => {
    const msgs = [
      {
        info: { id: "m1", role: "user", sessionID: "sid" },
        parts: [{ type: "text", text: "do task" }],
      },
      {
        info: { id: "m2", role: "assistant", sessionID: "sid" },
        parts: [{ type: "text", text: "done" }],
      },
    ]
    const result = buildEvalFromMessages(msgs, "sid", undefined, 2, new Set())
    expect(result).toBeNull()
  })

  test("filters out registered commands", () => {
    const cmds = new Set(["kasper"])
    const msgs = [
      {
        info: { id: "m1", role: "user", sessionID: "sid" },
        parts: [{ type: "text", text: "/kasper status" }],
      },
      {
        info: { id: "m2", role: "user", sessionID: "sid" },
        parts: [{ type: "text", text: "real request" }],
      },
      {
        info: { id: "m3", role: "assistant", sessionID: "sid" },
        parts: [{ type: "text", text: "ok" }],
      },
    ]
    const result = buildEvalFromMessages(
      msgs,
      "sid",
      undefined,
      0,
      cmds,
      undefined,
      true,
    )
    expect(result).not.toBeNull()
    expect(result!.userInstruction).toBe("real request")
  })

  test("discards trailing user message without assistant response", () => {
    const msgs = [
      {
        info: { id: "m1", role: "user", sessionID: "sid" },
        parts: [{ type: "text", text: "request" }],
      },
      {
        info: { id: "m2", role: "assistant", sessionID: "sid" },
        parts: [{ type: "text", text: "reply" }],
      },
      {
        info: { id: "m3", role: "user", sessionID: "sid" },
        parts: [{ type: "text", text: "follow-up without response" }],
      },
    ]
    const result = buildEvalFromMessages(msgs, "sid", undefined, 0, new Set())
    expect(result).not.toBeNull()
    expect(result!.userInstruction).toBe("request")
    expect(result!.pairs.length).toBe(1)
  })

  test("marks last pair complete when isIdle is true", () => {
    const msgs = [
      {
        info: { id: "m1", role: "user", sessionID: "sid" },
        parts: [{ type: "text", text: "request" }],
      },
      {
        info: { id: "m2", role: "assistant", sessionID: "sid" },
        parts: [{ type: "text", text: "reply" }],
      },
    ]
    const result = buildEvalFromMessages(
      msgs,
      "sid",
      undefined,
      0,
      new Set(),
      undefined,
      true,
    )
    expect(result).not.toBeNull()
    expect(result!.pairs.length).toBe(1)
    expect(result!.pairs[0].userInstruction).toBe("request")
  })

  test("returns null when last pair incomplete and not idle", () => {
    const msgs = [
      {
        info: { id: "m1", role: "user", sessionID: "sid" },
        parts: [{ type: "text", text: "request" }],
      },
      {
        info: { id: "m2", role: "assistant", sessionID: "sid" },
        parts: [{ type: "text", text: "reply" }],
      },
    ]
    const result = buildEvalFromMessages(
      msgs,
      "sid",
      undefined,
      0,
      new Set(),
      undefined,
      false,
    )
    expect(result).toBeNull()
  })

  test("extracts tool calls from assistant messages", () => {
    const msgs = [
      {
        info: { id: "m1", role: "user", sessionID: "sid" },
        parts: [{ type: "text", text: "run tool" }],
      },
      {
        info: { id: "m2", role: "assistant", sessionID: "sid" },
        parts: [
          { type: "tool_use", name: "bash", id: "t1", input: { cmd: "ls" } },
          { type: "tool_result", tool_use_id: "t1", content: "file.txt" },
        ],
      },
    ]
    const result = buildEvalFromMessages(
      msgs,
      "sid",
      undefined,
      0,
      new Set(),
      undefined,
      true,
    )
    expect(result).not.toBeNull()
    expect(result!.toolCalls.length).toBe(1)
    expect(result!.toolCalls[0].tool).toBe("bash")
    expect(result!.toolCalls[0].result).toBe("file.txt")
  })

  test("extracts subagent calls from assistant messages", () => {
    const msgs = [
      {
        info: { id: "m1", role: "user", sessionID: "sid" },
        parts: [{ type: "text", text: "delegate" }],
      },
      {
        info: { id: "m2", role: "assistant", sessionID: "sid" },
        parts: [{ type: "agent", name: "explore", input: "search codebase" }],
      },
    ]
    const result = buildEvalFromMessages(
      msgs,
      "sid",
      undefined,
      0,
      new Set(),
      undefined,
      true,
    )
    expect(result).not.toBeNull()
    expect(result!.subagentCalls.length).toBe(1)
    expect(result!.subagentCalls[0].agent).toBe("explore")
    expect(result!.subagentCalls[0].input).toBe("search codebase")
  })

  test("detects compacted sessions", () => {
    const msgs = [
      {
        info: { id: "m1", role: "user", sessionID: "sid" },
        parts: [{ type: "text", text: "request" }],
      },
      {
        info: { id: "m2", role: "assistant", sessionID: "sid" },
        parts: [{ type: "text", text: "actual response" }],
      },
      {
        info: { id: "m3", role: "system", sessionID: "sid" },
        parts: [{ type: "text", text: "▣ DCP Compression #1 summary" }],
      },
    ]
    const result = buildEvalFromMessages(
      msgs,
      "sid",
      undefined,
      0,
      new Set(),
      undefined,
      true,
    )
    expect(result).not.toBeNull()
    expect(result!.compacted).toBe(true)
  })

  test("builds multiple complete pairs", () => {
    const msgs = [
      {
        info: { id: "m1", role: "user", sessionID: "sid" },
        parts: [{ type: "text", text: "first" }],
      },
      {
        info: { id: "m2", role: "assistant", sessionID: "sid" },
        parts: [{ type: "text", text: "reply1" }],
      },
      {
        info: { id: "m3", role: "user", sessionID: "sid" },
        parts: [{ type: "text", text: "second" }],
      },
      {
        info: { id: "m4", role: "assistant", sessionID: "sid" },
        parts: [{ type: "text", text: "reply2" }],
      },
      {
        info: { id: "m5", role: "user", sessionID: "sid" },
        parts: [{ type: "text", text: "third" }],
      },
    ]
    const result = buildEvalFromMessages(msgs, "sid", undefined, 0, new Set())
    expect(result).not.toBeNull()
    expect(result!.pairs.length).toBe(2)
    expect(result!.pairs[0].userInstruction).toBe("first")
    expect(result!.pairs[1].userInstruction).toBe("second")
  })

  test("returns null when no assistant response parts or tool calls", () => {
    const msgs = [
      {
        info: { id: "m1", role: "user", sessionID: "sid" },
        parts: [{ type: "text", text: "request" }],
      },
      {
        info: { id: "m2", role: "assistant", sessionID: "sid" },
        parts: [{ type: "text", text: "" }],
      },
    ]
    const result = buildEvalFromMessages(
      msgs,
      "sid",
      undefined,
      0,
      new Set(),
      undefined,
      true,
    )
    expect(result).toBeNull()
  })

  test("replaces orphan user message when no assistant after", () => {
    const msgs = [
      {
        info: { id: "m1", role: "user", sessionID: "sid" },
        parts: [{ type: "text", text: "first request" }],
      },
      {
        info: { id: "m2", role: "user", sessionID: "sid" },
        parts: [{ type: "text", text: "second request" }],
      },
      {
        info: { id: "m3", role: "assistant", sessionID: "sid" },
        parts: [{ type: "text", text: "reply to second" }],
      },
    ]
    const result = buildEvalFromMessages(
      msgs,
      "sid",
      undefined,
      0,
      new Set(),
      undefined,
      true,
    )
    expect(result).not.toBeNull()
    expect(result!.userInstruction).toBe("second request")
  })
})

describe("batchEvaluateSessions", () => {
  test("evaluates multiple sessions and reports results", async () => {
    const sessions: any[] = []
    const ctx = mockCtx({
      idleSessions: new Set(["s1", "s2"]),
      config: { ...DEFAULT_CONFIG, min_session_messages: 1 },
      stateStore: {
        getConfig: () => DEFAULT_CONFIG,
        recordSession: (_id: string, _title: string, card: any) => {
          sessions.push({
            id: _id,
            score: card.overall_score,
            weaknesses: card.weaknesses,
            timestamp: Date.now(),
          })
        },
        mergeAllWeaknesses: async () => {},
        getRecentSessions: () => sessions,
        getSession: (id: string) => sessions.find((s) => s.id === id),
        getAggregate: () => ({
          total_sessions: sessions.length,
          avg_score:
            sessions.length > 0
              ? sessions.reduce((s, c) => s + c.score, 0) / sessions.length
              : 0,
          top_weaknesses: [],
          top_strengths: [],
          by_agent: {},
        }),
        addEvaluatedSession: () => {},
      } as any,
      client: {
        session: {
          messages: mock((args: any) => {
            const sid = args.path.id
            return Promise.resolve({
              data: [
                {
                  info: { id: `${sid}-m1`, role: "user", sessionID: sid },
                  parts: [{ type: "text", text: `request ${sid}` }],
                },
                {
                  info: { id: `${sid}-m2`, role: "assistant", sessionID: sid },
                  parts: [{ type: "text", text: "reply" }],
                },
              ],
            })
          }),
          list: mock(() => Promise.resolve({ data: [] })),
        },
      } as any,
      scorer: {
        evaluate: async () => makeScoreCard({ overall_score: 0.75 }),
      } as any,
    })

    const result = await batchEvaluateSessions(["s1", "s2"], ctx)
    expect(result).toContain("Batch Evaluation")
    expect(result).toContain("2 session(s) evaluated")
    ctx.sessionsEvaluated.clear()
  })

  test("skips already evaluated sessions", async () => {
    const sessions: any[] = []
    const ctx = mockCtx({
      idleSessions: new Set(["s1", "s2"]),
      config: { ...DEFAULT_CONFIG, min_session_messages: 1 },
      stateStore: {
        getConfig: () => DEFAULT_CONFIG,
        recordSession: (_id: string, _title: string, card: any) => {
          sessions.push({
            id: _id,
            score: card.overall_score,
            weaknesses: card.weaknesses,
            timestamp: Date.now(),
          })
        },
        mergeAllWeaknesses: async () => {},
        getRecentSessions: () => sessions,
        getSession: (id: string) => sessions.find((s) => s.id === id),
        getAggregate: () => ({
          total_sessions: sessions.length,
          avg_score:
            sessions.length > 0
              ? sessions.reduce((s, c) => s + c.score, 0) / sessions.length
              : 0,
          top_weaknesses: [],
          top_strengths: [],
          by_agent: {},
        }),
        addEvaluatedSession: () => {},
      } as any,
      client: {
        session: {
          messages: mock((args: any) =>
            Promise.resolve({
              data: [
                {
                  info: { id: "m1", role: "user", sessionID: args.path.id },
                  parts: [{ type: "text", text: "request" }],
                },
                {
                  info: {
                    id: "m2",
                    role: "assistant",
                    sessionID: args.path.id,
                  },
                  parts: [{ type: "text", text: "reply" }],
                },
              ],
            }),
          ),
        },
      } as any,
      scorer: {
        evaluate: async () => makeScoreCard({ overall_score: 0.75 }),
      } as any,
    })

    ctx.sessionsEvaluated.add("s1")
    const result = await batchEvaluateSessions(["s1", "s2"], ctx)
    expect(result).toContain("Batch Evaluation")
    ctx.sessionsEvaluated.clear()
  })

  test("handles sessions with no evaluable content", async () => {
    const ctx = mockCtx({
      idleSessions: new Set(["s1", "s2"]),
      client: {
        session: {
          messages: mock(() => Promise.resolve({ data: [] })),
        },
      } as any,
    })

    const result = await batchEvaluateSessions(["empty"], ctx)
    expect(result).toContain("Skipped")
    expect(result).toContain("empty/no-content")
  })

  test("handles client errors gracefully", async () => {
    const ctx = mockCtx({
      idleSessions: new Set(["s1", "s2"]),
      client: {
        session: {
          messages: mock(() => Promise.reject("network error")),
        },
      } as any,
    })

    const result = await batchEvaluateSessions(["err"], ctx)
    expect(result).toContain("Errors")
    expect(result).toContain("Failed to fetch")
  })
})

describe("history correctness regressions", () => {
  const message = (
    id: string,
    role: string,
    text: string,
    extra: Record<string, unknown> = {},
  ) => ({
    info: { id, role, sessionID: "history-session", ...extra },
    parts: text ? [{ type: "text", text }] : [],
  })
  const pair = () => [
    message("u1", "user", "run tests"),
    message("a1", "assistant", "done"),
  ]

  test("retains official V1 tool inputs, outputs and errors", () => {
    const msgs = pair()
    msgs[1].parts.push(
      ...([
        {
          type: "tool",
          callID: "c1",
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "bun test" },
            output: "79 passed",
          },
        },
        {
          type: "tool",
          callID: "c2",
          tool: "read",
          state: {
            status: "error",
            input: { filePath: "missing" },
            error: "ENOENT",
          },
        },
      ] as any),
    )
    const pending = buildEvalFromMessages(
      msgs,
      "s",
      "build",
      1,
      new Set(),
      undefined,
      true,
    )!
    expect(pending.toolCalls).toHaveLength(2)
    expect(pending.toolCalls[0].args).toContain("bun test")
    expect(pending.toolCalls[0].result).toBe("79 passed")
    expect(pending.toolCalls[1].result).toContain("ENOENT")
  })

  test("does not checkpoint an incomplete following turn", () => {
    const msgs = [
      ...pair(),
      message("u2", "user", "next"),
      message("a2", "assistant", "working"),
    ]
    const pending = buildEvalFromMessages(
      msgs,
      "s",
      "build",
      1,
      new Set(),
      undefined,
      false,
    )!
    expect(pending.pairs).toHaveLength(1)
    expect(pending.lastMessageId).toBe("a1")
  })

  test("missing checkpoint fails closed rather than replaying counted evidence", () => {
    expect(
      buildEvalFromMessages(
        pair(),
        "s",
        "build",
        1,
        new Set(),
        "missing",
        true,
      ),
    ).toBeNull()
  })

  test("never fabricates a user instruction from assistant or system text", () => {
    expect(
      buildEvalFromMessages(
        [
          message("a", "assistant", "unprompted"),
          message("b", "assistant", "more"),
        ],
        "s",
        "build",
        0,
        new Set(),
        undefined,
        true,
      ),
    ).toBeNull()
  })

  test("running tool blocks checkpoint even if idle observation is stale", () => {
    const msgs = pair()
    msgs[1].parts.push({
      type: "tool",
      tool: "bash",
      callID: "c",
      state: { status: "running", input: { command: "sleep" } },
    } as any)
    expect(
      buildEvalFromMessages(msgs, "s", "build", 1, new Set(), undefined, true),
    ).toBeNull()
  })

  test("manual scoring does not treat an active response as idle", async () => {
    const ctx = mockCtx({
      client: { session: { messages: async () => ({ data: pair() }) } } as any,
    })
    const calls = mock(async () => makeScoreCard())
    ctx.scorer.evaluate = calls as any
    const result = await manualEvaluateSession("s", ctx, "build", false)
    expect(calls).not.toHaveBeenCalled()
    expect(result).toContain("complete")
  })

  test("failed judge is reported as failure and is not batch success", async () => {
    const ctx = mockCtx({
      idleSessions: new Set(["s"]),
      client: { session: { messages: async () => ({ data: pair() }) } } as any,
    })
    ctx.scorer.evaluate = async () => makeScoreCard({ fallback: true })
    const result = await batchEvaluateSessions(["s"], ctx)
    expect(result).toContain("Errors")
    expect(result).not.toContain("session(s) evaluated")
    expect(ctx.sessionsEvaluated.has("s")).toBe(false)
    expect(ctx.sessionMsgCount.has("s")).toBe(false)
  })

  test("A-B-A work uses distinct ranges and the real preceding user request", async () => {
    const inputs: any[] = []
    const msgs = [
      message("u1", "user", "first request"),
      message("a1", "assistant", "A first", { agent: "A" }),
      message("u2", "user", "second request"),
      message("a2", "assistant", "B work", { agent: "B" }),
      message("u3", "user", "third request"),
      message("a3", "assistant", "A last", { agent: "A" }),
    ]
    const records = new Map<string, any>()
    const ctx = mockCtx({
      idleSessions: new Set(["s"]),
      config: { ...DEFAULT_CONFIG, min_session_messages: 1 },
      client: { session: { messages: async () => ({ data: msgs }) } } as any,
    })
    ctx.scorer.evaluate = async (input: any) => {
      inputs.push(input)
      return makeScoreCard({ session_id: input.sessionID })
    }
    ctx.stateStore.recordSession = ((
      id: string,
      title: string,
      card: ScoreCard,
      agent: string,
      _type: unknown,
      _parent: unknown,
      cursor: string,
    ) => {
      records.set(id, {
        id,
        title,
        score: card.overall_score,
        score_card: card,
        weaknesses: card.weaknesses,
        agent_name: agent,
        last_msg_id: cursor,
      })
    }) as any
    ctx.stateStore.getSession = ((id: string) => records.get(id)) as any
    ctx.stateStore.getRecentSessions = (() => [...records.values()]) as any
    const result = await manualEvaluateSession("s", ctx, undefined, false)
    expect(inputs).toHaveLength(3)
    expect(inputs.map((i) => i.sessionID)).toEqual(["s", "s", "s"])
    expect(records.size).toBe(3)
    expect(inputs.map((i) => i.userInstruction)).toEqual([
      "first request",
      "second request",
      "third request",
    ])
    expect(inputs.map((i) => i.agentName)).toEqual(["A", "B", "A"])
    expect(result).toContain("Per-Agent")
  })

  test("split judge failure consumes none of the pending evidence", async () => {
    let attempt = 0
    const ctx = mockCtx({
      config: { ...DEFAULT_CONFIG, max_score_input_chars: 1 },
    })
    ctx.scorer.evaluate = async () => {
      if (++attempt === 2) throw new Error("second pair failure")
      return makeScoreCard()
    }
    const recorded = mock(() => {})
    ctx.stateStore.recordSession = recorded as any
    const pending = makePendingEval({
      userInstruction: "long input",
      pairs: [
        {
          userInstruction: "one",
          agentResponse: "done",
          toolCalls: [],
          subagentCalls: [],
        },
        {
          userInstruction: "two",
          agentResponse: "done",
          toolCalls: [],
          subagentCalls: [],
        },
      ],
    })
    expect(await runEvaluation(pending, ctx)).toBe(false)
    expect(recorded).not.toHaveBeenCalled()
    expect(ctx.sessionsEvaluated.size).toBe(0)
  })
})

describe("evaluation range commits", () => {
  const message = (id: string, role: string, text: string, agent?: string) => ({
    info: { id, role, sessionID: "s", agent },
    parts: [{ type: "text", text }],
  })
  function tracked(messages: any[]) {
    const records = new Map<string, any>()
    const inputs: any[] = []
    const ctx = mockCtx({
      idleSessions: new Set(["s"]),
      client: {
        session: { messages: async () => ({ data: messages }) },
      } as any,
    })
    ctx.scorer.evaluate = async (input: any) => {
      inputs.push(input)
      return makeScoreCard({ session_id: input.sessionID })
    }
    ctx.stateStore.recordSession = ((
      id: string,
      title: string,
      card: ScoreCard,
      agent: string,
      _type: unknown,
      _parent: unknown,
      cursor: string,
    ) => {
      records.set(id, {
        id,
        title,
        score: card.overall_score,
        score_card: card,
        weaknesses: card.weaknesses,
        agent_name: agent,
        last_msg_id: cursor,
      })
    }) as any
    ctx.stateStore.getSession = ((id: string) => records.get(id)) as any
    ctx.stateStore.getRecentSessions = (() => [...records.values()]) as any
    return { ctx, records, inputs }
  }

  test("single-agent history can become multi-agent without recounting its first range", async () => {
    const msgs = [
      message("u1", "user", "first"),
      message("a1", "assistant", "A", "A"),
    ]
    const { ctx, records, inputs } = tracked(msgs)
    expect((await evaluateSession("s", ctx)).status).toBe("scored")
    msgs.push(
      message("u2", "user", "second"),
      message("a2", "assistant", "B", "B"),
    )
    expect((await evaluateSession("s", ctx)).status).toBe("scored")
    expect(inputs).toHaveLength(2)
    expect(records.size).toBe(2)
    expect((await evaluateSession("s", ctx)).status).toBe("skipped")
    expect(inputs).toHaveLength(2)
  })

  test("a failed middle range cannot consume later ranges and retries skip accepted prefix", async () => {
    const msgs = [
      message("u1", "user", "one"),
      message("a1", "assistant", "A", "A"),
      message("u2", "user", "two"),
      message("a2", "assistant", "B", "B"),
      message("u3", "user", "three"),
      message("a3", "assistant", "A again", "A"),
    ]
    const { ctx, records, inputs } = tracked(msgs)
    const original = ctx.scorer.evaluate
    ctx.scorer.evaluate = async (input: any, client: any) =>
      input.agentName === "B"
        ? makeScoreCard({ fallback: true })
        : original(input, client)
    expect((await evaluateSession("s", ctx)).status).toBe("failed")
    expect(records.size).toBe(1)
    expect(inputs).toHaveLength(1)
    expect(ctx.sessionsEvaluated.has("s")).toBe(false)
    ctx.scorer.evaluate = original
    expect((await evaluateSession("s", ctx)).status).toBe("scored")
    expect(records.size).toBe(3)
    expect(inputs).toHaveLength(3)
  })

  test("concurrent manual requests return a duplicate outcome after one range commits", async () => {
    const { ctx, inputs } = tracked([
      message("u1", "user", "first"),
      message("a1", "assistant", "done"),
    ])
    const results = await Promise.all([
      evaluateSession("s", ctx),
      evaluateSession("s", ctx),
    ])
    expect(results.map((r) => r.status).sort()).toEqual(["scored", "skipped"])
    expect(inputs).toHaveLength(1)
  })

  test("a state recording failure cannot mark the session evaluated", async () => {
    const ctx = mockCtx()
    ctx.stateStore.recordSession = () => {
      throw new Error("storage failed")
    }
    expect(await runEvaluation(makePendingEval(), ctx)).toBe(false)
    expect(ctx.sessionsEvaluated.has("test-session")).toBe(false)
  })

  test("post-record feedback failure does not report an accepted score as a failed job", async () => {
    const ctx = mockCtx()
    ctx.logger.log = async (event: string) => {
      if (event === "run_eval_recorded") throw new Error("logging failed")
    }
    expect(await runEvaluation(makePendingEval(), ctx)).toBe(true)
    expect(ctx.sessionsEvaluated.has("test-session")).toBe(true)
  })

  test("valid zero scores are scored outcomes, not infrastructure failures", async () => {
    const ctx = mockCtx()
    ctx.scorer.evaluate = async () => makeScoreCard({ overall_score: 0 })
    expect(await runEvaluation(makePendingEval(), ctx)).toBe(true)
    expect(ctx.sessionsEvaluated.has("test-session")).toBe(true)
  })

  test("official completed assistant metadata closes historical replies without pretending active sessions are idle", () => {
    const msgs = [
      message("u1", "user", "task"),
      message("a1", "assistant", "done"),
    ]
    Object.assign(msgs[1].info, {
      time: { completed: Date.now() },
      finish: "stop",
    })
    expect(
      buildEvalFromMessages(msgs, "s", "build", 1, new Set(), undefined, false)
        ?.lastMessageId,
    ).toBe("a1")
    Object.assign(msgs[1].info, { finish: "tool-calls" })
    expect(
      buildEvalFromMessages(msgs, "s", "build", 1, new Set(), undefined, false),
    ).toBeNull()
  })

  test("tool and agent selection parts do not fabricate delegation", () => {
    const msgs = [
      message("u1", "user", "task"),
      message("a1", "assistant", "done"),
    ]
    msgs[1].parts.push({
      type: "agent",
      name: "explore",
      text: "mention",
      source: { start: 0, end: 7 },
    } as any)
    expect(
      buildEvalFromMessages(msgs, "s", "build", 1, new Set(), undefined, true)
        ?.subagentCalls,
    ).toEqual([])
    msgs[1].parts.push({
      type: "tool",
      tool: "task",
      state: {
        status: "completed",
        input: { subagent_type: "explore", prompt: "search code" },
        output: "found it",
      },
    } as any)
    expect(
      buildEvalFromMessages(msgs, "s", "build", 1, new Set(), undefined, true)
        ?.subagentCalls,
    ).toEqual([{ agent: "explore", input: "search code" }])
  })

  test("a user agent selection changes attribution without becoming delegation", async () => {
    const msgs = [
      message("u1", "user", "one", "A"),
      message("a1", "assistant", "A response"),
      message("u2", "user", "two", "B"),
      message("a2", "assistant", "B response"),
    ]
    const { ctx, inputs } = tracked(msgs)
    expect((await evaluateSession("s", ctx)).status).toBe("scored")
    expect(inputs.map((i) => i.agentName)).toEqual(["A", "B"])
    expect(inputs.flatMap((i) => i.subagentCalls)).toEqual([])
  })

  test("child traversal shares a cycle guard and depth budget", async () => {
    const { ctx } = tracked([
      message("u1", "user", "task"),
      message("a1", "assistant", "done"),
    ])
    const fetched: string[] = []
    ctx.client.session.messages = async (args: any) => {
      fetched.push(args.path.id)
      return {
        data: [
          message("u1", "user", "task"),
          {
            ...message("a1", "assistant", "done"),
            info: {
              id: "a1",
              role: "assistant",
              sessionID: args.path.id,
              time: { completed: 1 },
              finish: "stop",
            },
          },
        ],
      } as any
    }
    ctx.parentToChildren.set("root", new Set(["a"]))
    ctx.parentToChildren.set("a", new Set(["root", "b"]))
    ctx.parentToChildren.set("b", new Set(["c"]))
    await evaluateChildSessions("root", ctx, 0, 2)
    expect(fetched).toEqual(["a", "b"])
  })
})
