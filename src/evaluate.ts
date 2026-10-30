import { createHash, randomUUID } from "node:crypto"
import {
  BACKUP_ENABLED,
  BACKUP_MAX_VERSIONS,
  isBuiltinAgentName,
  MAX_EVALUATED_SESSION_SET,
  MAX_MESSAGE_CHARS,
  MAX_PENDING_IMPROVEMENTS,
  MAX_TOOL_CALLS_EVAL,
  MAX_USER_INSTRUCTION_CHARS,
} from "./constants.js"
import type { V1HistoryMessage } from "./history.js"
import {
  completedHistoryTurns,
  historySegments,
  normalizeV1History,
  pendingFromHistoryTurns,
} from "./history.js"
import type { ScorerInput } from "./scorer.js"
import type {
  KasperConfig,
  KasperContext,
  PendingEval,
  ScoreCard,
} from "./types.js"
import {
  findMatchingWeakness,
  formatScore,
  isKasperSession,
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
  const sourceID = pending.sourceSessionID ?? pending.sessionID
  pending.lifecycleRevision ??= ctx.runtime?.capture(sourceID)
  pending.evaluationSignal ??= ctx.runtime?.sessionSignal(sourceID)
  const current = () =>
    !ctx.deletedSessions.has(sourceID) &&
    !ctx.lifetimeSignal?.aborted &&
    (!pending.lifecycleRevision ||
      !ctx.runtime ||
      ctx.runtime.isCurrent(sourceID, pending.lifecycleRevision))
  let scoreRecorded = false
  return ctx.evalMutex
    .runExclusive(async () => {
      if (!current()) return false
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
            userGuidance: ctx.userGuidance.get(sourceID) ?? undefined,
            compacted: pending.compacted,
            agentsMdChanged,
            existingWeaknesses: pending.existingWeaknesses,
          }
          try {
            const evaluate = ctx.scorer.evaluate.bind(ctx.scorer) as (
              ...args: [
                ...Parameters<typeof ctx.scorer.evaluate>,
                { signal?: AbortSignal }?,
              ]
            ) => ReturnType<typeof ctx.scorer.evaluate>
            const pc = await evaluate(
              { ...pairInput, sessionID: sourceID },
              ctx.client,
              { signal: pending.evaluationSignal },
            )
            pc.agent_prompt_hash = agentPromptHash
            pc.agents_md_hash = agentsMdHash
            if (pc.fallback || !Number.isFinite(pc.overall_score)) return false
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
            return false
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
          userGuidance: ctx.userGuidance.get(sourceID) ?? undefined,
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

        const evaluate = ctx.scorer.evaluate.bind(ctx.scorer) as (
          ...args: [
            ...Parameters<typeof ctx.scorer.evaluate>,
            { signal?: AbortSignal }?,
          ]
        ) => ReturnType<typeof ctx.scorer.evaluate>
        card = await evaluate(
          { ...scoreInput, sessionID: sourceID },
          ctx.client,
          { signal: pending.evaluationSignal },
        )
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

      if (card.fallback || !Number.isFinite(card.overall_score)) {
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
          reason: card.weaknesses[0] ?? "invalid_score",
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

      if (!current()) return false
      card.session_id = pending.sessionID
      const previousRecord = ctx.stateStore.getSession?.(pending.sessionID)
      ctx.stateStore.recordSession(
        pending.sessionID,
        pending.userInstruction.slice(0, 100),
        card,
        pending.agentName,
        pending.agentType,
        pending.parentSessionID,
        pending.lastMessageId,
        Date.now(),
        sourceID,
      )

      try {
        await ctx.stateStore.flush?.({
          strict: true,
          assertCurrent: evaluationGuard(pending, ctx),
        })
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            error.message === "State commit cancelled by an external reset"
          )
        )
          ctx.stateStore.restoreSessionAfterFailedCommit?.(
            pending.sessionID,
            previousRecord,
            card,
          )
        await ctx.logger.log("evaluation_persistence_failed", {
          sessionID: pending.sessionID,
          error: String(error),
        })
        return false
      }
      if (!current()) return false
      scoreRecorded = true
      ctx.sessionsEvaluated.add(pending.sessionID)
      ctx.stateStore.addEvaluatedSession?.(pending.sessionID)
      if (ctx.sessionsEvaluated.size > MAX_EVALUATED_SESSION_SET) {
        const toRemove = [...ctx.sessionsEvaluated].slice(
          0,
          ctx.sessionsEvaluated.size - MAX_EVALUATED_SESSION_SET,
        )
        for (const id of toRemove) ctx.sessionsEvaluated.delete(id)
      }

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
          await ctx.stateStore.mergeAllWeaknesses(ctx.scorer, ctx.client, {
            signal: pending.evaluationSignal,
            assertCurrent: evaluationGuard(pending, ctx),
          })
        } finally {
          ctx.isMergingWeaknesses = false
        }
      }

      if (!current()) return scoreRecorded

      const expired = ctx.stateStore.expireOldImprovements?.() ?? 0
      if (expired > 0) {
        await ctx.logger.log("improvements_expired", { count: expired })
      }

      closePendingScoreDeltas(ctx)

      ctx.logger.trim().catch(() => {})

      if (current() && card.overall_score < config.scoring_threshold) {
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
      await ctx.logger
        .log("run_eval_error", {
          sessionID: pending.sessionID,
          error: String(err),
          scoreRecorded,
        })
        .catch(() => {})
      // Optional merging, feedback and logging failures do not undo an accepted score.
      return scoreRecorded
    })
}

export function buildEvalFromMessages(
  msgs: V1HistoryMessage[],
  evalSessionID: string,
  agentName: string | undefined,
  minUserMessages = 0,
  registeredCommands = new Set<string>(),
  lastMsgId?: string,
  isIdle?: boolean,
): PendingEval | null {
  return pendingFromHistoryTurns(
    completedHistoryTurns(
      normalizeV1History(msgs),
      registeredCommands,
      lastMsgId,
      isIdle,
    ),
    evalSessionID,
    agentName,
    minUserMessages,
  )
}

export type EvaluationOutcome = {
  sessionID: string
  status: "scored" | "skipped" | "failed" | "cancelled"
  reason:
    | "scored"
    | "already_evaluated"
    | "no_content"
    | "incomplete"
    | "checkpoint_missing"
    | "history_unavailable"
    | "fetch_failed"
    | "judge_failed"
    | "owned_session"
    | "deleted_session"
    | "cancelled"
  detail: string
  scoredKeys: string[]
}

/** Machine-readable outcomes are shared by manual commands, child traversal and batch scoring. */
export async function evaluateSession(
  sessionID: string,
  ctx: KasperContext,
  agentHint?: string,
  options: { minimumUserMessages?: number } = {},
): Promise<EvaluationOutcome> {
  const revision = ctx.runtime?.capture(sessionID)
  const current = () =>
    !ctx.lifetimeSignal?.aborted &&
    !ctx.deletedSessions.has(sessionID) &&
    (!revision || !ctx.runtime || ctx.runtime.isCurrent(sessionID, revision))
  const outcome = (
    status: EvaluationOutcome["status"],
    reason: EvaluationOutcome["reason"],
    detail: string,
    scoredKeys: string[] = [],
  ): EvaluationOutcome => ({ sessionID, status, reason, detail, scoredKeys })
  if (ctx.deletedSessions.has(sessionID))
    return outcome(
      "skipped",
      "deleted_session",
      "This session has been deleted.",
    )
  if (ctx.kasperSessionIDs.has(sessionID))
    return outcome(
      "skipped",
      "owned_session",
      "Kasper's own sessions are excluded from evaluation.",
    )
  if (!ctx.client.session.messages)
    return outcome(
      "failed",
      "history_unavailable",
      "Session message history is not available for manual evaluation.",
    )

  let raw: V1HistoryMessage[]
  try {
    const response = await ctx.client.session.messages({
      path: { id: sessionID },
    })
    if (!response.data)
      return outcome(
        "failed",
        "fetch_failed",
        `Failed to fetch messages for session "${sessionID}".`,
      )
    raw = response.data
  } catch {
    return outcome(
      "failed",
      "fetch_failed",
      `Failed to fetch messages for session "${sessionID}". The session may not exist or may have been deleted.`,
    )
  }
  if (raw.length === 0)
    return outcome(
      "skipped",
      "no_content",
      `No messages found for session "${sessionID}".`,
    )
  if (!current())
    return outcome(
      "cancelled",
      "cancelled",
      "Evaluation cancelled by a lifecycle change.",
    )
  const history = normalizeV1History(raw)
  const parentRecord = ctx.stateStore.getSession(sessionID)
  if (
    parentRecord?.last_msg_id &&
    !history.some((m) => m.id === parentRecord.last_msg_id)
  ) {
    return outcome(
      "failed",
      "checkpoint_missing",
      `The saved checkpoint for session "${sessionID}" is absent from history; evaluation was not replayed.`,
    )
  }
  const isIdle = ctx.idleSessions?.has(sessionID) ?? false
  const complete = completedHistoryTurns(
    history,
    ctx.registeredCommands,
    undefined,
    isIdle,
  )
  const registry = ctx.agentRegistry.get(sessionID)
  if (complete.length < (options.minimumUserMessages ?? 1))
    return outcome(
      "skipped",
      "incomplete",
      "Not enough completed user messages for automatic evaluation.",
    )
  const segments = historySegments(complete, agentHint ?? registry?.agentName)
  if (segments.length === 0)
    return outcome(
      "skipped",
      "incomplete",
      `No complete user/assistant pairs found in session "${sessionID}".`,
    )

  const multiAgent = segments.length > 1
  const scoredKeys: string[] = []
  const summaries: string[] = []
  let failed = false
  let renewed = false
  for (const [index, segment] of segments.entries()) {
    // Stable start IDs distinguish A-B-A and let extensions update the same segment record.
    if (multiAgent && !segment.firstMessageId)
      return outcome(
        "failed",
        "history_unavailable",
        "Agent ranges require durable message IDs.",
      )
    const key =
      multiAgent && !(index === 0 && parentRecord)
        ? `${sessionID}|agent:${encodeURIComponent(segment.agentName ?? "default")}|from:${segment.firstMessageId}`
        : sessionID
    const previous = ctx.stateStore.getSession(key)
    let turns = segment.turns
    if (previous?.last_msg_id) {
      const ids = segment.turns.flatMap((t) => t.assistants.map((m) => m.id))
      const cursor = ids.indexOf(previous.last_msg_id)
      if (cursor < 0)
        return outcome(
          "failed",
          "checkpoint_missing",
          `The saved checkpoint for session "${sessionID}" is absent from history; evaluation was not replayed.`,
        )
      const remaining = new Set(ids.slice(cursor + 1))
      turns = segment.turns
        .map((t) => ({
          ...t,
          assistants: t.assistants.filter((m) => remaining.has(m.id)),
        }))
        .filter((t) => t.assistants.length > 0)
      if (turns.length === 0) {
        const { emoji, pct } = formatScore(previous.score)
        summaries.push(
          `**${segment.agentName ?? "default"}**: ${emoji} ${pct}% (already evaluated)`,
        )
        if (previous.weaknesses.length)
          summaries.push(`  - ${previous.weaknesses.slice(0, 3).join(", ")}`)
        continue
      }
      renewed = true
    } else if (ctx.sessionsEvaluated.has(key)) {
      // Historical pre-checkpoint records cannot establish which content was consumed.
      return outcome(
        "failed",
        "checkpoint_missing",
        `Session "${sessionID}" has an evaluation without a saved checkpoint; evaluation was not replayed.`,
      )
    }
    const pending = pendingFromHistoryTurns(turns, key, segment.agentName, 1)
    if (!pending) continue
    pending.sourceSessionID = sessionID
    pending.lifecycleRevision = revision
    pending.evaluationSignal = ctx.runtime?.sessionSignal(sessionID)
    pending.agentType = registry?.agentType ?? "primary"
    pending.parentSessionID = registry?.parentSessionID
    if (previous?.weaknesses.length)
      pending.existingWeaknesses = previous.weaknesses
    ctx.sessionsEvaluated.delete(key)
    if (!(await runEvaluation(pending, ctx))) {
      if (!current())
        return outcome(
          "cancelled",
          "cancelled",
          "Evaluation cancelled by a lifecycle change.",
          scoredKeys,
        )
      // A concurrent action may have committed this exact range while we waited for the mutex.
      const concurrent = ctx.stateStore.getSession(key)
      if (
        concurrent?.last_msg_id === pending.lastMessageId &&
        ctx.sessionsEvaluated.has(key)
      ) {
        summaries.push(
          `**${segment.agentName ?? "default"}**: already evaluated`,
        )
        continue
      }
      failed = true
      summaries.push(`**${segment.agentName ?? "default"}**: evaluation failed`)
      // Do not run later ranges after a failed range: no checkpoint can skip it.
      break
    }
    scoredKeys.push(key)
    const record =
      ctx.stateStore.getSession(key) ??
      ctx.stateStore.getRecentSessions(200).find((s) => s.id === key)
    const label = record
      ? `${formatScore(record.score).emoji} ${formatScore(record.score).pct}%`
      : "scored"
    summaries.push(`**${segment.agentName ?? "default"}**: ${label}`)
    if (record?.weaknesses.length)
      summaries.push(`  - ${record.weaknesses.slice(0, 3).join(", ")}`)
  }

  if (failed)
    return outcome(
      "failed",
      "judge_failed",
      `Evaluation failed for session "${sessionID}".\n${summaries.join("\n")}`,
      scoredKeys,
    )
  if (scoredKeys.length === 0)
    return outcome(
      "skipped",
      "already_evaluated",
      `This session has already been evaluated.\n${summaries.join("\n")}\n\nUse /kasper status for detailed results.`,
    )
  // This count is diagnostic only, never an authority for history completeness.
  ctx.sessionMsgCount.set(sessionID, raw.length)
  let detail: string
  if (multiAgent) {
    detail = `## Per-Agent Evaluation for Session "${sessionID}"\n\n${summaries.join("\n")}\n\nUse /kasper status for detailed results.`
  } else {
    const record =
      ctx.stateStore.getSession(sessionID) ??
      ctx.stateStore.getRecentSessions(200).find((s) => s.id === sessionID)
    const label = record
      ? `${formatScore(record.score).emoji} ${formatScore(record.score).pct}%`
      : "scored"
    detail = `${renewed ? "Re-evaluated" : "Manual evaluation for"} session "${sessionID}": ${label}`
    if (record?.weaknesses.length)
      detail += `\n\n**Weaknesses:** ${record.weaknesses.slice(0, 3).join(", ")}`
    detail += "\n\nUse /kasper status for detailed results."
  }
  return outcome("scored", "scored", detail, scoredKeys)
}

export async function manualEvaluateSession(
  sessionID: string,
  ctx: KasperContext,
  agentHint?: string,
  evaluateChildren = true,
): Promise<string> {
  const outcome = await evaluateSession(sessionID, ctx, agentHint)
  let detail = outcome.detail
  if (
    evaluateChildren &&
    (outcome.status === "scored" || outcome.reason === "already_evaluated")
  ) {
    const children = await evaluateChildSessions(sessionID, ctx, 0)
    if (children.length)
      detail += `\n\n### Subagent Sessions\n${children.map((c) => `- ${c.id}: ${c.result}`).join("\n")}`
  }
  return detail
}

export async function evaluateChildSessions(
  parentID: string,
  ctx: KasperContext,
  depth: number,
  maxDepth = 3,
  visited = new Set<string>(),
): Promise<Array<{ id: string; result: string }>> {
  if (depth >= maxDepth || visited.has(parentID)) return []
  visited.add(parentID)

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
    if (visited.has(cid) || ctx.kasperSessionIDs.has(cid)) continue
    try {
      const child = await evaluateSession(cid, ctx, childAgentHints.get(cid))
      if (child.status === "scored" || child.reason === "already_evaluated") {
        results.push({
          id: cid,
          result: child.detail.split("\n")[0] ?? "scored",
        })
      } else if (
        child.status === "failed" &&
        child.reason !== "history_unavailable"
      ) {
        results.push({ id: cid, result: child.detail })
      }
      const deeper = await evaluateChildSessions(
        cid,
        ctx,
        depth + 1,
        maxDepth,
        visited,
      )
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
  const outcomes: EvaluationOutcome[] = []
  await ctx.logger.log("batch_evaluate_start", { totalIDs: sessionIDs.length })
  for (const id of new Set(sessionIDs)) {
    try {
      outcomes.push(await evaluateSession(id, ctx, agentHints?.get(id)))
    } catch (error) {
      outcomes.push({
        sessionID: id,
        status: "failed",
        reason: "judge_failed",
        detail: String(error),
        scoredKeys: [],
      })
    }
    const result = outcomes.at(-1)
    if (!result) continue
    await ctx.logger.log("batch_eval_result", {
      sessionID: id,
      status: result.status,
      reason: result.reason,
    })
  }
  const scored = outcomes.filter((o) => o.status === "scored")
  const skipped = outcomes.filter((o) => o.status === "skipped")
  const failed = outcomes.filter(
    (o) => o.status === "failed" || o.status === "cancelled",
  )
  await ctx.logger.log("batch_evaluate_done", {
    totalInput: sessionIDs.length,
    ok: scored.length,
    skipped: skipped.length,
    errors: failed.length,
  })
  const lines: string[] = []
  if (scored.length)
    lines.push(
      `## Batch Evaluation ? ${scored.length} session(s) evaluated`,
      ...scored.map((o) => `\n${o.detail}`),
    )
  if (skipped.length) {
    const empty = skipped.filter(
      (o) => o.reason === "no_content" || o.reason === "incomplete",
    ).length
    const duplicate = skipped.filter(
      (o) => o.reason === "already_evaluated",
    ).length
    const reasons = [
      ...(empty ? [`${empty} empty/no-content or incomplete`] : []),
      ...(duplicate ? [`${duplicate} already evaluated`] : []),
    ]
    lines.push(
      `\n**Skipped**: ${skipped.length} session(s)${reasons.length ? ` (${reasons.join(", ")})` : ""}`,
    )
  }
  if (failed.length)
    lines.push(
      "\n**Errors**:",
      ...failed.map((o) => `- ${o.sessionID}: ${o.detail}`),
    )
  return lines.join("\n")
}

function evaluationGuard(pending: PendingEval, ctx: KasperContext): () => void {
  const sourceID = pending.sourceSessionID ?? pending.sessionID
  return () => {
    if (ctx.deletedSessions.has(sourceID) || ctx.lifetimeSignal?.aborted)
      throw new Error("Evaluation cancelled")
    if (pending.lifecycleRevision)
      ctx.runtime?.assertCurrent(sourceID, pending.lifecycleRevision)
  }
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
    source_session_id: sessionID,
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
  const assertCurrent = evaluationGuard(pending, ctx)

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

  assertCurrent()
  const inject = ctx.agentPrompts.injectSection.bind(ctx.agentPrompts) as (
    ...args: [
      ...Parameters<typeof ctx.agentPrompts.injectSection>,
      (() => void)?,
    ]
  ) => ReturnType<typeof ctx.agentPrompts.injectSection>
  await inject(
    agentName,
    "Kasper Inferred Instructions",
    updateText,
    BACKUP_ENABLED,
    BACKUP_MAX_VERSIONS,
    "subagent",
    _config.agent_prompt_inject_mode,
    assertCurrent,
  )
  assertCurrent()
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
  const assertCurrent = evaluationGuard(pending, ctx)
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
  assertCurrent()
  const manager = ctx.agentsMd as typeof ctx.agentsMd & {
    applyGuidance?: (
      content: string,
      assertCurrent?: () => void,
    ) => Promise<string | undefined>
  }
  if (manager.applyGuidance) {
    backupPath = (await manager.applyGuidance(updateText, assertCurrent)) ?? ""
  } else {
    await ctx.agentsMd.lockedUpdate(async (existing) => {
      if (BACKUP_ENABLED) {
        backupPath = await ctx.agentsMd.backup("pre-improvement")
      }
      assertCurrent()
      const sectionName = "Kasper Inferred Instructions"
      const updated = ctx.agentsMd.injectSection(
        existing,
        sectionName,
        updateText,
      )
      return updated
    })
  }
  assertCurrent()
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
          sessionID: pending.sourceSessionID ?? pending.sessionID,
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
  evaluationGuard(pending, ctx)()
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
      pending.sourceSessionID ?? pending.sessionID,
      card.weaknesses,
    )
  } else if (rerouteToAgentsMd && agentPromptUpdate) {
    await queueImprovement(
      "agents_md",
      pending.agentName,
      agentPromptUpdate,
      ctx,
      pending.sourceSessionID ?? pending.sessionID,
      card.weaknesses,
    )
  }
  if (hasAgentsMd) {
    evaluationGuard(pending, ctx)()
    await queueImprovement(
      "agents_md",
      pending.agentName,
      agentsMdUpdate,
      ctx,
      pending.sourceSessionID ?? pending.sessionID,
      card.weaknesses,
    )
  }
}
