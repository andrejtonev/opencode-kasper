import { randomUUID } from "node:crypto"
import {
  type AgentPromptSource,
  materializeInlinePrompt,
  resolveAgentPromptSource,
} from "./agent-prompt-resolver.js"
import {
  BACKUP_ENABLED,
  BACKUP_MAX_VERSIONS,
  isBuiltinAgentName,
} from "./constants.js"
import { batchEvaluateSessions, manualEvaluateSession } from "./evaluate.js"
import type {
  ImprovementRecord,
  KasperContext,
  PerAgentStats,
  WeaknessPattern,
} from "./types.js"
import { categorizeWeakness } from "./types.js"
import {
  formatScore,
  isKasperSession,
  isValidGuidanceText,
  renderSparkline,
  sanitizeImprovementText,
  showToast,
  weaknessesMergeable,
} from "./utils.js"

/**
 * Build a list of human-readable lines describing what kasper is currently
 * doing in the background. Returned lines start with a leading marker so
 * they render as their own block in the status output. Returns an empty
 * array when nothing is in flight.
 */
export function summarizeValidationInProgress(ctx: KasperContext): string[] {
  const lines: string[] = []

  if (ctx.kasperPaused) {
    lines.push("⏸ Validation paused — `/kasper resume` to re-enable")
  }

  if (ctx.evaluationRunning) {
    const startedAt = ctx.evaluationStartedAt
    const elapsed =
      typeof startedAt === "number"
        ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
        : null
    const idleCount = ctx.idleSessions.size
    const idleSuffix =
      idleCount > 0
        ? ` (${idleCount} idle session${idleCount === 1 ? "" : "s"} queued)`
        : ""
    const elapsedSuffix = elapsed !== null ? ` — ${formatElapsed(elapsed)}` : ""
    lines.push(`🔄 Validation in progress${idleSuffix}${elapsedSuffix}`)
  } else if (ctx.idleSessions.size > 0) {
    lines.push(
      `⏳ ${ctx.idleSessions.size} session${ctx.idleSessions.size === 1 ? "" : "s"} idle, waiting for next poll`,
    )
  }

  if (ctx.isMergingWeaknesses) {
    lines.push("🧠 Merging weaknesses across sessions — LLM call in flight")
  }

  if (ctx.improvementsPending.length > 0) {
    const n = ctx.improvementsPending.length
    lines.push(
      `📝 ${n} pending improvement${n === 1 ? "" : "s"} awaiting application — review with \`/kasper improve\``,
    )
  }

  return lines
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return s === 0 ? `${m}m` : `${m}m ${s}s`
}

export async function executeKasperStatus(
  args: { agent?: string; limit: number },
  ctx: KasperContext,
): Promise<string> {
  const agg = ctx.stateStore.getAggregate()
  const recent = ctx.stateStore.getRecentSessions(args.limit)
  const improvements = ctx.stateStore.getImprovements()

  const { emoji: scoreEmoji, pct: scorePct } = formatScore(agg.avg_score)

  let primaryCount = 0
  let subagentCount = 0
  for (const s of recent) {
    if (s.agent_type === "subagent") subagentCount++
    else primaryCount++
  }

  const lines: string[] = [
    `## Kasper Status`,
    ``,
    `**Total sessions tracked:** ${agg.total_sessions}${subagentCount > 0 ? ` (${primaryCount} primary, ${subagentCount} subagent in recent)` : ""}`,
    `**Average adherence score:** ${scoreEmoji} ${scorePct}%`,
    ``,
  ]

  const progress = summarizeValidationInProgress(ctx)
  if (progress.length > 0) {
    lines.push(`### In Progress`, ...progress, ``)
  }

  const agentNames = Object.keys(agg.by_agent).filter((n) => n !== "unknown")
  const showPerAgent = !args.agent && agentNames.length > 0

  if (args.agent) {
    const agentAgg = ctx.stateStore.getAgentAggregate(args.agent)
    if (agentAgg) {
      const agentSessions = ctx.stateStore.getAgentSessions(args.agent, 5)
      lines.push(`### ${args.agent} Agent Stats`)
      lines.push(
        ``,
        `**Total sessions:** ${agentAgg.total_sessions}`,
        `**Average score:** ${(agentAgg.avg_score * 100).toFixed(0)}%`,
      )

      if (agentSessions.length > 0) {
        const latest = agentSessions[0]
        const c = latest.score_card.categories
        lines.push(
          ``,
          `**Latest session:** ${latest.title}`,
          `**Latest score:** ${(latest.score * 100).toFixed(0)}%`,
          ``,
          `#### Score Breakdown`,
          `| Dimension | Score |`,
          `|---|---|`,
          `| Instruction Following | ${(c.instruction_following * 100).toFixed(0)}% |`,
          `| Completeness | ${(c.completeness * 100).toFixed(0)}% |`,
          `| Proactiveness | ${(c.proactiveness * 100).toFixed(0)}% |`,
          `| Code Quality | ${(c.code_quality * 100).toFixed(0)}% |`,
          `| Communication | ${(c.communication * 100).toFixed(0)}% |`,
        )

        if (latest.weaknesses.length > 0) {
          lines.push(``, `#### Latest Weaknesses`)
          for (const w of latest.weaknesses) {
            lines.push(`- ${w}`)
          }
        }

        if (agentSessions.length > 1) {
          const avgLast3 =
            agentSessions.slice(0, 3).reduce((s, e) => s + e.score, 0) /
            Math.min(agentSessions.length, 3)
          const direction =
            latest.score >= avgLast3 ? "↑ improving" : "↓ declining"
          lines.push(
            ``,
            `**Recent trend (last ${Math.min(agentSessions.length, 3)}):** ${(avgLast3 * 100).toFixed(0)}% avg — ${direction}`,
          )
        }
      }

      if (agentAgg.top_weaknesses.length > 0) {
        lines.push(``, `#### Aggregate Weaknesses`)
        for (const w of agentAgg.top_weaknesses) {
          const targetLabel = w.target
            ? ` [${w.target === "agents_md" ? "AGENTS.md" : `${args.agent} prompt`}]`
            : ""
          lines.push(`- ${w.pattern} (${w.count}x)${targetLabel}`)
          if (
            w.suggested_fix &&
            w.suggested_fix !== `Prevent this issue: "${w.pattern}"`
          ) {
            lines.push(`  Fix: ${w.suggested_fix}`)
          }
        }
      }
      if (agentAgg.top_strengths.length > 0) {
        lines.push(``, `**Strengths:**`)
        for (const s of agentAgg.top_strengths) {
          lines.push(`- ${s}`)
        }
      }
    } else {
      lines.push(`No data found for agent "${args.agent}".`)
    }
  } else if (showPerAgent) {
    if (agg.top_weaknesses.length > 0) {
      lines.push(`### Top Weaknesses`)
      for (const w of agg.top_weaknesses) {
        const contributing = agentNames.filter((name) => {
          const pa = agg.by_agent[name]
          if (!pa) return false
          return pa.top_weaknesses.some((pw) =>
            weaknessesMergeable(pw.pattern, w.pattern, pw.category, w.category),
          )
        })
        const agentLabel =
          contributing.length > 0 ? ` [${contributing.join(", ")}]` : ""
        lines.push(`- ${w.pattern} (${w.count}x)${agentLabel}`)
      }
    }
    if (agg.top_strengths.length > 0) {
      lines.push(``, `### Top Strengths`)
      for (const s of agg.top_strengths) {
        lines.push(`- ${s}`)
      }
    }
    lines.push(``)
    for (const name of agentNames) {
      const agentAgg = agg.by_agent[name]
      if (!agentAgg || agentAgg.total_sessions === 0) continue
      const { emoji: ae, pct: ap } = formatScore(agentAgg.avg_score)
      lines.push(
        `### ${name}: ${ae} ${ap}% (${agentAgg.total_sessions} sessions)`,
      )
      if (agentAgg.top_weaknesses.length > 0) {
        for (const w of agentAgg.top_weaknesses) {
          lines.push(`- Weakness: ${w.pattern} (${w.count}x)`)
        }
      }
      if (agentAgg.top_strengths.length > 0) {
        lines.push(`- Strength: ${agentAgg.top_strengths[0]}`)
      }
      lines.push(``)
    }
  } else {
    if (agg.top_weaknesses.length > 0) {
      lines.push(`### Top Weaknesses`)
      for (const w of agg.top_weaknesses) {
        const contributing = agentNames.filter((name) => {
          const pa = agg.by_agent[name]
          if (!pa) return false
          return pa.top_weaknesses.some((pw) =>
            weaknessesMergeable(pw.pattern, w.pattern, pw.category, w.category),
          )
        })
        const agentLabel =
          contributing.length > 0 ? ` [${contributing.join(", ")}]` : ""
        lines.push(`- ${w.pattern} (${w.count}x)${agentLabel}`)
      }
    }
    if (agg.top_strengths.length > 0) {
      lines.push(``, `### Top Strengths`)
      for (const s of agg.top_strengths) {
        lines.push(`- ${s}`)
      }
    }
  }

  lines.push(`### Recent Sessions`)
  for (const s of recent.slice(0, 5)) {
    const agentLabel = s.agent_name ? ` [${s.agent_name}]` : ""
    const sublabel = s.agent_type === "subagent" ? " [sub]" : ""
    lines.push(
      `- ${s.title} — ${(s.score * 100).toFixed(0)}%${agentLabel}${sublabel}`,
    )
  }

  const sparklineSessions = recent.slice(0, 7).reverse()
  if (sparklineSessions.length >= 2) {
    const scores = sparklineSessions.map((s) => s.score)
    const spark = renderSparkline(scores)
    const pcts = scores.map((s) => `${(s * 100).toFixed(0)}%`).join(" ")
    lines.push(
      ``,
      `**Score Trend**: ${spark} (last ${sparklineSessions.length}: ${pcts})`,
    )
  }

  if (improvements.length > 0) {
    lines.push(``, `### Improvements Applied: ${improvements.length}`)
    const last = improvements[improvements.length - 1]
    let lastLine = `Last: ${last.reason.slice(0, 80)}...`
    if (last.outcome_score_delta !== undefined) {
      const dir = last.outcome_score_delta > 0 ? "+" : ""
      lastLine += ` (score ${dir}${(last.outcome_score_delta * 100).toFixed(1)}%)`
    }
    lines.push(lastLine)

    const deltas = improvements
      .map((i) => i.outcome_score_delta)
      .filter((d): d is number => d !== undefined)
    if (deltas.length >= 2) {
      const helped = deltas.filter((d) => d > 0).length
      const hurt = deltas.filter((d) => d < 0).length
      const avgDelta = deltas.reduce((s, d) => s + d, 0) / deltas.length
      const avgDir = avgDelta > 0 ? "+" : ""
      lines.push(
        `Avg delta: ${avgDir}${(avgDelta * 100).toFixed(1)}% (${helped} helped, ${hurt} hurt)`,
      )
    }
  } else {
    lines.push(``, `### No improvements applied yet.`)
  }

  const autoLabel = ctx.autoUpdateEnabled ? "ON" : "OFF"
  lines.push(``, `Auto-update: ${autoLabel} | /kasper auto for details`)

  return lines.join("\n")
}

function resolveWeaknessAgentLabels(
  w: WeaknessPattern,
  agg: ReturnType<KasperContext["stateStore"]["getAggregate"]>,
): string {
  const agents: string[] = []
  if (agg.by_agent) {
    for (const [name, pa] of Object.entries(agg.by_agent)) {
      const hasMatch = pa.top_weaknesses.some((aw: WeaknessPattern) =>
        weaknessesMergeable(w.pattern, aw.pattern, w.category, aw.category),
      )
      if (hasMatch) agents.push(name)
    }
  }
  if (agents.length === 0) return ""
  return ` [agent: ${agents.join(", ")}]`
}

function collectAgentWeaknesses(agg: {
  by_agent?: Record<string, PerAgentStats>
}): WeaknessPattern[] {
  const all: Array<{ w: WeaknessPattern; agent: string }> = []
  for (const [agent, pa] of Object.entries(agg.by_agent ?? {})) {
    for (const w of pa.top_weaknesses) {
      all.push({ w, agent })
    }
  }
  all.sort((a, b) => b.w.count - a.w.count)

  const result: WeaknessPattern[] = []
  const seen = new Set<string>()
  for (const { w, agent } of all) {
    const key = w.pattern.toLowerCase().trim()
    let dup = false
    for (const s of seen) {
      if (weaknessesMergeable(key, s, w.category, categorizeWeakness(s))) {
        dup = true
        break
      }
    }
    if (!dup) {
      seen.add(key)
      result.push({ ...w, agent_name: agent })
    }
  }
  return result
}

function weaknessToPending(
  w: WeaknessPattern,
  ctx: KasperContext,
  agentFallback?: string,
): void {
  for (const existing of ctx.improvementsPending) {
    if (weaknessesMergeable(w.pattern, existing.reason)) {
      return
    }
  }
  const target = w.target ?? (agentFallback ? "agent_prompt" : "agents_md")
  const agentName = w.agent_name ?? agentFallback
  ctx.improvementsPending.push({
    id: randomUUID(),
    timestamp: Date.now(),
    target,
    agent_name: agentName,
    agents_md_diff: w.suggested_fix || "",
    reason: w.pattern,
    backup_path: "",
    weaknesses: [w.pattern],
  })
}

export function resolveTargetOverride(
  arg: string,
): { target: "agents_md" | "agent_prompt"; cleanArg: string } | null {
  const trimmed = arg.trim()
  if (!trimmed) return null
  const parts = trimmed.split(/\s+/)
  const last = parts[parts.length - 1]?.toLowerCase() ?? ""
  const normalized = last.replace(/\.md$/i, "").replace(/[_-]/g, "")
  if (
    normalized === "agentsmd" ||
    normalized === "agmd" ||
    normalized === "agents"
  ) {
    return {
      target: "agents_md",
      cleanArg: parts.slice(0, -1).join(" "),
    }
  }
  if (last === "prompt" || last === "agent_prompt") {
    return {
      target: "agent_prompt",
      cleanArg: parts.slice(0, -1).join(" "),
    }
  }
  return null
}

export async function executeKasperImprove(
  args: { agent?: string; force?: boolean; dryRun?: boolean },
  ctx: KasperContext,
): Promise<string> {
  const config = ctx.stateStore.getConfig()
  const agg = ctx.stateStore.getAggregate()

  const weaknesses = args.agent
    ? (ctx.stateStore.getAgentAggregate(args.agent)?.top_weaknesses ??
      agg.top_weaknesses)
    : collectAgentWeaknesses(agg)

  if (weaknesses.length === 0) {
    return "No weaknesses recorded yet. Complete more sessions to build up observations — the scorer evaluates after each session."
  }

  const top = weaknesses.filter((w: WeaknessPattern) => {
    if (!args.force && w.count < ctx.config.min_observations_for_update)
      return false
    for (const rejected of ctx.rejectedPatterns) {
      if (weaknessesMergeable(w.pattern, rejected, w.category)) return false
    }
    return true
  })

  if (top.length === 0) {
    return `No weaknesses have reached the minimum observation threshold (${ctx.config.min_observations_for_update}). Current top weakness: "${weaknesses[0].pattern}" (${weaknesses[0].count}x).`
  }

  const header = args.agent
    ? `## ${args.dryRun ? "Dry-Run: " : ""}Suggested Improvements for ${args.agent}`
    : `## ${args.dryRun ? "Dry-Run: " : ""}Suggested Improvements`

  const rows = top.map((w: WeaknessPattern, i: number) => {
    const agentLabel =
      args.agent || resolveWeaknessAgentLabels(w, agg) || w.agent_name || ""
    const targetLabel = w.target === "agents_md" ? "AGENTS.md" : "agent prompt"
    return [i + 1, w.pattern, w.count, agentLabel, targetLabel]
  })

  const tableLines = [
    `| # | Weakness | Count | Agent | Target |`,
    `|---|---|---|---|---|`,
    ...rows.map((r) => `| ${r[0]} | ${r[1]} | ${r[2]} | ${r[3]} | ${r[4]} |`),
  ]

  const fixLines = top.map((w: WeaknessPattern, i: number) => {
    const fix =
      w.suggested_fix &&
      w.suggested_fix !== `Prevent this issue: "${w.pattern}"`
        ? w.suggested_fix
        : `Add a guideline that prevents: "${w.pattern}"`
    return `Fix #${i + 1}: ${fix}`
  })

  const result = [
    header,
    ``,
    ...tableLines,
    ``,
    ...fixLines,
    ``,
    `Auto-update: ${config.auto_update ? "ON" : "OFF"} (session: ${ctx.autoUpdateEnabled ? "ON" : "OFF"})`,
    ``,
    args.dryRun
      ? `Dry-run mode: nothing was queued. Remove --dry-run to actually queue improvements.`
      : `Use /kasper apply <n> to apply.`,
  ].join("\n")

  if (args.dryRun) return result

  for (const w of top) {
    weaknessToPending(w, ctx, args.agent)
  }

  return result
}

export async function executeKasperAuto(
  arg: string,
  ctx: KasperContext,
): Promise<string> {
  const sub = arg.trim().toLowerCase()

  if (sub === "on") {
    ctx.autoUpdateEnabled = true
    return `Auto-update enabled for both AGENTS.md and agent prompts. Improvements will be applied automatically.`
  } else if (sub === "off") {
    ctx.autoUpdateEnabled = false
    return `Auto-update disabled for both AGENTS.md and agent prompts. Use /kasper apply to manually approve improvements.`
  }

  return [
    `Auto-update: ${ctx.autoUpdateEnabled ? "ON" : "OFF"} (config default: ${ctx.config.auto_update ? "ON" : "OFF"})`,
    ``,
    `Use "/kasper auto on|off" to toggle.`,
  ].join("\n")
}

export async function executeKasperScoreSession(
  sessionID: string | undefined,
  ctx: KasperContext,
): Promise<string> {
  const targetID = sessionID || ctx.lastActiveSessionID
  if (!targetID) {
    return "No session ID provided and no active session."
  }

  return manualEvaluateSession(targetID, ctx)
}

export async function executeKasperScoreAgent(
  agentName: string,
  ctx: KasperContext,
): Promise<string> {
  const sessions = ctx.stateStore.getAgentSessions(agentName, 5)
  if (sessions.length === 0) {
    return `No evaluations found for agent "${agentName}". The agent may not have been observed yet.`
  }

  const latest = sessions[0]
  const c = latest.score_card.categories
  const lines: string[] = [
    `## Latest ${agentName} Evaluation`,
    ``,
    `**Session:** ${latest.title}`,
    `**Overall:** ${(latest.score * 100).toFixed(0)}%`,
    ``,
    `### Scores`,
    `| Dimension | Score |`,
    `|---|---|`,
    `| Instruction Following | ${(c.instruction_following * 100).toFixed(0)}% |`,
    `| Completeness | ${(c.completeness * 100).toFixed(0)}% |`,
    `| Proactiveness | ${(c.proactiveness * 100).toFixed(0)}% |`,
    `| Code Quality | ${(c.code_quality * 100).toFixed(0)}% |`,
    `| Communication | ${(c.communication * 100).toFixed(0)}% |`,
  ]

  if (latest.weaknesses.length > 0) {
    lines.push(``, `### Weaknesses`)
    for (const w of latest.weaknesses) {
      lines.push(`- ${w}`)
    }
  } else {
    lines.push(``, `### No weaknesses detected.`)
  }

  if (sessions.length > 1) {
    const avgLast3 =
      sessions.slice(0, 3).reduce((s, e) => s + e.score, 0) /
      Math.min(sessions.length, 3)
    lines.push(``, `### Recent Trend (last ${Math.min(sessions.length, 3)})`)
    lines.push(`Average: ${(avgLast3 * 100).toFixed(0)}%`)
    const direction = latest.score >= avgLast3 ? "↑ improving" : "↓ declining"
    lines.push(`Trend: ${direction}`)
  }

  return lines.join("\n")
}

async function handleScoreCommand(
  arg: string,
  sessionID: string | undefined,
  ctx: KasperContext,
): Promise<string> {
  const scoreParts = arg.trim().split(/\s+/)
  const sub = scoreParts[0]?.toLowerCase() ?? ""
  const subArg = scoreParts.slice(1).join(" ")

  if (sub === "agent") {
    const name = subArg.trim()
    if (!name) {
      return "Specify an agent name: /kasper score agent <name>"
    }
    return executeKasperScoreAgent(name, ctx)
  }

  if (sub === "session") {
    const rest = subArg.trim()

    const lastMatch = rest.match(/^last\s+(\d+)$/i)
    if (lastMatch) {
      return handleBatchScoreSession(
        parseInt(lastMatch[1], 10),
        undefined,
        undefined,
        ctx,
      )
    }

    const sinceMatch = rest.match(/^since\s+(\d{4}-\d{2}-\d{2})$/i)
    if (sinceMatch) {
      const since = new Date(sinceMatch[1])
      if (Number.isNaN(since.getTime()))
        return "Invalid date format. Use YYYY-MM-DD (e.g., since 2026-03-01)."
      return handleBatchScoreSession(undefined, since, new Date(), ctx)
    }

    const rangeMatch = rest.match(
      /^range\s+(\d{4}-\d{2}-\d{2})\s+(\d{4}-\d{2}-\d{2})$/i,
    )
    if (rangeMatch) {
      const start = new Date(rangeMatch[1])
      const end = new Date(rangeMatch[2])
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        return "Invalid date format. Use YYYY-MM-DD (e.g., range 2026-03-01 2026-03-15)."
      }
      return handleBatchScoreSession(undefined, start, end, ctx)
    }

    const targetID = rest || ctx.lastActiveSessionID
    if (!targetID) {
      return "No session ID provided and no active session. Use /kasper score session <id> to specify a session."
    }

    return manualEvaluateSession(targetID, ctx)
  }
  if (sessionID) {
    return manualEvaluateSession(sessionID, ctx)
  }
  return "No active session found. Use /kasper score session <id> to score a specific session, or /kasper score agent <name> for an agent summary."
}

export async function handleBatchScoreSession(
  lastCount: number | undefined,
  since: Date | undefined,
  until: Date | undefined,
  ctx: KasperContext,
): Promise<string> {
  if (!ctx.client.session.list) {
    return "Session listing is not available. Try /kasper score session <id> with a specific session ID instead."
  }

  type SessionListItem = {
    id: string
    title: string
    agent?: string
    agentName?: string
    subagent_type?: string
    parentID?: string
    time: { created: number; updated: number }
  }
  type SessionInfo = {
    id: string
    agent?: string
    title?: string
    parentID?: string
    time: { created: number; updated: number }
  }
  let rawSessions: SessionListItem[]
  let sessions: SessionInfo[]
  try {
    const result = await ctx.client.session.list()
    rawSessions = (result.data ?? []) as SessionListItem[]
    sessions = rawSessions
      .filter((s) => !isKasperSession(s.title))
      .filter((s) => !ctx.kasperSessionIDs.has(s.id))
      .map((s) => ({
        id: s.id,
        agent: s.agent || s.agentName || s.subagent_type,
        title: s.title,
        parentID: s.parentID,
        time: s.time,
      }))
  } catch (err) {
    return `Failed to list sessions: ${err}`
  }

  if (sessions.length === 0) return "No sessions found."

  sessions.sort((a, b) => b.time.updated - a.time.updated)

  let selected: SessionInfo[]
  if (lastCount !== undefined) {
    selected = sessions.slice(0, lastCount)
  } else if (since !== undefined) {
    const sinceMs = since.getTime()
    const untilMs = until?.getTime() ?? Date.now()
    selected = sessions.filter(
      (s) => s.time.created >= sinceMs && s.time.created <= untilMs,
    )
  } else {
    selected = sessions
  }

  if (selected.length === 0) return "No sessions match the given criteria."

  await ctx.logger.log("batch_score_start", {
    totalSessions: sessions.length,
    selectedCount: selected.length,
    mode:
      lastCount !== undefined
        ? `last_${lastCount}`
        : since !== undefined
          ? "date_range"
          : "all",
  })

  const agentHints = new Map<string, string>()
  for (const s of selected) {
    if (s.agent) agentHints.set(s.id, s.agent)
  }

  let cachedSkipCount = 0
  const needsEval = selected.filter((s) => {
    if (!ctx.sessionsEvaluated.has(s.id)) return true
    const record = ctx.stateStore.getSession(s.id)
    if (!record?.last_updated_at) return true
    if (s.time.updated > record.last_updated_at) return true
    cachedSkipCount++
    return false
  })

  let allIDs: string[]
  if (lastCount !== undefined) {
    allIDs = needsEval.map((s) => s.id)
  } else {
    const seenIDs = new Set(needsEval.map((s) => s.id))
    for (const [parent, children] of ctx.parentToChildren) {
      if (seenIDs.has(parent)) {
        for (const child of children) {
          if (!seenIDs.has(child) && !ctx.deletedSessions.has(child)) {
            seenIDs.add(child)
            agentHints.set(child, ctx.agentRegistry.get(child)?.agentName ?? "")
          }
        }
      }
    }

    for (const s of rawSessions) {
      if (!s.parentID || !s.id) continue
      if (
        seenIDs.has(s.parentID) &&
        !seenIDs.has(s.id) &&
        !ctx.deletedSessions.has(s.id) &&
        !isKasperSession(s.title) &&
        !ctx.kasperSessionIDs.has(s.id)
      ) {
        seenIDs.add(s.id)
        agentHints.set(
          s.id,
          s.agent ||
            s.agentName ||
            s.subagent_type ||
            ctx.agentRegistry.get(s.id)?.agentName ||
            "",
        )
      }
    }

    allIDs = [...seenIDs]
  }

  const batchResult = await batchEvaluateSessions(allIDs, ctx, agentHints)
  if (cachedSkipCount > 0) {
    const lines = batchResult.split("\n")
    const header = lines[0] ?? ""
    const note = `_Note: ${cachedSkipCount} session(s) skipped (no new messages since last evaluation)_`
    return `${header}\n${note}\n${lines.slice(1).join("\n")}`
  }
  return batchResult
}

export async function executeKasperHistory(
  args: { agent?: string; limit: number },
  ctx: KasperContext,
): Promise<string> {
  const sessions = args.agent
    ? ctx.stateStore.getAgentSessions(args.agent, args.limit)
    : ctx.stateStore.getRecentSessions(args.limit)

  const improvements = args.agent
    ? ctx.stateStore
        .getImprovements()
        .filter((i: ImprovementRecord) => i.agent_name === args.agent)
        .slice(-args.limit)
    : ctx.stateStore.getImprovements().slice(-args.limit)

  const lines: string[] = [`## Kasper History`]

  if (args.agent) lines.push(`### Agent: ${args.agent}`)

  lines.push(``, `### Sessions (${sessions.length})`)

  if (sessions.length === 0) {
    lines.push(`No sessions recorded yet.`)
  } else {
    for (const s of sessions) {
      const date = new Date(s.timestamp).toISOString().slice(0, 10)
      const scores = s.score_card.categories
      lines.push(
        `- **${date}** — ${s.title} | Overall: **${(s.score * 100).toFixed(0)}%**`,
      )
      lines.push(
        `  IF:${(scores.instruction_following * 100).toFixed(0)} C:${(scores.completeness * 100).toFixed(0)} P:${(scores.proactiveness * 100).toFixed(0)} CQ:${(scores.code_quality * 100).toFixed(0)} CM:${(scores.communication * 100).toFixed(0)}`,
      )
      if (s.weaknesses.length > 0) {
        lines.push(`  Weaknesses: ${s.weaknesses.slice(0, 3).join("; ")}`)
      }
    }
  }

  if (improvements.length > 0) {
    lines.push(``, `### Improvements (${improvements.length})`)
    for (const imp of improvements) {
      const date = new Date(imp.timestamp).toISOString().slice(0, 10)
      let deltaStr = ""
      if (imp.outcome_score_delta !== undefined) {
        const dir = imp.outcome_score_delta > 0 ? "+" : ""
        deltaStr = ` [score ${dir}${(imp.outcome_score_delta * 100).toFixed(1)}%]`
      }
      lines.push(`- ${date}: ${imp.reason.slice(0, 100)}${deltaStr}`)
    }
  }

  return lines.join("\n")
}

export function describeAgentPromptSource(source: AgentPromptSource): string {
  switch (source.kind) {
    case "external_file":
      return `{file:...} directive → ${source.path}\n  declared in: ${source.configPath}`
    case "project_file":
      return `project file: ${source.path}`
    case "global_file":
      return `global file: ${source.path}`
    case "inline":
      return `inline string in ${source.configPath} (${source.prompt.length} chars)`
    case "missing":
      return `no prompt source found for this agent`
  }
}

export async function executeKasperMigrate(
  rawArg: string,
  ctx: KasperContext,
): Promise<string> {
  const arg = rawArg.trim()
  const showOnly = /\bshow\b|\b--show\b/.test(arg)
  const name = arg.replace(/\b(show|--show)\b/g, "").trim()
  if (!name) {
    return [
      "Usage:",
      "  /kasper migrate <agent-name>           extract inline prompt to a file",
      "  /kasper migrate <agent-name> --show    report the current source without changing it",
    ].join("\n")
  }

  const projectRoot = (ctx.agentPrompts as unknown as { projectRoot: string })
    .projectRoot
  const globalOpencodeDir = (
    ctx.agentPrompts as unknown as { globalOpencodeDir?: string }
  ).globalOpencodeDir

  const source = await resolveAgentPromptSource(
    name,
    projectRoot,
    globalOpencodeDir,
  )
  const description = describeAgentPromptSource(source)

  if (showOnly) {
    return [`## Agent prompt source: \`${name}\``, ``, description].join("\n")
  }

  if (source.kind !== "inline") {
    if (source.kind === "missing") {
      return [
        `## Nothing to migrate for \`${name}\``,
        ``,
        "No prompt source exists for this agent in any opencode config or conventional file location.",
        "",
        "If you want to create a new prompt file, use your editor or a /kasper apply workflow to inject the initial section.",
      ].join("\n")
    }
    return [
      `## Nothing to migrate for \`${name}\``,
      ``,
      `Current source: ${description}`,
      "",
      "Migration only applies when the prompt is an inline string in opencode.json. Kasper already writes to this source directly.",
    ].join("\n")
  }

  let mode: "primary" | "subagent" = "subagent"
  for (const [, info] of ctx.agentRegistry) {
    if (info.agentName === name) {
      mode = info.agentType === "primary" ? "primary" : "subagent"
      break
    }
  }

  try {
    const result = await materializeInlinePrompt(
      name,
      projectRoot,
      globalOpencodeDir,
      {
        mode,
      },
    )
    ctx.agentPrompts.invalidateSourceCache(name)
    await ctx.logger.log("agent_prompt_migrated", {
      agent: name,
      filePath: result.filePath,
      configPath: result.configPath,
      configModified: result.configModified,
    })
    showToast(
      ctx.client,
      "Kasper",
      `Migrated ${name} inline prompt to ${result.filePath}. Restart opencode.`,
      "success",
    )
    return [
      `## Migrated \`${name}\` prompt`,
      ``,
      `**New prompt file:** \`${result.filePath}\`${result.fileCreated ? " (created)" : " (left in place)"}`,
      `**Source opencode.json:** \`${result.configPath}\`${result.configModified ? " (inline `prompt` field replaced with `{file:...}` directive)" : " (no changes needed)"}`,
      ``,
      "**Restart opencode** to load the new prompt. From now on, kasper will edit the file directly.",
    ].join("\n")
  } catch (err) {
    return `Migration failed: ${err instanceof Error ? err.message : String(err)}`
  }
}

export async function executeKasperReset(
  arg: string,
  ctx: KasperContext,
): Promise<string> {
  const normalized = arg.trim().toLowerCase()
  if (normalized !== "--force" && normalized !== "confirm") {
    return [
      "## ⚠️ Dangerous Operation",
      "",
      "This will permanently delete all Kasper state including:",
      "- All session scores and evaluations",
      "- All tracked weaknesses and strengths",
      "- All pending and applied improvements",
      "- All agent registry data",
      "",
      "This action **cannot be undone**.",
      "",
      "To confirm, run: `/kasper reset --force`",
    ].join("\n")
  }

  const before = ctx.stateStore.getAggregate()
  ctx.kasperPaused = true
  await ctx.stateStore.reset()
  ctx.sessionsEvaluated.clear()
  ctx.improvementsPending.length = 0
  ctx.rejectedPatterns.clear()
  ctx.agentRegistry.clear()
  ctx.sessionMsgCount.clear()
  ctx.sessionParents.clear()
  ctx.parentToChildren.clear()
  ctx.autoUpdateEnabled = ctx.config.auto_update
  ctx.userGuidance.clear()
  await ctx.logger.log("kasper_reset", {
    sessionsBefore: before.total_sessions,
  })
  showToast(ctx.client, "Kasper", "All kasper state has been reset.", "info")
  return `Kasper state reset. Cleared ${before.total_sessions} session(s), ${ctx.stateStore.getImprovements().length} improvement(s), and all pending data.`
}

export function executeKasperHelp(): string {
  return [
    `## Kasper Commands`,
    ``,
    `| Command | Description |`,
    `|---|---|`,
    `| \`/kasper status [agent <name>]\` | View aggregate scores, top weaknesses, recent sessions, score trend |`,
    `| \`/kasper score session <id>\` | Evaluate a past session (omit id for current). Supports \`last N\`, \`since YYYY-MM-DD\`, \`range X Y\` |`,
    `| \`/kasper improve [agent]\` | Show suggested improvements as a table with weakness, count, agent, target |`,
    `| \`/kasper apply [n|all]\` | Apply a pending improvement (first if no index, at index, or all) |`,
    `| \`/kasper history [agent]\` | View session history with score breakdowns and improvement log |`,
    `| \`/kasper reset\` | Clear all kasper state (sessions, scores, improvements) |`,
    `| \`/kasper migrate <name> [--show]\` | Extract an inline (opencode.json) agent prompt to a file so kasper can edit it |`,
    `| \`/kasper help\` | Show this help |`,
    ``,
    `Scoring dimensions: instruction following, completeness, proactiveness, code quality, communication.`,
    ``,
    `Scores: 🟢 ≥80%  🟡 ≥60%  🔴 <60%`,
  ].join("\n")
}

export async function dispatchKasperCommand(
  action: string,
  arg: string,
  sessionID: string | undefined,
  ctx: KasperContext,
): Promise<string> {
  if (!action) {
    const agg = ctx.stateStore.getAggregate()
    const { emoji: scoreEmoji, pct: scorePct } = formatScore(agg.avg_score)
    const autoLabel = ctx.autoUpdateEnabled ? "ON" : "OFF"
    const progress = summarizeValidationInProgress(ctx)
    return [
      `## Kasper`,
      ``,
      `${scoreEmoji} Average score: ${scorePct}% across ${agg.total_sessions} session(s)`,
      ...(progress.length > 0 ? ["", ...progress] : []),
      ``,
      `Auto-update: ${autoLabel} | /kasper status for details`,
      `Type /kasper help for all commands`,
    ]
      .filter((line) => line !== undefined && line !== null)
      .join("\n")
  }

  switch (action) {
    case "status":
      return executeKasperStatus({ agent: arg || undefined, limit: 15 }, ctx)
    case "score":
      return handleScoreCommand(arg, sessionID, ctx)
    case "improve": {
      const dryRun = /\b--dry-run\b/.test(arg)
      const cleanArg = arg.replace(/\b--dry-run\b/, "").trim()
      return executeKasperImprove({ agent: cleanArg || undefined, dryRun }, ctx)
    }
    case "apply": {
      if (arg === "all") {
        if (ctx.improvementsPending.length === 0) {
          return "No pending improvements. Run /kasper improve to generate suggestions."
        }
        const count = ctx.improvementsPending.length
        const results: string[] = []
        while (ctx.improvementsPending.length > 0) {
          const item = ctx.improvementsPending.shift()
          if (!item) break
          results.push(await applyImprovement(item, ctx))
        }
        return `Applied all ${count} pending improvement(s):\n\n${results.join("\n\n")}`
      }
      const parsed = Number(arg)
      const index = Number.isInteger(parsed) && parsed > 0 ? parsed : NaN
      if (!Number.isNaN(index)) {
        if (index < 1 || index > ctx.improvementsPending.length) {
          return `Invalid index ${arg}. There are ${ctx.improvementsPending.length} pending improvements. Use /kasper improve to see the list.`
        }
        const [pending] = ctx.improvementsPending.splice(index - 1, 1)
        return applyImprovement(pending, ctx)
      }
      const pending = ctx.improvementsPending.shift()
      if (pending) return applyImprovement(pending, ctx)
      return "No pending improvements. Run /kasper improve to generate suggestions."
    }
    case "history":
      return executeKasperHistory({ agent: arg || undefined, limit: 20 }, ctx)
    case "auto":
      return executeKasperAuto(arg, ctx)
    case "help":
      return executeKasperHelp()
    case "reset":
      return executeKasperReset(arg, ctx)
    case "migrate":
      return executeKasperMigrate(arg, ctx)
    default:
      return `Unknown /kasper command: "${action}". Available: status, score, improve, apply, history, reset, help`
  }
}

export function buildApplyPromptForPendings(
  pending: ImprovementRecord[],
): string {
  if (pending.length === 0) {
    return "No pending improvements to apply. Run /kasper improve to generate suggestions."
  }

  const lines: string[] = [
    "Apply the following Kasper-suggested improvement(s):",
    "",
  ]

  for (let i = 0; i < pending.length; i++) {
    const p = pending[i]
    const prefix = pending.length > 1 ? `**[${i + 1}/${pending.length}]** ` : ""

    if (p.target === "agents_md") {
      lines.push(
        `${prefix}**Target**: AGENTS.md (project root)`,
        `**Description**: ${p.reason}`,
        "",
        "Find or create a `## Kasper Inferred Instructions` section in AGENTS.md and add:",
        `> ${p.reason}`,
      )
    } else {
      const name = p.agent_name || "unknown"
      lines.push(
        `${prefix}**Target**: \`${name}\` agent prompt`,
        `**Description**: ${p.reason}`,
        ``,
        `The \`${name}\` agent prompt may be defined in one of:`,
        `  1. \`.opencode/agents/${name}.md\` (project-specific markdown)`,
        `  2. \`~/.config/opencode/agents/${name}.md\` (global markdown)`,
        `  3. \`opencode.json\` under \`"agent"."${name}"."prompt"\` (inline or \`{file:...}\` reference)`,
        ``,
        "Check each location to find where the prompt is defined, then add under the prompt:",
        `> ${p.reason}`,
        "",
        `Kasper's default style adds a visible \`## Kasper Inferred Instructions\` section. If \`agent_prompt_inject_mode = "inline"\` is set in kasper.json(c), kasper appends the guidance directly with no section header (wrapped only in \`<!-- kasper-injected:begin/end -->\` HTML comments for rollback).`,
        "If the prompt already has a `## Kasper Inferred Instructions` section, add a bullet point there.",
        `If the prompt is an inline string in opencode.json, run \`/kasper migrate ${name}\` first to extract it, then add the entry.`,
      )
    }
    lines.push("")
  }

  if (pending.length === 1) {
    const p = pending[0]
    if (!p) return lines.join("\n")
    if (p.target === "agents_md") {
      lines.push(
        `**Instructions**:`,
        `1. Read the full AGENTS.md to understand its current structure and existing guidelines`,
        `2. Check if this improvement (or something very similar) already exists in the file`,
        `3. If missing, determine the best section to introduce it — it may belong under \`## Kasper Inferred Instructions\` or a more specific section`,
        `4. If adding to Kasper Inferred Instructions, find or create that section; otherwise add where it fits best`,
        `5. Verify the file is well-formed and no duplication occurred before finishing`,
      )
    } else {
      const name = p.agent_name || "unknown"
      lines.push(
        `**Instructions**:`,
        `1. Look up the \`${name}\` agent prompt in the locations listed above`,
        `2. Read the full prompt to understand its current structure and existing guidelines`,
        `3. Check if this improvement (or something very similar) already exists`,
        `4. If missing, determine the best section — look for \`## Kasper Inferred Instructions\` or a natural heading. If \`agent_prompt_inject_mode = "inline"\` is set, append directly at the end of the file (after any existing \`<!-- kasper-injected:end -->\` block).`,
        `5. Add the improvement, preserving all existing content`,
        `6. If the prompt lives in opencode.json as an inline string, run \`/kasper migrate ${name}\` to extract it before editing`,
        `7. Verify the change is well-formed and no duplication occurred before finishing`,
      )
    }
    lines.push("")
  }

  if (pending.length === 1) {
    const p = pending[0]
    if (!p) return lines.join("\n")
    if (p.target === "agents_md") {
      lines.push(
        `**Instructions**:`,
        `1. Read the full AGENTS.md to understand its current structure and existing guidelines`,
        `2. Check if this improvement (or something very similar) already exists in the file`,
        `3. If missing, determine the best section to introduce it — it may belong under \`## Kasper Inferred Instructions\` or a more specific section`,
        `4. If adding to Kasper Inferred Instructions, find or create that section; otherwise add where it fits best`,
        `5. Verify the file is well-formed and no duplication occurred before finishing`,
      )
    } else {
      const name = p.agent_name || "unknown"
      lines.push(
        `**Instructions**:`,
        `1. Look up the \`${name}\` agent prompt in the locations listed above`,
        `2. Read the full prompt to understand its current structure and existing guidelines`,
        `3. Check if this improvement (or something very similar) already exists`,
        `4. If missing, determine the best section — look for \`## Kasper Inferred Instructions\` or a natural heading`,
        `5. Add the improvement, preserving all existing content`,
        `6. If the prompt lives in opencode.json as an inline string, run \`/kasper migrate ${name}\` to extract it before editing`,
        `7. Verify the change is well-formed and no duplication occurred before finishing`,
      )
    }
  } else {
    lines.push(
      `**Instructions**:`,
      `1. For each item: read the full target file, check for existing similar content`,
      `2. If the improvement is not already present, determine the best section to introduce it`,
      `3. Add the improvement under \`## Kasper Inferred Instructions\` or a more specific section`,
      `4. For agent prompts, check all listed locations to find where the prompt lives`,
      `5. Verify no duplication occurred and all files are well-formed before finishing`,
    )
  }

  return lines.join("\n")
}

export async function applyImprovement(
  pending: ImprovementRecord,
  ctx: KasperContext,
): Promise<string> {
  const config = ctx.stateStore.getConfig()
  if (config.strict_sanitize) {
    const sanResult = sanitizeImprovementText(pending.reason)
    if (!sanResult.safe) {
      showToast(
        ctx.client,
        "Kasper",
        `Improvement rejected: contains ${sanResult.rejections.join(", ")}`,
        "warning",
        6000,
      )
      return `Improvement rejected by sanitization: ${sanResult.rejections.join(", ")}`
    }
  }

  if (!isValidGuidanceText(pending.reason)) {
    return "Improvement rejected: text fails validation (may contain special instructions or be too short)."
  }

  const patterns = pending.weaknesses ?? [pending.reason]

  if (pending.target === "agent_prompt" && pending.agent_name) {
    // Built-in opencode agents (build, plan, general, ...) have hard-coded
    // prompts shipped with opencode. `.opencode/agents/<name>.md` is only
    // consulted when `agent.<name>.prompt` in `opencode.json` is set to a
    // `{file:...}` directive or inline string. If a built-in agent has no
    // defined prompt, creating a markdown file at the conventional path
    // produces a dead file that opencode never reads. Reroute the
    // improvement to AGENTS.md in that case — built-in agents always
    // honour the project rules file.
    const source = await ctx.agentPrompts.resolve(pending.agent_name)
    if (source.kind === "missing" && isBuiltinAgentName(pending.agent_name)) {
      const rerouted: ImprovementRecord = {
        ...pending,
        target: "agents_md",
      }
      return applyAgentsMd(rerouted, patterns, ctx, {
        rerouteNote: `Rerouted from agent_prompt:"${pending.agent_name}" — built-in agent has no defined prompt; improvement applied to AGENTS.md instead.`,
      })
    }

    const promptExisted = await ctx.agentPrompts.exists(pending.agent_name)

    let agentMode = "subagent"
    for (const [, info] of ctx.agentRegistry) {
      if (info.agentName === pending.agent_name) {
        agentMode = info.agentType === "primary" ? "primary" : "subagent"
        break
      }
    }

    const backupPath = await ctx.agentPrompts.injectSection(
      pending.agent_name,
      "Kasper Inferred Instructions",
      pending.reason,
      BACKUP_ENABLED,
      BACKUP_MAX_VERSIONS,
      agentMode,
      ctx.config.agent_prompt_inject_mode,
    )
    ctx.stateStore.recordImprovement({
      ...pending,
      backup_path: backupPath ?? "",
    })
    ctx.stateStore.resetWeaknessCounts(patterns)

    const restartNote = promptExisted
      ? ""
      : "\n\n**Note**: Restart opencode for the new prompt file to take effect."
    showToast(
      ctx.client,
      "Kasper",
      `${pending.agent_name} agent prompt updated — restore from .opencode/kasper/backups/ if needed`,
      "success",
    )
    const remaining = ctx.improvementsPending.length
    const hint =
      remaining > 0
        ? `\n\nUse /kasper apply <n> to apply remaining (${remaining} pending).`
        : ""
    return `${pending.agent_name} agent prompt updated:\n> ${pending.reason.slice(0, 200)}\n\nRestore from .opencode/kasper/backups/ if needed${hint}${restartNote}`
  }

  return applyAgentsMd(pending, patterns, ctx)
}

async function applyAgentsMd(
  pending: ImprovementRecord,
  patterns: string[],
  ctx: KasperContext,
  opts: { rerouteNote?: string } = {},
): Promise<string> {
  let backupPath = ""
  await ctx.agentsMd.lockedUpdate(async (existing) => {
    if (BACKUP_ENABLED) {
      backupPath = await ctx.agentsMd.backup("manual-apply")
    }
    return ctx.agentsMd.injectSection(
      existing,
      "Kasper Inferred Instructions",
      pending.reason,
    )
  })
  ctx.stateStore.recordImprovement({ ...pending, backup_path: backupPath })
  ctx.stateStore.resetWeaknessCounts(patterns)
  showToast(
    ctx.client,
    "Kasper",
    "AGENTS.md updated — restore from .opencode/kasper/backups/ if needed",
    "success",
  )
  const remaining = ctx.improvementsPending.length
  const hint =
    remaining > 0
      ? `\n\nUse /kasper apply <n> to apply remaining (${remaining} pending).`
      : ""
  const reroute = opts.rerouteNote ? `\n\n${opts.rerouteNote}` : ""
  return `AGENTS.md updated:\n> ${pending.reason.slice(0, 200)}\n\nRestore from .opencode/kasper/backups/ if needed${hint}${reroute}`
}
