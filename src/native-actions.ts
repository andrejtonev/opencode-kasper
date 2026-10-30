import { calendarDate, positiveInteger } from "./actions.js"
import type {
  CommandRequest,
  CommandResult,
  parseCommand,
} from "./command-results.js"
import { evaluateSession, evaluateSessions } from "./evaluate.js"
import { dispatchKasperCommand } from "./handlers.js"
import type { KasperContext } from "./types.js"

export async function executeNativeAction(
  request: CommandRequest,
  parsed: ReturnType<typeof parseCommand>,
  ctx: KasperContext,
): Promise<Pick<CommandResult, "status" | "text">> {
  if (ctx.lifetimeSignal?.aborted)
    return { status: "cancelled", text: "Kasper is unloaded." }
  if (!ctx.historyHost)
    return {
      status: "unsupported",
      text: "Native history host is unavailable.",
    }
  const revision = ctx.runtime?.capture(request.sessionID)
  const source = await ctx.historyHost.get(request.sessionID, {
    signal: ctx.lifetimeSignal,
  })
  if (revision) ctx.runtime?.assertCurrent(request.sessionID, revision)
  ctx.lifetimeSignal?.throwIfAborted()
  if (source.agent)
    ctx.agentRegistry.set(source.id, {
      agentName: source.agent,
      agentType: source.parentID ? "subagent" : "primary",
      parentSessionID: source.parentID,
    })
  const { action, arg } = parsed
  if (action === "status") {
    const text = await dispatchKasperCommand(
      action,
      arg,
      request.sessionID,
      ctx,
    )
    const coverage = await ctx.instructionCoverage?.(source.agent)
    return {
      status: "ok",
      text: `${text}\n\nNative capabilities: direct commands/results; historical archive ${ctx.historyArchiveAvailable ? "available" : "requires an explicit trusted connection"}; instruction coverage ${coverage?.complete ? "complete" : "incomplete"}${coverage?.issues.length ? ` (${coverage.issues.join("; ")})` : ""}. Instruction activation is unconfirmed.`,
    }
  }
  if (action === "migrate")
    return {
      status: "unsupported",
      text: "Native agent migration requires proven editable source ownership. Use an explicit editable_agents target or agent_overlays; source factories are read-only.",
    }
  if (action === "pause" || action === "resume") {
    ctx.runtime?.invalidateAll()
    ctx.kasperPaused = action === "pause"
    return {
      status: "ok",
      text: ctx.kasperPaused
        ? "Automatic evaluation paused."
        : "Automatic evaluation resumed.",
    }
  }
  if (action === "config")
    return { status: "ok", text: JSON.stringify(ctx.config, null, 2) }
  if (action === "auto") ctx.runtime?.invalidateAll()
  if (action === "score" && arg.startsWith("agent ")) {
    const agent = arg.slice(6).trim()
    if (!agent || /\s/.test(agent))
      return {
        status: "unsupported",
        text: "Agent scoring requires one exact agent identity.",
      }
    const sessions = (
      await ctx.historyHost.list({ signal: ctx.lifetimeSignal })
    ).filter((session) => session.agent === agent)
    const outcomes = await evaluateSessions(
      sessions.map((session) => session.id),
      ctx,
      new Map(sessions.map((session) => [session.id, agent])),
    )
    return {
      status: outcomes.some((item) => item.status === "unsupported")
        ? "unsupported"
        : outcomes.some((item) => item.status === "failed")
          ? "failed"
          : "ok",
      text:
        outcomes
          .map((item) => `${item.sessionID}: ${item.detail}`)
          .join("\n\n") || "No sessions matched this agent.",
    }
  }
  if (action === "score" && !arg.startsWith("agent ")) {
    const selector = arg.replace(/^session(?:\s+|$)/i, "").trim()
    const last = selector.match(/^last\s+(\d+)$/i),
      since = selector.match(/^since\s+(\S+)$/i),
      range = selector.match(/^range\s+(\S+)\s+(\S+)$/i)
    if (last || since || range) {
      const count = last ? Number(last[1]) : undefined
      const start = since
        ? calendarDate(since[1])
        : range
          ? calendarDate(range[1])
          : undefined
      const end = range ? calendarDate(range[2]) : new Date()
      if (
        (last && !positiveInteger(count)) ||
        (!last && (!start || !end || end < start))
      )
        return {
          status: "unsupported",
          text: "Invalid count or calendar date range.",
        }
      const sessions = (
        await ctx.historyHost.list({ signal: ctx.lifetimeSignal })
      )
        .filter(
          (session) =>
            !ctx.deletedSessions.has(session.id) &&
            !ctx.kasperSessionIDs.has(session.id),
        )
        .sort((a, b) => b.time.updated - a.time.updated)
      const selected = count
        ? sessions.slice(0, count)
        : sessions.filter(
            (session) =>
              start &&
              end &&
              session.time.created >= start.getTime() &&
              session.time.created <= end.getTime(),
          )
      const outcomes = await evaluateSessions(
        selected.map((session) => session.id),
        ctx,
        new Map(
          selected.flatMap((session) =>
            session.agent ? [[session.id, session.agent]] : [],
          ),
        ),
      )
      return {
        status: outcomes.some((outcome) => outcome.status === "unsupported")
          ? "unsupported"
          : outcomes.some((outcome) => outcome.status === "failed")
            ? "failed"
            : "ok",
        text:
          outcomes
            .map((outcome) => `${outcome.sessionID}: ${outcome.detail}`)
            .join("\n\n") || "No sessions matched.",
      }
    }
    if (/^(last|since|range)\b/i.test(selector) || /\s/.test(selector))
      return {
        status: "unsupported",
        text: "Invalid session scoring selector.",
      }
    const target = selector || request.sessionID
    await ctx.historyHost.get(target, {
      signal: ctx.runtime?.sessionSignal(target) ?? ctx.lifetimeSignal,
    })
    const outcome = await evaluateSession(target, ctx)
    return {
      status:
        outcome.status === "unsupported"
          ? "unsupported"
          : outcome.status === "cancelled"
            ? "cancelled"
            : outcome.status === "failed"
              ? "failed"
              : "ok",
      text: outcome.detail,
    }
  }
  if (action === "improve" || action === "apply") {
    const agent =
      action === "improve"
        ? arg
            .split(/\s+/)
            .filter((token) => token && !token.startsWith("--"))
            .join(" ") || source.agent
        : source.agent
    const coverage = await ctx.instructionCoverage?.(agent)
    if (!agent || (coverage && !coverage.complete))
      return {
        status: "unsupported",
        text: `Instruction coverage is incomplete: ${coverage?.issues.join("; ") ?? "active agent identity is unavailable"}`,
      }
    if (action === "apply") {
      const pending =
        arg === "all"
          ? ctx.improvementsPending
          : [ctx.improvementsPending[(arg ? Number(arg) : 1) - 1]].filter(
              Boolean,
            )
      for (const item of pending) {
        const itemCoverage = await ctx.instructionCoverage?.(
          item.agent_name ?? agent,
        )
        if (itemCoverage && !itemCoverage.complete)
          return {
            status: "unsupported",
            text: "Pending improvement instruction coverage is incomplete.",
          }
        if (item.target === "agent_prompt") {
          const source = await ctx.agentPrompts.resolve(
            item.agent_name ?? agent,
          )
          if (source.kind !== "editable" && source.kind !== "overlay")
            return {
              status: "unsupported",
              text: "This agent prompt has no explicitly editable source; its origin is read-only.",
            }
        }
      }
    }
  }
  const selected =
    action === "apply"
      ? (arg === "all"
          ? ctx.improvementsPending
          : [ctx.improvementsPending[(arg ? Number(arg) : 1) - 1]].filter(
              Boolean,
            )
        ).map((item) => item.id)
      : []
  const text = await dispatchKasperCommand(action, arg, request.sessionID, ctx)
  return {
    status: ctx.lifetimeSignal?.aborted
      ? "cancelled"
      : selected.some((id) =>
            ctx.improvementsPending.some((item) => item.id === id),
          )
        ? "failed"
        : "ok",
    text,
  }
}
