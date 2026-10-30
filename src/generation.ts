/** One logical judge request. Host retries and provider token ceilings are separate capabilities. */
export interface GenerationRequest {
  prompt: string
  model?: { providerID: string; modelID: string }
  purpose: "score" | "merge"
  sourceSessionID?: string
  timeoutMs: number
}

export interface GenerationOptions {
  signal?: AbortSignal
}

export interface GenerationPort {
  readonly capabilities: {
    cancellation: "control-fence" | "effect-interruption"
    enforcedOutputLimit: false
  }
  generate(
    request: GenerationRequest,
    options?: GenerationOptions,
  ): Promise<string>
}

export class GenerationError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
    readonly outcomeUnknown = false,
  ) {
    super(message)
    this.name = "GenerationError"
  }
}

/** Deadlines cancel control flow; they never race an underlying request to release its slot. */
export function generationControl(timeoutMs: number, signal?: AbortSignal) {
  const deadline = new AbortController()
  const timer = setTimeout(
    () => deadline.abort(new GenerationError("Judge request timed out")),
    Math.max(1, timeoutMs),
  )
  const combined = signal
    ? AbortSignal.any([signal, deadline.signal])
    : deadline.signal
  return {
    signal: combined,
    assertActive() {
      if (combined.aborted)
        throw new GenerationError(
          deadline.signal.aborted
            ? "Judge request timed out"
            : "Judge request cancelled",
        )
    },
    dispose() {
      clearTimeout(timer)
    },
  }
}

/** A quarantined remote outcome requires a new host lifetime, never an automatic retry. */
export function exclusiveGeneration(
  execute: (
    request: GenerationRequest,
    options?: GenerationOptions,
  ) => Promise<string>,
): GenerationPort["generate"] {
  let active = false
  let quarantined = false
  return async (request, options) => {
    if (active || quarantined)
      throw new GenerationError(
        quarantined
          ? "Previous judge outcome is unknown; generation is suspended"
          : "Judge generation is busy",
      )
    if (options?.signal?.aborted)
      throw new GenerationError("Judge request cancelled")
    active = true
    try {
      return await execute(request, options)
    } catch (error) {
      if (error instanceof GenerationError && error.outcomeUnknown)
        quarantined = true
      throw error
    } finally {
      active = false
    }
  }
}

/** This bounds retained data, not tokens already generated or billed by the provider. */
export function boundedGenerationText(text: string, limit = 100000): string {
  if (text.length > limit)
    throw new GenerationError("Judge output exceeds retained-data limit")
  return text
}
