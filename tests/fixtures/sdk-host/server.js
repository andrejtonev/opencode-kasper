import { writeFile } from "node:fs/promises"
// Rpc comes from the public plugin schema, rather than Effect's transport namespace.
import { Plugin, Rpc as PluginRpc } from "@opencode/plugin/effect"
import { Effect, Schema } from "effect"

export default Plugin.define({
  id: "kasper.sdk-host-fixture",
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
      let started = false
      let interrupted = false
      let completed = false
      const definition = PluginRpc.define({
        id: "kasper.sdk-host-fixture.wait",
        methods: {
          wait: { input: Schema.Struct({}), output: Schema.Struct({}) },
        },
        events: {},
      })
      yield* context.rpc.register(definition, {
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
})
