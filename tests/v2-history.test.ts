import { expect, mock, test } from "bun:test"
import { SessionMessage } from "@opencode/schema/session-message"
import { Effect, Schema } from "effect"
import { completedHistoryTurns, historySegments } from "../src/history.js"
import type { SessionDescriptor } from "../src/history-port.js"
import {
  createV2HistoryHost,
  normalizeV2History,
  v2NativeHistoryAccess,
} from "../src/v2-history.js"

const directory = process.cwd()
const descriptor: SessionDescriptor = {
  id: "ses_test",
  projectID: "project",
  location: { directory },
  title: "task",
  time: { created: 1, updated: 10, busy: 2, idle: 10 },
  outcome: "succeeded",
}
const decode = Schema.decodeUnknownSync(SessionMessage.Info)
function user(id = "msg_1", text = "real request") {
  return decode({ type: "user", id, text, time: { created: 1 } })
}
function assistant(
  id = "msg_2",
  agent = "A",
  content: unknown[] = [{ type: "text", text: "done" }],
  extra: Record<string, unknown> = {},
) {
  return decode({
    type: "assistant",
    id,
    agent,
    model: { providerID: "test", id: "test" },
    content,
    time: { created: 2, completed: 3 },
    finish: "stop",
    ...extra,
  })
}
function idle(id = "msg_3", outcome = "succeeded", error?: unknown) {
  return decode({
    type: "idle",
    id,
    outcome,
    ...(error === undefined ? {} : { error }),
    time: { created: 4 },
  })
}
function native(
  records: readonly SessionMessage.Info[] = [user(), assistant(), idle()],
) {
  return {
    get: mock(async () => descriptor),
    context: mock(async () => records),
    list: mock(async () => ({ data: [descriptor], cursor: {} })),
  }
}

test("current-window read rejects a changed execution anchor after awaiting context", async () => {
  const access = native()
  access.context.mockImplementation(async () => {
    access.get.mockImplementation(async () => ({
      ...descriptor,
      time: { ...descriptor.time, updated: 11, busy: 11 },
    }))
    return [user(), assistant()]
  })
  const host = createV2HistoryHost({ location: { directory }, native: access })
  await expect(
    host.read(descriptor.id, { purpose: "current" }),
  ).rejects.toThrow("changed while its current context")
})
function archive(
  pages: Array<{ data: unknown[]; cursor: { next?: string | null } }>,
  session: unknown = descriptor,
) {
  let page = 0
  return {
    serverURL: "http://127.0.0.1:4100",
    authenticated: true as const,
    client: {
      session: { get: mock(async () => session) },
      message: {
        list: mock(async () => pages[Math.min(page++, pages.length - 1)]),
      },
    } as any,
  }
}
const encode = Schema.encodeSync(SessionMessage.Info)

test("actual 2.2.2 schema decodes tools and normalization retains IDs, file provenance, input and errors", () => {
  const records = [
    user(),
    assistant("msg_2", "reviewer", [
      {
        type: "tool",
        id: "call_1",
        name: "read",
        state: {
          status: "completed",
          input: { path: "code.ts" },
          content: [
            { type: "text", text: "observed" },
            {
              type: "file",
              uri: "media:abc",
              mime: "text/plain",
              name: "output",
            },
          ],
        },
        time: { created: 2, completed: 3 },
      },
      {
        type: "tool",
        id: "call_2",
        name: "task",
        state: {
          status: "error",
          input: { subagent_type: "tester", prompt: "run tests" },
          error: { type: "ToolFailed", message: "permission denied" },
        },
        time: { created: 2, completed: 3 },
      },
    ]),
  ]
  const history = normalizeV2History(records)
  expect(history[1].agentName).toBe("reviewer")
  expect(history[1].toolCalls[0].callID).toBe("call_1")
  expect(history[1].toolCalls[0].args).toContain("code.ts")
  expect(history[1].toolCalls[0].result).toContain("observed")
  expect(history[1].toolCalls[0].result).toContain("contents not read")
  expect(history[1].toolCalls[1].result).toContain("permission denied")
  expect(history[1].subagentCalls).toEqual([
    { agent: "tester", input: "run tests" },
  ])
})

test("streaming and running tools block even an idle boundary, while error-only completed executions retain failure evidence", () => {
  for (const status of ["streaming", "running"]) {
    const state =
      status === "streaming"
        ? { status, input: '{"path":' }
        : { status, input: { path: "x" }, metadata: {} }
    const tool = assistant(
      "msg_2",
      "A",
      [{ type: "tool", id: "call", name: "read", state, time: { created: 2 } }],
      { time: { created: 2 }, finish: "tool-calls" },
    )
    expect(
      completedHistoryTurns(
        normalizeV2History([user(), tool, idle()]),
        new Set(),
      ),
    ).toHaveLength(0)
  }
  const failed = assistant("msg_2", "A", [], {
    error: { type: "ProviderError", message: "unavailable" },
    finish: "error",
  })
  expect(
    completedHistoryTurns(normalizeV2History([user(), failed]), new Set()),
  ).toHaveLength(0)
  const turns = completedHistoryTurns(
    normalizeV2History([
      user(),
      failed,
      idle("msg_3", "failed", { type: "ExecutionError", message: "stopped" }),
    ]),
    new Set(),
  )
  expect(turns).toHaveLength(1)
  expect(turns[0].assistants[0].text).toContain("unavailable")
  expect(turns[0].assistants[0].text).toContain("stopped")
})

test("agent switches and compaction preserve the real request across A-B-A ranges", () => {
  const records = [
    user(),
    assistant("msg_2", "A"),
    decode({
      type: "agent-switched",
      id: "msg_3",
      agent: "B",
      previous: "A",
      time: { created: 3 },
    }),
    assistant("msg_4", "B"),
    decode({
      type: "compaction",
      id: "msg_5",
      status: "completed",
      reason: "auto",
      summary: "invented summary request",
      time: { created: 5 },
    }),
    assistant("msg_6", "A"),
    idle("msg_7"),
  ]
  const segments = historySegments(
    completedHistoryTurns(normalizeV2History(records), new Set()),
  )
  expect(segments.map((segment) => segment.agentName)).toEqual(["A", "B", "A"])
  expect(segments.map((segment) => segment.firstMessageId)).toEqual([
    "msg_2",
    "msg_4",
    "msg_6",
  ])
  expect(
    segments.every((segment) => segment.turns[0].user.text === "real request"),
  ).toBe(true)
  expect(segments.every((segment) => segment.turns[0].compacted)).toBe(true)
})

test("historical scoring cannot silently substitute native latest-window context", async () => {
  const access = native()
  const host = createV2HistoryHost({ location: { directory }, native: access })
  const historical = await host.read("ses_test", { purpose: "historical" })
  expect(historical.status).toBe("unsupported")
  expect(access.context).not.toHaveBeenCalled()
  const current = await host.read("ses_test", { purpose: "current" })
  expect(current.status).toBe("ok")
  if (current.status === "ok")
    expect(current.snapshot.coverage).toBe("current-window")
})

test("explicit archive reads every ascending page and forwards cancellation", async () => {
  const reader = archive([
    { data: [encode(user())], cursor: { next: "page2" } },
    { data: [encode(assistant())], cursor: { next: null } },
  ])
  const host = createV2HistoryHost({
    location: { directory },
    native: native(),
    serverURL: reader.serverURL,
    archive: reader,
  })
  const controller = new AbortController()
  const result = await host.read("ses_test", {
    purpose: "historical",
    signal: controller.signal,
  })
  expect(result.status).toBe("ok")
  if (result.status === "ok") {
    expect(result.snapshot.coverage).toBe("archive")
    expect(result.snapshot.messages.map((message) => message.id)).toEqual([
      "msg_1",
      "msg_2",
    ])
  }
  expect(reader.client.message.list.mock.calls[1][0]).toEqual({
    sessionID: "ses_test",
    limit: 200,
    order: "asc",
    cursor: "page2",
  })
  expect(reader.client.message.list.mock.calls[1][1].signal).toBe(
    controller.signal,
  )
})

test("archive cannot read a mismatched native identity, project, location or creation", async () => {
  for (const changed of [
    { id: "ses_other" },
    { projectID: "other" },
    { location: { directory: `${directory}-other` } },
    { time: { created: 99, updated: 10 } },
  ]) {
    const reader = archive([{ data: [], cursor: {} }], {
      ...descriptor,
      ...changed,
    })
    const host = createV2HistoryHost({
      location: { directory },
      native: native(),
      serverURL: reader.serverURL,
      archive: reader,
    })
    await expect(
      host.read("ses_test", { purpose: "historical" }),
    ).rejects.toThrow("provenance")
    expect(reader.client.message.list).not.toHaveBeenCalled()
  }
})

test("archive bounds, ordering and cursor loops fail closed without a partial snapshot", async () => {
  for (const pages of [
    [
      { data: [encode(user())], cursor: { next: "same" } },
      { data: [encode(assistant())], cursor: { next: "same" } },
    ],
    [{ data: [encode(assistant()), encode(user())], cursor: {} }],
    [{ data: [encode(user()), encode(user())], cursor: {} }],
  ]) {
    const reader = archive(pages)
    const host = createV2HistoryHost({
      location: { directory },
      native: native(),
      serverURL: reader.serverURL,
      archive: reader,
    })
    await expect(
      host.read("ses_test", { purpose: "historical" }),
    ).rejects.toThrow()
  }
  const reader = archive([
    { data: [encode(user()), encode(assistant())], cursor: {} },
  ])
  const host = createV2HistoryHost({
    location: { directory },
    native: native(),
    serverURL: reader.serverURL,
    archive: reader,
    maxMessages: 1,
  })
  await expect(
    host.read("ses_test", { purpose: "historical" }),
  ).rejects.toThrow("bounds")
})

test("archive configuration rejects guessed, credential-bearing and insecure remote URLs", () => {
  const reader = archive([])
  expect(() =>
    createV2HistoryHost({
      location: { directory },
      native: native(),
      archive: reader,
    }),
  ).toThrow("explicit")
  for (const url of [
    "http://remote.example",
    "https://user:secret@example.com",
    "https://example.com?token=secret",
    "https://example.com#secret",
  ]) {
    expect(() =>
      createV2HistoryHost({
        location: { directory },
        native: native(),
        serverURL: url,
        archive: { ...reader, serverURL: url },
      }),
    ).toThrow()
  }
})

test("native Effect access interrupts the actual context computation", async () => {
  let interrupted = false
  const access = v2NativeHistoryAccess({
    context: () =>
      Effect.never.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            interrupted = true
          }),
        ),
      ),
    get: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  } as any)
  const controller = new AbortController()
  const read = access.context("ses_test", controller.signal)
  controller.abort()
  await expect(read).rejects.toThrow()
  expect(interrupted).toBe(true)
})

test("archive malformed records or a changed execution never produce an accepted snapshot", async () => {
  const malformed = archive([
    {
      data: [{ type: "assistant", id: "msg_bad", time: { created: 2 } }],
      cursor: {},
    },
  ])
  const badHost = createV2HistoryHost({
    location: { directory },
    native: native(),
    serverURL: malformed.serverURL,
    archive: malformed,
  })
  await expect(
    badHost.read("ses_test", { purpose: "historical" }),
  ).rejects.toThrow()
  const access = native()
  let reads = 0
  access.get = mock(async () =>
    ++reads === 1
      ? descriptor
      : { ...descriptor, time: { ...descriptor.time, updated: 11 } },
  )
  const reader = archive([
    { data: [encode(user()), encode(assistant())], cursor: {} },
  ])
  const host = createV2HistoryHost({
    location: { directory },
    native: access,
    serverURL: reader.serverURL,
    archive: reader,
  })
  await expect(
    host.read("ses_test", { purpose: "historical" }),
  ).rejects.toThrow("changed")
})

test("native listing validates location, parent identity and pagination bounds", async () => {
  const access = native()
  const host = createV2HistoryHost({ location: { directory }, native: access })
  expect((await host.list())[0].id).toBe("ses_test")
  expect(access.list.mock.calls[0][0].directory).toBe(directory)
  await expect(host.list({ parentID: "ses_parent" })).rejects.toThrow(
    "different parent",
  )
  access.get = mock(async () => ({
    ...descriptor,
    location: { directory: `${directory}-other` },
  }))
  await expect(host.read("ses_test", { purpose: "current" })).rejects.toThrow(
    "location",
  )
  expect(access.context).not.toHaveBeenCalled()
  const looping = native()
  looping.list = mock(async () => ({ data: [], cursor: { next: "loop" } }))
  await expect(
    createV2HistoryHost({
      location: { directory },
      native: looping,
      maxPages: 2,
    }).list(),
  ).rejects.toThrow("cursor loop")
})
