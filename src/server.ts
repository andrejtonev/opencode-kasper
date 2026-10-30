import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join, normalize, resolve } from "node:path"
import { OpenCode } from "@opencode/client"
import type { Plugin } from "@opencode/plugin/effect"
import { Config } from "@opencode/schema/config"
import type { Plugin as LegacyPlugin } from "@opencode-ai/plugin"
import { Effect, Schema } from "effect"
import { parse } from "jsonc-parser"
import {
  type CommandRequest,
  type CommandResult,
  CommandResults,
} from "./command-results.js"
import { renderCompactionFeedback } from "./compaction.js"
import { normalizeKasperConfig } from "./config.js"
import { evaluateSession } from "./evaluate.js"
import { createV2Generation } from "./hosts/v2-generation.js"
import {
  createV2AgentsMd,
  loadV2AgentOverlays,
  V2AgentPrompts,
  type V2InstructionOptions,
} from "./hosts/v2-instructions.js"
import { KasperLogger } from "./logging.js"
import { AsyncMutex } from "./mutex.js"
import { executeNativeAction } from "./native-actions.js"
import { superviseNativeEvents } from "./native-events.js"
import { _stateStoreRegistry } from "./registry.js"
import { KasperRuntime } from "./runtime.js"
import { Scorer } from "./scorer.js"
import { KasperStateStore } from "./state.js"
import { DEFAULT_CONFIG, type KasperContext } from "./types.js"
import { deepEqual } from "./utils.js"
import {
  createV2HistoryHost,
  type TrustedV2Archive,
  v2NativeHistoryAccess,
} from "./v2-history.js"
import { kasperRpc } from "./v2-rpc.js"

function pathKey(path: string): string {
  const key = normalize(resolve(path))
  return process.platform === "win32" ? key.toLowerCase() : key
}

export function archiveAddress(
  value: string,
  headers: Readonly<Record<string, string>> | undefined,
  trustLocal: boolean,
): string {
  if (
    headers &&
    (typeof headers !== "object" ||
      Array.isArray(headers) ||
      Object.entries(headers).some(
        ([name, value]) =>
          !/^[!#$%&'*+.^_`|~\w-]+$/.test(name) ||
          typeof value !== "string" ||
          !value.trim() ||
          /[\r\n]/.test(value),
      ))
  )
    throw new Error(
      "Archive authentication headers must be explicit valid header strings",
    )
  const url = new URL(value)
  const local =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127\.\d+\.\d+\.\d+$/.test(url.hostname)
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && local))
  )
    throw new Error(
      "Archive URL requires HTTPS or loopback HTTP without embedded credentials, query, or fragment",
    )
  if (!Object.keys(headers ?? {}).length && !(trustLocal && local))
    throw new Error(
      "Archive connection requires explicit authentication headers or an explicit local no-auth trust assertion",
    )
  return url.href
}

/** Native configuration is project-local. Legacy host config and ambient auth are never read. */
export async function readNativeConfig(
  directory: string,
  options: Readonly<Record<string, unknown>>,
) {
  for (const candidate of [
    join(directory, ".opencode", "kasper.jsonc"),
    join(directory, ".opencode", "kasper.json"),
    join(directory, "kasper.jsonc"),
    join(directory, "kasper.json"),
  ]) {
    try {
      const errors: import("jsonc-parser").ParseError[] = []
      const raw = parse(await readFile(candidate, "utf8"), errors)
      if (
        errors.length ||
        !raw ||
        typeof raw !== "object" ||
        Array.isArray(raw)
      )
        throw new Error(`Invalid Kasper configuration: ${candidate}`)
      return {
        ...DEFAULT_CONFIG,
        ...normalizeKasperConfig(raw),
        ...normalizeKasperConfig(options),
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  return { ...DEFAULT_CONFIG, ...normalizeKasperConfig(options) }
}

export const KasperServer: Plugin.Plugin = {
  id: "kasper",
  effect(context) {
    return Effect.gen(function* () {
      const services = yield* Effect.context<never>()
      const runtime = new KasperRuntime()
      const run = Effect.runPromiseWith(services)
      const directory = context.location.directory
      const options = context.options
      const config = yield* Effect.promise(() =>
        readNativeConfig(directory, options),
      )
      const stateDir = resolve(
        directory,
        config.state_dir || ".opencode/kasper",
      )
      const logger = new KasperLogger(stateDir)
      const stateStore = new KasperStateStore(
        join(stateDir, "state.json"),
        stateDir,
        config,
        logger,
      )
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await runtime.dispose()
          await stateStore.destroy()
          if (_stateStoreRegistry.get(directory) === stateStore)
            _stateStoreRegistry.delete(directory)
        }),
      )
      yield* Effect.promise(async () => {
        await logger.init()
        await stateStore.init()
      })
      _stateStoreRegistry.set(directory, stateStore)
      const generation = yield* createV2Generation(
        context.experimental.generate,
        runtime.lifetimeSignal,
      )
      let archive: TrustedV2Archive | undefined
      let connection: ReturnType<typeof OpenCode.make> | undefined
      if (typeof options.server_url === "string") {
        const headers = options.archive_headers as
          | Record<string, string>
          | undefined
        const serverURL = archiveAddress(
          options.server_url,
          headers,
          options.trust_local_archive === true,
        )
        const client = OpenCode.make({ baseUrl: serverURL, headers })
        connection = client
        const location = yield* Effect.promise(() =>
          client.location.get(
            { location: { directory } },
            { signal: runtime.lifetimeSignal },
          ),
        )
        if (
          pathKey(location.directory) !== pathKey(directory) ||
          location.project.id !== context.location.project.id ||
          pathKey(location.project.canonical) !==
            pathKey(context.location.project.canonical)
        )
          throw new Error(
            "Archive connection does not match the native project/location",
          )
        archive = { serverURL, authenticated: true, client: connection }
      }
      const historyHost = createV2HistoryHost({
        location: context.location,
        native: v2NativeHistoryAccess(context.session, run),
        ...(archive ? { serverURL: archive.serverURL, archive } : {}),
      })
      const configConnection = connection
      const instructionOptions: V2InstructionOptions = {
        projectRoot: context.location.project.directory,
        directory,
        stateDir,
        globalConfigDir: options.global_config_dir,
        projectDiscovery: options.project_discovery !== false,
        globalDiscovery: options.global_discovery !== false,
        editableAgents: options.editable_agents,
        overlays: options.agent_overlays,
        catalog: {
          list: async () =>
            (
              await run(context.agent.list(), {
                signal: runtime.lifetimeSignal,
              })
            ).data,
          get: async (id) =>
            (
              await run(context.agent.get({ agentID: id }), {
                signal: runtime.lifetimeSignal,
              })
            ).data,
          reload: () =>
            run(context.agent.reload(), { signal: runtime.lifetimeSignal }),
        },
        ...(configConnection
          ? {
              configEntries: async () =>
                (
                  await configConnection.config.get(
                    { location: { directory } },
                    { signal: runtime.lifetimeSignal },
                  )
                ).map((entry) => Schema.decodeUnknownSync(Config.Entry)(entry)),
            }
          : {}),
      }
      const agentsMd = createV2AgentsMd(instructionOptions),
        agentPrompts = new V2AgentPrompts(instructionOptions)
      yield* Effect.promise(async () => {
        await agentsMd.init()
        await agentPrompts.init()
      })
      let overlays = yield* Effect.promise(() =>
        loadV2AgentOverlays(instructionOptions),
      )
      yield* context.agent.transform((editor) => {
        for (const [id, text] of overlays)
          editor.update(id, (agent) => {
            agent.system = [agent.system, text].filter(Boolean).join("\n\n")
          })
      })
      const ctx: KasperContext = {
        runtime,
        lifetimeSignal: runtime.lifetimeSignal,
        generation,
        historyHost,
        historyArchiveAvailable: Boolean(archive),
        config,
        stateStore,
        agentsMd,
        agentPrompts,
        logger,
        scorer: new Scorer(config, logger),
        pluginStartTime: Date.now(),
        agentRegistry: new Map(),
        sessionsEvaluated: new Set(stateStore.getEvaluatedSessions()),
        improvementsPending: [],
        parentToChildren: new Map(),
        sessionParents: new Map(),
        deletedSessions: new Set(),
        kasperSessionIDs: new Set(),
        idleSessions: new Set(),
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
        instructionCoverage: async (name) =>
          options.instruction_discovery_verified !== true
            ? {
                complete: false,
                issues: [
                  "instruction_discovery_verified must explicitly assert that Kasper discovery settings match the actual host policy",
                ],
              }
            : name
              ? agentPrompts.readCoverage(name)
              : {
                  complete: false,
                  issues: ["Actual agent identity is required"],
                },
        automaticImprovementAllowed: async (name) => {
          if (!name) return false
          const source = await agentPrompts.resolve(name)
          return (
            source.complete &&
            (source.kind === "editable" || source.kind === "overlay")
          )
        },
      }
      const results = new CommandResults((request, parsed) =>
        runtime.track(async () => {
          if (pathKey(request.location) !== pathKey(directory))
            throw new Error(
              "Command location does not match this plugin location",
            )
          const receipt = await executeNativeAction(request, parsed, ctx)
          if (parsed.action === "apply" && receipt.status === "ok") {
            overlays = await loadV2AgentOverlays(instructionOptions)
            await run(context.agent.reload(), {
              signal: runtime.lifetimeSignal,
            })
            receipt.text +=
              "\nInstruction activation is pending; existing session context may retain earlier instructions."
          }
          return receipt
        }),
      )
      const registration = yield* context.rpc.register(kasperRpc, {
        execute: (request) => execute(request),
        results: (request) =>
          Effect.promise(async () => {
            if (pathKey(request.location) !== pathKey(directory))
              throw new Error("Result location mismatch")
            await historyHost.get(request.sessionID, {
              signal: runtime.lifetimeSignal,
            })
            return results.list(request.sessionID, request.location)
          }),
      })
      const execute = (request: CommandRequest): Effect.Effect<CommandResult> =>
        Effect.promise(() => results.execute(request)).pipe(
          Effect.flatMap((receipt) =>
            registration.events.emit("result", receipt).pipe(
              Effect.catch(() => Effect.void),
              Effect.as(receipt),
            ),
          ),
        )
      yield* context.command.transform((editor) =>
        editor.add({
          name: "kasper",
          execute: (invocation) =>
            execute({
              requestID: randomUUID(),
              sessionID: invocation.sessionID,
              location: directory,
              command: invocation.prompt.text,
            }).pipe(Effect.asVoid),
        }),
      )
      yield* context.tool.transform((editor) =>
        editor.add({
          name: "kasper_control",
          description:
            "Execute a Kasper administrative action in this session. Status/help/config/pause/resume/reset/apply do not generate chat. Score/improve can call the configured judge.",
          input: Schema.Struct({
            action: Schema.String,
            arg: Schema.optionalKey(Schema.String),
          }),
          execute: (input, invocation) =>
            execute({
              requestID: randomUUID(),
              sessionID: invocation.sessionID,
              location: directory,
              command: `${input.action} ${input.arg ?? ""}`,
            }).pipe(Effect.map((result) => ({ content: result.text }))),
        }),
      )
      yield* context.session.hook("compaction", (event) =>
        Effect.sync(() => {
          const text = renderCompactionFeedback(
            stateStore.getAggregate(),
            event.agent,
            stateStore.getAgentAggregate(event.agent),
          )
          if (text) event.system.push({ type: "text", text })
        }),
      )
      yield* superviseNativeEvents(
        context.event.subscribe(),
        (event) =>
          Effect.tryPromise(async () => {
            if (
              event.location &&
              pathKey(event.location.directory) !== pathKey(directory)
            )
              return
            const data = event.data
            if (!("sessionID" in data) || typeof data.sessionID !== "string")
              return
            const id = data.sessionID
            if (event.type === "session.created") {
              const created = event.data
              if (pathKey(created.location.directory) !== pathKey(directory))
                return
              if (created.agent)
                ctx.agentRegistry.set(id, {
                  agentName: created.agent,
                  agentType: created.parentID ? "subagent" : "primary",
                  parentSessionID: created.parentID,
                })
            }
            if (event.type === "session.agent.selected") {
              runtime.invalidateSession(id)
              ctx.agentRegistry.set(id, {
                agentName: event.data.agent,
                agentType: ctx.agentRegistry.get(id)?.agentType ?? "primary",
                parentSessionID: ctx.agentRegistry.get(id)?.parentSessionID,
              })
            }
            if (
              event.type === "session.execution.started" ||
              event.type === "session.instructions.updated" ||
              event.type === "session.revert.committed"
            ) {
              runtime.invalidateSession(id)
              ctx.idleSessions.delete(id)
            }
            if (
              event.type === "session.execution.succeeded" ||
              event.type === "session.execution.failed" ||
              event.type === "session.execution.interrupted"
            )
              ctx.idleSessions.add(id)
            if (event.type === "session.deleted") {
              runtime.invalidateSession(id)
              ctx.deletedSessions.add(id)
              ctx.agentRegistry.delete(id)
              ctx.idleSessions.delete(id)
              stateStore.removeSession(id)
              for (const key of ctx.sessionsEvaluated)
                if (key === id || key.startsWith(`${id}|agent:`))
                  ctx.sessionsEvaluated.delete(key)
              ctx.improvementsPending.splice(
                0,
                ctx.improvementsPending.length,
                ...ctx.improvementsPending.filter(
                  (item) => item.source_session_id !== id,
                ),
              )
              await stateStore.flush()
            }
          }),
        runtime,
        (error) => logger.log("native_event_error", { error: String(error) }),
      )
      let lastPoll = 0
      runtime.every(
        "native-evaluation",
        1000,
        async () => {
          if (!ctx.config.enabled || ctx.kasperPaused) return
          if (Date.now() - lastPoll < ctx.config.evaluation_poll_interval_ms)
            return
          lastPoll = Date.now()
          for (const session of await historyHost.list({
            signal: runtime.lifetimeSignal,
          })) {
            if (
              session.time.updated < ctx.pluginStartTime ||
              ctx.deletedSessions.has(session.id)
            )
              continue
            if (
              session.time.busy !== undefined &&
              (session.time.idle === undefined ||
                session.time.busy > session.time.idle)
            )
              continue
            await evaluateSession(session.id, ctx, session.agent, {
              purpose: "current",
              minimumUserMessages: ctx.config.min_session_messages,
            })
          }
        },
        (error) => {
          void logger.log("native_poll_error", { error: String(error) })
        },
      )
      runtime.every(
        "native-config",
        3000,
        async () => {
          const next = await readNativeConfig(directory, options)
          if (deepEqual(next, ctx.config)) return
          if (
            resolve(directory, next.state_dir || ".opencode/kasper") !==
            stateDir
          ) {
            await logger.log("native_config_restart_required", {
              field: "state_dir",
            })
            return
          }
          runtime.invalidateAll()
          ctx.config = next
          ctx.autoUpdateEnabled = next.auto_update
          stateStore.reloadConfig(next)
          ctx.scorer.reloadModel(next)
        },
        (error) => {
          void logger.log("native_config_error", { error: String(error) })
        },
      )
      yield* Effect.promise(() =>
        logger.log("native_setup", {
          directory,
          archive: Boolean(archive),
          instructionActivation: "unconfirmed",
        }),
      )
    }).pipe(Effect.orDie)
  },
}

// 1.18.23 prefers ./server too. Its public loader selects server(); V2 selects effect.
// Lazy legacy loading keeps V1-only runtime dependencies out of the native Effect path.
const legacyServer: LegacyPlugin = async (input) =>
  (await import("./index.js")).default(input)
export default { ...KasperServer, server: legacyServer }
