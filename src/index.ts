import { mkdir, readdir, rm, stat } from "node:fs/promises"
import { isAbsolute, join, normalize, resolve } from "node:path"
import type { Config, Plugin } from "@opencode-ai/plugin"
import type { Event, Part, UserMessage } from "@opencode-ai/sdk"
import { AgentPromptManager } from "./agent-prompts.js"
import { AgentsMdManager } from "./agents-md.js"
import { resolveAgentsMdSource } from "./agents-md-resolver.js"
import { renderCompactionFeedback } from "./compaction.js"
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
  MAX_SESSION_PARENTS,
  MAX_TRACKED_DELETED_IDS,
  PARENT_CLEANUP_BATCH,
  SESSION_DEBOUNCE_MS,
} from "./constants.js"
import { evaluateChildSessions, evaluateSession } from "./evaluate.js"
import { dispatchKasperCommand } from "./handlers.js"
import { KasperLogger } from "./logging.js"
import { AsyncMutex } from "./mutex.js"
import { _stateStoreRegistry } from "./registry.js"
import { KasperRuntime } from "./runtime.js"
import { Scorer } from "./scorer.js"
import { KasperStateStore } from "./state.js"
import { createKasperTools } from "./tools.js"

import type {
  AgentSessionInfo,
  ImprovementRecord,
  KasperConfig,
  KasperContext,
} from "./types.js"
import { deepEqual, getSessionID, isKasperSession, showToast } from "./utils.js"

// Compatibility handlers for direct callers. Official hosts enter through `event`.
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

  const runtime = new KasperRuntime()
  const ctx: KasperContext = {
    runtime,
    lifetimeSignal: runtime.lifetimeSignal,
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
  const configReloadTimer = runtime.every(
    "config",
    CONFIG_POLL_INTERVAL_MS,
    async () => {
      if (configReloading) return
      configReloading = true
      try {
        const fresh = await loadKasperConfig(cwd, true)
        const changed = !deepEqual(fresh, ctx.config)
        if (!changed) return
        if (!runtime.active) return
        runtime.invalidateAll()
        const prevModel = ctx.config.model
        ctx.config = fresh
        ctx.autoUpdateEnabled = fresh.auto_update
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
        if (!runtime.active) return
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
    },
    (error) => {
      void ctx.logger.log("config_reload_error", { error: String(error) })
    },
  )
  ctx.configReloadTimer = configReloadTimer

  const evaluationPollTimer = runtime.every(
    "evaluation",
    config.evaluation_poll_interval_ms,
    async () => {
      if (ctx.kasperPaused || !ctx.config.enabled) return
      ctx.evaluationRunning = true
      ctx.evaluationStartedAt = Date.now()
      try {
        await pollAndEvaluate(ctx)
      } finally {
        ctx.evaluationRunning = false
      }
    },
    (error) => {
      void ctx.logger.log("poll_error", { error: String(error) })
    },
  )
  ctx.evaluationPollTimer = evaluationPollTimer

  async function gracefulShutdown(
    ctx: KasperContext,
    configReloadTimer: ReturnType<typeof setInterval>,
    evaluationPollTimer: ReturnType<typeof setInterval>,
  ): Promise<void> {
    await runtime.dispose()
    clearInterval(configReloadTimer)
    clearInterval(evaluationPollTimer)
    await ctx.logger.log("plugin_unloaded", {
      sessionsEvaluated: ctx.sessionsEvaluated.size,
      improvementsPending: ctx.improvementsPending.length,
    })
    await ctx.stateStore.destroy()
  }
  let shutdownPromise: Promise<void> | undefined
  const close = (): Promise<void> => {
    shutdownPromise ??= gracefulShutdown(
      ctx,
      configReloadTimer,
      evaluationPollTimer,
    ).finally(() => {
      // An old instance must never deregister the replacement instance's store.
      if (_stateStoreRegistry.get(directory) === stateStore)
        _stateStoreRegistry.delete(directory)
    })
    return shutdownPromise
  }

  const hooks = {
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

    event: async (input: { event: Event }): Promise<void> => {
      if (!runtime.active) return
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

      const properties = evt.properties as Record<string, unknown> | undefined
      if (name === "server.instance.disposed") {
        const disposedDirectory = properties?.directory
        if (typeof disposedDirectory !== "string") return
        const canonical = (path: string) => {
          const value = normalize(resolve(path))
          return process.platform === "win32" ? value.toLowerCase() : value
        }
        if (canonical(disposedDirectory) === canonical(cwd)) await close()
        return
      }
      const info = properties?.info as Record<string, unknown> | undefined
      const part = properties?.part as Record<string, unknown> | undefined
      const sid = (properties?.sessionID ??
        info?.sessionID ??
        part?.sessionID ??
        (name.startsWith("session.") ? info?.id : undefined) ??
        evt.sessionID) as string | undefined
      const routed = { event: input.event, sessionID: sid } as RuntimeHookEvent
      if (name === "session.created") return hooks["session.created"](routed)
      if (name === "session.updated") return hooks["session.updated"](routed)
      if (name === "session.deleted") return hooks["session.deleted"](routed)
      if (
        name === "message.updated" ||
        name === "message.part.updated" ||
        name === "message.removed" ||
        name === "message.part.removed"
      )
        return hooks["message.updated"](routed)
      if (
        name === "session.status" &&
        properties?.status &&
        (properties.status as { type?: string }).type !== "idle" &&
        sid
      ) {
        ctx.idleSessions.delete(sid)
        if (!ctx.kasperSessionIDs.has(sid)) runtime.invalidateSession(sid)
      }

      if (name === "session.idle") {
        const sid =
          ((evt.properties as Record<string, unknown>)?.sessionID as string) ||
          ((evt.info as Record<string, unknown>)?.id as string) ||
          ((evt as Record<string, unknown>).sessionID as string)
        if (
          sid &&
          !ctx.deletedSessions.has(sid) &&
          !ctx.kasperSessionIDs.has(sid)
        ) {
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

      if (!runtime.active) {
        out.message = "Kasper is unloaded."
        out.stop = true
        return
      }
      try {
        const result = await runtime.track(() =>
          dispatchKasperCommand(action, restArg, sessionID, ctx),
        )
        out.message = result
      } catch (err) {
        out.message = `Kasper error: ${err instanceof Error ? err.message : String(err)}`
        await ctx.logger.log("command_error", { action, error: String(err) })
      }
      out.stop = true
    },

    "session.created": async (input: RuntimeHookEvent) => {
      if (!runtime.active) return
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

      runtime.invalidateSession(sessionID)
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
      if (!runtime.active) return
      const sessionID = getSessionID(input)
      if (!sessionID) return
      if (ctx.deletedSessions.has(sessionID)) return
      ctx.lastActiveSessionID = sessionID

      const { parentID, agentName } = extractAgentInfo(input)

      if (agentName) {
        agentRegistry.set(sessionID, {
          agentName,
          agentType: parentID ? "subagent" : "primary",
          parentSessionID: parentID,
        })
      }
    },

    "session.deleted": async (input: RuntimeHookEvent) => {
      if (!runtime.active) return
      const sessionID = getSessionID(input)
      if (!sessionID) return

      runtime.invalidateSession(sessionID)
      ctx.deletedSessions.add(sessionID)
      ctx.idleSessions.delete(sessionID)
      ctx.stateStore.removeSession(sessionID)
      for (const key of ctx.sessionsEvaluated)
        if (key === sessionID || key.startsWith(`${sessionID}|agent:`))
          ctx.sessionsEvaluated.delete(key)
      ctx.improvementsPending = ctx.improvementsPending.filter(
        (p) => p.source_session_id !== sessionID,
      )
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
      if (!runtime.active) return
      const sessionID = getSessionID(input) || input.sessionID
      if (!sessionID) return

      if (
        ctx.kasperSessionIDs.has(sessionID) ||
        ctx.deletedSessions.has(sessionID)
      )
        return
      runtime.invalidateSession(sessionID)
      ctx.lastActiveSessionID = sessionID
      ctx.idleSessions.delete(sessionID)
      const { agentName } = extractAgentInfo(input)
      if (agentName) {
        const prior = agentRegistry.get(sessionID)
        agentRegistry.set(sessionID, {
          agentName,
          agentType: prior?.agentType ?? "primary",
          parentSessionID: prior?.parentSessionID,
        })
      }
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
      if (
        !runtime.active ||
        ctx.kasperSessionIDs.has(sessionID) ||
        ctx.deletedSessions.has(sessionID)
      )
        return
      runtime.invalidateSession(sessionID)
      ctx.lastActiveSessionID = sessionID
      ctx.idleSessions.delete(sessionID)
      if (input.agent) {
        const prior = agentRegistry.get(sessionID)
        agentRegistry.set(sessionID, {
          agentName: input.agent,
          agentType: prior?.agentType ?? "primary",
          parentSessionID: prior?.parentSessionID,
        })
      }
      if (ctx.deletedSessions.has(sessionID)) return
      if (ctx.kasperSessionIDs.has(sessionID)) return
    },

    "experimental.session.compacting": async (
      input: { sessionID: string },
      output: { context: string[]; prompt?: string },
    ) => {
      const sessionID = input.sessionID
      if (ctx.kasperSessionIDs.has(sessionID)) return

      if (!runtime.active) return
      const agentName = agentRegistry.get(sessionID)?.agentName
      const text = renderCompactionFeedback(
        ctx.stateStore.getAggregate(),
        agentName,
        agentName ? ctx.stateStore.getAgentAggregate(agentName) : undefined,
      )
      if (text) {
        if (!Array.isArray(output.context)) output.context = []
        output.context.push(text)
      }
    },

    close,
  }
  return hooks
}

async function pollAndEvaluate(ctx: KasperContext): Promise<void> {
  if (!ctx.client.session.list || !ctx.client.session.messages) return

  try {
    const installedAt = ctx.stateStore.getInstalledAt()

    // Keep the polling admission until the host request actually settles.
    const result = await ctx.client.session.list()
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

    for (const session of sessions) {
      if (ctx.lifetimeSignal?.aborted) return
      const hint = session.agent || session.agentName || session.subagent_type
      if (hint && !ctx.agentRegistry.has(session.id))
        ctx.agentRegistry.set(session.id, {
          agentName: hint,
          agentType: session.parentID ? "subagent" : "primary",
          parentSessionID: session.parentID,
        })
      const minimumUserMessages = session.parentID
        ? 1
        : ctx.config.min_session_messages
      const outcome = await evaluateSession(session.id, ctx, hint, {
        minimumUserMessages,
      })
      await ctx.logger.log("poll_evaluation", {
        sessionID: session.id,
        status: outcome.status,
        reason: outcome.reason,
      })
      if (!session.parentID && outcome.status === "scored")
        await evaluateChildSessions(session.id, ctx, 0)
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
