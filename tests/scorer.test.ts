import { describe, expect, mock, test } from "bun:test"
import type { ScorerInput } from "../src/scorer.js"
import { parseModelString, Scorer } from "../src/scorer.js"
import type { OpencodeSessionClient } from "../src/types.js"
import { DEFAULT_CONFIG } from "../src/types.js"

describe("parseModelString", () => {
  test("parses provider/model correctly", () => {
    expect(parseModelString("openai/gpt-4")).toEqual({
      providerID: "openai",
      modelID: "gpt-4",
    })
  })

  test("parses provider with complex model ID", () => {
    expect(parseModelString("anthropic/claude-sonnet-4-20250514")).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-20250514",
    })
  })

  test("returns null for string without slash", () => {
    expect(parseModelString("gpt-4")).toBeNull()
  })

  test("returns null for empty string", () => {
    expect(parseModelString("")).toBeNull()
  })

  test("handles multiple slashes", () => {
    expect(parseModelString("provider/multi/part/model")).toEqual({
      providerID: "provider",
      modelID: "multi/part/model",
    })
  })
})

describe("Scorer", () => {
  function makeInput(overrides: Partial<ScorerInput> = {}): ScorerInput {
    return {
      sessionID: "s1",
      userInstruction: "fix the bug",
      agentResponse: "done",
      toolCalls: [],
      agentsMdContent: "",
      ...overrides,
    }
  }

  function makeMockSession(
    createId: string,
    promptText: string | undefined,
    rejectWith?: string,
  ) {
    return {
      session: {
        create: mock(() => Promise.resolve({ data: { id: createId } })),
        prompt: mock(() => {
          if (rejectWith !== undefined) return Promise.reject(rejectWith)
          return Promise.resolve({
            data: {
              parts:
                promptText !== undefined
                  ? [{ type: "text", text: promptText }]
                  : undefined,
            },
          })
        }),
        delete: mock(() => Promise.resolve()),
      },
    }
  }

  describe("buildEvalPrompt", () => {
    test("includes user instruction and agent response", () => {
      const scorer = new Scorer(DEFAULT_CONFIG)
      const prompt = scorer.buildEvalPrompt(
        makeInput({
          userInstruction: "fix the bug in login",
          agentResponse: "I fixed the login bug",
        }),
      )

      expect(prompt).toContain("fix the bug in login")
      expect(prompt).toContain("I fixed the login bug")
    })

    test("includes tool calls with truncated results", () => {
      const scorer = new Scorer(DEFAULT_CONFIG)
      const prompt = scorer.buildEvalPrompt(
        makeInput({
          toolCalls: [
            { tool: "bash", args: '{"cmd":"ls"}', result: "file.txt" },
          ],
        }),
      )

      expect(prompt).toContain("bash")
      expect(prompt).toContain("file.txt")
      expect(prompt).toContain("ls")
    })

    test("truncates tool result to 500 chars", () => {
      const scorer = new Scorer(DEFAULT_CONFIG)
      const longResult = "x".repeat(1000)
      const prompt = scorer.buildEvalPrompt(
        makeInput({
          toolCalls: [{ tool: "bash", args: "{}", result: longResult }],
        }),
      )

      const resultLine = prompt.split("\n").find((l) => l.includes("<result>"))
      if (!resultLine) throw new Error("Expected <result> in prompt")
      const start = resultLine.indexOf("<result>") + 8
      const end = resultLine.indexOf("</result>")
      const content = resultLine.slice(start, end)
      expect(content.length).toBeLessThanOrEqual(500)
    })

    test("includes agents.md content", () => {
      const scorer = new Scorer(DEFAULT_CONFIG)
      const prompt = scorer.buildEvalPrompt(
        makeInput({
          agentsMdContent: "# AGENTS Rules\nBe helpful.",
        }),
      )

      expect(prompt).toContain("Be helpful.")
    })

    test("includes agent name when provided", () => {
      const scorer = new Scorer(DEFAULT_CONFIG)
      const prompt = scorer.buildEvalPrompt(
        makeInput({
          agentName: "build",
        }),
      )

      expect(prompt).toContain("<agent>")
      expect(prompt).toContain("build")
    })

    test("does not include agent section when name missing", () => {
      const scorer = new Scorer(DEFAULT_CONFIG)
      const prompt = scorer.buildEvalPrompt(makeInput({ agentName: undefined }))
      expect(prompt).not.toContain("<agent>")
    })

    test("includes agent prompt when provided", () => {
      const scorer = new Scorer(DEFAULT_CONFIG)
      const prompt = scorer.buildEvalPrompt(
        makeInput({
          agentPrompt: "You are a build agent.",
        }),
      )

      expect(prompt).toContain("<current_agent_prompt>")
      expect(prompt).toContain("You are a build agent.")
    })

    test("does not include agent prompt section when missing", () => {
      const scorer = new Scorer(DEFAULT_CONFIG)
      const prompt = scorer.buildEvalPrompt(
        makeInput({ agentPrompt: undefined }),
      )
      expect(prompt).not.toContain("<current_agent_prompt>")
    })

    test("handles empty agents.md content gracefully", () => {
      const scorer = new Scorer(DEFAULT_CONFIG)
      const prompt = scorer.buildEvalPrompt(makeInput({ agentsMdContent: "" }))
      expect(prompt).toContain("(none)")
    })

    test("includes evaluation scoring prompt", () => {
      const scorer = new Scorer(DEFAULT_CONFIG)
      const prompt = scorer.buildEvalPrompt(makeInput())
      expect(prompt).toContain("instruction_following")
      expect(prompt).toContain("completeness")
      expect(prompt).toContain("proactiveness")
      expect(prompt).toContain("code_quality")
      expect(prompt).toContain("communication")
    })

    test("includes user guidance when provided", () => {
      const scorer = new Scorer(DEFAULT_CONFIG)
      const prompt = scorer.buildEvalPrompt(
        makeInput({
          userGuidance: "focus on code reuse",
        }),
      )
      expect(prompt).toContain("<user_guidance>")
      expect(prompt).toContain("focus on code reuse")
      expect(prompt).toContain("focus on in your evaluation")
    })

    test("does not include user guidance section when absent", () => {
      const scorer = new Scorer(DEFAULT_CONFIG)
      const prompt = scorer.buildEvalPrompt(
        makeInput({ userGuidance: undefined }),
      )
      expect(prompt).not.toContain("<user_guidance>")
    })
  })

  describe("reloadModel", () => {
    test("updates model info from new config", () => {
      const scorer = new Scorer({ ...DEFAULT_CONFIG, model: "openai/gpt-4" })
      expect(scorer.modelInfo).toEqual({
        providerID: "openai",
        modelID: "gpt-4",
      })

      scorer.reloadModel({
        ...DEFAULT_CONFIG,
        model: "anthropic/claude-sonnet",
      })
      expect(scorer.modelInfo).toEqual({
        providerID: "anthropic",
        modelID: "claude-sonnet",
      })
    })
  })

  describe("evaluate", () => {
    test("returns score card from structured output", async () => {
      const mockClient = makeMockSession(
        "scoring-session-123",
        JSON.stringify({
          overall_score: 0.85,
          categories: {
            instruction_following: 0.9,
            completeness: 0.8,
            proactiveness: 0.7,
            code_quality: 0.9,
            communication: 0.8,
          },
          strengths: ["great code"],
          weaknesses: ["slow response"],
          suggested_agents_md_update: "Add speed rule",
          suggested_agent_prompt_update: "Always respond in under 30s",
        }),
      )

      const scorer = new Scorer(DEFAULT_CONFIG)
      const card = await scorer.evaluate(
        makeInput(),
        mockClient as unknown as OpencodeSessionClient,
      )

      expect(card.overall_score).toBe(0.85)
      expect(card.categories.instruction_following).toBe(0.9)
      expect(card.strengths).toEqual(["great code"])
      expect(card.weaknesses).toEqual(["slow response"])
      expect(card.suggested_agents_md_update).toBe("Add speed rule")
      expect(card.suggested_agent_prompt_update).toBe(
        "Always respond in under 30s",
      )
      expect(mockClient.session.delete).toHaveBeenCalled()
    })

    test("falls back to defaults for missing structured output fields", async () => {
      const mockClient = makeMockSession("scoring-session-2", "{}")

      const scorer = new Scorer(DEFAULT_CONFIG)
      const card = await scorer.evaluate(
        makeInput(),
        mockClient as unknown as OpencodeSessionClient,
      )

      expect(card.overall_score).toBe(0.5)
      expect(card.categories.instruction_following).toBe(0.5)
      expect(card.strengths).toEqual([])
      expect(card.weaknesses).toEqual([])
    })

    test("returns fallback score card on client error", async () => {
      const mockClient = makeMockSession("s", undefined, "network error")

      const scorer = new Scorer(DEFAULT_CONFIG)
      const card = await scorer.evaluate(
        makeInput(),
        mockClient as unknown as OpencodeSessionClient,
      )

      expect(card.overall_score).toBe(0.5)
      expect(card.weaknesses[0]).toContain("Scoring failed")
      expect(card.weaknesses[0]).toContain("network error")
    })

    test("retries on failure up to scoring_retries", async () => {
      let callCount = 0
      const mockClient = {
        session: {
          create: mock(() =>
            Promise.resolve({ data: { id: `s-${++callCount}` } }),
          ),
          prompt: mock(() => {
            if (callCount <= 2) return Promise.reject("error")
            return Promise.resolve({
              data: {
                parts: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      overall_score: 0.9,
                      categories: {
                        instruction_following: 1,
                        completeness: 0.9,
                        proactiveness: 0.8,
                        code_quality: 0.9,
                        communication: 0.9,
                      },
                      strengths: ["ok"],
                      weaknesses: [],
                    }),
                  },
                ],
              },
            })
          }),
          delete: mock(() => Promise.resolve()),
        },
      }

      const scorer = new Scorer(DEFAULT_CONFIG)
      const card = await scorer.evaluate(
        makeInput(),
        mockClient as unknown as OpencodeSessionClient,
      )

      expect(card.overall_score).toBe(0.9)
      expect(mockClient.session.prompt).toHaveBeenCalledTimes(3)
      expect(mockClient.session.delete).toHaveBeenCalledTimes(3)
    })

    test("falls back when prompt response data is empty", async () => {
      const mockClient = makeMockSession("null-output", "")

      const scorer = new Scorer(DEFAULT_CONFIG)
      const card = await scorer.evaluate(
        makeInput(),
        mockClient as unknown as OpencodeSessionClient,
      )

      expect(card.overall_score).toBe(0.5)
      expect(card.fallback).toBe(true)
    })

    test("falls back when data is null", async () => {
      const mockClient = {
        session: {
          create: mock(() => Promise.resolve({ data: { id: "null-data" } })),
          prompt: mock(() => Promise.resolve(null)),
          delete: mock(() => Promise.resolve()),
        },
      }

      const scorer = new Scorer(DEFAULT_CONFIG)
      const card = await scorer.evaluate(
        makeInput(),
        mockClient as unknown as OpencodeSessionClient,
      )

      expect(card.overall_score).toBe(0.5)
      expect(card.fallback).toBe(true)
    })

    test("falls back when prompt response is not JSON", async () => {
      const mockClient = makeMockSession("not-obj", "just a string")

      const scorer = new Scorer(DEFAULT_CONFIG)
      const card = await scorer.evaluate(
        makeInput(),
        mockClient as unknown as OpencodeSessionClient,
      )

      expect(card.overall_score).toBe(0.5)
      expect(card.fallback).toBe(true)
    })

    test("falls back with defaults when categories is missing", async () => {
      const mockClient = makeMockSession(
        "no-cats",
        JSON.stringify({
          overall_score: 0.75,
          strengths: ["good"],
          weaknesses: ["bad"],
        }),
      )

      const scorer = new Scorer(DEFAULT_CONFIG)
      const card = await scorer.evaluate(
        makeInput(),
        mockClient as unknown as OpencodeSessionClient,
      )

      expect(card.overall_score).toBe(0.75)
      expect(card.categories.instruction_following).toBe(0.5)
      expect(card.categories.completeness).toBe(0.5)
      expect(card.strengths).toEqual(["good"])
      expect(card.weaknesses).toEqual(["bad"])
    })

    test("cleans up scoring session on success", async () => {
      const mockClient = makeMockSession(
        "cleanup-test",
        JSON.stringify({
          overall_score: 0.7,
          categories: {
            instruction_following: 0.7,
            completeness: 0.7,
            proactiveness: 0.7,
            code_quality: 0.7,
            communication: 0.7,
          },
          strengths: [],
          weaknesses: [],
        }),
      )

      const scorer = new Scorer(DEFAULT_CONFIG)

      await scorer.evaluate(
        makeInput(),
        mockClient as unknown as OpencodeSessionClient,
      )

      expect(mockClient.session.delete).toHaveBeenCalled()
    })

    test("cleans up scoring session when prompt throws after create succeeds", async () => {
      const mockClient = makeMockSession(
        "leak-check",
        undefined,
        "model unavailable",
      )

      const scorer = new Scorer(DEFAULT_CONFIG)
      const card = await scorer.evaluate(
        makeInput(),
        mockClient as unknown as OpencodeSessionClient,
      )

      expect(card.fallback).toBe(true)
      expect(mockClient.session.delete).toHaveBeenCalled()
    })

    test("uses bracket fallback for StructuredOutput format", async () => {
      const mockClient = makeMockSession(
        "bracket-test",
        "# StructuredOutput [overall_score=0.75, instruction_following=0.7]",
      )

      const scorer = new Scorer(DEFAULT_CONFIG)
      const card = await scorer.evaluate(
        makeInput(),
        mockClient as unknown as OpencodeSessionClient,
      )

      expect(card.overall_score).toBe(0.75)
      expect(card.categories.instruction_following).toBe(0.75)
    })

    test("handles tool result via message polling", async () => {
      const mockClient = {
        session: {
          create: mock(() => Promise.resolve({ data: { id: "poll-test" } })),
          prompt: mock(() =>
            Promise.resolve({
              data: {
                parts: [
                  {
                    type: "tool",
                    tool: "StructuredOutput",
                    input: {},
                    callID: "c1",
                  },
                ],
              },
            }),
          ),
          messages: mock(() =>
            Promise.resolve({
              data: [
                {
                  parts: [
                    {
                      type: "tool_result",
                      content: {
                        text: JSON.stringify({
                          overall_score: 0.88,
                          categories: {
                            instruction_following: 0.9,
                            completeness: 0.8,
                            proactiveness: 0.8,
                            code_quality: 0.9,
                            communication: 0.9,
                          },
                          strengths: ["good"],
                          weaknesses: ["minor"],
                        }),
                      },
                    },
                  ],
                },
              ],
            }),
          ),
          delete: mock(() => Promise.resolve()),
        },
      }

      const scorer = new Scorer(DEFAULT_CONFIG)
      const card = await scorer.evaluate(
        makeInput(),
        mockClient as unknown as OpencodeSessionClient,
      )

      expect(card.overall_score).toBe(0.88)
      expect(card.strengths).toEqual(["good"])
    })

    test("handles empty prompt response with format retry", async () => {
      let callCount = 0
      const mockClient = {
        session: {
          create: mock(() =>
            Promise.resolve({ data: { id: `fmt-${++callCount}` } }),
          ),
          prompt: mock(() => {
            if (callCount === 1) {
              return Promise.resolve({ data: { parts: [] } })
            }
            return Promise.resolve({
              data: {
                parts: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      overall_score: 0.65,
                      categories: {
                        instruction_following: 0.6,
                        completeness: 0.7,
                        proactiveness: 0.6,
                        code_quality: 0.7,
                        communication: 0.6,
                      },
                      strengths: [],
                      weaknesses: [],
                    }),
                  },
                ],
              },
            })
          }),
          delete: mock(() => Promise.resolve()),
        },
      }

      const scorer = new Scorer(DEFAULT_CONFIG)
      const card = await scorer.evaluate(
        makeInput(),
        mockClient as unknown as OpencodeSessionClient,
      )

      expect(card.overall_score).toBe(0.65)
    })

    test("handles tool_choice error with format retry", async () => {
      let callCount = 0
      const mockClient = {
        session: {
          create: mock(() =>
            Promise.resolve({ data: { id: `tc-${++callCount}` } }),
          ),
          prompt: mock(() => {
            if (callCount === 1) {
              return Promise.reject(new Error("tool_choice not supported"))
            }
            return Promise.resolve({
              data: {
                parts: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      overall_score: 0.72,
                      categories: {
                        instruction_following: 0.7,
                        completeness: 0.7,
                        proactiveness: 0.8,
                        code_quality: 0.7,
                        communication: 0.7,
                      },
                      strengths: [],
                      weaknesses: [],
                    }),
                  },
                ],
              },
            })
          }),
          delete: mock(() => Promise.resolve()),
        },
      }

      const scorer = new Scorer(DEFAULT_CONFIG)
      const card = await scorer.evaluate(
        makeInput(),
        mockClient as unknown as OpencodeSessionClient,
      )

      expect(card.overall_score).toBe(0.72)
    })
  })

  describe("mergeWeaknesses", () => {
    test("returns input when 1 or fewer weaknesses", async () => {
      const scorer = new Scorer(DEFAULT_CONFIG)
      const mockClient = makeMockSession("", "")
      const result = await scorer.mergeWeaknesses(
        [{ pattern: "slow", count: 2, suggested_fix: "" }],
        mockClient as unknown as OpencodeSessionClient,
      )
      expect(result).toHaveLength(1)
      expect(result[0].pattern).toBe("slow")
    })

    test("returns input when session create fails", async () => {
      const scorer = new Scorer(DEFAULT_CONFIG)
      const mockClient = {
        session: {
          create: mock(() => Promise.resolve({ data: { id: undefined } })),
        },
      }
      const weaknesses = [
        { pattern: "slow", count: 2, suggested_fix: "" },
        { pattern: "fast", count: 1, suggested_fix: "" },
      ]
      const result = await scorer.mergeWeaknesses(
        weaknesses,
        mockClient as unknown as OpencodeSessionClient,
      )
      expect(result).toHaveLength(2)
    })

    test("merges weaknesses from model output", async () => {
      const scorer = new Scorer(DEFAULT_CONFIG)
      const mockClient = makeMockSession(
        "merge-sess",
        JSON.stringify({
          merged_weaknesses: [
            { pattern: "slow response", count: 5 },
            { pattern: "missed details", count: 2 },
          ],
        }),
      )
      const weaknesses = [
        { pattern: "slow", count: 2, suggested_fix: "" },
        { pattern: "slow response", count: 3, suggested_fix: "" },
        { pattern: "missed details", count: 2, suggested_fix: "" },
      ]
      const result = await scorer.mergeWeaknesses(
        weaknesses,
        mockClient as unknown as OpencodeSessionClient,
      )
      expect(result.length).toBe(2)
      expect(result[0].pattern).toBe("slow response")
      expect(result[0].count).toBe(5)
    })
  })
})
