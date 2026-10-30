import {
  MAX_MESSAGE_CHARS,
  MAX_MESSAGE_PARTS,
  MAX_TOOL_CALLS_EVAL,
  MAX_USER_INSTRUCTION_CHARS,
} from "./constants.js"
import type {
  PendingEval,
  SubagentCallRecord,
  ToolCallRecord,
} from "./types.js"
import { isRegisteredCommand } from "./utils.js"

/** Host adapters produce these records; provider-visible hook messages are not history. */
export interface HistoryMessage {
  id?: string
  role: "user" | "assistant" | "boundary" | "other"
  text: string
  agentName?: string
  toolCalls: ToolCallRecord[]
  subagentCalls: SubagentCallRecord[]
  unsettled: boolean
  terminal: boolean
  compacted: boolean
}

export interface V1HistoryMessage {
  info?: { id: string; role: string; sessionID: string }
  role?: string
  parts?: Array<Record<string, unknown>>
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function agentName(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value
  const nested = record(value)
  return typeof nested?.name === "string" ? nested.name : undefined
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return ""
  return value
    .map((part) => {
      const p = record(part)
      if (typeof p?.text === "string") return p.text
      // A URI is provenance, not observed file contents.
      if (p?.type === "file" && typeof p.uri === "string")
        return `[file result: ${p.uri}]`
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

function compression(text: string): boolean {
  return (
    text.includes("\u25a3 DCP") ||
    text.includes("\u25a3 Compression #") ||
    text.includes("\u00e2\u2013\u00a3 DCP") ||
    text.includes("\u00e2\u2013\u00a3 Compression #") ||
    text.toLowerCase().includes("the user triggered compression")
  )
}

/** V1 durable ToolPart uses state.input/output/error, not provider tool_use messages. */
export function normalizeV1History(
  messages: V1HistoryMessage[],
): HistoryMessage[] {
  return messages.map((message) => {
    const info = record(message.info)
    const rawRole = message.info?.role ?? message.role
    const parts = Array.isArray(message.parts) ? message.parts : []
    const toolCalls: ToolCallRecord[] = []
    const subagentCalls: SubagentCallRecord[] = []
    let unsettled = false
    for (const part of parts) {
      if (part.type === "tool" && typeof part.tool === "string") {
        const state = record(part.state)
        const status = state?.status
        if (status !== "completed" && status !== "error") unsettled = true
        const error = state?.error
        const result =
          status === "error"
            ? `[tool error] ${typeof error === "string" ? error : JSON.stringify(error ?? {})}`
            : textContent(state?.output) ||
              (status === "completed"
                ? "(empty)"
                : `[tool ${String(status ?? "pending")}]`)
        toolCalls.push({
          tool: part.tool,
          args: JSON.stringify(state?.input ?? {}),
          result,
        })
        const input = record(state?.input)
        if (part.tool === "task" && typeof input?.subagent_type === "string") {
          subagentCalls.push({
            agent: input.subagent_type,
            input: typeof input.prompt === "string" ? input.prompt : undefined,
          })
        }
      } else if (part.type === "tool_use" && typeof part.name === "string") {
        // Compatibility for existing synthetic fixtures, separate from the actual V1 contract.
        const result = parts.find(
          (p) => p.type === "tool_result" && p.tool_use_id === part.id,
        )
        toolCalls.push({
          tool: part.name,
          args: JSON.stringify(part.input ?? {}),
          result: textContent(result?.content) || "(empty)",
        })
      } else if (
        part.type === "agent" &&
        typeof part.input === "string" &&
        part.id === undefined &&
        part.source === undefined
      ) {
        // A bare agent selection/mention is not delegation evidence.
        const name =
          agentName(part.name) ??
          agentName(record(part.data)?.name) ??
          agentName(record(part.content)?.name)
        if (name)
          subagentCalls.push({
            agent: name,
            input: part.input as string,
          })
      }
    }
    let text = parts
      .filter(
        (p) =>
          p.type === "text" &&
          typeof p.text === "string" &&
          p.ignored !== true &&
          p.synthetic !== true,
      )
      .map((p) => p.text as string)
      .join(" ")
    if (rawRole === "assistant" && info?.error)
      text += `${text ? "\n" : ""}[assistant error] ${JSON.stringify(info.error)}`
    const compacted =
      parts.some((p) => p.type === "compaction") || compression(text)
    const selected = parts.find((p) => p.type === "agent")
    const selectedName =
      agentName(selected?.name) ??
      agentName(record(selected?.data)?.name) ??
      agentName(record(selected?.content)?.name)
    const time = record(info?.time)
    return {
      id: message.info?.id,
      role:
        rawRole === "user"
          ? "user"
          : rawRole === "assistant" && !compression(text)
            ? "assistant"
            : "other",
      text,
      agentName:
        agentName(info?.agent) ??
        agentName(info?.agentName) ??
        agentName(info?.subagent_type) ??
        agentName(info?.agent_type) ??
        (rawRole === "user" ? selectedName : undefined),
      toolCalls,
      subagentCalls,
      unsettled,
      // A step/tool-calls finish does not establish completion of the agent turn.
      terminal: !!time?.completed && info?.finish !== "tool-calls",
      compacted,
    }
  })
}

export interface HistoryTurn {
  user: HistoryMessage
  assistants: HistoryMessage[]
  compacted: boolean
}

/** Completed prefix only. Unknown checkpoints must not replay already-counted evidence. */
export function completedHistoryTurns(
  messages: HistoryMessage[],
  registeredCommands: Set<string>,
  lastMessageId?: string,
  isIdle = false,
): HistoryTurn[] {
  const cursor = lastMessageId
    ? messages.findIndex((m) => m.id === lastMessageId)
    : -1
  if (lastMessageId && cursor === -1) return []
  const turns: HistoryTurn[] = []
  let user: HistoryMessage | undefined
  let assistants: HistoryMessage[] = []
  let compacted = false
  let blocked = false
  const close = (complete: boolean) => {
    if (!user || assistants.length === 0) return
    if (!complete || assistants.some((m) => m.unsettled)) {
      blocked = true
      return
    }
    if (!blocked) turns.push({ user, assistants, compacted })
  }
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (message.role === "user") {
      close(true)
      user = isRegisteredCommand(message.text, registeredCommands)
        ? undefined
        : message
      assistants = []
      compacted = false
    } else if (i > cursor && user && message.role === "assistant") {
      if (
        message.text.trim() ||
        message.toolCalls.length ||
        message.subagentCalls.length
      )
        assistants.push(message)
    }
    // V2 records the actual execution outcome, including failed/interrupted runs.
    // The boundary carries no fabricated user request or assistant response.
    if (i > cursor && message.role === "boundary" && message.terminal) {
      if (message.text && assistants.length) {
        const last = assistants.at(-1)
        if (last)
          assistants[assistants.length - 1] = {
            ...last,
            text: `${last.text}\n${message.text}`,
          }
      }
      close(true)
      assistants = []
    }
    if (i > cursor && message.compacted) compacted = true
  }
  close(isIdle || assistants.at(-1)?.terminal === true)
  return turns
}

export function pendingFromHistoryTurns(
  turns: HistoryTurn[],
  sessionID: string,
  agent?: string,
  minUserMessages = 0,
): PendingEval | null {
  if (turns.length === 0 || turns.length < minUserMessages) return null
  const pairs = turns.map((turn) => ({
    evidenceTruncated:
      turn.user.text.length > MAX_USER_INSTRUCTION_CHARS ||
      turn.assistants
        .map((m) => m.text)
        .filter(Boolean)
        .join("\n").length > MAX_MESSAGE_CHARS ||
      turn.assistants.flatMap((m) => m.toolCalls).length > MAX_TOOL_CALLS_EVAL,
    userInstruction: turn.user.text.slice(-MAX_USER_INSTRUCTION_CHARS),
    agentResponse: turn.assistants
      .map((m) => m.text)
      .filter(Boolean)
      .join("\n")
      .slice(0, MAX_MESSAGE_CHARS),
    toolCalls: turn.assistants
      .flatMap((m) => m.toolCalls)
      .slice(-MAX_TOOL_CALLS_EVAL),
    subagentCalls: turn.assistants.flatMap((m) => m.subagentCalls),
  }))
  return {
    sessionID,
    evidenceTruncated:
      pairs.some((pair) => pair.evidenceTruncated) ||
      pairs.map((pair) => pair.userInstruction).join("\n---\n").length >
        MAX_USER_INSTRUCTION_CHARS ||
      pairs.filter((pair) => pair.agentResponse).length > MAX_MESSAGE_PARTS ||
      pairs.flatMap((pair) => pair.toolCalls).length > MAX_TOOL_CALLS_EVAL,
    agentName: agent,
    userInstruction: pairs
      .map((p) => p.userInstruction)
      .join("\n---\n")
      .slice(-MAX_USER_INSTRUCTION_CHARS),
    agentResponseParts: pairs
      .map((p) => p.agentResponse)
      .filter(Boolean)
      .slice(-MAX_MESSAGE_PARTS),
    toolCalls: pairs.flatMap((p) => p.toolCalls).slice(-MAX_TOOL_CALLS_EVAL),
    subagentCalls: pairs.flatMap((p) => p.subagentCalls),
    pairs,
    compacted: turns.some((t) => t.compacted),
    createdAt: Date.now(),
    lastMessageId: turns.at(-1)?.assistants.at(-1)?.id,
  }
}

export interface HistorySegment {
  agentName?: string
  firstMessageId?: string
  turns: HistoryTurn[]
}

/** Carry the real request over agent switches; A-B-A ranges keep distinct starting IDs. */
export function historySegments(
  turns: HistoryTurn[],
  hint?: string,
): HistorySegment[] {
  const segments: HistorySegment[] = []
  let current: HistorySegment | undefined
  for (const turn of turns) {
    for (const assistant of turn.assistants) {
      const agent =
        assistant.agentName ?? turn.user.agentName ?? current?.agentName ?? hint
      if (!current || current.agentName !== agent) {
        current = { agentName: agent, firstMessageId: assistant.id, turns: [] }
        segments.push(current)
      }
      let segmentTurn = current.turns.at(-1)
      if (!segmentTurn || segmentTurn.user !== turn.user) {
        segmentTurn = { ...turn, assistants: [] }
        current.turns.push(segmentTurn)
      }
      segmentTurn.assistants.push(assistant)
    }
  }
  return segments
}
