import { normalize, resolve } from "node:path"
import type { OpenCodeClient } from "@opencode/client"
import type { Plugin } from "@opencode/plugin/effect"
import { AbsolutePath } from "@opencode/schema/schema"
import type { Session } from "@opencode/schema/session"
import { Session as SessionSchema } from "@opencode/schema/session"
import type { SessionMessage } from "@opencode/schema/session-message"
import { SessionMessage as SessionSchemaMessage } from "@opencode/schema/session-message"
import { DateTime, Effect, Schema } from "effect"
import type { HistoryMessage } from "./history.js"
import type { HistoryHost, SessionDescriptor } from "./history-port.js"

export function v2SessionDescriptor(session: Session.Info): SessionDescriptor {
  return {
    id: session.id,
    title: session.title,
    agent: session.agent,
    parentID: session.parentID,
    projectID: session.projectID,
    location: session.location,
    outcome: session.outcome,
    time: {
      created: DateTime.toEpochMillis(session.time.created),
      updated: DateTime.toEpochMillis(session.time.updated),
      busy: session.time.busy
        ? DateTime.toEpochMillis(session.time.busy)
        : undefined,
      idle: session.time.idle
        ? DateTime.toEpochMillis(session.time.idle)
        : undefined,
    },
  }
}

type DurableRecord =
  | SessionMessage.Info
  | Awaited<ReturnType<OpenCodeClient["message"]["list"]>>["data"][number]

/** 2.2.2 durable records, never provider replay messages or compaction summaries as requests. */
export function normalizeV2History(
  records: readonly DurableRecord[],
): HistoryMessage[] {
  return records.map((message) => {
    const base: HistoryMessage = {
      id: message.id,
      role: "other",
      text: "",
      toolCalls: [],
      subagentCalls: [],
      unsettled: false,
      terminal: false,
      compacted: false,
    }
    if (message.type === "user")
      return { ...base, role: "user", text: message.text ?? "" }
    if (message.type === "agent-switched")
      return { ...base, agentName: message.agent }
    if (message.type === "compaction")
      return {
        ...base,
        role: "boundary",
        compacted: message.status === "completed",
      }
    if (message.type === "idle")
      return {
        ...base,
        role: "boundary",
        terminal: true,
        text: message.error
          ? `[execution ${message.outcome}] ${message.error.type}: ${message.error.message}`
          : "",
      }
    if (message.type !== "assistant") return base
    base.role = "assistant"
    base.agentName = message.agent
    base.text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
    if (message.error)
      base.text += `\n[assistant error] ${message.error.type}: ${message.error.message}`
    base.terminal =
      message.time.completed !== undefined && message.finish === "stop"
    for (const block of message.content) {
      if (block.type !== "tool") continue
      const state = block.state
      const settled = state.status === "completed" || state.status === "error"
      if (!settled) base.unsettled = true
      let result =
        state.status === "streaming" || state.status === "running"
          ? `[tool ${state.status}]`
          : (state.content ?? [])
              .map((content) =>
                content.type === "text"
                  ? content.text
                  : `[file result metadata: ${JSON.stringify({ uri: content.uri, mime: content.mime, name: content.name })}; contents not read]`,
              )
              .join("\n")
      if (state.status === "error")
        result = `[tool error] ${state.error.type}: ${state.error.message}${result ? `\n${result}` : ""}`
      base.toolCalls.push({
        tool: block.name,
        callID: block.id,
        status: state.status,
        args:
          typeof state.input === "string"
            ? state.input
            : JSON.stringify(state.input),
        result: result || "(empty)",
      })
      if (
        block.name === "task" &&
        typeof state.input !== "string" &&
        typeof state.input.subagent_type === "string"
      ) {
        base.subagentCalls.push({
          agent: state.input.subagent_type,
          input:
            typeof state.input.prompt === "string"
              ? state.input.prompt
              : undefined,
        })
      }
    }
    return base
  })
}

export interface V2NativeHistoryAccess {
  get(sessionID: string, signal?: AbortSignal): Promise<SessionDescriptor>
  context(
    sessionID: string,
    signal?: AbortSignal,
  ): Promise<readonly SessionMessage.Info[]>
  list(
    input: {
      directory: string
      parentID?: string
      order: "asc"
      cursor?: string
    },
    signal?: AbortSignal,
  ): Promise<{ data: readonly SessionDescriptor[]; cursor: { next?: string } }>
}

/** Native Effect calls retain cancellation; no Promise SDK adapter drops the signal. */
export function v2NativeHistoryAccess(
  session: Pick<Plugin.Context["session"], "get" | "context" | "list">,
  run: typeof Effect.runPromise = Effect.runPromise,
): V2NativeHistoryAccess {
  return {
    get: async (sessionID, signal) =>
      v2SessionDescriptor(
        await run(
          session.get({ sessionID: SessionSchema.ID.make(sessionID) }),
          { signal },
        ),
      ),
    context: (sessionID, signal) =>
      run(session.context({ sessionID: SessionSchema.ID.make(sessionID) }), {
        signal,
      }),
    list: async (input, signal) => {
      const result = await run(
        session.list({
          directory: Schema.decodeUnknownSync(AbsolutePath)(input.directory),
          ...(input.parentID
            ? { parentID: SessionSchema.ID.make(input.parentID) }
            : {}),
          order: input.order,
          ...(input.cursor
            ? {
                cursor: Schema.decodeUnknownSync(SessionSchema.ListCursor)(
                  input.cursor,
                ),
              }
            : {}),
        }),
        { signal },
      )
      return {
        data: result.data.map(v2SessionDescriptor),
        cursor: { next: result.cursor.next },
      }
    },
  }
}
export interface TrustedV2Archive {
  /** Supplied by the caller after establishing an authenticated same-server connection. */
  serverURL: string
  authenticated: true
  client: Pick<OpenCodeClient, "session" | "message">
}
function sameDirectory(a: string, b: string): boolean {
  const canonical = (path: string) => normalize(resolve(path))
  return process.platform === "win32"
    ? canonical(a).toLowerCase() === canonical(b).toLowerCase()
    : canonical(a) === canonical(b)
}
function assertLocation(
  session: SessionDescriptor,
  expected: { directory: string; workspaceID?: string },
  id?: string,
): void {
  if (
    (id && session.id !== id) ||
    !sameDirectory(session.location.directory, expected.directory) ||
    (expected.workspaceID !== undefined &&
      session.location.workspaceID !== expected.workspaceID)
  )
    throw new Error(
      "Session identity or location does not match the plugin location",
    )
}
function aborted(signal?: AbortSignal): void {
  signal?.throwIfAborted()
}
function serverAddress(value: string): string {
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash)
    throw new Error(
      "Archive server URL must not contain credentials, query parameters, or fragments",
    )
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127\.\d+\.\d+\.\d+$/.test(url.hostname)
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new Error("Authenticated archive requires HTTPS or loopback HTTP")
  return url.href
}

/** No URL discovery, provider messages, credential lookup, or guessed localhost connection. */
export function createV2HistoryHost(options: {
  location: { directory: string; workspaceID?: string }
  native: V2NativeHistoryAccess
  serverURL?: string
  archive?: TrustedV2Archive
  maxPages?: number
  maxMessages?: number
}): HistoryHost {
  const maxPages = options.maxPages ?? 100,
    maxMessages = options.maxMessages ?? 10000
  if (
    !Number.isSafeInteger(maxPages) ||
    maxPages <= 0 ||
    !Number.isSafeInteger(maxMessages) ||
    maxMessages <= 0
  )
    throw new Error("History bounds must be positive finite integers")
  if (
    options.archive &&
    (!options.serverURL ||
      options.archive.authenticated !== true ||
      serverAddress(options.serverURL) !==
        serverAddress(options.archive.serverURL))
  )
    throw new Error(
      "Archive requires an explicit authenticated connection to the same server URL",
    )
  const get = async (sessionID: string, input?: { signal?: AbortSignal }) => {
    aborted(input?.signal)
    const session = await options.native.get(sessionID, input?.signal)
    aborted(input?.signal)
    assertLocation(session, options.location, sessionID)
    return session
  }
  return {
    get,
    async list(input) {
      const sessions: SessionDescriptor[] = [],
        seen = new Set<string>(),
        cursors = new Set<string>()
      let cursor: string | undefined
      for (let page = 0; page < maxPages; page++) {
        aborted(input?.signal)
        const result = await options.native.list(
          {
            directory: options.location.directory,
            parentID: input?.parentID,
            order: "asc",
            cursor,
          },
          input?.signal,
        )
        for (const session of result.data) {
          assertLocation(session, options.location)
          if (seen.has(session.id))
            throw new Error("Session pagination repeated an identity")
          if (input?.parentID && session.parentID !== input.parentID)
            throw new Error("Session directory returned a different parent")
          seen.add(session.id)
          sessions.push(session)
          if (sessions.length > maxMessages)
            throw new Error("Session listing exceeds configured bounds")
        }
        cursor = result.cursor.next ?? undefined
        if (!cursor) return sessions
        if (cursors.has(cursor))
          throw new Error("Session pagination cursor loop")
        cursors.add(cursor)
      }
      throw new Error("Session pagination exceeds configured page bounds")
    },
    async read(sessionID, input) {
      const session = await get(sessionID, input)
      if (input.purpose === "historical" && !options.archive)
        return {
          status: "unsupported",
          reason: "archive_unavailable",
          detail:
            "Historical scoring requires an explicitly connected authenticated archive reader. Native session context covers only the current compaction window.",
        }
      const isIdle =
        session.time.idle !== undefined &&
        (session.time.busy === undefined ||
          session.time.idle >= session.time.busy)
      if (!options.archive) {
        const records = await options.native.context(sessionID, input.signal)
        aborted(input.signal)
        if (records.length > maxMessages)
          throw new Error("Current context exceeds configured history bounds")
        const after = await get(sessionID, input)
        if (
          after.time.updated !== session.time.updated ||
          after.time.busy !== session.time.busy ||
          after.time.idle !== session.time.idle
        )
          throw new Error(
            "Session changed while its current context was being read",
          )
        return {
          status: "ok",
          snapshot: {
            sessionID,
            coverage: "current-window",
            messages: normalizeV2History(records),
            isIdle,
          },
        }
      }
      const archive = options.archive.client
      const archived = await archive.session.get(
        { sessionID },
        { signal: input.signal },
      )
      if (
        archived.id !== session.id ||
        !sameDirectory(
          archived.location.directory,
          session.location.directory,
        ) ||
        archived.projectID !== session.projectID ||
        archived.time.created !== session.time.created
      )
        throw new Error(
          "Archive session provenance does not match the native session",
        )
      const records: DurableRecord[] = [],
        seen = new Set<string>(),
        cursors = new Set<string>()
      let cursor: string | undefined,
        previousTime = -Infinity,
        previousID = ""
      for (let page = 0; page < maxPages; page++) {
        aborted(input.signal)
        const result = await archive.message.list(
          {
            sessionID,
            limit: Math.min(200, maxMessages),
            order: "asc",
            cursor,
          },
          { signal: input.signal },
        )
        for (const record of result.data) {
          // Public HTTP clients expose encoded JSON types; validate the real
          // durable schema before treating the response as complete evidence.
          const decoded = Schema.decodeUnknownSync(SessionSchemaMessage.Info)(
            record,
          )
          const time = DateTime.toEpochMillis(decoded.time.created)
          if (
            seen.has(record.id) ||
            time < previousTime ||
            (time === previousTime && record.id < previousID)
          )
            throw new Error(
              "Archive messages are duplicated or out of chronological order",
            )
          seen.add(record.id)
          records.push(decoded)
          previousTime = time
          previousID = record.id
          if (records.length > maxMessages)
            throw new Error("Archive history exceeds configured message bounds")
        }
        cursor = result.cursor.next ?? undefined
        if (!cursor) {
          const after = await get(sessionID, input)
          if (
            after.time.updated !== session.time.updated ||
            after.time.busy !== session.time.busy ||
            after.time.idle !== session.time.idle
          )
            throw new Error("Session changed while its archive was being read")
          return {
            status: "ok",
            snapshot: {
              sessionID,
              coverage: "archive",
              messages: normalizeV2History(records),
              isIdle,
            },
          }
        }
        if (cursors.has(cursor))
          throw new Error("Archive message pagination cursor loop")
        cursors.add(cursor)
      }
      throw new Error("Archive history exceeds configured page bounds")
    },
  }
}
