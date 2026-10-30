import type {
  ExperimentalGenerateTextInput,
  MessageApi,
} from "@opencode/client/effect/api"
import { Plugin, Rpc } from "@opencode/plugin/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Session } from "@opencode/schema/session"
import type { SessionPromptData } from "@opencode-ai/sdk"
import { Effect, Schema } from "effect"
import { createV2Generation } from "../../src/hosts/v2-generation.js"

export const legacyJudgePrompt: SessionPromptData = {
  url: "/session/{id}/message",
  path: { id: "ses_auxiliary" },
  body: {
    parts: [{ type: "text", text: "Untrusted evidence for evaluation" }],
    tools: { "*": false },
  },
}

export const fixture = Plugin.define({
  id: "kasper.sdk-contract",
  effect(context) {
    return Effect.gen(function* () {
      const sessions = yield* context.session.list({
        limit: 20,
        order: "asc",
        directory: context.location.directory,
      })
      const next = sessions.cursor.next
      if (next)
        yield* context.session.list({
          cursor: next,
          limit: 20,
          directory: context.location.directory,
        })
      yield* context.command.transform((editor) =>
        editor.add({
          name: "kasper-contract",
          execute: (invocation) =>
            Effect.sync(() => {
              void invocation.sessionID
              void invocation.prompt.text
            }),
        }),
      )
      yield* context.session.hook("compaction", (event) =>
        Effect.sync(() => {
          event.system.push({ type: "text", text: "feedback" })
        }),
      )
      yield* context.tool.transform((editor) =>
        editor.add({
          name: "kasper_contract",
          description: "Read-only fixture",
          input: Schema.Struct({}),
          execute: (_input, invocation) =>
            Effect.succeed({ content: invocation.sessionID }),
        }),
      )
      yield* context.rpc.register(
        Rpc.define({
          id: "kasper.contract",
          methods: {
            status: {
              input: Schema.Struct({}),
              output: Schema.Struct({ text: Schema.String }),
            },
          },
          events: {},
        }),
        { status: () => Effect.succeed({ text: "status" }) },
      )
    }).pipe(Effect.orDie)
  },
})

export function nativeText(
  context: Context,
  prompt: string,
  signal: AbortSignal,
) {
  return Effect.runPromise(context.experimental.generate.text({ prompt }), {
    signal,
  })
}

// Compile the production bridge against the actual public host context.
export function nativePort(context: Context, lifetimeSignal?: AbortSignal) {
  return createV2Generation(context.experimental.generate, lifetimeSignal)
}

// Actual declared APIs; these @ts-expect-error checks fail compilation if the contract changes.
export function absentCapabilities(context: Context) {
  const sessionID = Session.ID.make("session-contract")
  // @ts-expect-error The plugin context does not expose the full archive domain.
  void context.message.list({ sessionID })
  // @ts-expect-error context accepts only sessionID; it is not a full archive selector.
  void context.session.context({ sessionID, mode: "full" })
  const request: ExperimentalGenerateTextInput = { prompt: "fixture" }
  // @ts-expect-error No per-request output-token option in native stateless generation 2.2.2.
  request.maxTokens = 100
  return request
}

export function archivePage(message: MessageApi, sessionID: Session.ID) {
  return Effect.gen(function* () {
    const page = yield* message.list({ sessionID, order: "asc", limit: 20 })
    if (page.cursor.next)
      yield* message.list({
        sessionID,
        limit: 20,
        cursor: page.cursor.next,
      })
    return page.data
  })
}
