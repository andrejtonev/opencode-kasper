import { expect, mock, test } from "bun:test"
import { Effect, Stream } from "effect"
import { superviseNativeEvents } from "../src/native-events.js"
import { KasperRuntime } from "../src/runtime.js"

test("handler defects and logger rejection cannot stop subsequent lifecycle events", async () => {
  const runtime = new KasperRuntime(),
    observed: number[] = []
  const logger = mock(async () => {
    throw new Error("logger unavailable")
  })
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* superviseNativeEvents(
          Stream.fromIterable([1, 2]).pipe(Stream.concat(Stream.never)),
          (event) =>
            event === 1
              ? Effect.die("handler defect")
              : Effect.sync(() => {
                  observed.push(event)
                }),
          runtime,
          logger,
        )
        yield* Effect.sleep(10)
        expect(observed).toEqual([2])
        expect(runtime.active).toBe(true)
        expect(logger).toHaveBeenCalledTimes(1)
      }),
    ),
  )
  expect(runtime.active).toBe(false)
})

for (const failure of [false, true])
  test(`unexpected stream ${failure ? "defect" : "completion"} closes admission and fences a running judge`, async () => {
    const runtime = new KasperRuntime()
    let terminate!: () => void,
      finishJudge!: () => void,
      committed = false
    const termination = new Promise<void>((resolve) => {
      terminate = resolve
    })
    const judgeGate = new Promise<void>((resolve) => {
      finishJudge = resolve
    })
    const revision = runtime.capture("source")
    const judge = runtime
      .track(async () => {
        await judgeGate
        runtime.assertCurrent("source", revision)
        committed = true
      })
      .then(
        () => "committed",
        () => "cancelled",
      )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const end = Effect.promise(() => termination).pipe(
            Effect.flatMap(() =>
              failure ? Effect.die("subscription defect") : Effect.void,
            ),
          )
          yield* superviseNativeEvents(
            Stream.fromEffect(end),
            () => Effect.void,
            runtime,
            async () => {
              throw new Error("log unavailable")
            },
          )
          terminate()
          yield* Effect.sleep(10)
          expect(runtime.active).toBe(false)
          expect(runtime.lifetimeSignal.aborted).toBe(true)
          yield* Effect.promise(async () => {
            await expect(runtime.track(async () => {})).rejects.toThrow(
              "unloaded",
            )
          })
          finishJudge()
          expect(yield* Effect.promise(() => judge)).toBe("cancelled")
          expect(committed).toBe(false)
        }),
      ),
    )
  })
