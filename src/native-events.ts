import { Effect, Stream } from "effect"
import type { KasperRuntime } from "./runtime.js"

/** An event subscription is required for admission, rather than optional background telemetry. */
export function superviseNativeEvents<A>(
  stream: Stream.Stream<A, unknown>,
  handle: (event: A) => Effect.Effect<void, unknown>,
  runtime: KasperRuntime,
  log: (error: unknown) => Promise<void>,
) {
  const report = (error: unknown) =>
    Effect.tryPromise(() => log(error)).pipe(
      Effect.catchCause(() => Effect.void),
    )
  return stream.pipe(
    Stream.runForEach((event) => handle(event).pipe(Effect.catchCause(report))),
    Effect.onExit((exit) =>
      Effect.promise(async () => {
        await runtime.dispose()
      }).pipe(
        Effect.catchCause(() => Effect.void),
        Effect.andThen(report(exit)),
      ),
    ),
    Effect.catchCause(() => Effect.void),
    Effect.forkScoped,
  )
}
