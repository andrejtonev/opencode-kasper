import {
  boundedGenerationText,
  exclusiveGeneration,
  GenerationError,
  type GenerationPort,
  generationControl,
} from "../generation.js"
import { parseScoringJSON } from "../scoring-json.js"
import type { KasperContext, OpencodeSessionClient } from "../types.js"

export interface V1GenerationOwnership {
  lifetimeSignal?: AbortSignal
  onOwned?(id: string): void
  onReleased?(id: string): void
  onCleanupError?(id: string, error: unknown): void
}

/** Preserve useful text/reasoning and StructuredOutput compatibility without diagnostic model calls. */
export function generationText(
  parts?: Array<{ type: string; [key: string]: unknown }>,
): string {
  for (let index = (parts?.length ?? 0) - 1; index >= 0; index--) {
    const part = parts?.[index]
    if (!part) continue
    if (typeof part.text === "string" && part.text.trim())
      return boundedGenerationText(part.text)
    if (part.type === "tool_result") {
      const content = part.content
      if (typeof content === "string") return boundedGenerationText(content)
      if (content && typeof content === "object") {
        if ("text" in content && typeof content.text === "string")
          return boundedGenerationText(content.text)
        if (Array.isArray(content)) {
          const text = content
            .map((item) =>
              item && typeof item.text === "string" ? item.text : "",
            )
            .join("\n")
          if (text.trim()) return boundedGenerationText(text)
        }
      }
    }
    if (
      part.type === "tool" &&
      part.input &&
      typeof part.input === "object" &&
      !Array.isArray(part.input)
    ) {
      if ("overall_score" in part.input || "groups" in part.input)
        return boundedGenerationText(JSON.stringify(part.input))
      for (const value of Object.values(part.input))
        if (typeof value === "string" && value.trim())
          return boundedGenerationText(value)
    }
  }
  return ""
}

export function createV1Generation(
  client: OpencodeSessionClient,
  ownership: V1GenerationOwnership = {},
): GenerationPort {
  return {
    capabilities: { cancellation: "control-fence", enforcedOutputLimit: false },
    generate: exclusiveGeneration(async (request, options) => {
      const signal =
        options?.signal && ownership.lifetimeSignal
          ? AbortSignal.any([options.signal, ownership.lifetimeSignal])
          : (options?.signal ?? ownership.lifetimeSignal)
      const control = generationControl(request.timeoutMs, signal)
      let ownedID: string | undefined
      let unknownOutcome = false
      try {
        control.assertActive()
        // Fetch AbortSignal plumbing exists in V1, but aborting a create loses its exact ID,
        // and aborting prompt HTTP does not prove the provider settled. Await those calls.
        const created = await client.session.create({
          body: {
            title: `kasper-${request.purpose === "merge" ? "merge" : "scoring"}-${request.sourceSessionID?.slice(0, 8) ?? Date.now()}`,
          },
        })
        ownedID = created?.data?.id
        if (!ownedID)
          throw new GenerationError("Failed to create scoring session")
        ownership.onOwned?.(ownedID)
        control.assertActive() // A late create is cleaned by exact ID without dispatching a prompt.
        let response: Awaited<
          ReturnType<OpencodeSessionClient["session"]["prompt"]>
        >
        try {
          response = await client.session.prompt({
            path: { id: ownedID },
            body: {
              parts: [{ type: "text", text: request.prompt }],
              ...(request.model ? { model: request.model } : {}),
            },
          })
        } catch (error) {
          // Explicit provider format rejection is terminal. Network/server failures may hide a
          // still-running provider attempt; retain ownership and suspend automatic dispatch.
          const explicit =
            error instanceof GenerationError &&
            !error.outcomeUnknown &&
            error.retryable
          unknownOutcome = !explicit
          throw new GenerationError(String(error), explicit, unknownOutcome)
        }
        if (!response?.data) {
          unknownOutcome = true
          throw new GenerationError(
            "Judge response is missing terminal data",
            false,
            true,
          )
        }
        control.assertActive()
        let text = generationText(response?.data?.parts)
        if (
          Object.keys(parseScoringJSON(text)).length === 0 &&
          response?.data?.parts?.some((part) => part.type === "tool") &&
          client.session.messages
        ) {
          const until = Date.now() + Math.min(5000, request.timeoutMs)
          while (Date.now() < until) {
            control.assertActive()
            const messages = await client.session.messages({
              path: { id: ownedID },
            })
            control.assertActive()
            const history = messages?.data ?? []
            for (let index = history.length - 1; index >= 0; index--) {
              const candidate = generationText(history[index].parts)
              if (Object.keys(parseScoringJSON(candidate)).length) {
                text = candidate
                break
              }
            }
            if (Object.keys(parseScoringJSON(text)).length) break
            await new Promise<void>((resolve) => {
              const timer = setTimeout(done, 100)
              function done() {
                clearTimeout(timer)
                control.signal.removeEventListener("abort", done)
                resolve()
              }
              control.signal.addEventListener("abort", done, { once: true })
              if (control.signal.aborted) done()
            })
          }
        }
        control.assertActive()
        return text
      } finally {
        control.dispose()
        if (ownedID && !unknownOutcome) {
          try {
            await client.session.delete({ path: { id: ownedID } })
            ownership.onReleased?.(ownedID)
          } catch (error) {
            ownership.onCleanupError?.(ownedID, error)
            // Keep the ID fenced when cleanup fails. Never scan titles to guess ownership.
          }
        }
      }
    }),
  }
}

const clients = new WeakMap<OpencodeSessionClient, GenerationPort>()
export function legacyGeneration(
  client: OpencodeSessionClient,
): GenerationPort {
  let port = clients.get(client)
  if (!port) {
    port = createV1Generation(client)
    clients.set(client, port)
  }
  return port
}

const contexts = new WeakMap<KasperContext, GenerationPort>()
export function generationForContext(context: KasperContext): GenerationPort {
  if (context.generation) return context.generation
  let port = contexts.get(context)
  if (!port) {
    port = createV1Generation(context.client, {
      lifetimeSignal: context.lifetimeSignal ?? context.runtime?.lifetimeSignal,
      onOwned: (id) => context.kasperSessionIDs.add(id),
      onReleased: (id) => context.kasperSessionIDs.delete(id),
      onCleanupError: (id, error) => {
        void context.logger
          .log("scoring_cleanup_failed", {
            scoringSessionId: id,
            error: String(error),
          })
          .catch(() => {})
      },
    })
    contexts.set(context, port)
  }
  return port
}
