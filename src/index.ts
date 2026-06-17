import { mkdir, readdir, rm, stat } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import type { Config, Plugin } from "@opencode-ai/plugin"
import type { Event, Part, UserMessage } from "@opencode-ai/sdk"
import { AgentPromptManager } from "./agent-prompts.js"
import { AgentsMdManager } from "./agents-md.js"
import { resolveAgentsMdSource } from "./agents-md-resolver.js"
import {
  ensureDefaultKasperConfigFile,
  loadKasperConfig,
  resolveGlobalOpencodeDir,
} from "./config.js"
import {
  BACKUP_MAX_VERSIONS,
  CONFIG_POLL_INTERVAL_MS,
  LOG_MAX_LINES,
  MAX_AGENT_SESSION_IDS,
  MAX_EVAL_DURATION_MS,
  MAX_SESSION_PARENTS,
  MAX_TRACKED_DELETED_IDS,
  PARENT_CLEANUP_BATCH,
  SDK_TIMEOUT_MS,
  SESSION_DEBOUNCE_MS,
} from "./constants.js"
import {
  buildEvalFromMessages,
  evaluateChildSessions,
  runEvaluation,
} from "./evaluate.js"
import { dispatchKasperCommand } from "./handlers.js"
import { KasperLogger } from "./logging.js"
import { AsyncMutex } from "./mutex.js"
import { clearWriteLocks } from "./prompt-utils.js"
import { _stateStoreRegistry } from "./registry.js"
import { Scorer } from "./scorer.js"
import { KasperStateStore } from "./state.js"
import { createKasperTools } from "./tools.js"

import type {
  AgentSessionInfo,
  ImprovementRecord,
  KasperConfig,
  KasperContext,
} from "./types.js"
import {
  deepEqual,
  formatScore,
  getSessionID,
  isKasperSession,
  showToast,
  withTimeout,
} from "./utils.js"

// Runtime hooks not present in the official @opencode-ai/plugin Hooks type.
// They are dispatched dynamically by the SDK and supplement the polling mechanism.
interface RuntimeHookEvent {
  event?: {
    type?: string
    properties?: {
      info?: {
        id?: string
        sessionID?: string
        title?: string
        agent?: string
        parentID?: string
      }
    }
  }
  info?: Record<string, unknown>
  sessionID?: string
  session?: { id?: string }
  properties?: Record<string, unknown>
}

async function cleanupStaleTempFiles(stateDir: string): Promise<void> {
  try {
    const entries = await readdir(stateDir)
    for (const entry of entries) {
      if (entry.includes(".tmp-")) {
        try {
          await rm(join(stateDir, entry), { force: true })
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* directory may not exist yet */
  }
}

/**
 * Delete kasper-prefixed sessions that are not tracked by the current plugin
 * instance. This is purely a hygiene step - the polling loop already skips
 * kasper sessions, so leaving them in the server has no functional impact.
 * We use a short, bounded timeout here (SDK_TIMEOUT_MS / 2) because this is
 * a background task and we don't want a slow server to make it pile up.
 */
async function cleanupStaleKasperSessions(
  ctx: KasperContext,
  logger: KasperLogger,
): Promise<void> {
  if (!ctx.client.session.list || !ctx.client.session.delete) return
  const cleanupStart = Date.now()
  try {
    const allSessions = await withTimeout(
      ctx.client.session.list(),
      Math.max(1000, Math.floor(SDK_TIMEOUT_MS / 2)),
      "stale.session.list",
    )
    const sessions = allSessions.data ?? []
    const stale = sessions.filter(
      (s) => isKasperSession(s.title) && !ctx.kasperSessionIDs.has(s.id),
    )
    if (stale.length === 0) return

    await logger.log("stale_kasper_cleanup_start", {
      count: stale.length,
      sessionIDs: stale.map((s) => s.id),
    })
    for (const s of stale) {
      try {
        await ctx.client.session.delete({ path: { id: s.id } })
        ctx.kasperSessionIDs.add(s.id)
        await logger.log("stale_kasper_deleted", { sessionID: s.id })
      } catch (e) {
        await logger.log("stale_kasper_delete_failed", {
          sessionID: s.id,
          error: String(e),
        })
      }
    }
    await logger.log("stale_kasper_cleanup_done", {
      total: stale.length,
      durationMs: Date.now() - cleanupStart,
    })
  } catch (e) {
    await logger.log("stale_kasper_cleanup_error", { error: String(e) })
  }
}

interface HealthReport {
  ok: boolean
  checks: Array<{ name: string; ok: boolean; detail: string }>
}

interface HealthProbe {
  name: string
  path: string
  // Detail to use when the path exists and the check is ok (presence check).
  presentDetail: string
  // Detail to use when the path is missing and the check is failing.
  absentDetail?: string
  // If set, the check INVERTS: a present path is failing (a "stale" check,
  // e.g. leftover lock file) and a missing path is ok.
  failingWhenPresentDetail?: string
}

async function probePaths(
  probes: HealthProbe[],
): Promise<HealthReport["checks"]> {
  // Run all stat() calls concurrently - each is a single syscall, and
  // they are independent. Sequential awaiting was adding ~5 stat-roundtrips
  // to startup time on cold cache.
  const results = await Promise.all(
    probes.map(async (p) => {
      try {
        await stat(p.path)
        if (p.failingWhenPresentDetail) {
          return {
            name: p.name,
            ok: false,
            detail: p.failingWhenPresentDetail,
          }
        }
        return { name: p.name, ok: true, detail: p.presentDetail }
      } catch {
        if (p.failingWhenPresentDetail) {
          return { name: p.name, ok: true, detail: p.presentDetail }
        }
        return { name: p.name, ok: false, detail: p.absentDetail ?? "" }
      }
    }),
  )
  return results
}

async function runHealthCheck(
  stateDir: string,
  config: KasperConfig,
  logger: KasperLogger,
  agentsMdPath: string,
  agentsMdReason: string,
): Promise<HealthReport> {
  const backupDir = join(stateDir, "backups")
  const lockPath = join(stateDir, "state.json.lock")
  const stateFilePath = join(stateDir, "state.json")

  const checks = await probePaths([
    {
      name: "state_dir",
      path: stateDir,
      presentDetail: stateDir,
      absentDetail: `${stateDir} missing - will be created`,
    },
    {
      name: "state_file",
      path: stateFilePath,
      presentDetail: "exists",
      absentDetail: "not yet created",
    },
    {
      name: "agents_md",
      path: agentsMdPath,
      // Surface the resolver's reason so the user can tell where the
      // path came from (configured / local-walkup / global-opencode /
      // global-claude / opencode-config-dir / fallback-project-root).
      presentDetail: `${agentsMdPath} (${agentsMdReason})`,
      absentDetail: `no rules file found at resolved location (${agentsMdReason})`,
    },
    {
      name: "backup_dir",
      path: backupDir,
      presentDetail: backupDir,
      absentDetail: "will be created on first backup",
    },
    {
      name: "lock_file",
      path: lockPath,
      presentDetail: "no stale lock",
      failingWhenPresentDetail: "stale lock file detected (will auto-clear)",
    },
  ])

  const hasModel = !!config.model?.includes("/")
  checks.push({
    name: "model",
    ok: hasModel,
    detail: hasModel ? config.model : `invalid model format: ${config.model}`,
  })

  await logger.log("health_check", {
    checks,
    config_model: config.model,
    config_auto_update: config.auto_update,
    config_threshold: config.scoring_threshold,
  })

  return {
    ok: checks.every((c) => c.ok),
    checks,
  }
}

function extractAgentInfo(input: unknown): {
  parentID?: string
  agentName?: string
} {
  const obj = (input ?? {}) as Record<string, unknown>
  const event = (obj.event ?? {}) as Record<string, unknown>
  const eventProps = (event.properties ?? {}) as Record<string, unknown>
  const info = (eventProps.info ?? obj.info ?? {}) as Record<string, unknown>
  return {
    parentID: typeof info?.parentID === "string" ? info.parentID : undefined,
    agentName: typeof info?.agent === "string" ? info.agent : undefined,
  }
}

const KasperPlugin: Plugin = async ({ client, directory }) => {
  const cwd = directory || process.cwd()
  const config = await loadKasperConfig(cwd)

  if (!config.enabled) return {}

  const globalDir = resolveGlobalOpencodeDir()
  await ensureDefaultKasperConfigFile(globalDir)

  const stateDir = config.state_dir
    ? isAbsolute(config.state_dir)
      ? config.state_dir
      : join(cwd, config.state_dir)
    : join(cwd, ".opencode", "kasper")
  await mkdir(stateDir, { recursive: true })
  await cleanupStaleTempFiles(stateDir)

  const logger = new KasperLogger(stateDir, LOG_MAX_LINES)
  await logger.init()

  await logger.log("plugin_loaded", {
    model: config.model,
    autoUpdate: config.auto_update,
    threshold: config.scoring_threshold,
  })

  // Resolve the project's rules file BEFORE the health check so the
  // health check reports the path the resolver will actually use
  // (which may be a configured `agents_md_paths` entry, an ancestor's
  // AGENTS.md, the global opencode dir, or `~/.claude/CLAUDE.md`).
  // Pre-fix the health check hardcoded `<cwd>/AGENTS.md` and reported
  // it as missing even when the resolver had found a valid file
  // elsewhere.
  const agentsMdSource = await resolveAgentsMdSource(cwd, {
    agentsMdPaths: config.agents_md_paths,
    globalOpencodeDir: globalDir,
  })

  const health = await runHealthCheck(
    stateDir,
    config,
    logger,
    agentsMdSource.primary,
    agentsMdSource.reason,
  )
  if (!health.ok) {
    const failChecks = health.checks.filter((c) => !c.ok)
    for (const c of failChecks) {
      await logger.log("health_check_warn", { name: c.name, detail: c.detail })
    }
  }

  const stateStore = new KasperStateStore(
    join(stateDir, "state.json"),
    stateDir,
    config,
    logger,
  )
  _stateStoreRegistry.set(directory, stateStore)
  await stateStore.init()

  if (stateStore.getAggregate().total_sessions === 0) {
    showToast(
      client,
      "Kasper",
      "Kasper active — scoring sessions and suggesting improvements. Type /kasper status to get started.",
      "info",
      8000,
    )
  }

  const agentsMd = new AgentsMdManager(
    agentsMdSource.primary,
    stateDir,
    BACKUP_MAX_VERSIONS,
  )
  await agentsMd.init()

  const agentPrompts = new AgentPromptManager(
    cwd,
    stateDir,
    globalDir,
    config.prompt_paths,
  )
  await agentPrompts.init()

  const scorer = new Scorer(config, logger)
  const agentRegistry = new Map<string, AgentSessionInfo>()
  const sessionsEvaluated = new Set<string>()
  const persistedEvaluated = stateStore.getEvaluatedSessions()
  for (const sid of persistedEvaluated) {
    sessionsEvaluated.add(sid)
  }
  const improvementsPending: ImprovementRecord[] = []

  const parentToChildren = new Map<string, Set<string>>()
  const sessionParents = new Map<string, string>()
  const deletedSessions = new Set<string>()
  const kasperSessionIDs = new Set<string>()
  const idleSessions = new Set<string>()

  let lastActiveSessionID: string | undefined
  const pluginStartTime = Date.now()

  const ctx: KasperContext = {
    stateStore,
    agentsMd,
    agentPrompts,
    scorer,
    agentRegistry,
    client,
    config,
    logger,
    pluginStartTime,
    lastActiveSessionID,
    sessionsEvaluated,
    improvementsPending,
    parentToChildren,
    sessionParents,
    deletedSessions,
    kasperSessionIDs,
    idleSessions,
    autoUpdateEnabled: config.auto_update,
    agentSessionIDs: new Map(),
    rejectedPatterns: new Set(stateStore.getRejectedPatterns()),
    userGuidance: new Map(),
    kasperPaused: false,
    evalMutex: new AsyncMutex(),
    evaluationRunning: false,
    evaluationStartedAt: undefined,
    isMergingWeaknesses: false,
    registeredCommands: new Set(),
    sessionMsgCount: new Map(),
  }

  let configReloading = false
  const configReloadTimer = setInterval(async () => {
    if (configReloading) return
    configReloading = true
    try {
      const fresh = await loadKasperConfig(cwd, true)
      const changed = !deepEqual(fresh, ctx.config)
      if (!changed) return
      const prevModel = ctx.config.model
      ctx.config = fresh
      ctx.stateStore.reloadConfig(fresh)
      ctx.scorer.reloadModel(fresh)
      // Re-resolve the rules file if `agents_md_paths` changed, and
      // push the new resolver inputs into the agent-prompt manager.
      // Pre-fix, the reload timer only invalidated the AGENTS.md
      // *content* cache — it left the managers pinned to old paths
      // until opencode restarted, so editing `agents_md_paths` or
      // `prompt_paths` in `kasper.json` had no effect (B4).
      const newAgentsMdSource = await resolveAgentsMdSource(cwd, {
        agentsMdPaths: fresh.agents_md_paths,
        globalOpencodeDir: globalDir,
      })
      ctx.agentsMd.setResolvedPath(newAgentsMdSource.primary)
      ctx.agentPrompts.setResolverInputs(globalDir, fresh.prompt_paths)
      await ctx.logger.log("config_reloaded", {
        model: fresh.model,
        prevModel,
        autoUpdate: fresh.auto_update,
        threshold: fresh.scoring_threshold,
        agentsMdPath: newAgentsMdSource.primary,
        agentsMdReason: newAgentsMdSource.reason,
      })
    } catch {
      await ctx.logger.log("debug", {
        context: "config_reload",
        detail: "config load failure is non-fatal",
      })
    } finally {
      configReloading = false
    }
  }, CONFIG_POLL_INTERVAL_MS)
  ctx.configReloadTimer = configReloadTimer

  // Stale kasper-session cleanup is hygiene, not correctness: pollAndEvaluate
  // (line 757) already filters kasper sessions out of the polling set, so the
  // user-facing prompt is unaffected by leaving them in the server. We used
  // to await client.session.list() synchronously here, but the opencode
  // server's HTTP listener may not be bound yet at plugin-init time, and the
  // call then waited the full SDK_TIMEOUT_MS (30s) before timing out. That
  // blocked opencode startup. Defer the work to the next event-loop tick
  // (and a short retry) so init returns immediately. The helper guards on
  // client.session.list / .delete being present at runtime.
  const cleanupAttempts = [0, 500]
  for (const delayMs of cleanupAttempts) {
    setTimeout(() => {
      cleanupStaleKasperSessions(ctx, logger).catch(() => {
        /* errors are logged inside the helper */
      })
    }, delayMs)
  }

  const evaluationPollTimer = setInterval(async () => {
    if (ctx.kasperPaused) return

    if (ctx.evaluationRunning) {
      if (
        ctx.evaluationStartedAt &&
        Date.now() - ctx.evaluationStartedAt > MAX_EVAL_DURATION_MS
      ) {
        ctx.logger.log("eval_timeout_skip", {
          startedAt: new Date(ctx.evaluationStartedAt).toISOString(),
          duration: Date.now() - ctx.evaluationStartedAt,
        })
        ctx.evaluationRunning = false
      }
      return
    }

    ctx.evaluationRunning = true
    ctx.evaluationStartedAt = Date.now()
    try {
      await pollAndEvaluate(ctx)
    } finally {
      ctx.evaluationRunning = false
    }
  }, config.evaluation_poll_interval_ms)
  ctx.evaluationPollTimer = evaluationPollTimer

  async function gracefulShutdown(
    ctx: KasperContext,
    configReloadTimer: ReturnType<typeof setInterval>,
    evaluationPollTimer: ReturnType<typeof setInterval>,
  ): Promise<void> {
    clearInterval(configReloadTimer)
    clearInterval(evaluationPollTimer)
    clearWriteLocks()
    await ctx.logger.log("plugin_unloaded", {
      sessionsEvaluated: ctx.sessionsEvaluated.size,
      improvementsPending: ctx.improvementsPending.length,
    })
    await ctx.stateStore.destroy()
  }

  return {
    config: async (opencodeConfig: Config) => {
      try {
        opencodeConfig.command ??= {}
        const commandConfig = opencodeConfig.command as Record<string, unknown>
        if (!commandConfig.kasper) {
          commandConfig.kasper = {
            template: `/kasper $ARGUMENTS

Call the matching kasper_* tool:
- status → kasper_status (agent param for per-agent detail)
- history → kasper_history
- score session → kasper_score_session (session_id, count=n, since=YYYY-MM-DD)
- improve → kasper_improve (show user the table, let them pick [N])
- apply → kasper_apply (index=N)
- reset → kasper_reset
- config → (handled by slash command)
- help → (handled by slash command)`,
            description:
              "Inspect or control the Kasper plugin (status|score|improve|apply|history|config|reset|help)",
            suggested: true,
          }
        }

        ctx.registeredCommands.clear()
        for (const key of Object.keys(commandConfig)) {
          ctx.registeredCommands.add(key.toLowerCase())
        }
      } catch (err) {
        process.stderr.write(
          `[kasper] Config hook error: ${err instanceof Error ? err.stack : String(err)}\n`,
        )
        throw err
      }
    },

    event: async (input: { event: Event }) => {
      const evt = input.event as unknown as Record<string, unknown>
      const name =
        (evt?.type as string) ||
        (evt?.name as string) ||
        (evt?.event as string) ||
        (evt?.kind as string) ||
        "unknown_event"

      if (name === "error" || name === "unhandled_rejection") {
        return handleErrorEvent(name, evt, ctx)
      }

      if (name === "session.idle") {
        const sid =
          ((evt.properties as Record<string, unknown>)?.sessionID as string) ||
          ((evt.info as Record<string, unknown>)?.id as string) ||
          ((evt as Record<string, unknown>).sessionID as string)
        if (sid) {
          ctx.idleSessions.add(sid)
          await ctx.logger.log("session_idle", { sessionID: sid })
        }
        return
      }

      if (!config.debug) return
      await ctx.logger.log("sdk_event", {
        name,
        keys: Object.keys(evt).slice(0, 20),
      })
    },

    tool: createKasperTools(ctx),

    "command.execute.before": async (
      input: { command: string; sessionID: string; arguments: string },
      output: { parts: Part[] },
    ) => {
      // The SDK type only declares { parts: Part[] }, but the runtime also reads
      // .message and .stop for command interception.
      const out = output as typeof output & { message?: string; stop?: boolean }

      const commandName = input.command.replace(/^\/+/, "").toLowerCase()
      if (commandName !== "kasper") return

      const rawArg =
        input.arguments ?? (input as { argument?: string }).argument ?? ""
      const action = rawArg.trim().split(/\s+/)[0] || ""
      const restArg = rawArg.slice(action.length).trim()
      const sessionID = input.sessionID

      try {
        const result = await dispatchKasperCommand(
          action,
          restArg,
          sessionID,
          ctx,
        )
        out.message = result
      } catch (err) {
        out.message = `Kasper error: ${err instanceof Error ? err.message : String(err)}`
        await ctx.logger.log("command_error", { action, error: String(err) })
      }
      out.stop = true
    },

    "session.created": async (input: RuntimeHookEvent) => {
      const sessionID = getSessionID(input)
      if (!sessionID) return

      const info: Record<string, unknown> =
        (input?.event?.properties?.info as Record<string, unknown>) ??
        input?.info ??
        {}
      const title = typeof info?.title === "string" ? info.title : ""
      if (title && isKasperSession(title)) {
        ctx.kasperSessionIDs.add(sessionID)
        return
      }

      ctx.deletedSessions.delete(sessionID)
      ctx.idleSessions.delete(sessionID)
      ctx.lastActiveSessionID = sessionID

      const { parentID, agentName } = extractAgentInfo(input)

      if (agentName) {
        agentRegistry.set(sessionID, {
          agentName,
          agentType: parentID ? "subagent" : "primary",
          parentSessionID: parentID,
        })
        const ids = ctx.agentSessionIDs.get(agentName) ?? []
        ids.push(sessionID)
        if (ids.length > MAX_AGENT_SESSION_IDS) ids.shift()
        ctx.agentSessionIDs.set(agentName, ids)
      }

      if (parentID) {
        if (sessionParents.size > MAX_SESSION_PARENTS) {
          const toRemove = [...sessionParents.keys()].slice(
            0,
            PARENT_CLEANUP_BATCH,
          )
          for (const id of toRemove) {
            sessionParents.delete(id)
            parentToChildren.delete(id)
          }
        }
        sessionParents.set(sessionID, parentID)
        let children = parentToChildren.get(parentID)
        if (!children) {
          children = new Set()
          parentToChildren.set(parentID, children)
        }
        children.add(sessionID)

        ctx.logger.log("subagent_created", {
          sessionID,
          parentID,
          agentName,
        })
        return
      }

      ctx.logger.log("session_created", { sessionID, agentName })
    },

    "session.updated": async (input: RuntimeHookEvent) => {
      const sessionID = getSessionID(input)
      if (!sessionID) return
      ctx.deletedSessions.delete(sessionID)
      ctx.idleSessions.delete(sessionID)
      ctx.lastActiveSessionID = sessionID

      const { parentID, agentName } = extractAgentInfo(input)

      if (agentName && !agentRegistry.has(sessionID)) {
        agentRegistry.set(sessionID, {
          agentName,
          agentType: parentID ? "subagent" : "primary",
          parentSessionID: parentID,
        })
      }
    },

    "session.deleted": async (input: RuntimeHookEvent) => {
      const sessionID = getSessionID(input)
      if (!sessionID) return

      ctx.deletedSessions.add(sessionID)
      if (ctx.deletedSessions.size > MAX_TRACKED_DELETED_IDS) {
        const toRemove = [...ctx.deletedSessions].slice(
          0,
          ctx.deletedSessions.size - MAX_TRACKED_DELETED_IDS,
        )
        for (const id of toRemove) ctx.deletedSessions.delete(id)
      }
      agentRegistry.delete(sessionID)
      sessionParents.delete(sessionID)
      ctx.kasperSessionIDs.delete(sessionID)
      ctx.sessionMsgCount.delete(sessionID)

      for (const [agent, ids] of ctx.agentSessionIDs.entries()) {
        const idx = ids.indexOf(sessionID)
        if (idx !== -1) {
          ids.splice(idx, 1)
          if (ids.length === 0) ctx.agentSessionIDs.delete(agent)
          break
        }
      }

      const children = parentToChildren.get(sessionID)
      if (children) {
        for (const child of children) {
          sessionParents.delete(child)
        }
        parentToChildren.delete(sessionID)
      }

      for (const [parent, childSet] of parentToChildren.entries()) {
        if (childSet.has(sessionID)) {
          childSet.delete(sessionID)
          if (childSet.size === 0) parentToChildren.delete(parent)
          break
        }
      }

      ctx.logger.log("session_deleted", { sessionID })
    },

    "message.updated": async (input: RuntimeHookEvent) => {
      const sessionID = getSessionID(input) || input.sessionID
      if (!sessionID) return

      ctx.lastActiveSessionID = sessionID
      ctx.idleSessions.delete(sessionID)
      if (ctx.deletedSessions.has(sessionID)) return
    },

    "chat.message": async (
      input: {
        sessionID: string
        agent?: string
        model?: { providerID: string; modelID: string }
        messageID?: string
        variant?: string
      },
      _output: { message: UserMessage; parts: Part[] },
    ) => {
      const sessionID = input.sessionID
      ctx.lastActiveSessionID = sessionID
      ctx.idleSessions.delete(sessionID)
      if (ctx.deletedSessions.has(sessionID)) return
      if (ctx.kasperSessionIDs.has(sessionID)) return
    },

    "experimental.session.compacting": async (
      input: { sessionID: string },
      output: { context: string[]; prompt?: string },
    ) => {
      const sessionID = input.sessionID
      if (ctx.kasperSessionIDs.has(sessionID)) return

      const agg = ctx.stateStore.getAggregate()
      if (agg.total_sessions === 0) return

      const lines: string[] = []

      const { emoji: scoreEmoji, pct: scorePct } = formatScore(agg.avg_score)
      const recent = ctx.stateStore.getRecentSessions(5)
      let trend = ""
      if (recent.length >= 2) {
        const sorted = [...recent].sort((a, b) => a.timestamp - b.timestamp)
        const first = sorted[0].score
        const last = sorted[sorted.length - 1].score
        const delta = last - first
        if (delta > 0.05) trend = " \u2191 improving"
        else if (delta < -0.05) trend = " \u2193 worsening"
        else trend = " \u2192 stable"
        lines.push(`**Overall score**: ${scoreEmoji} ${scorePct}%${trend}`)
      }

      const topWeak = agg.top_weaknesses.slice(0, 3)
      if (topWeak.length > 0) {
        lines.push(`## Kasper Feedback`)
        lines.push(
          `The following issues have been observed across ${agg.total_sessions} session(s):`,
        )
        for (const w of topWeak) {
          lines.push(
            `${topWeak.indexOf(w) + 1}. **${w.pattern}** (appeared ${w.count} time(s))`,
          )
        }
        lines.push(
          `Current average adherence score: ${scoreEmoji} ${scorePct}%`,
        )
        lines.push(``)
        lines.push(
          `Review these patterns and adjust your approach accordingly.`,
        )
      }

      const agentInfo = agentRegistry.get(sessionID)
      if (agentInfo) {
        const agentAgg = ctx.stateStore.getAgentAggregate(agentInfo.agentName)
        if (agentAgg && agentAgg.total_sessions > 0) {
          lines.push(``)
          lines.push(`### ${agentInfo.agentName} Agent Stats`)
          lines.push(
            `Sessions: ${agentAgg.total_sessions}, Avg Score: ${(agentAgg.avg_score * 100).toFixed(0)}%`,
          )
          if (agentAgg.top_weaknesses.length > 0) {
            lines.push(`Top weaknesses for ${agentInfo.agentName}:`)
            for (const w of agentAgg.top_weaknesses.slice(0, 3)) {
              lines.push(`- **${w.pattern}** (${w.count}x)`)
            }
          }
        }
      }

      if (lines.length > 0) {
        if (!Array.isArray(output.context)) output.context = []
        output.context.push(lines.join("\n"))
      }
    },

    close: async () => {
      await gracefulShutdown(ctx, configReloadTimer, evaluationPollTimer)
      _stateStoreRegistry.delete(directory)
    },
  }
}

async function pollAndEvaluate(ctx: KasperContext): Promise<void> {
  if (!ctx.client.session.list || !ctx.client.session.messages) return

  try {
    const installedAt = ctx.stateStore.getInstalledAt()

    const result = await withTimeout(
      ctx.client.session.list(),
      SDK_TIMEOUT_MS,
      "session.list",
    )
    const allSessions = result.data ?? []
    const sessions = allSessions.filter((s) => {
      if (!s.id) return false
      if (s.time.created < installedAt) return false
      if (ctx.deletedSessions.has(s.id)) return false
      if (s.title && isKasperSession(s.title)) {
        ctx.kasperSessionIDs.add(s.id)
        return false
      }
      if (ctx.kasperSessionIDs.has(s.id)) return false
      if (Date.now() - s.time.updated < SESSION_DEBOUNCE_MS * 3) return false
      return true
    })
    if (allSessions.length > 0 && sessions.length === 0) {
      await ctx.logger.log("poll_filter_all", {
        totalSessions: allSessions.length,
        filteredOut: allSessions.length,
        installedAt,
      })
    }

    for (const s of sessions) {
      const sid = s.id
      if (!sid) continue
      const agentInfo = ctx.agentRegistry.get(sid)
      const agentName =
        s.agent || s.agentName || s.subagent_type || agentInfo?.agentName

      const msgsResult = await withTimeout(
        ctx.client.session.messages({ path: { id: sid } }),
        SDK_TIMEOUT_MS,
        "session.messages",
      )
      const msgs = msgsResult?.data ?? []
      if (!msgs.length) continue

      let lastMsgId: string | undefined
      if (ctx.sessionsEvaluated.has(sid)) {
        const existing = ctx.stateStore.getSession(sid)
        if (existing?.last_msg_id) {
          const foundIdx = msgs.findIndex(
            (m) => m.info?.id === existing.last_msg_id,
          )
          if (foundIdx < 0 || foundIdx === msgs.length - 1) continue
          lastMsgId = existing.last_msg_id
        } else {
          continue
        }
        ctx.sessionsEvaluated.delete(sid)
      }

      const isIdle = ctx.idleSessions.has(sid)
      const isSubagent = agentInfo?.agentType === "subagent" || s.parentID
      const minUserMsgs = isSubagent ? 1 : ctx.config.min_session_messages
      const pending = buildEvalFromMessages(
        msgs,
        sid,
        agentName,
        minUserMsgs,
        ctx.registeredCommands,
        lastMsgId,
        isIdle,
      )
      if (isIdle) {
        ctx.idleSessions.delete(sid)
      }
      if (!pending) {
        await ctx.logger.log("poll_skip", {
          sessionID: sid,
          agentName,
          msgCount: msgs.length,
          minUserMsgs,
          isIdle,
          reason: "buildEvalFromMessages returned null",
        })
        continue
      }

      const storedSession = ctx.stateStore.getSession(sid)
      if (storedSession?.agents_md_hash) {
        pending.agentsMdHash = storedSession.agents_md_hash
      }

      if (agentName && !ctx.agentRegistry.has(sid)) {
        ctx.agentRegistry.set(sid, {
          agentName,
          agentType: s.parentID ? "subagent" : "primary",
          parentSessionID: s.parentID,
        })
      }

      // Ensure agentType and parentSessionID are set on pending before evaluation
      const registryInfo = ctx.agentRegistry.get(sid)
      if (registryInfo) {
        pending.agentType = registryInfo.agentType
        pending.parentSessionID = registryInfo.parentSessionID
      } else if (s.parentID) {
        pending.agentType = "subagent"
        pending.parentSessionID = s.parentID
      } else {
        pending.agentType = "primary"
      }

      try {
        await runEvaluation(pending, ctx)
      } catch (err) {
        await ctx.logger.log("eval_error", {
          sessionID: sid,
          agentName,
          error: String(err),
        })
      }

      // Also evaluate subagent children for primary sessions
      if (pending.agentType === "primary" || !pending.agentType) {
        try {
          const childResults = await evaluateChildSessions(
            pending.sessionID,
            ctx,
            0,
          )
          if (childResults.length > 0) {
            await ctx.logger.log("poll_child_eval", {
              sessionID: sid,
              childCount: childResults.length,
              childIDs: childResults.map((c) => c.id),
            })
          }
        } catch (err) {
          await ctx.logger.log("poll_child_eval_error", {
            sessionID: sid,
            error: String(err),
          })
        }
      }
    }
  } catch (err) {
    await ctx.logger.log("poll_error", { error: String(err) })
  }
}

async function handleErrorEvent(
  name: string,
  evt: Record<string, unknown>,
  ctx: KasperContext,
): Promise<void> {
  await ctx.logger.log("sdk_error", {
    name,
    message: (evt as { message?: string }).message ?? String(evt),
    keys: Object.keys(evt).slice(0, 10),
  })
}

export default KasperPlugin
