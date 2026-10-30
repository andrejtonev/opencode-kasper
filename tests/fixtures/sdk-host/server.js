import { writeFile } from "node:fs/promises"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Effect, Schema } from "effect"
// Rpc comes from the public plugin schema, rather than Effect's transport namespace.
import legacy from "./index.js"

export default {
  id: "kasper.sdk-host-fixture",
  server: legacy,
  effect(context) {
    return Effect.gen(function* () {
      const report = {
        entrypoint: "server-v2",
        loaded: true,
        version: context.app.version,
      }
      const page = yield* context.session.list({
        limit: 1,
        order: "asc",
        directory: context.location.directory,
      })
      report.sessionPage = { size: page.data.length, cursor: page.cursor }
      if (context.options.provider_test === true) {
        yield* context.provider.transform((editor) => {
          for (const record of editor.list())
            if (record.provider.id !== "fixture")
              editor.remove(record.provider.id)
        })
      }
      let started = false
      let interrupted = false
      let completed = false
      const definition = {
        id: "kasper.sdk-host-fixture.wait",
        methods: {
          wait: { input: Schema.Struct({}), output: Schema.Struct({}) },
          generate: {
            input: Schema.Struct({ prompt: Schema.String }),
            output: Schema.Struct({ text: Schema.String }),
          },
        },
        events: {},
      }
      yield* context.rpc.register(definition, {
        generate: ({ prompt }) =>
          context.experimental.generate.text({
            prompt,
            model: {
              id: Model.ID.make("judge"),
              providerID: Provider.ID.make("fixture"),
            },
          }),
        wait: () =>
          Effect.callback((resume) => {
            started = true
            const timer = setTimeout(() => {
              completed = true
              resume(Effect.succeed({}))
            }, 1000)
            return Effect.sync(() => {
              interrupted = true
              clearTimeout(timer)
            })
          }),
      })
      const controller = new AbortController()
      const abort = setTimeout(() => controller.abort(), 30)
      const run = Effect.runPromise(context.rpc(definition).wait({}), {
        signal: controller.signal,
      })
      yield* Effect.promise(async () => {
        try {
          await run
        } catch {
          /* Expected interruption. */
        } finally {
          clearTimeout(abort)
        }
      })
      report.cancellation = { started, interrupted, completed }
      yield* Effect.promise(() =>
        writeFile(context.options.reportPath, JSON.stringify(report)),
      )
    }).pipe(Effect.orDie)
  },
}
