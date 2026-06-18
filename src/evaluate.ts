import { createHash, randomUUID } from "node:crypto"
import {
  BACKUP_ENABLED,
  BACKUP_MAX_VERSIONS,
  isBuiltinAgentName,
  MAX_EVALUATED_SESSION_SET,
  MAX_MESSAGE_CHARS,
  MAX_MESSAGE_PARTS,
  MAX_PENDING_IMPROVEMENTS,
  MAX_TOOL_CALLS_EVAL,
  MAX_USER_INSTRUCTION_CHARS,
} from "./constants.js"
import type { ScorerInput } from "./scorer.js"
import type {
  KasperConfig,
  KasperContext,
  PendingEval,
  ScoreCard,
  SubagentCallRecord,
  ToolCallRecord,
} from "./types.js"
import {
  findMatchingWeakness,
  formatScore,
  isKasperSession,
  isRegisteredCommand,
  isValidGuidanceText,
  sanitizeImprovementText,
  showToast,
  weaknessesMergeable,
} from "./utils.js"

function closePendingScoreDeltas(ctx: KasperContext): void {
  const improvements = ctx.stateStore.getImprovements?.() ?? []
  if (improvements.length === 0) return

  const agg = ctx.stateStore.getAggregate()
  const cursor = ctx.stateStore.getDeltaScanCursor()
  const startIdx = cursor
    ? improvements.findIndex((i) => i.id === cursor) + 1
    : 0
  let newCursor = cursor
  for (let i = startIdx; i < improvements.length; i++) {
    const imp = improvements[i]
    if (
      imp.score_before !== undefined &&
      imp.outcome_score_delta === undefined
    ) {
      const after =
        imp.target === "agent_prompt" && imp.agent_name
          ? (agg.by_agent[imp.agent_name]?.avg_score ?? agg.avg_score)
          : agg.avg_score
      ctx.stateStore.setImprovementDelta(imp.id, after - imp.score_before)
      newCursor = imp.id
    }
  }
  ctx.stateStore.setDeltaScanCursor(newCursor)
}

function aggregateScoreCards(cards: ScoreCard[], sessionID: string): ScoreCard {
  if (cards.length === 0) {
    throw new Error("cannot aggregate empty score cards")
  }
  const avg = (fn: (c: ScoreCard) => number) =>
    cards.reduce((s, c) => s + fn(c), 0) / cards.length

  return {
    session_id: sessionID,
    timestamp: cards[0].timestamp,
    overall_score: avg((c) => c.overall_score),
    categories: {
      instruction_following: avg((c) => c.categories.instruction_following),
      completeness: avg((c) => c.categories.completeness),
      proactiveness: avg((c) => c.categories.proactiveness),
      code_quality: avg((c) => c.categories.code_quality),
      communication: avg((c) => c.categories.communication),
    },
    strengths: [...new Set(cards.flatMap((c) => c.strengths))],
    weaknesses: [...new Set(cards.flatMap((c) => c.weaknesses))],
    suggested_agents_md_update: cards.find((c) => c.suggested_agents_md_update)
      ?.suggested_agents_md_update,
    suggested_agent_prompt_update: cards.find(
      (c) => c.suggested_agent_prompt_update,
    )?.suggested_agent_prompt_update,
    weakness_suggestions: cards.flatMap((c) => c.weakness_suggestions ?? []),
    fallback: cards.some((c) => c.fallback),
  }
}

export async function runEvaluation(
  pending: PendingEval,
  ctx: KasperContext,
): Promise<boolean> {
  return ctx.evalMutex
    .runExclusive(async () => {
      if (ctx.sessionsEvaluated.has(pending.sessionID)) {
        await ctx.logger.log("run_eval_skipped", {
          sessionID: pending.sessionID,
          reason: "already_in_evaluated_set",
        })
        return false
      }
      ctx.evaluationStartedAt = Date.now()
      await ctx.logger.log("run_eval_start", {
        sessionID: pending.sessionID,
        agentName: pending.agentName,
        pairsCount: pending.pairs.length,
        instructionLen: pending.userInstruction.length,
      })
      const config = ctx.stateStore.getConfig()
      const agentsMdContent = await ctx.agentsMd.read()

      const currentHash = agentsMdContent
        ? createHash("sha256")
            .update(agentsMdContent)
            .digest("hex")
            .slice(0, 16)
        : undefined
      const agentsMdHash = currentHash
      const agentsMdChanged = !!(
        pending.agentsMdHash &&
        currentHash &&
        pending.agentsMdHash !== currentHash
      )

      let agentPrompt: string | undefined
      let agentPromptHash: string | undefined
      if (pending.agentName) {
        if (ctx.client.app?.agents) {
          try {
            const rawAgents = await ctx.client.app.agents()
            const agents = Array.isArray(rawAgents)
              ? rawAgents
              : (((rawAgents as Record<string, unknown>)?.data as
                  | Array<{ name?: string; prompt?: string }>
                  | undefined) ?? [])
            const found = agents.find(
              (a: { name?: string }) => a.name === pending.agentName,
            )
            if (found?.prompt) {
              agentPrompt = found.prompt
            }
          } catch {
            ctx.logger.log("debug", {
              context: "agent_prompt_fetch",
              detail: "falling back to file read",
            })
          }
        }
        if (!agentPrompt) {
          agentPrompt =
            (await ctx.agentPrompts.read(pending.agentName)) || undefined
        }
        if (agentPrompt) {
          agentPromptHash = createHash("sha256")
            .update(agentPrompt)
            .digest("hex")
            .slice(0, 16)
        }
      }

      const fullResponse = pending.agentResponseParts.join("\n")
      const agentResponse =
        fullResponse.length > MAX_MESSAGE_CHARS
          ? fullResponse.slice(0, MAX_MESSAGE_CHARS)
          : fullResponse

      const toolCalls =
        pending.toolCalls.length > MAX_TOOL_CALLS_EVAL
          ? pending.toolCalls.slice(-MAX_TOOL_CALLS_EVAL)
          : pending.toolCalls

      let card: ScoreCard
      const maxInputChars = ctx.config.max_score_input_chars
      if (
        pending.pairs.length > 1 &&
        pending.userInstruction.length + fullResponse.length > maxInputChars
      ) {
        await ctx.logger.log("evaluation_split", {
          sessionID: pending.sessionID,
          pairCount: pending.pairs.length,
          totalInputLen: pending.userInstruction.length + fullResponse.length,
        })
        const pairCards: ScoreCard[] = []
        for (let i = 0; i < pending.pairs.length; i++) {
          const pair = pending.pairs[i]
          const pairInput: ScorerInput = {
            sessionID: pending.sessionID,
            userInstruction: pair.userInstruction.slice(
              -MAX_USER_INSTRUCTION_CHARS,
            ),
            agentResponse: pair.agentResponse.slice(0, MAX_MESSAGE_CHARS),
            toolCalls: pair.toolCalls.slice(-MAX_TOOL_CALLS_EVAL),
            subagentCalls: pair.subagentCalls,
            agentsMdContent,
            agentName: pending.agentName,
            agentPrompt,
            userGuidance: ctx.userGuidance.get(pending.sessionID) ?? undefined,
            compacted: pending.compacted,
            agentsMdChanged,
            existingWeaknesses: pending.existingWeaknesses,
          }
          try {
            const pc = await ctx.scorer.evaluate(pairInput, ctx.client)
            pc.agent_prompt_hash = agentPromptHash
            pc.agents_md_hash = agentsMdHash
            pairCards.push(pc)
            await ctx.logger.log("pair_evaluated", {
              sessionID: pending.sessionID,
              pairIndex: i,
              score: pc.overall_score,
            })
          } catch (err) {
            await ctx.logger.log("pair_eval_error", {
              sessionID: pending.sessionID,
              pairIndex: i,
              error: String(err),
            })
          }
        }
        if (pairCards.length === 0) {
          await ctx.logger.log("evaluation_skipped", {
            sessionID: pending.sessionID,
            reason: "all_pairs_failed",
          })
          return false
        }
        card = aggregateScoreCards(pairCards, pending.sessionID)
        card.agent_prompt_hash = agentPromptHash
        card.agents_md_hash = agentsMdHash
      } else {
        const scoreInput: ScorerInput = {
          sessionID: pending.sessionID,
          userInstruction: pending.userInstruction,
          agentResponse,
          toolCalls,
          subagentCalls: pending.subagentCalls,
          agentsMdContent,
          agentName: pending.agentName,
          agentPrompt,
          userGuidance: ctx.userGuidance.get(pending.sessionID) ?? undefined,
          compacted: pending.compacted,
          agentsMdChanged,
          existingWeaknesses: pending.existingWeaknesses,
        }

        await ctx.logger.log("evaluation_start", {
          sessionID: pending.sessionID,
          agentName: pending.agentName ?? "unknown",
          instructionLen: pending.userInstruction.length,
          responseLen: fullResponse.length,
          toolCalls: pending.toolCalls.length,
          truncatedResponse: fullResponse.length > MAX_MESSAGE_CHARS,
          truncatedToolCalls: pending.toolCalls.length > MAX_TOOL_CALLS_EVAL,
        })

        card = await ctx.scorer.evaluate(scoreInput, ctx.client)
        card.agent_prompt_hash = agentPromptHash
        card.agents_md_hash = agentsMdHash
      }

      await ctx.logger.log("evaluation_done", {
        sessionID: pending.sessionID,
        overall_score: card.overall_score,
        fallback: card.fallback,
        weaknesses: card.weaknesses.slice(0, 3),
      })

      const scorePct = (card.overall_score * 100).toFixed(0)
      const { emoji: _scoreEmoji } = formatScore(card.overall_score)

      if (card.fallback || card.overall_score <= 0) {
        // Failure path: do NOT add pending.sessionID to
        // ctx.sessionsEvaluated or to the persistent
        // ctx.stateStore.addEvaluatedSession list. Adding it would mark
        // the primary session as "already evaluated" forever, blocking
        // any future re-attempt (e.g. after the user fixes the model
        // config in kasper.jsonc). Scorer errors are transient: the
        // model may be unavailable right now but become available
        // later, the user may edit kasper.jsonc, or the user may
        // restart opencode. The session will be retried on the next
        // poll cycle (or after restart) when SESSION_DEBOUNCE_MS elapses
        // — and a fresh scoring attempt produces a fresh card. The
        // trade-off is some 6s-cycle log noise while the model is
        // unavailable, but the toast warning already tells the user.
        // The successful-recording path (below) is the only path that
        // is allowed to mark a session as evaluated.
        await ctx.logger.log("evaluation_skipped", {
          sessionID: pending.sessionID,
          score: card.overall_score,
          reason:
            card.weaknesses[0] ??
            (card.overall_score <= 0 ? "zero_score" : "fallback"),
        })
        if (card.fallback && !ctx.config.quiet) {
          showToast(
            ctx.client,
            "Kasper",
            `Scoring failed — skipping session "${pending.userInstruction.slice(0, 40)}...". Check model availability.`,
            "warning",
          )
        }
        return false
      }

      await ctx.logger.log("run_eval_recording", {
        sessionID: pending.sessionID,
        score: card.overall_score,
        sessionsEvaluatedSizeBefore: ctx.sessionsEvaluated.size,
      })

      ctx.sessionsEvaluated.add(pending.sessionID)
      ctx.stateStore.addEvaluatedSession?.(pending.sessionID)
      if (ctx.sessionsEvaluated.size > MAX_EVALUATED_SESSION_SET) {
        const toRemove = [...ctx.sessionsEvaluated].slice(
          0,
          ctx.sessionsEvaluated.size - MAX_EVALUATED_SESSION_SET,
        )
        for (const id of toRemove) ctx.sessionsEvaluated.delete(id)
      }

      ctx.stateStore.recordSession(
        pending.sessionID,
        pending.userInstruction.slice(0, 100),
        card,
        pending.agentName,
        pending.agentType,
        pending.parentSessionID,
        pending.lastMessageId,
        Date.now(),
      )

      const aggAfterRecording = ctx.stateStore.getAggregate()
      await ctx.logger.log("run_eval_recorded", {
        sessionID: pending.sessionID,
        score: card.overall_score,
        totalSessionsAfter: aggAfterRecording.total_sessions,
        sessionsInStore:
          typeof ctx.stateStore.getTotalSessions === "function"
            ? ctx.stateStore.getTotalSessions()
            : undefined,
        sessionsEvaluatedSize: ctx.sessionsEvaluated.size,
      })

      if (aggAfterRecording.total_sessions > 1 && !ctx.isMergingWeaknesses) {
        ctx.isMergingWeaknesses = true
        try {
          await ctx.stateStore.mergeAllWeaknesses(ctx.scorer, ctx.client)
        } finally {
          ctx.isMergingWeaknesses = false
        }
      }

      const expired = ctx.stateStore.expireOldImprovements?.() ?? 0
      if (expired > 0) {
        await ctx.logger.log("improvements_expired", { count: expired })
      }

      closePendingScoreDeltas(ctx)

      ctx.logger.trim().catch(() => {})

      if (card.overall_score < config.scoring_threshold) {
        await considerImprovement(card, ctx, config, pending)
      }

      if (card.overall_score < 0.4) {
        showToast(
          ctx.client,
          "Kasper",
          `Low adherence score: ${scorePct}% — session "${pending.userInstruction.slice(0, 40)}..."`,
          "warning",
        )
      }
      await ctx.logger.log("run_eval_success", {
        sessionID: pending.sessionID,
        score: card.overall_score,
      })
      return true
    })
    .catch(async (err) => {
      await ctx.logger.log("run_eval_error", {
        sessionID: pending.sessionID,
        error: String(err),
      })
      return false
    })
}

interface PartWithMeta extends Record<string, unknown> {
  data?: { name?: string }
  content?: { name?: string }
}

function extractAgentFromPart(p: Record<string, unknown>): string | undefined {
  if (p.type !== "agent") return undefined
  if (typeof p.name === "string" && p.name) return p.name
  const pm = p as PartWithMeta
  if (typeof pm.data?.name === "string" && pm.data.name) return pm.data.name
  if (typeof pm.content?.name === "string" && pm.content.name)
    return pm.content.name
  return undefined
}

function extractSubagentCallsFromMessages(
  msgs: Array<{ parts?: Array<Record<string, unknown>> }>,
): SubagentCallRecord[] {
  const calls: SubagentCallRecord[] = []
  for (const msg of msgs) {
    const parts = Array.isArray(msg.parts) ? msg.parts : []
    for (const part of parts) {
      if (part.type === "agent") {
        const agent = extractAgentFromPart(part)
        if (agent) {
          const input =
            typeof part.input === "string"
              ? part.input
              : typeof part.text === "string"
                ? part.text
                : ""
          calls.push({ agent, input })
        }
      }
    }
  }
  return calls
}

function extractAgentFromInfo(info: unknown): string | undefined {
  if (!info || typeof info !== "object") return undefined
  const i = info as Record<string, unknown>
  if (typeof i.agent === "string" && i.agent) return i.agent
  if (typeof i.agentName === "string" && i.agentName) return i.agentName
  if (typeof i.subagent_type === "string" && i.subagent_type)
    return i.subagent_type
  if (typeof i.agent_type === "string" && i.agent_type) return i.agent_type
  return undefined
}

function detectAgentTransitions(
  msgList: Array<{
    info?: { id: string; role: string; sessionID: string }
    parts?: Array<Record<string, unknown>>
  }>,
): Array<{
  agentName: string | undefined
  msgs: typeof msgList
}> {
  const segments: Array<{
    agentName: string | undefined
    msgs: typeof msgList
  }> = []
  let currentAgent: string | undefined
  let currentMsgs: typeof msgList = []

  for (const msg of msgList) {
    const parts = Array.isArray(msg.parts) ? msg.parts : []

    let detectedAgent: string | undefined
    for (const p of parts) {
      detectedAgent = extractAgentFromPart(p)
      if (detectedAgent) break
    }
    if (!detectedAgent) {
      detectedAgent = extractAgentFromInfo(msg.info)
    }

    if (detectedAgent && detectedAgent !== currentAgent) {
      if (currentMsgs.length > 0) {
        segments.push({ agentName: currentAgent, msgs: currentMsgs })
        currentMsgs = []
      }
      currentAgent = detectedAgent
    }
    currentMsgs.push(msg)
  }
  if (currentMsgs.length > 0) {
    segments.push({ agentName: currentAgent, msgs: currentMsgs })
  }
  return segments
}

interface ToolResultPart extends Record<string, unknown> {
  tool_use_id?: string
  content?: string | Array<{ text?: string }>
}

function extractToolCallsFromMessages(
  msgs: Array<{
    info?: { id: string; role: string; sessionID: string }
    parts?: Array<Record<string, unknown>>
  }>,
): ToolCallRecord[] {
  const toolCalls: ToolCallRecord[] = []
  for (const msg of msgs) {
    const parts = Array.isArray(msg.parts) ? msg.parts : []
    for (const part of parts) {
      if (part.type === "tool_use" && typeof part.name === "string") {
        const resultPart = parts.find(
          (p) =>
            p.type === "tool_result" &&
            (p as ToolResultPart).tool_use_id === part.id,
        ) as ToolResultPart | undefined
        const content = resultPart?.content
        toolCalls.push({
          tool: part.name,
          args: JSON.stringify(part.input ?? {}),
          result:
            typeof content === "string"
              ? content
              : Array.isArray(content)
                ? content
                    .map((c) => (typeof c.text === "string" ? c.text : ""))
                    .join(" ")
                : "(empty)",
        })
      }
    }
  }
  return toolCalls
}

function isCompressionOutput(text: string): boolean {
  if (text.includes("▣ DCP") || text.includes("▣ Compression #")) return true
  if (text.toLowerCase().includes("the user triggered compression")) return true
  return false
}

interface MsgWithRole {
  info?: { id: string; role: string; sessionID: string }
  role?: string
  parts?: Array<Record<string, unknown>>
}

function getMsgRole(msg: MsgWithRole): string | undefined {
  return msg.info?.role ?? msg.role
}

export function buildEvalFromMessages(
  msgs: Array<{
    info?: { id: string; role: string; sessionID: string }
    parts?: Array<Record<string, unknown>>
  }>,
  evalSessionID: string,
  agentName: string | undefined,
  minUserMessages = 0,
  registeredCommands = new Set<string>(),
  lastMsgId?: string,
  isIdle?: boolean,
): PendingEval | null {
  if (msgs.length === 0) return null

  let startIdx = 0
  if (lastMsgId) {
    const found = msgs.findIndex((m) => m.info?.id === lastMsgId)
    if (found !== -1) {
      startIdx = found + 1
    }
  }
  const filteredMsgs = startIdx > 0 ? msgs.slice(startIdx) : msgs
  if (filteredMsgs.length === 0) return null

  let currentUserMsg: (typeof msgs)[0] | null = null
  const keptMsgs: typeof msgs = []
  let userMessageCount = 0
  // Tracks whether the last assistant message in filteredMsgs was
  // immediately followed by a user message (making that pair complete).
  let lastAssistantFollowedByUser = false

  for (const msg of filteredMsgs) {
    const role = getMsgRole(msg)
    const parts = Array.isArray(msg.parts) ? msg.parts : []
    const text = parts
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join(" ")

    if (role === "user") {
      lastAssistantFollowedByUser = true
      if (isRegisteredCommand(text, registeredCommands)) {
        currentUserMsg = null
        continue
      }

      if (currentUserMsg) {
        const prevIdx = keptMsgs.lastIndexOf(currentUserMsg)
        if (prevIdx !== -1) {
          const hasAssistantAfter = keptMsgs
            .slice(prevIdx + 1)
            .some((m) => getMsgRole(m) === "assistant")
          if (!hasAssistantAfter) {
            keptMsgs.splice(prevIdx, 1)
            userMessageCount--
          }
        }
      }

      currentUserMsg = msg
      keptMsgs.push(msg)
      userMessageCount++
    } else if (role === "assistant") {
      lastAssistantFollowedByUser = false
      if (isCompressionOutput(text)) continue

      if (currentUserMsg) {
        keptMsgs.push(msg)
      } else if (text.trim()) {
        currentUserMsg = msg
        keptMsgs.push(msg)
        userMessageCount++
      }
    } else {
      if (currentUserMsg) {
        keptMsgs.push(msg)
      } else if (text.trim()) {
        currentUserMsg = msg
        keptMsgs.push(msg)
        userMessageCount++
      }
    }
  }

  if (
    currentUserMsg &&
    keptMsgs.length > 0 &&
    keptMsgs[keptMsgs.length - 1] === currentUserMsg
  ) {
    keptMsgs.pop()
    userMessageCount--
  }

  if (keptMsgs.length === 0) return null
  if (minUserMessages > 0 && userMessageCount < minUserMessages) return null

  // First pass: build all pairs, marking completeness.
  // A pair is "complete" if the assistant response is followed by another
  // user message (next turn started) OR if the session is idle (no more
  // activity expected for the current turn).
  interface InternalPair {
    userInstruction: string
    agentResponse: string
    toolCalls: ToolCallRecord[]
    subagentCalls: SubagentCallRecord[]
    complete: boolean
  }

  const allPairs: InternalPair[] = []
  let currentPairUser = ""
  let currentPairResponse = ""
  let currentPairToolCalls: ToolCallRecord[] = []
  let currentPairSubagents: SubagentCallRecord[] = []

  for (const msg of keptMsgs) {
    const role = getMsgRole(msg)
    const parts = Array.isArray(msg.parts) ? msg.parts : []
    const text = parts
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join(" ")

    if (role === "user" || (!currentPairUser && text.trim())) {
      if (
        currentPairUser &&
        (currentPairResponse.trim() || currentPairToolCalls.length > 0)
      ) {
        allPairs.push({
          userInstruction: currentPairUser,
          agentResponse: currentPairResponse,
          toolCalls: currentPairToolCalls,
          subagentCalls: currentPairSubagents,
          complete: true,
        })
      }
      currentPairUser = text
      currentPairResponse = ""
      currentPairToolCalls = []
      currentPairSubagents = []
    } else {
      if (currentPairResponse) currentPairResponse += "\n"
      currentPairResponse += text
      currentPairToolCalls.push(...extractToolCallsFromMessages([msg]))
      currentPairSubagents.push(...extractSubagentCallsFromMessages([msg]))
    }
  }

  if (
    currentPairUser &&
    (currentPairResponse.trim() ||
      currentPairToolCalls.length > 0 ||
      currentPairSubagents.length > 0)
  ) {
    allPairs.push({
      userInstruction: currentPairUser,
      agentResponse: currentPairResponse,
      toolCalls: currentPairToolCalls,
      subagentCalls: currentPairSubagents,
      complete: lastAssistantFollowedByUser || !!isIdle,
    })
  }

  const pairs = allPairs.filter((p) => p.complete)
  if (pairs.length === 0) return null

  // Rebuild aggregated fields from complete pairs only.
  let userInstruction = ""
  const agentResponseParts: string[] = []
  let hasAssistantResponse = false
  const keptToolCalls: ToolCallRecord[] = []
  const keptSubagentCalls: SubagentCallRecord[] = []

  for (const pair of pairs) {
    if (userInstruction) userInstruction += "\n---\n"
    userInstruction += pair.userInstruction
    if (pair.agentResponse.trim()) {
      agentResponseParts.push(pair.agentResponse.slice(0, MAX_MESSAGE_CHARS))
      hasAssistantResponse = true
    }
    keptToolCalls.push(...pair.toolCalls)
    keptSubagentCalls.push(...pair.subagentCalls)
  }

  if (
    !hasAssistantResponse &&
    keptToolCalls.length === 0 &&
    keptSubagentCalls.length === 0
  )
    return null

  const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : undefined

  const isCompacted = filteredMsgs.some((m) => {
    const parts = Array.isArray(m.parts) ? m.parts : []
    return parts.some(
      (p: Record<string, unknown>) =>
        p.type === "text" &&
        typeof p.text === "string" &&
        isCompressionOutput(p.text),
    )
  })

  return {
    sessionID: evalSessionID,
    agentName,
    userInstruction: userInstruction.slice(-MAX_USER_INSTRUCTION_CHARS),
    agentResponseParts: agentResponseParts.slice(-MAX_MESSAGE_PARTS),
    toolCalls: keptToolCalls.slice(-MAX_TOOL_CALLS_EVAL),
    subagentCalls: keptSubagentCalls,
    pairs: pairs.map((p) => ({
      userInstruction: p.userInstruction.slice(-MAX_USER_INSTRUCTION_CHARS),
      agentResponse: p.agentResponse.slice(0, MAX_MESSAGE_CHARS),
      toolCalls: p.toolCalls,
      subagentCalls: p.subagentCalls,
    })),
    compacted: isCompacted,
    createdAt: Date.now(),
    lastMessageId: lastMsg?.info?.id,
  }
}

export async function manualEvaluateSession(
  sessionID: string,
  ctx: KasperContext,
  agentHint?: string,
  evaluateChildren = true,
): Promise<string> {
  if (!ctx.client.session.messages) {
    return "Session message history is not available for manual evaluation."
  }

  let messages: Awaited<
    ReturnType<NonNullable<typeof ctx.client.session.messages>>
  >
  try {
    messages = await ctx.client.session.messages({ path: { id: sessionID } })
  } catch {
    return `Failed to fetch messages for session "${sessionID}". The session may not exist or may have been deleted.`
  }
  const msgList = messages.data ?? []
  await ctx.logger.log("manual_eval_msgs", {
    sessionID,
    msgCount: msgList.length,
  })

  if (!msgList || msgList.length === 0) {
    return `No messages found for session "${sessionID}".`
  }

  let reEvaluated = false
  let existingWeaknesses: string[] | undefined
  let lastMsgId: string | undefined

  if (ctx.sessionsEvaluated.has(sessionID)) {
    const existingRecord = ctx.stateStore.getSession(sessionID)
    const storedMsgId = existingRecord?.last_msg_id

    if (storedMsgId) {
      const foundIdx = msgList.findIndex((m) => m.info?.id === storedMsgId)
      if (foundIdx === msgList.length - 1) {
        await ctx.logger.log("manual_eval_skip", {
          sessionID,
          reason: "no_new_messages",
        })
        const { emoji, pct } = formatScore(existingRecord.score)
        let msg = `This session has already been evaluated: ${emoji} ${pct}%`
        if (existingRecord.weaknesses.length > 0) {
          msg += `\n\n**Weaknesses:** ${existingRecord.weaknesses.slice(0, 3).join(", ")}`
        }
        msg += `\n\nUse /kasper status for detailed results.`
        return msg
      }
      lastMsgId = storedMsgId
      existingWeaknesses =
        existingRecord.weaknesses.length > 0
          ? existingRecord.weaknesses
          : undefined
    } else {
      const prevCount = ctx.sessionMsgCount.get(sessionID)
      if (prevCount !== undefined && msgList.length === prevCount) {
        await ctx.logger.log("manual_eval_skip", {
          sessionID,
          reason: "already_in_evaluated_set",
        })
        const recent = ctx.stateStore.getRecentSessions(20)
        const existing = recent.find((s) => s.id === sessionID)
        if (existing) {
          const { emoji, pct } = formatScore(existing.score)
          let msg = `This session has already been evaluated: ${emoji} ${pct}%`
          if (existing.weaknesses.length > 0) {
            msg += `\n\n**Weaknesses:** ${existing.weaknesses.slice(0, 3).join(", ")}`
          }
          msg += `\n\nUse /kasper status for detailed results.`
          return msg
        }
        return "This session has already been evaluated. Use /kasper status to view results."
      }
    }
    ctx.sessionsEvaluated.delete(sessionID)
    reEvaluated = true
    await ctx.logger.log("manual_eval_renew", {
      sessionID,
      lastMsgId,
      newCount: msgList.length,
    })
  }

  const segments = detectAgentTransitions(msgList)
  await ctx.logger.log("manual_eval_segments", {
    sessionID,
    segmentCount: segments.length,
    agents: segments.map((s) => s.agentName),
  })

  if (segments.length <= 1) {
    const detectedAgent = segments[0]?.agentName
    const regAgent = ctx.agentRegistry.get(sessionID)?.agentName
    const agentName = detectedAgent || agentHint || regAgent

    await ctx.logger.log("manual_eval_build_eval", {
      sessionID,
      agentName,
      detectedAgent,
      agentHint,
      regAgent,
    })

    // diagnose message structure
    const msgRoles = msgList.map((m, i) => {
      const role = getMsgRole(m) ?? "unknown"
      const parts = Array.isArray(m.parts) ? m.parts : []
      const textTypes = parts.filter(
        (p) => p.type === "text" && typeof p.text === "string",
      )
      const toolUseTypes = parts.filter((p) => p.type === "tool_use")
      const text = textTypes
        .map((p) => (p as { text?: string }).text ?? "")
        .join(" ")
        .slice(0, 80)
      return {
        idx: i,
        role,
        parts: parts.length,
        textTypes: textTypes.length,
        toolUseTypes: toolUseTypes.length,
        textPreview: text,
      }
    })
    await ctx.logger.log("manual_eval_msg_diag", {
      sessionID,
      msgCount: msgList.length,
      msgRoles,
    })

    const agentInfo = ctx.agentRegistry.get(sessionID)
    const minUserMsgs =
      agentInfo?.agentType === "subagent" ? 1 : ctx.config.min_session_messages

    const pending = buildEvalFromMessages(
      msgList,
      sessionID,
      agentName,
      minUserMsgs,
      ctx.registeredCommands,
      lastMsgId,
      true,
    )
    if (!pending && minUserMsgs > 1) {
      // Retry with minUserMsgs=1 so explicit manual eval still scores
      // sessions that have fewer user messages than the auto-poll threshold.
      const fallbackPending = buildEvalFromMessages(
        msgList,
        sessionID,
        agentName,
        1,
        ctx.registeredCommands,
        lastMsgId,
        true,
      )
      if (fallbackPending) {
        await ctx.logger.log("manual_eval_fallback", {
          sessionID,
          agentName,
          originalMin: minUserMsgs,
          fallbackMin: 1,
          userMsgCount: fallbackPending.userInstruction ? 1 : 0,
        })
        const evalOk = await runEvaluation(fallbackPending, ctx)
        if (evalOk) {
          ctx.sessionMsgCount.set(sessionID, msgList.length)
        }
        const recent = ctx.stateStore.getRecentSessions(5)
        const session = recent.find((s) => s.id === sessionID)

        await ctx.logger.log("manual_eval_after_run", {
          sessionID,
          foundInRecent: !!session,
          totalSessionsInStore:
            typeof ctx.stateStore.getTotalSessions === "function"
              ? ctx.stateStore.getTotalSessions()
              : undefined,
          reEvaluated,
          fallback: true,
        })

        if (session) {
          const { emoji, pct } = formatScore(session.score)
          let msg = `Session scored: ${emoji} ${pct}%`
          if (session.weaknesses.length > 0) {
            msg += `\n\n**Weaknesses:** ${session.weaknesses.slice(0, 3).join(", ")}`
          }
          msg += `\n\n*Note: This session only had 1 user message, so the usual threshold (${minUserMsgs}) was bypassed for manual evaluation.*`
          return msg
        }
        return "Session scored successfully."
      }
    }
    if (!pending) {
      const diag = {
        sessionID,
        agentName,
        msgCount: msgList.length,
        roles: msgRoles
          .map(
            (r) =>
              `${r.idx}:${r.role}(text=${r.textTypes},tool=${r.toolUseTypes})`,
          )
          .join("|"),
      }
      await ctx.logger.log("manual_eval_no_pending", diag)
      return `No user messages found in session "${sessionID}".`
    }
    if (existingWeaknesses) {
      pending.existingWeaknesses = existingWeaknesses
    }

    if (agentInfo) {
      pending.agentType = agentInfo.agentType
      pending.parentSessionID = agentInfo.parentSessionID
    } else if (!agentName) {
      pending.agentType = "primary"
    }

    await ctx.logger.log("manual_eval_pending", {
      sessionID,
      agentName,
      userInstructionLen: pending.userInstruction.length,
      responseParts: pending.agentResponseParts.length,
      toolCalls: pending.toolCalls.length,
      pairs: pending.pairs.length,
    })

    const evalOk = await runEvaluation(pending, ctx)
    if (evalOk) {
      ctx.sessionMsgCount.set(sessionID, msgList.length)
    }
    const recent = ctx.stateStore.getRecentSessions(5)
    const session = recent.find((s) => s.id === sessionID)

    await ctx.logger.log("manual_eval_after_run", {
      sessionID,
      foundInRecent: !!session,
      totalSessionsInStore:
        typeof ctx.stateStore.getTotalSessions === "function"
          ? ctx.stateStore.getTotalSessions()
          : undefined,
      recentIDs: recent.map((s) => s.id),
    })

    let msg: string
    if (session) {
      const scorePct = (session.score * 100).toFixed(0)
      const { emoji: scoreEmoji } = formatScore(session.score)
      msg = `${reEvaluated ? "Re-evaluated" : "Manual evaluation for"} session "${sessionID}": ${scoreEmoji} ${scorePct}%`
      if (reEvaluated) msg += ` (${msgList.length} messages)`
      if (session.weaknesses.length > 0) {
        msg += `\n\n**Weaknesses:** ${session.weaknesses.slice(0, 3).join(", ")}`
      }
    } else {
      msg = `Manual evaluation triggered for session "${sessionID}". Check /kasper status for results.`
    }

    if (evaluateChildren) {
      const childResults = await evaluateChildSessions(sessionID, ctx, 0)
      if (childResults.length > 0) {
        msg += `\n\n### Subagent Sessions`
        for (const child of childResults) {
          msg += `\n- ${child.id.slice(0, 8)}: ${child.result}`
        }
      }
    }

    return msg
  }

  for (const seg of segments) {
    const agentName = seg.agentName || "default"
    const evalKey = `${sessionID}|agent:${agentName}`

    if (ctx.sessionsEvaluated.has(evalKey)) continue

    const agentInfo = ctx.agentRegistry.get(sessionID)
    const minUserMsgs =
      agentInfo?.agentType === "subagent" ? 1 : ctx.config.min_session_messages

    const pending = buildEvalFromMessages(
      seg.msgs,
      evalKey,
      seg.agentName,
      minUserMsgs,
      ctx.registeredCommands,
      undefined,
      true,
    )
    if (!pending) continue
    if (agentInfo) {
      pending.agentType = agentInfo.agentType
      pending.parentSessionID = agentInfo.parentSessionID
    }

    await runEvaluation(pending, ctx)
  }

  ctx.sessionsEvaluated.add(sessionID)
  ctx.sessionMsgCount.set(sessionID, msgList.length)

  const allSessions = ctx.stateStore.getRecentSessions(200)
  const lines: string[] = [
    reEvaluated
      ? `## Re-evaluated Session (${msgList.length} messages)`
      : `## Per-Agent Evaluation for Session`,
    ``,
  ]
  for (const seg of segments) {
    const agentName = seg.agentName || "default"
    const evalKey = `${sessionID}|agent:${agentName}`
    const record = allSessions.find((s) => s.id === evalKey)
    if (record) {
      const scorePct = (record.score * 100).toFixed(0)
      const { emoji: scoreEmoji } = formatScore(record.score)
      lines.push(
        `**${seg.agentName || "default"}**: ${scoreEmoji} ${scorePct}%`,
      )
      if (record.weaknesses.length > 0) {
        for (const w of record.weaknesses.slice(0, 2)) {
          lines.push(`  - ${w}`)
        }
      }
    } else {
      lines.push(`**${seg.agentName || "default"}**: (not evaluated)`)
    }
  }
  lines.push(``, `Use /kasper status for detailed results.`)

  if (evaluateChildren) {
    const childResults = await evaluateChildSessions(sessionID, ctx, 0)
    if (childResults.length > 0) {
      lines.push(``, `### Subagent Sessions`)
      for (const child of childResults) {
        lines.push(`- ${child.id.slice(0, 8)}: ${child.result}`)
      }
    }
  }

  return lines.join("\n")
}

export async function evaluateChildSessions(
  parentID: string,
  ctx: KasperContext,
  depth: number,
  maxDepth = 3,
): Promise<Array<{ id: string; result: string }>> {
  if (depth >= maxDepth) return []

  const childIDs = new Set<string>()
  const childAgentHints = new Map<string, string>()

  const runtimeChildren = ctx.parentToChildren.get(parentID)
  if (runtimeChildren) {
    for (const cid of runtimeChildren) {
      if (!ctx.deletedSessions.has(cid)) childIDs.add(cid)
    }
  }

  if (ctx.client.session.list) {
    try {
      const all = await ctx.client.session.list()
      if (all.data) {
        for (const s of all.data) {
          if (
            s.parentID === parentID &&
            s.title &&
            !isKasperSession(s.title) &&
            !ctx.kasperSessionIDs.has(s.id)
          ) {
            if (!ctx.deletedSessions.has(s.id)) {
              childIDs.add(s.id)
              const agent = s.agent || s.agentName || s.subagent_type
              if (agent) childAgentHints.set(s.id, agent)
              if (!ctx.agentRegistry.has(s.id)) {
                ctx.agentRegistry.set(s.id, {
                  agentName: agent || s.id.slice(0, 8),
                  agentType: "subagent",
                  parentSessionID: parentID,
                })
              }
            }
          }
        }
      }
    } catch {}
  }

  const results: Array<{ id: string; result: string }> = []
  for (const cid of childIDs) {
    if (ctx.sessionsEvaluated.has(cid)) {
      results.push({ id: cid, result: "already evaluated" })
      continue
    }
    try {
      const childResult = await manualEvaluateSession(
        cid,
        ctx,
        childAgentHints.get(cid),
      )
      if (
        childResult.startsWith("No user messages") ||
        childResult.startsWith("No messages") ||
        childResult.startsWith("Session message history") ||
        childResult.startsWith("Failed to fetch")
      ) {
        continue
      }
      if (/\b0%/.test(childResult.split("\n")[0] ?? "")) {
        continue
      }
      results.push({
        id: cid,
        result:
          childResult
            .split("\n")[0]
            ?.replace(/^Manual evaluation for session "[^"]+": /, "") ??
          "scored",
      })
      const deeper = await evaluateChildSessions(cid, ctx, depth + 1, maxDepth)
      results.push(...deeper)
    } catch {
      results.push({ id: cid, result: "evaluation failed" })
    }
  }
  return results
}

export async function batchEvaluateSessions(
  sessionIDs: string[],
  ctx: KasperContext,
  agentHints?: Map<string, string>,
): Promise<string> {
  const results: Array<{ id: string; status: string; detail: string }> = []
  await ctx.logger.log("batch_evaluate_start", {
    totalIDs: sessionIDs.length,
  })
  let idx = 0
  for (const id of sessionIDs) {
    idx++
    if (idx % 100 === 0 || idx === 1 || idx === sessionIDs.length) {
      await ctx.logger.log("batch_evaluate_progress", {
        index: idx,
        total: sessionIDs.length,
        sessionID: id,
      })
    }
    let result: string
    try {
      result = await manualEvaluateSession(id, ctx, agentHints?.get(id), false)
    } catch (err) {
      await ctx.logger.log("batch_eval_error", {
        sessionID: id,
        error: String(err),
      })
      results.push({ id, status: "error", detail: String(err) })
      continue
    }
    if (result.startsWith("Manual evaluation")) {
      const scoreMatch = result.match(/(\d+)%/)
      const score = scoreMatch ? parseInt(scoreMatch[1], 10) : -1
      if (score <= 0) {
        results.push({ id, status: "skipped", detail: `empty session (0%)` })
        await ctx.logger.log("batch_eval_result", {
          sessionID: id,
          status: "skipped_empty",
          result: result.slice(0, 120),
        })
      } else {
        results.push({ id, status: "ok", detail: result })
        await ctx.logger.log("batch_eval_result", {
          sessionID: id,
          status: "ok",
          score,
        })
      }
    } else if (
      result.startsWith("Failed to fetch") ||
      result.startsWith("No messages") ||
      result.startsWith("No user messages")
    ) {
      results.push({ id, status: "skipped", detail: "no evaluable content" })
      await ctx.logger.log("batch_eval_result", {
        sessionID: id,
        status: "skipped_no_content",
        result: result.slice(0, 120),
      })
    } else if (result.startsWith("This session has already")) {
      results.push({ id, status: "skipped", detail: "already evaluated" })
      await ctx.logger.log("batch_eval_result", {
        sessionID: id,
        status: "skipped_already_eval",
      })
    } else {
      results.push({ id, status: "ok", detail: result })
      await ctx.logger.log("batch_eval_result", {
        sessionID: id,
        status: "ok_fallback",
        result: result.slice(0, 120),
      })
    }
  }

  const ok = results.filter((r) => r.status === "ok")
  const skipped = results.filter((r) => r.status === "skipped")
  const errors = results.filter((r) => r.status === "error")

  const aggAfter = ctx.stateStore.getAggregate()
  await ctx.logger.log("batch_evaluate_done", {
    totalInput: sessionIDs.length,
    ok: ok.length,
    skipped: skipped.length,
    errors: errors.length,
    sessionsEvaluated: ctx.sessionsEvaluated.size,
    aggregateTotalSessions: aggAfter.total_sessions,
    aggregateAvgScore: aggAfter.avg_score,
  })

  const lines: string[] = []
  if (ok.length > 0) {
    lines.push(`## Batch Evaluation — ${ok.length} session(s) evaluated`)
    for (const r of ok) {
      lines.push(``, `${r.detail}`)
    }
  }
  if (skipped.length > 0) {
    const emptyCount = skipped.filter(
      (r) =>
        r.detail === "no evaluable content" ||
        r.detail.startsWith("empty session"),
    ).length
    const dupeCount = skipped.filter(
      (r) => r.detail === "already evaluated",
    ).length
    const parts: string[] = []
    if (emptyCount > 0) parts.push(`${emptyCount} empty/no-content`)
    if (dupeCount > 0) parts.push(`${dupeCount} already evaluated`)
    lines.push(
      ``,
      `**Skipped**: ${skipped.length} session(s) (${parts.join(", ")})`,
    )
  }
  if (errors.length > 0) {
    lines.push(``, `**Errors**:`)
    for (const r of errors) {
      lines.push(`- ${r.id}: ${r.detail}`)
    }
  }
  return lines.join("\n")
}

async function queueImprovement(
  target: "agents_md" | "agent_prompt",
  agentName: string | undefined,
  reason: string,
  ctx: KasperContext,
  sessionID: string,
  weaknesses: string[],
): Promise<void> {
  if (ctx.improvementsPending.length >= MAX_PENDING_IMPROVEMENTS) {
    ctx.improvementsPending.shift()
  }
  ctx.improvementsPending.push({
    id: randomUUID(),
    timestamp: Date.now(),
    target,
    agent_name: agentName,
    agents_md_diff: reason,
    reason,
    backup_path: "",
    weaknesses,
  })
  await ctx.logger.log("improvement_pending", {
    sessionID,
    target,
    agentName,
    reason: reason.slice(0, 100),
  })
  if (!ctx.config.quiet) {
    showToast(
      ctx.client,
      "Kasper",
      target === "agent_prompt"
        ? `Improvement suggestion available for ${agentName}. /kasper pending to review, /kasper apply to accept.`
        : `Improvement suggestion available. /kasper pending to review, /kasper apply to accept.`,
      "info",
      6000,
    )
  }
}

async function shouldRerouteBuiltinAgentPrompt(
  agentName: string,
  ctx: KasperContext,
): Promise<boolean> {
  if (!isBuiltinAgentName(agentName)) return false
  const source = await ctx.agentPrompts.resolve(agentName)
  return source.kind === "missing"
}

async function applyAgentPromptImprovement(
  updateText: string,
  weaknesses: string[],
  ctx: KasperContext,
  _config: KasperConfig,
  pending: PendingEval,
): Promise<void> {
  const agentName = pending.agentName
  if (!agentName) return

  // Built-in opencode agents (build, plan, general, ...) have hard-coded
  // prompts shipped with opencode. `.opencode/agents/<name>.md` is only
  // consulted when `agent.<name>.prompt` in `opencode.json` is set to a
  // `{file:...}` directive or inline string. If a built-in agent has no
  // defined prompt, creating a markdown file at the conventional path
  // produces a dead file that opencode never reads. Reroute the
  // improvement to AGENTS.md in that case — built-in agents always
  // honour the project rules file.
  if (await shouldRerouteBuiltinAgentPrompt(agentName, ctx)) {
    if (pending.agentType === "subagent") {
      // Subagent sessions must not write to AGENTS.md. Drop the
      // improvement rather than silently write a project-wide rule
      // that came from a subagent's local view.
      await ctx.logger.log("improvement_reroute_dropped_subagent", {
        sessionID: pending.sessionID,
        agentName,
        reason: "built-in subagent with no defined prompt",
      })
      return
    }
    await ctx.logger.log("improvement_rerouted_to_agents_md", {
      sessionID: pending.sessionID,
      agentName,
      reason: "built-in agent has no defined prompt",
    })
    await applyAgentsMdImprovement(
      updateText,
      weaknesses,
      ctx,
      _config,
      pending,
    )
    return
  }

  if (_config.strict_sanitize) {
    const result = sanitizeImprovementText(updateText)
    if (!result.safe) {
      await ctx.logger.log("improvement_rejected_sanitize", {
        sessionID: pending.sessionID,
        target: "agent_prompt",
        agentName,
        rejections: result.rejections,
        textPreview: updateText.slice(0, 100),
      })
      showToast(
        ctx.client,
        "Kasper",
        `Improvement for ${agentName} rejected: contains ${result.rejections.join(", ")}`,
        "warning",
        6000,
      )
      return
    }
  }

  if (!isValidGuidanceText(updateText)) {
    await ctx.logger.log("improvement_rejected_invalid", {
      sessionID: pending.sessionID,
      agentName,
      textPreview: updateText.slice(0, 100),
    })
    return
  }

  const budgetMax = ctx.stateStore.getImprovementBudget?.()
  if (budgetMax && updateText.length > budgetMax) {
    await ctx.logger.log("improvement_skipped_budget", {
      sessionID: pending.sessionID,
      agentName,
      textLen: updateText.length,
      budgetMax,
    })
    showToast(
      ctx.client,
      "Kasper",
      `Improvement for ${agentName} skipped: exceeds guidance budget (${updateText.length} > ${budgetMax} chars)`,
      "warning",
      6000,
    )
    return
  }

  const existingPrompt = await ctx.agentPrompts.read(agentName)
  const dupeResult = checkImprovementDuplicate(updateText, existingPrompt)
  if (dupeResult) {
    await ctx.logger.log("improvement_skipped_duplicate", {
      sessionID: pending.sessionID,
      agentName,
      reason: dupeResult,
    })
    return
  }

  await ctx.agentPrompts.injectSection(
    agentName,
    "Kasper Inferred Instructions",
    updateText,
    BACKUP_ENABLED,
    BACKUP_MAX_VERSIONS,
    "subagent",
    _config.agent_prompt_inject_mode,
  )
  ctx.stateStore.recordImprovement({
    id: randomUUID(),
    timestamp: Date.now(),
    target: "agent_prompt",
    agent_name: agentName,
    agents_md_diff: `Added instructions to ${agentName} agent prompt`,
    reason: updateText,
    backup_path: "",
    score_before:
      (typeof ctx.stateStore.getAgentAggregate === "function"
        ? ctx.stateStore.getAgentAggregate(agentName)?.avg_score
        : undefined) ?? 0,
    weaknesses,
  })
  ctx.stateStore.resetWeaknessCounts(weaknesses)
  const agentNameVal = pending.agentName
  await ctx.logger.log("improvement_applied", {
    sessionID: pending.sessionID,
    target: "agent_prompt",
    agentName: agentNameVal,
    reason: updateText.slice(0, 100),
  })
  showToast(
    ctx.client,
    "Kasper",
    `${agentNameVal} prompt updated — restore from .opencode/kasper/backups/ if needed`,
    "success",
    12000,
  )
}

async function applyAgentsMdImprovement(
  updateText: string,
  weaknesses: string[],
  ctx: KasperContext,
  _config: KasperConfig,
  pending: PendingEval,
): Promise<void> {
  if (_config.strict_sanitize) {
    const result = sanitizeImprovementText(updateText)
    if (!result.safe) {
      await ctx.logger.log("improvement_rejected_sanitize", {
        sessionID: pending.sessionID,
        target: "agents_md",
        rejections: result.rejections,
        textPreview: updateText.slice(0, 100),
      })
      showToast(
        ctx.client,
        "Kasper",
        `AGENTS.md improvement rejected: contains ${result.rejections.join(", ")}`,
        "warning",
        6000,
      )
      return
    }
  }

  if (!isValidGuidanceText(updateText)) {
    await ctx.logger.log("improvement_rejected_invalid", {
      sessionID: pending.sessionID,
      textPreview: updateText.slice(0, 100),
    })
    return
  }

  const budgetMax = ctx.stateStore.getImprovementBudget?.()
  if (budgetMax && updateText.length > budgetMax) {
    await ctx.logger.log("improvement_skipped_budget", {
      sessionID: pending.sessionID,
      target: "agents_md",
      textLen: updateText.length,
      budgetMax,
    })
    showToast(
      ctx.client,
      "Kasper",
      `AGENTS.md improvement skipped: exceeds guidance budget (${updateText.length} > ${budgetMax} chars)`,
      "warning",
      6000,
    )
    return
  }

  const existingContent = await ctx.agentsMd.read()
  const dupeResult = checkImprovementDuplicate(updateText, existingContent)
  if (dupeResult) {
    await ctx.logger.log("improvement_skipped_duplicate", {
      sessionID: pending.sessionID,
      reason: dupeResult,
    })
    return
  }

  let backupPath = ""
  await ctx.agentsMd.lockedUpdate(async (existing) => {
    if (BACKUP_ENABLED) {
      backupPath = await ctx.agentsMd.backup("pre-improvement")
    }
    const sectionName = "Kasper Inferred Instructions"
    const updated = ctx.agentsMd.injectSection(
      existing,
      sectionName,
      updateText,
    )
    return updated
  })
  const reasonText = updateText
  ctx.stateStore.recordImprovement({
    id: randomUUID(),
    timestamp: Date.now(),
    target: "agents_md",
    agent_name: pending.agentName,
    agents_md_diff: `Added instructions to "Kasper Inferred Instructions" section`,
    reason: reasonText,
    backup_path: backupPath,
    score_before: ctx.stateStore.getAggregate().avg_score,
    weaknesses,
  })
  ctx.stateStore.resetWeaknessCounts(weaknesses)
  await ctx.logger.log("improvement_applied", {
    sessionID: pending.sessionID,
    reason: updateText.slice(0, 100),
    backupPath,
  })
  showToast(
    ctx.client,
    "Kasper",
    `AGENTS.md updated — restore from .opencode/kasper/backups/ if needed`,
    "success",
    12000,
  )
}

function checkImprovementDuplicate(
  newText: string,
  existingTarget: string,
): string | false {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim()
  const newNorm = norm(newText)
  if (!newNorm || newNorm.length < 10) return "text too short"

  const existingNorm = norm(existingTarget)
  if (existingNorm.includes(newNorm)) return "already present verbatim"

  const newSentences = newNorm.split(/[.!?]\s*/).filter((s) => s.length > 10)
  for (const sentence of newSentences) {
    if (existingNorm.includes(sentence)) return "sentence already present"
  }

  const newWords = new Set(newNorm.split(/\s+/).filter((w) => w.length > 3))
  if (newWords.size === 0) return "no substantial content"

  const existingWords = new Set(
    existingNorm.split(/\s+/).filter((w) => w.length > 3),
  )
  let overlap = 0
  for (const w of newWords) {
    if (existingWords.has(w)) overlap++
  }
  if (newWords.size > 0 && overlap / newWords.size > 0.8) {
    return "too similar to existing content"
  }

  return false
}

export async function considerImprovement(
  card: ScoreCard,
  ctx: KasperContext,
  config: KasperConfig,
  pending: PendingEval,
): Promise<void> {
  // Use weakness_suggestions as the primary source (LLM prompt instructs
  // the model to populate this and leave deprecated fields empty).
  // Fall back to deprecated fields only for backward compatibility.
  const suggestions = card.weakness_suggestions ?? []
  const agentPromptSuggestions = suggestions
    .filter((s) => s.target === "agent_prompt" && s.suggested_fix)
    .map((s) => s.suggested_fix)
  const agentsMdSuggestions = suggestions
    .filter((s) => s.target === "agents_md" && s.suggested_fix)
    .map((s) => s.suggested_fix)

  const agentPromptUpdate =
    agentPromptSuggestions.length > 0
      ? agentPromptSuggestions.join("\n\n")
      : card.suggested_agent_prompt_update
  const agentsMdUpdate =
    agentsMdSuggestions.length > 0
      ? agentsMdSuggestions.join("\n\n")
      : card.suggested_agents_md_update

  if (!agentPromptUpdate && !agentsMdUpdate) return

  const nonRejectedWeaknesses = card.weaknesses.filter((weakness) => {
    for (const rejected of ctx.rejectedPatterns) {
      if (weaknessesMergeable(weakness, rejected)) {
        ctx.logger.log("improvement_rejected_cached", {
          sessionID: pending.sessionID,
          weakness,
          matched_rejected: rejected,
        })
        return false
      }
    }
    return true
  })

  if (nonRejectedWeaknesses.length === 0) return

  const agg = ctx.stateStore.getAggregate()
  const matchingWeakness = findMatchingWeakness(
    nonRejectedWeaknesses,
    agg.top_weaknesses,
    config.min_observations_for_update,
  )

  if (!matchingWeakness) return

  const isAuto = config.auto_update || ctx.autoUpdateEnabled

  const hasAgentPrompt = !!agentPromptUpdate && !!pending.agentName
  const hasAgentsMd = !!agentsMdUpdate && pending.agentType !== "subagent"

  // Reroute: built-in opencode agents with no defined prompt cannot
  // accept a per-agent file write (the file would be a dead drop).
  // The auto path handles this inside applyAgentPromptImprovement.
  // The non-auto path queues the text as an agents_md improvement.
  const rerouteToAgentsMd =
    hasAgentPrompt &&
    !!pending.agentName &&
    pending.agentType !== "subagent" &&
    (await shouldRerouteBuiltinAgentPrompt(pending.agentName, ctx))

  // Prefer local agent/subagent prompt over global AGENTS.md
  if (isAuto) {
    if (hasAgentPrompt) {
      await applyAgentPromptImprovement(
        agentPromptUpdate,
        card.weaknesses,
        ctx,
        config,
        pending,
      )
      return
    }
    if (hasAgentsMd) {
      await applyAgentsMdImprovement(
        agentsMdUpdate,
        card.weaknesses,
        ctx,
        config,
        pending,
      )
    }
    return
  }

  // Non-auto: queue improvements
  if (hasAgentPrompt && !rerouteToAgentsMd) {
    await queueImprovement(
      "agent_prompt",
      pending.agentName,
      agentPromptUpdate,
      ctx,
      pending.sessionID,
      card.weaknesses,
    )
  } else if (rerouteToAgentsMd && agentPromptUpdate) {
    await queueImprovement(
      "agents_md",
      pending.agentName,
      agentPromptUpdate,
      ctx,
      pending.sessionID,
      card.weaknesses,
    )
  }
  if (hasAgentsMd) {
    await queueImprovement(
      "agents_md",
      pending.agentName,
      agentsMdUpdate,
      ctx,
      pending.sessionID,
      card.weaknesses,
    )
  }
}
