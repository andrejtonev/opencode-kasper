import type { Context as PluginContext } from "@opencode/plugin/effect/plugin"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Effect } from "effect"
import {
  boundedGenerationText,
  exclusiveGeneration,
  GenerationError,
  type GenerationPort,
  generationControl,
} from "../generation.js"

/** Call inside the native setup Effect to capture its public service context, never private Core. */
export function createV2Generation<R = never>(
  generate: Pick<PluginContext["experimental"]["generate"], "text">,
  lifetimeSignal?: AbortSignal,
): Effect.Effect<GenerationPort, never, R> {
  return Effect.gen(function* () {
    const services = yield* Effect.context<R>()
    const run = Effect.runPromiseWith(services)
    return {
      capabilities: {
        cancellation: "effect-interruption",
        enforcedOutputLimit: false,
      },
      generate: exclusiveGeneration(async (request, options) => {
        const signal =
          options?.signal && lifetimeSignal
            ? AbortSignal.any([options.signal, lifetimeSignal])
            : (options?.signal ?? lifetimeSignal)
        const control = generationControl(request.timeoutMs, signal)
        let dispatched = false
        try {
          control.assertActive()
          dispatched = true
          const response = await run(
            generate.text({
              prompt: request.prompt,
              ...(request.model
                ? {
                    model: {
                      id: Model.ID.make(request.model.modelID),
                      providerID: Provider.ID.make(request.model.providerID),
                    },
                  }
                : {}),
            }),
            { signal: control.signal },
          )
          control.assertActive()
          return boundedGenerationText(response.text)
        } catch (error) {
          if (!dispatched) throw error
          if (error instanceof GenerationError && !control.signal.aborted)
            throw error
          // Native Effect interruption is verified; provider termination/billing is not.
          throw new GenerationError(String(error), false, true)
        } finally {
          control.dispose()
        }
      }),
    } satisfies GenerationPort
  })
}
