import { createHash } from "node:crypto"
import { parse as parseJSONC } from "jsonc-parser"
import { MAX_WEAKNESSES_FOR_MERGE } from "./constants.js"
import type { KasperLogger } from "./logging.js"
import type {
  KasperConfig,
  OpencodeSessionClient,
  ScoreCard,
  SubagentCallRecord,
  ToolCallRecord,
  WeaknessPattern,
} from "./types.js"

export const KASPER_JUDGE_VERSION = "1.1.0"
export const KASPER_RUBRIC_VERSION = "1.0.0"

export interface ScorerInput {
  sessionID: string
  messageID?: string
  userInstruction: string
  agentResponse: string
  toolCalls: ToolCallRecord[]
  subagentCalls: SubagentCallRecord[]
  agentsMdContent: string
  agentName?: string
  agentPrompt?: string
  userGuidance?: string
  compacted?: boolean
  agentsMdChanged?: boolean
  existingWeaknesses?: string[]
}

export const SCORE_PROMPT = `You are evaluating an AI coding agent's adherence to user instructions.
Analyze the user's request and the agent's response, then score the agent on these dimensions:

1. **instruction_following**: Did the agent do exactly what was asked? (0.0 - 1.0)
2. **completeness**: Did the agent fully complete the task? (0.0 - 1.0)
3. **proactiveness**: Did the agent act appropriately without over-stepping or under-stepping? (0.0 - 1.0)
4. **code_quality**: Quality, correctness, and maintainability of any code produced (0.0 - 1.0)
5. **communication**: Clarity and helpfulness of explanations (0.0 - 1.0)

Also identify specific strengths and weaknesses in the agent's response.

CRITICAL — Respect the agent prompt: If a "Current Agent Prompt" section is present, it defines this specific agent's assigned role and scope. The agent should be evaluated against that role — do NOT penalize it for omitting tasks that fall outside its defined scope. For instance, if the prompt says the agent only compiles code, penalizing it for not running tests would be wrong.

IMPORTANT: For EVERY weakness you identify, provide a concrete, actionable suggestion in the "weakness_suggestions" array. Each entry must specify:
- "weakness": The weakness text (must match one in the weaknesses array)
- "suggested_fix": A concrete, specific instruction addressing this weakness
- "target": Either "agents_md" (project-wide standard for ALL agents) or "agent_prompt" (specific to this agent's role/prompt file)

The "suggested_agents_md_update" and "suggested_agent_prompt_update" fields are deprecated — set them to empty strings. Use "weakness_suggestions" instead.

Guidance for choosing target:
- Use "agents_md" for project-wide standards that ALL agent types should follow (e.g., "Always use const for immutable variables", "Write a brief summary of changes made")
- Use "agent_prompt" for instructions specific to this agent's role (e.g., "Before writing code, explain your approach first", "After compiling, verify no errors before proceeding")

If there are truly no improvements to suggest for a weakness, omit it from weakness_suggestions. Generic text like "add instructions addressing X" is NOT acceptable.`

const SCORE_PROMPT_HASH = createHash("sha256")
  .update(SCORE_PROMPT)
  .digest("hex")
  .slice(0, 16)

export const MERGE_WEAKNESSES_PROMPT = `## Weakness Pattern Merging

Below are currently tracked weakness patterns from evaluating agent sessions.
Each pattern has an observation count. Some patterns may describe the same root cause using different wording — these should be merged.

TASK: Identify groups of patterns that refer to the same root issue. For each group:
- Pick the clearest, most specific description
- Sum their observation counts
- Keep the result sorted by count (highest first)

Return FEWER patterns than the input. Only keep genuinely distinct issues.
When in doubt about whether two patterns should be merged, merge them.

CRITICAL: This is an automated pipeline step. Do NOT ask questions. Do NOT ask for clarification. Do NOT engage in conversation. Do NOT output any text other than the JSON result. If you produce anything other than the JSON object below, the pipeline will fail.

Return ONLY valid JSON in this exact format (no markdown, no extra text):
{"merged_weaknesses":[{"pattern":"Description","count":5}]}`

export function parseModelString(
  model: string,
  logger?: KasperLogger,
): { providerID: string; modelID: string } | null {
  const idx = model.indexOf("/")
  if (idx === -1) {
    logger?.log("model_parse_warning", {
      model,
      error: "unexpected format — expected provider/model",
    })
    return null
  }
  return {
    providerID: model.slice(0, idx),
    modelID: model.slice(idx + 1),
  }
}

interface ScorerStructuredOutput {
  overall_score?: number
  categories?: {
    instruction_following?: number
    completeness?: number
    proactiveness?: number
    code_quality?: number
    communication?: number
  }
  strengths?: string[]
  weaknesses?: (string | { description?: string; weakness?: string })[]
  suggested_agents_md_update?: string
  suggested_agent_prompt_update?: string
  weakness_suggestions?: Array<{
    weakness: string
    suggested_fix: string
    target: string
  }>
}

function safeTruncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  const truncated = text.slice(0, maxLen)

  const stack: string[] = []
  let inString = false
  let escaped = false
  for (const ch of truncated) {
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === "\\") {
      escaped = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === "{") stack.push("}")
    else if (ch === "[") stack.push("]")
    else if (ch === "}" || ch === "]") {
      if (stack.length > 0 && stack[stack.length - 1] === ch) stack.pop()
    }
  }

  return truncated + stack.reverse().join("")
}

export class Scorer {
  private modelInfo: { providerID: string; modelID: string } | null

  constructor(
    private config: KasperConfig,
    private logger?: KasperLogger,
  ) {
    this.modelInfo = parseModelString(config.model, this.logger)
  }

  reloadModel(config: KasperConfig): void {
    this.config = config
    this.modelInfo = parseModelString(config.model, this.logger)
  }

  async mergeWeaknesses(
    weaknesses: WeaknessPattern[],
    sessionClient: OpencodeSessionClient,
  ): Promise<WeaknessPattern[]> {
    if (weaknesses.length <= 1) return weaknesses
    const limited = weaknesses.slice(0, MAX_WEAKNESSES_FOR_MERGE)
    const weaknessList = limited
      .map((w, i) => `${i + 1}. "${w.pattern}" (count: ${w.count})`)
      .join("\n")

    const prompt = `${MERGE_WEAKNESSES_PROMPT}\n\nWEAKNESSES:\n${weaknessList}`
    let scoringSessionId: string | null = null
    const mergeStart = Date.now()
    this.logger?.log("merge_weaknesses_start", {
      weaknessCount: weaknesses.length,
      model: this.config.model,
    })

    try {
      const createStart = Date.now()
      const scoringSession = await sessionClient.session.create({
        body: { title: `kasper-merge-${Date.now()}` },
      })
      scoringSessionId = scoringSession.data?.id ?? null
      this.logger?.log("merge_session_created", {
        scoringSessionId,
        durationMs: Date.now() - createStart,
      })
      if (!scoringSessionId) {
        this.logger?.log("merge_session_create_failed", {
          model: this.config.model,
        })
        return weaknesses
      }

      const promptStart = Date.now()
      const result = await sessionClient.session.prompt({
        path: { id: scoringSessionId },
        body: {
          parts: [{ type: "text", text: prompt }],
          ...(this.modelInfo
            ? {
                model: {
                  providerID: this.modelInfo.providerID,
                  modelID: this.modelInfo.modelID,
                },
              }
            : {}),
        },
      })

      const responseText = this.extractResponseText(
        result.data?.parts,
        "mergePrompt",
      )
      this.logger?.log("merge_prompt_done", {
        scoringSessionId,
        durationMs: Date.now() - promptStart,
        responseLen: responseText.length,
        responsePreview: responseText.slice(0, 200),
      })

      const data = this.parseResponseJSON(responseText) as Record<
        string,
        unknown
      >
      const merged = data?.merged_weaknesses as
        | Array<{ pattern: string; count: number }>
        | undefined

      if (Array.isArray(merged) && merged.length > 0) {
        const suggestedFixes = new Map(
          weaknesses.map((w) => [w.pattern, w.suggested_fix]),
        )
        this.logger?.log("merge_weaknesses_done", {
          before: weaknesses.length,
          after: merged.length,
          totalDurationMs: Date.now() - mergeStart,
        })
        return merged
          .map((w) => {
            const fix = suggestedFixes.get(w.pattern) ?? ""
            return {
              pattern: w.pattern,
              count: Math.max(1, Math.round(w.count)),
              suggested_fix: fix,
            }
          })
          .sort((a, b) => b.count - a.count)
      }
      this.logger?.log("merge_weaknesses_no_merge", {
        weaknessCount: weaknesses.length,
        responseLen: responseText.length,
      })
      return weaknesses
    } catch (err) {
      this.logger?.log("merge_weaknesses_error", {
        error: String(err),
        scoringSessionId,
        durationMs: Date.now() - mergeStart,
      })
      return weaknesses
    } finally {
      if (scoringSessionId) {
        const delStart = Date.now()
        try {
          await sessionClient.session.delete({
            path: { id: scoringSessionId },
          })
          this.logger?.log("merge_session_deleted", {
            scoringSessionId,
            durationMs: Date.now() - delStart,
          })
        } catch (e) {
          this.logger?.log("merge_cleanup_failed", {
            scoringSessionId,
            error: String(e),
          })
        }
      }
    }
  }

  async evaluate(
    input: ScorerInput,
    sessionClient: OpencodeSessionClient,
  ): Promise<ScoreCard> {
    const maxRetries = this.config.scoring_retries
    const attempts: Array<{
      attempt: number
      score: number
      fallback: boolean
      error?: string
    }> = []

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        this.logger?.log("scoring_attempt", {
          sessionID: input.sessionID,
          attempt,
          maxRetries,
          model: this.config.model,
        })
        const card = await this.tryEvaluate(input, sessionClient)
        attempts.push({
          attempt,
          score: card.overall_score,
          fallback: !!card.fallback,
        })
        if (!card.fallback) {
          this.logger?.log("scoring_attempt_success", {
            sessionID: input.sessionID,
            attempt,
            score: card.overall_score,
          })
          return card
        }
        if (attempt === maxRetries) {
          this.logger?.log("scoring_all_attempts_fallback", {
            sessionID: input.sessionID,
            totalAttempts: attempt + 1,
          })
          return card
        }
        this.logger?.log("scoring_attempt_fallback_retry", {
          sessionID: input.sessionID,
          attempt,
          score: card.overall_score,
        })
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        attempts.push({ attempt, score: 0.5, fallback: true, error: errMsg })
        this.logger?.log("scoring_attempt_error", {
          sessionID: input.sessionID,
          attempt: attempt + 1,
          maxRetries,
          error: errMsg,
          model: this.config.model,
        })
        if (attempt === maxRetries) {
          return this.fallbackCard(
            input,
            `Scoring failed after ${maxRetries + 1} attempt(s): ${errMsg}`,
          )
        }
      }
    }

    return this.fallbackCard(input, "Scoring failed: unknown error")
  }

  private fallbackCard(input: ScorerInput, reason: string): ScoreCard {
    return {
      session_id: input.sessionID,
      message_id: input.messageID,
      timestamp: Date.now(),
      overall_score: 0.5,
      categories: {
        instruction_following: 0.5,
        completeness: 0.5,
        proactiveness: 0.5,
        code_quality: 0.5,
        communication: 0.5,
      },
      strengths: [],
      weaknesses: [reason],
      fallback: true,
    }
  }

  private async tryEvaluate(
    input: ScorerInput,
    sessionClient: OpencodeSessionClient,
  ): Promise<ScoreCard> {
    const tStart = Date.now()
    const evaluationPrompt = this.buildEvalPrompt(input)
    let scoringSessionId: string | null = null

    this.logger?.log("try_evaluate_start", {
      sessionID: input.sessionID,
      model: this.config.model,
      providerID: this.modelInfo?.providerID,
      modelID: this.modelInfo?.modelID,
      promptLen: evaluationPrompt.length,
      timeout: this.config.scoring_timeout_ms,
      retries: this.config.scoring_retries,
    })

    try {
      const createTimeoutMs = Math.min(this.config.scoring_timeout_ms, 30_000)
      const createStart = Date.now()
      let createTimer: ReturnType<typeof setTimeout> | undefined
      const scoringSession = await Promise.race([
        sessionClient.session.create({
          body: { title: `kasper-scoring-${input.sessionID.slice(0, 8)}` },
        }),
        new Promise<never>((_, reject) => {
          createTimer = setTimeout(
            () =>
              reject(
                new Error(
                  "Scoring session creation timed out — model may be unavailable",
                ),
              ),
            createTimeoutMs,
          )
        }),
      ]).finally(() => {
        if (createTimer !== undefined) clearTimeout(createTimer)
      })
      scoringSessionId = scoringSession.data?.id ?? null
      this.logger?.log("scoring_session_created", {
        sessionID: input.sessionID,
        scoringSessionId,
        durationMs: Date.now() - createStart,
        model: this.config.model,
      })
      if (!scoringSessionId) {
        throw new Error("Failed to create scoring session")
      }

      const promptBody: {
        parts: { type: string; text: string }[]
        model?: { providerID: string; modelID: string }
        format?: { type: string; schema: Record<string, unknown> }
      } = {
        parts: [{ type: "text", text: evaluationPrompt }],
      }
      if (this.modelInfo) {
        promptBody.model = {
          providerID: this.modelInfo.providerID,
          modelID: this.modelInfo.modelID,
        }
      }
      // NOTE: We do NOT set promptBody.format here because it causes models that don't
      // support native JSON output (e.g. minimax-m2.5) to use the StructuredOutput tool,
      // which never gets executed in the SDK scoring session. The prompt itself already
      // instructs the model to return raw JSON, which parseResponseJSON can extract.
      // promptBody.format removed — see note above

      // Diagnostic: use a SEPARATE session so it doesn't pollute the scoring session
      // Only run in debug mode to avoid doubling ephemeral session creation overhead.
      if (this.config.debug) {
        let diagSessionId: string | null = null
        try {
          const diagStart = Date.now()
          const diagSession = await sessionClient.session.create({
            body: { title: `kasper-diag-${input.sessionID.slice(0, 8)}` },
          })
          diagSessionId = diagSession.data?.id ?? null
          if (diagSessionId) {
            const diagPromptTimeoutMs = Math.min(
              15_000,
              this.config.scoring_timeout_ms,
            )
            let diagPromptTimer: ReturnType<typeof setTimeout> | undefined
            const testResult = await Promise.race([
              sessionClient.session.prompt({
                path: { id: diagSessionId },
                body: {
                  parts: [{ type: "text", text: '{"ok": true}' }],
                  ...(this.modelInfo
                    ? {
                        model: {
                          providerID: this.modelInfo.providerID,
                          modelID: this.modelInfo.modelID,
                        },
                      }
                    : {}),
                  format: {
                    type: "json_schema",
                    schema: {
                      type: "object",
                      properties: { ok: { type: "boolean" } },
                      required: ["ok"],
                    },
                  },
                },
              }),
              new Promise<never>((_, reject) => {
                diagPromptTimer = setTimeout(
                  () =>
                    reject(
                      new Error(
                        `Diagnostic prompt timed out after ${diagPromptTimeoutMs}ms`,
                      ),
                    ),
                  diagPromptTimeoutMs,
                )
              }),
            ]).finally(() => {
              if (diagPromptTimer !== undefined) clearTimeout(diagPromptTimer)
            })
            const testText = this.extractResponseText(
              testResult.data?.parts,
              "diagTest",
            )
            this.logger?.log("scoring_diag_test", {
              sessionID: input.sessionID,
              diagSessionId,
              model: this.config.model,
              durationMs: Date.now() - diagStart,
              responseLength: testText.length,
              responsePreview: testText.slice(0, 200),
              ok: testText.includes("true"),
            })
          } else {
            this.logger?.log("diag_session_create_failed", {
              sessionID: input.sessionID,
            })
          }
        } catch (err) {
          this.logger?.log("scoring_diag_test_error", {
            sessionID: input.sessionID,
            model: this.config.model,
            error: String(err),
          })
        } finally {
          if (diagSessionId) {
            const diagDelStart = Date.now()
            try {
              await sessionClient.session.delete({
                path: { id: diagSessionId },
              })
              this.logger?.log("scoring_diag_deleted", {
                diagSessionId,
                sessionID: input.sessionID,
                durationMs: Date.now() - diagDelStart,
              })
            } catch (e) {
              this.logger?.log("scoring_diag_cleanup_failed", {
                diagSessionId,
                error: String(e),
              })
            }
          }
        }
      }

      const promptTimeoutMs = this.config.scoring_timeout_ms
      const sessionId = scoringSessionId

      const doPrompt = async () => {
        let promptTimer: ReturnType<typeof setTimeout> | undefined
        let timeoutFired = false
        this.logger?.log("scoring_prompt_sending", {
          sessionID: input.sessionID,
          scoringSessionId: sessionId,
          promptLen: evaluationPrompt.length,
          hasFormat: !!promptBody.format,
          promptTimeoutMs,
        })
        return Promise.race([
          sessionClient.session
            .prompt({
              path: { id: sessionId },
              body: promptBody,
            })
            .then((res) => {
              if (timeoutFired) {
                this.logger?.log("scoring_prompt_late_response", {
                  sessionID: input.sessionID,
                  scoringSessionId: sessionId,
                  model: this.config.model,
                })
              }
              return res
            }),
          new Promise<never>((_, reject) => {
            promptTimer = setTimeout(() => {
              timeoutFired = true
              this.logger?.log("scoring_prompt_timeout_fired", {
                sessionID: input.sessionID,
                scoringSessionId: sessionId,
                promptTimeoutMs,
                model: this.config.model,
              })
              reject(
                new Error(
                  `Scoring timed out after ${(promptTimeoutMs / 1000).toFixed(0)}s — is the model "${this.config.model}" available?`,
                ),
              )
            }, promptTimeoutMs)
          }),
        ]).finally(() => {
          if (promptTimer !== undefined) clearTimeout(promptTimer)
        })
      }

      let result: Awaited<ReturnType<typeof sessionClient.session.prompt>>
      try {
        result = await doPrompt()
      } catch (err) {
        const msg = String(err)
        this.logger?.log("scoring_prompt_error", {
          sessionID: input.sessionID,
          scoringSessionId,
          error: msg,
          model: this.config.model,
          isTimeout: msg.includes("timed out"),
          durationSoFarMs: Date.now() - tStart,
        })
        if (msg.includes("tool_choice") || msg.includes("Thinking mode")) {
          this.logger?.log("scoring_format_retry", {
            sessionID: input.sessionID,
            scoringSessionId,
            originalError: msg,
          })
          delete promptBody.format
          result = await doPrompt()
        } else {
          throw err
        }
      }

      const responseText = this.extractResponseText(
        result.data?.parts,
        "promptResponse",
      )

      const rawPartsSummary = (result.data?.parts ?? []).map((p) => {
        const rp = p as Record<string, unknown>
        return {
          t: p.type,
          hasText: typeof p.text === "string",
          textLen: typeof p.text === "string" ? p.text.length : 0,
          textSlice: typeof p.text === "string" ? p.text.slice(0, 80) : null,
          hasInput: typeof rp.input === "object" && rp.input !== null,
          keys: Object.keys(p),
        }
      })

      // Deep diagnostic: dump full tool part data and result.data keys/values
      // Full raw result dump (truncate large text fields)
      const rawDump = result.data
        ? (() => {
            const data = result.data as Record<string, unknown>
            const dump: Record<string, unknown> = {}
            for (const k of Object.keys(data)) {
              const v = data[k]
              if (k === "parts" && Array.isArray(v)) {
                dump[k] = v.map((p: Record<string, unknown>, i: number) => {
                  const partDump: Record<string, unknown> = {
                    _idx: i,
                    type: p.type,
                  }
                  for (const pk of Object.keys(p)) {
                    const pv = p[pk]
                    if (pv === null || pv === undefined) continue
                    if (
                      pk === "id" ||
                      pk === "type" ||
                      pk === "callID" ||
                      pk === "state" ||
                      pk === "tool" ||
                      pk === "sessionID" ||
                      pk === "messageID"
                    ) {
                      partDump[pk] = pv
                    } else if (typeof pv === "string") {
                      partDump[pk] = `${pv.length}c:${pv.slice(0, 100)}`
                    } else if (
                      typeof pv === "number" ||
                      typeof pv === "boolean"
                    ) {
                      partDump[pk] = pv
                    } else if (typeof pv === "object") {
                      partDump[pk] = Object.keys(pv as Record<string, unknown>)
                    }
                  }
                  return partDump
                })
              } else if (typeof v === "object" && v !== null) {
                dump[k] = Object.keys(v as Record<string, unknown>)
              } else if (typeof v === "string") {
                dump[k] = `str:${v.length}c`
              } else {
                dump[k] = v
              }
            }
            return dump
          })()
        : null

      this.logger?.log("scoring_prompt_response", {
        sessionID: input.sessionID,
        scoringSessionId,
        durationMs: Date.now() - tStart,
        responseLen: responseText.length,
        partsCount: result.data?.parts?.length ?? 0,
        partTypes: result.data?.parts?.map((p) => p.type) ?? [],
        responsePreview: responseText.slice(0, 300),
        hasData: !!result.data,
        dataKeys: result.data ? Object.keys(result.data) : [],
        rawParts: rawPartsSummary,
        _diag_dataTopKeys: result.data ? Object.keys(result.data) : [],
        _diag_infoKeys: (result.data as Record<string, unknown>)?.info
          ? Object.keys(
              (result.data as Record<string, unknown>).info as Record<
                string,
                unknown
              >,
            )
          : [],
        _diag_toolParts: (result.data?.parts ?? [])
          .filter((p) => p.type === "tool")
          .map((p) => {
            const rp = p as Record<string, unknown>
            return {
              keys: Object.keys(p),
              toolName: rp.tool,
              callID: rp.callID,
              hasInput: typeof rp.input === "object" && rp.input !== null,
              inputType: typeof rp.input,
              inputKeys:
                typeof rp.input === "object" &&
                rp.input &&
                !Array.isArray(rp.input)
                  ? Object.keys(rp.input as Record<string, unknown>)
                  : Array.isArray(rp.input)
                    ? `array[${rp.input.length}]`
                    : "n/a",
              state: rp.state,
            }
          }),
        _diag_fullRawDump: rawDump,
      })

      if (!responseText) {
        this.logger?.log("scoring_empty_response", {
          sessionID: input.sessionID,
          scoringSessionId,
          model: this.config.model,
          partsCount: result.data?.parts?.length ?? 0,
          durationMs: Date.now() - tStart,
          rawParts: rawPartsSummary,
        })
      }

      if (!responseText.trim() && promptBody.format) {
        this.logger?.log("scoring_empty_retry_no_format", {
          sessionID: input.sessionID,
          scoringSessionId,
          model: this.config.model,
        })
        delete promptBody.format
        result = await doPrompt()
      }

      const finalText = this.extractResponseText(
        result.data?.parts,
        "finalText",
      )

      // If the model uses StructuredOutput tool, the scoring data is in a follow-up
      // tool_result message, not in the assistant's parts. Poll messages to find it.
      let evalData = this.parseResponseJSON(finalText) as ScorerStructuredOutput

      if (
        Object.keys(evalData).length === 0 &&
        sessionClient.session.messages
      ) {
        const hasToolCall = result.data?.parts?.some((p) => p.type === "tool")
        if (hasToolCall) {
          const pollStart = Date.now()
          const maxPollMs = 5000
          const pollIntervalMs = 500
          let found = false
          while (!found && Date.now() - pollStart < maxPollMs) {
            try {
              const msgsResult = await sessionClient.session.messages({
                path: { id: sessionId },
              })
              const msgs = msgsResult?.data ?? []

              // Diagnostic: dump poll messages state on first poll
              const pollDuration = Date.now() - pollStart
              if (pollDuration === 0) {
                this.logger?.log("scoring_poll_diag", {
                  sessionID: input.sessionID,
                  scoringSessionId,
                  msgCount: msgs.length,
                  msgSummary: msgs.map((m, mi) => {
                    const r = m as Record<string, unknown>
                    return {
                      idx: mi,
                      role: r.role,
                      partsCount: (m.parts ?? []).length,
                      partTypes: (m.parts ?? []).map(
                        (p: Record<string, unknown>) => p.type,
                      ),
                      partKeys: (m.parts ?? []).map(
                        (p: Record<string, unknown>) => Object.keys(p),
                      ),
                      partToolNames: (m.parts ?? []).map(
                        (p: Record<string, unknown>) =>
                          (p as Record<string, unknown>).tool,
                      ),
                      partToolStates: (m.parts ?? []).map(
                        (p: Record<string, unknown>) =>
                          (p as Record<string, unknown>).state,
                      ),
                      partHasInput: (m.parts ?? []).map(
                        (p: Record<string, unknown>) =>
                          typeof (p as Record<string, unknown>).input ===
                            "object" &&
                          (p as Record<string, unknown>).input !== null
                            ? Object.keys(
                                (p as Record<string, unknown>).input as Record<
                                  string,
                                  unknown
                                >,
                              )
                            : false,
                      ),
                      partHasContent: (m.parts ?? []).map(
                        (p: Record<string, unknown>) =>
                          typeof (p as Record<string, unknown>).content ===
                            "object" &&
                          (p as Record<string, unknown>).content !== null
                            ? Object.keys(
                                (p as Record<string, unknown>)
                                  .content as Record<string, unknown>,
                              )
                            : false,
                      ),
                    }
                  }),
                })
              }

              // Scan newest-to-oldest for tool_result or tool with input
              for (let mi = msgs.length - 1; mi >= 0; mi--) {
                const msgParts = msgs[mi].parts ?? []
                for (let pi = msgParts.length - 1; pi >= 0; pi--) {
                  const rp = msgParts[pi] as Record<string, unknown>
                  let candidate = ""
                  // tool_result: check content.text or content array
                  if (
                    msgParts[pi].type === "tool_result" &&
                    typeof rp.content === "object" &&
                    rp.content
                  ) {
                    const content = rp.content as Record<string, unknown>
                    if (typeof content.text === "string")
                      candidate = content.text
                    else if (Array.isArray(content)) {
                      candidate = content
                        .map((c) =>
                          typeof (c as Record<string, unknown>).text ===
                          "string"
                            ? ((c as Record<string, unknown>).text as string)
                            : "",
                        )
                        .join(" ")
                    }
                  }
                  // tool with input (completed StructuredOutput)
                  if (
                    !candidate &&
                    msgParts[pi].type === "tool" &&
                    typeof rp.input === "object" &&
                    rp.input &&
                    !Array.isArray(rp.input)
                  ) {
                    const inp = rp.input as Record<string, unknown>
                    for (const val of Object.values(inp)) {
                      if (typeof val === "string" && val.trim()) {
                        candidate = val
                        break
                      }
                    }
                  }
                  if (candidate.trim()) {
                    const parsed = this.parseResponseJSON(
                      candidate,
                    ) as ScorerStructuredOutput
                    if (Object.keys(parsed).length > 0) {
                      this.logger?.log("scoring_toolresult_found", {
                        sessionID: input.sessionID,
                        scoringSessionId,
                        candidateLen: candidate.length,
                        candidatePreview: candidate.slice(0, 200),
                        pollMs: pollDuration,
                      })
                      evalData = parsed
                      found = true
                      break
                    }
                  }
                }
                if (found) break
              }
              if (!found && Date.now() - pollStart < maxPollMs) {
                await new Promise((r) => setTimeout(r, pollIntervalMs))
              }
            } catch (err) {
              this.logger?.log("scoring_toolresult_poll_error", {
                sessionID: input.sessionID,
                scoringSessionId,
                error: String(err),
              })
              break
            }
          }
          if (!found) {
            // Final diagnostic: dump full message state
            try {
              const finalMsgs = await sessionClient.session.messages({
                path: { id: sessionId },
              })
              const fmsgs = finalMsgs?.data ?? []
              this.logger?.log("scoring_toolresult_not_found", {
                sessionID: input.sessionID,
                scoringSessionId,
                pollMs: Date.now() - pollStart,
                finalMsgCount: fmsgs.length,
                finalMsgSummary: fmsgs.map((m, mi) => {
                  const r = m as Record<string, unknown>
                  return {
                    idx: mi,
                    role: r.role,
                    partsCount: (m.parts ?? []).length,
                    partTypes: (m.parts ?? []).map(
                      (p: Record<string, unknown>) => p.type,
                    ),
                    partKeys: (m.parts ?? []).map(
                      (p: Record<string, unknown>) => Object.keys(p),
                    ),
                    partToolStates: (m.parts ?? []).map(
                      (p: Record<string, unknown>) =>
                        (p as Record<string, unknown>).state,
                    ),
                    partHasInput: (m.parts ?? []).map(
                      (p: Record<string, unknown>) =>
                        typeof (p as Record<string, unknown>).input ===
                          "object" &&
                        (p as Record<string, unknown>).input !== null
                          ? Object.keys(
                              (p as Record<string, unknown>).input as Record<
                                string,
                                unknown
                              >,
                            )
                          : false,
                    ),
                    partHasContent: (m.parts ?? []).map(
                      (p: Record<string, unknown>) =>
                        typeof (p as Record<string, unknown>).content ===
                          "object" &&
                        (p as Record<string, unknown>).content !== null
                          ? Object.keys(
                              (p as Record<string, unknown>).content as Record<
                                string,
                                unknown
                              >,
                            )
                          : false,
                    ),
                    // Deep dump for tool/tool_result parts: all non-trivial values
                    partDiagnostics: (m.parts ?? [])
                      .map((p: Record<string, unknown>) => {
                        if (p.type === "tool" || p.type === "tool_result") {
                          const rp = p as Record<string, unknown>
                          const diag: Record<string, unknown> = {}
                          for (const k of Object.keys(rp)) {
                            const v = rp[k]
                            if (v === null || v === undefined) continue
                            if (
                              k === "id" ||
                              k === "callID" ||
                              k === "sessionID" ||
                              k === "messageID"
                            )
                              diag[k] = v
                            else if (typeof v === "string")
                              diag[k] =
                                v.length > 200 ? `${v.slice(0, 200)}...` : v
                            else if (
                              typeof v === "number" ||
                              typeof v === "boolean"
                            )
                              diag[k] = v
                            else if (typeof v === "object")
                              diag[k] = Object.keys(
                                v as Record<string, unknown>,
                              )
                          }
                          return diag
                        }
                        return null
                      })
                      .filter(Boolean),
                  }
                }),
              })
            } catch {
              this.logger?.log("scoring_toolresult_not_found", {
                sessionID: input.sessionID,
                scoringSessionId,
                pollMs: Date.now() - pollStart,
              })
            }
          }
        }
      }

      if (Object.keys(evalData).length === 0 && finalText.length > 0) {
        // Some models emit scoring data as "# StructuredOutput [key=value, ...]"
        // in the reasoning text. Extract overall_score from this format.
        const bracketMatch = finalText.match(
          /#\s*StructuredOutput\s*\[([^\]]*)\]/i,
        )
        if (bracketMatch) {
          const raw = bracketMatch[1]
          const scoreMatch = raw.match(/overall_score\s*=\s*([\d.]+)/)
          if (scoreMatch) {
            const score = Number.parseFloat(scoreMatch[1])
            if (!Number.isNaN(score) && score >= 0 && score <= 1) {
              evalData = {
                overall_score: score,
                categories: {
                  instruction_following: score,
                  completeness: score,
                  proactiveness: score,
                  code_quality: score,
                  communication: score,
                },
                strengths: [],
                weaknesses: [],
              }
              this.logger?.log("scoring_bracket_fallback", {
                sessionID: input.sessionID,
                scoringSessionId,
                overall_score: score,
                bracketText: raw.slice(0, 200),
              })
            }
          }
        }
      }

      if (Object.keys(evalData).length === 0 && finalText.length > 0) {
        const preview =
          finalText.length <= 500 ? finalText : finalText.slice(0, 500)
        this.logger?.log("scoring_parse_failed", {
          sessionID: input.sessionID,
          scoringSessionId,
          model: this.config.model,
          responsePreview: preview,
          responseLength: finalText.length,
        })
      }

      this.logger?.log("scoring_try_done", {
        sessionID: input.sessionID,
        scoringSessionId,
        overall_score: evalData.overall_score,
        strengthsCount: evalData.strengths?.length ?? 0,
        weaknessesCount: evalData.weaknesses?.length ?? 0,
        suggestionCount: evalData.weakness_suggestions?.length ?? 0,
        totalDurationMs: Date.now() - tStart,
      })
      const clamp = (n: number) => Math.max(0, Math.min(1, n))
      const cats = evalData.categories ?? {}

      const rawWeaknesses = Array.isArray(evalData.weaknesses)
        ? evalData.weaknesses
        : []
      const normalizedWeaknesses = rawWeaknesses.map((w) =>
        typeof w === "string"
          ? w
          : (w.description ?? w.weakness ?? JSON.stringify(w)),
      )

      const suggestionArr = evalData.weakness_suggestions
      const parsedSuggestions = Array.isArray(suggestionArr)
        ? suggestionArr
            .filter(
              (s) =>
                s &&
                typeof s.weakness === "string" &&
                typeof s.suggested_fix === "string" &&
                typeof s.target === "string",
            )
            .map((s) => ({
              weakness: s.weakness,
              suggested_fix: s.suggested_fix,
              target:
                s.target === "agent_prompt"
                  ? ("agent_prompt" as const)
                  : ("agents_md" as const),
            }))
        : undefined

      return {
        session_id: input.sessionID,
        message_id: input.messageID,
        timestamp: Date.now(),
        overall_score:
          typeof evalData.overall_score === "number"
            ? clamp(evalData.overall_score)
            : 0.5,
        categories: {
          instruction_following: clamp(cats.instruction_following ?? 0.5),
          completeness: clamp(cats.completeness ?? 0.5),
          proactiveness: clamp(cats.proactiveness ?? 0.5),
          code_quality: clamp(cats.code_quality ?? 0.5),
          communication: clamp(cats.communication ?? 0.5),
        },
        strengths: Array.isArray(evalData.strengths) ? evalData.strengths : [],
        weaknesses: normalizedWeaknesses,
        suggested_agents_md_update:
          typeof evalData.suggested_agents_md_update === "string" &&
          evalData.suggested_agents_md_update.length > 0
            ? evalData.suggested_agents_md_update
            : undefined,
        suggested_agent_prompt_update:
          typeof evalData.suggested_agent_prompt_update === "string" &&
          evalData.suggested_agent_prompt_update.length > 0
            ? evalData.suggested_agent_prompt_update
            : undefined,
        weakness_suggestions: parsedSuggestions,
        fallback: typeof evalData.overall_score !== "number",
        scoring_prompt_hash: SCORE_PROMPT_HASH,
        judge_version: KASPER_JUDGE_VERSION,
        rubric_version: KASPER_RUBRIC_VERSION,
        model_name: this.config.model,
      }
    } catch (err) {
      return this.fallbackCard(input, `Scoring failed: ${err}`)
    } finally {
      if (scoringSessionId) {
        const delStart = Date.now()
        try {
          await sessionClient.session.delete({
            path: { id: scoringSessionId },
          })
          this.logger?.log("scoring_session_deleted", {
            scoringSessionId,
            sessionID: input.sessionID,
            durationMs: Date.now() - delStart,
          })
        } catch (e) {
          this.logger?.log("scoring_cleanup_failed", {
            scoringSessionId,
            sessionID: input.sessionID,
            error: String(e),
          })
        }
      }
    }
  }

  private extractResponseText(
    parts?: Array<{ type: string; [key: string]: unknown }>,
    debugLabel?: string,
  ): string {
    if (!parts || parts.length === 0) return ""
    const scanLog: Array<{
      i: number
      type: string
      found: boolean
      reason: string
    }> = []
    // Scan newest-to-oldest; stop at the first part with useful content
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i]
      if (typeof part.text === "string" && part.text.trim()) {
        scanLog.push({
          i,
          type: part.type,
          found: true,
          reason: `text:${part.text.length}c non-empty`,
        })
        if (debugLabel) {
          this.logger?.log("extractResponseText", {
            label: debugLabel,
            foundAt: i,
            partType: part.type,
            textLen: part.text.length,
            textPreview: part.text.slice(0, 100),
            scanLog,
          })
        }
        return part.text
      }
      if (
        part.type === "tool" &&
        typeof part.input === "object" &&
        part.input &&
        !Array.isArray(part.input)
      ) {
        const inp = part.input as Record<string, unknown>
        for (const val of Object.values(inp)) {
          if (typeof val === "string" && val.trim()) {
            scanLog.push({
              i,
              type: part.type,
              found: true,
              reason: `tool.input.${Object.keys(inp)[0]}`,
            })
            if (debugLabel) {
              this.logger?.log("extractResponseText", {
                label: debugLabel,
                foundAt: i,
                partType: part.type,
                inputKeys: Object.keys(inp),
                textPreview: val.slice(0, 100),
                scanLog,
              })
            }
            return val
          }
        }
        scanLog.push({
          i,
          type: part.type,
          found: false,
          reason: `tool.inpObj has ${Object.keys(inp).length} keys but no string vals: ${JSON.stringify(Object.keys(inp))}`,
        })
        continue
      }
      if (part.type === "tool") {
        const rp = part as Record<string, unknown>
        scanLog.push({
          i,
          type: part.type,
          found: false,
          reason: `tool hasInput=${typeof rp.input === "object" && rp.input !== null} hasInputArr=${Array.isArray(rp.input)} inputType=${typeof rp.input}`,
        })
        continue
      }
      if (typeof part.text === "string") {
        scanLog.push({
          i,
          type: part.type,
          found: false,
          reason: `text:${part.text.length}c empty-after-trim`,
        })
        continue
      }
      scanLog.push({
        i,
        type: part.type,
        found: false,
        reason: `no text or tool input`,
      })
    }
    if (debugLabel) {
      this.logger?.log("extractResponseText", {
        label: debugLabel,
        foundAt: -1,
        partType: "none",
        textPreview: "",
        scanLog,
      })
    }
    return ""
  }

  private extractBalancedJSON(text: string): string | null {
    const startIdx = text.indexOf("{")
    if (startIdx === -1) return null

    let depth = 0
    let inString = false
    let escaped = false
    for (let i = startIdx; i < text.length; i++) {
      const ch = text[i]
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === "\\") {
        escaped = true
        continue
      }
      if (ch === '"') {
        inString = !inString
        continue
      }
      if (inString) continue
      if (ch === "{") depth++
      else if (ch === "}") {
        depth--
        if (depth === 0) return text.slice(startIdx, i + 1)
      }
    }
    return null
  }

  private parseResponseJSON(text: string): Record<string, unknown> {
    const trimmed = text.trim()
    if (!trimmed) return {}

    const tryParse = (s: string): Record<string, unknown> | undefined => {
      const extracted = this.extractBalancedJSON(s)
      if (!extracted) return undefined
      try {
        const errors: { error: number; offset: number; length: number }[] = []
        const result = parseJSONC(extracted, errors)
        if (
          errors.length === 0 &&
          result &&
          typeof result === "object" &&
          !Array.isArray(result)
        ) {
          return result as Record<string, unknown>
        }
      } catch {
        /* parse failure is non-fatal */
      }
      return undefined
    }

    const codeBlockRegex = /```(?:json)?\s*\n?/i
    const startMatch = trimmed.match(codeBlockRegex)
    if (startMatch) {
      const contentStart = (startMatch.index ?? 0) + startMatch[0].length
      const closeIdx = trimmed.indexOf("```", contentStart)
      if (closeIdx !== -1) {
        const inner = trimmed.slice(contentStart, closeIdx).trim()
        const parsed = tryParse(inner)
        if (parsed) return parsed
      }
    }

    const parsed = tryParse(trimmed)
    if (parsed) return parsed

    return {}
  }

  buildEvalPrompt(input: ScorerInput): string {
    const detail = this.config.detail_level
    const parts: string[] = []
    const esc = (s: string) => s.replace(/</g, "&lt;").replace(/>/g, "&gt;")

    parts.push("<instructions>")
    parts.push("")
    parts.push(SCORE_PROMPT)
    parts.push("")
    parts.push(
      "Return ONLY valid JSON in this exact format (no markdown, no extra text):",
    )
    parts.push("```json")
    parts.push(
      JSON.stringify(
        {
          overall_score: 0.85,
          categories: {
            instruction_following: 0.9,
            completeness: 0.8,
            proactiveness: 0.8,
            code_quality: 0.8,
            communication: 0.9,
          },
          strengths: ["Did exactly what was asked", "Clean code"],
          weaknesses: ["Response could be more concise"],
          suggested_agents_md_update: "",
          suggested_agent_prompt_update: "",
          weakness_suggestions: [
            {
              weakness: "Response could be more concise",
              suggested_fix:
                "When presenting results, keep summaries to 2-3 bullet points maximum unless the user asks for detail.",
              target: "agent_prompt",
            },
          ],
        },
        null,
        2,
      ),
    )
    parts.push("```")
    parts.push("")
    parts.push("</instructions>")
    parts.push("")

    parts.push("<session_data>")
    parts.push("")

    if (input.agentName) {
      parts.push(`<agent>${esc(input.agentName)}</agent>`)
      parts.push("")
    }

    parts.push(`<user_request>\n${esc(input.userInstruction)}\n</user_request>`)
    parts.push("")

    parts.push(
      `<agent_response>\n${esc(input.agentResponse)}\n</agent_response>`,
    )
    parts.push("")

    if (detail === "minimal") {
      parts.push(
        `<tools_used>\n${input.toolCalls.map((tc) => `- ${esc(tc.tool)}`).join("\n") || "(none)"}\n</tools_used>`,
      )
    } else {
      const resultLen = detail === "thorough" ? 2000 : 500
      parts.push(
        `<tool_calls>\n${input.toolCalls.map((tc) => `  <call>\n    <tool>${esc(tc.tool)}</tool>\n    <args>${esc(tc.args)}</args>\n    <result>${safeTruncate(tc.result, resultLen)}</result>\n  </call>`).join("\n")}\n</tool_calls>`,
      )
    }

    const subagentList = input.subagentCalls || []
    if (subagentList.length > 0) {
      if (detail === "minimal") {
        parts.push(
          `<subagents_used>\n${subagentList.map((sc) => `- ${esc(sc.agent)}`).join("\n")}\n</subagents_used>`,
        )
      } else {
        parts.push(
          `<subagent_calls>\n${subagentList.map((sc) => `  <call>\n    <agent>${esc(sc.agent)}</agent>\n    <args>${sc.input ? esc(sc.input) : ""}</args>\n  </call>`).join("\n")}\n</subagent_calls>`,
        )
      }
    }

    parts.push("")
    parts.push("</session_data>")
    parts.push("")

    parts.push("<agent_context>")
    parts.push("")

    if (detail !== "minimal") {
      if (input.agentPrompt) {
        parts.push(
          `<current_agent_prompt>\n${esc(input.agentPrompt)}\n</current_agent_prompt>`,
        )
        parts.push("")
      }

      parts.push(
        `<current_agents_md>\n${esc(input.agentsMdContent || "(none)")}\n</current_agents_md>`,
      )
    } else {
      parts.push(
        `<context_notes>\n${input.agentPrompt ? "A per-agent prompt file exists with specific instructions." : ""}${input.agentsMdContent ? " AGENTS.md exists with project-wide instructions." : ""}\n</context_notes>`,
      )
    }
    parts.push("")

    if (input.userGuidance) {
      parts.push(
        `<user_guidance>\n${esc(input.userGuidance)}\n</user_guidance>`,
      )
      parts.push("")
      parts.push(
        "IMPORTANT: The guidance above tells you what aspects to focus on in your evaluation. " +
          "It is NOT an instruction to inflate or deflate scores. " +
          "Evaluate honestly based on the actual agent performance against the user's original request.",
      )
      parts.push("")
    }

    if (input.compacted) {
      parts.push(
        "<note>\nThis session was compacted mid-conversation (context was summarized). The agent response you see may be incomplete or summarized. Adjust your evaluation accordingly.\n</note>",
      )
      parts.push("")
    }

    if (input.agentsMdChanged) {
      parts.push(
        "<note>\nAGENTS.md was modified during this session. The AGENTS.md content shown above is the CURRENT state and may differ from what the agent saw when it responded. The agent should be evaluated against the instructions available at the time of its response, not against changes made afterward.\n</note>",
      )
      parts.push("")
    }

    if (input.existingWeaknesses && input.existingWeaknesses.length > 0) {
      parts.push("<existing_weaknesses>")
      parts.push("")
      parts.push(
        "This session has the following known weaknesses from previous evaluations:",
      )
      parts.push("")
      for (const w of input.existingWeaknesses) {
        parts.push(`- ${esc(w)}`)
      }
      parts.push("")
      parts.push(
        "When evaluating this new response, check whether each existing weakness is still present.",
      )
      parts.push(
        "Also identify any NEW weaknesses that were not present before.",
      )
      parts.push(
        "Do NOT re-list existing weaknesses in your output unless they are still present in the new messages.",
      )
      parts.push("")
      parts.push("</existing_weaknesses>")
      parts.push("")
    }

    parts.push("</agent_context>")

    return parts.join("\n").trimEnd()
  }
}
