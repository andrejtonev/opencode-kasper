# Shared judge generation port (C06)

Reviewed 2026-10-30 against the installed V1 SDK 1.15.11, native plugin/client/schema 2.2.2 and Effect 4.0.6. C05's [native and declared SDK evidence](V2-SDK-CONTRACTS.md) remains the qualification boundary. No provider call or user host configuration change was made for this chunk.

`Scorer.evaluate(input, generationOrV1Client, {signal?})` and `mergeWeaknesses(patterns, generationOrV1Client, {signal?})` share the same prompt, bounded parsing, finite score validation and stable grouping protocol. Judge version is 1.3.0; the scoring rubric stays 1.0.0. Existing callers supplying a V1 client remain supported. `ctx.generation` supplies a native port; `generationForContext(ctx)` otherwise creates a cached V1 port with exact child-session ownership callbacks and the plugin lifetime signal.

`GenerationPort.generate` takes `{prompt, model?, purpose, sourceSessionID?, timeoutMs}` and optional `{signal}`. It returns text. The port admits one underlying operation at a time; a second concurrent operation fails before dispatch. An unknown remote outcome suspends further dispatch for that port lifetime. A parsed but invalid completed response may be retried within the existing configured retry limit; unknown transport outcomes and cancellation cannot trigger paid retries. Hosts may perform their own physical provider retries, so this is a logical request bound.

## V1 ownership and deadlines

The adapter owns create, prompt, useful StructuredOutput history reads and deletion. Debug logging never sends a diagnostic model request. It announces an exact returned ID before prompting, deletes only that ID, and releases its ownership fence only after successful deletion. Failed cleanup keeps the ID fenced. A create returning after cancellation or deadline is announced and deleted without prompting.

Installed V1 SDK declarations and a custom-fetch offline fixture confirm that the request options support a real AbortSignal and forward it to Fetch's Request. See [V1 SDK method](https://github.com/anomalyco/opencode/blob/v1.15.11/packages/sdk/js/src/gen/sdk.gen.ts) and its [fetch client](https://github.com/anomalyco/opencode/blob/v1.15.11/packages/sdk/js/src/gen/client/client.gen.ts). This proves HTTP plumbing, not provider termination. Aborting create HTTP can hide the new ID; aborting prompt HTTP can hide a still-running provider attempt. The adapter therefore conservatively awaits those underlying calls while applying cancellation/deadline control fences before and after every await. A timeout cannot release admission while its request is still pending. Late output is discarded and cleaned after actual terminal data arrives.

Unknown transport rejection or missing terminal response data retains exact ownership and suspends the port. It does not guess ownership from titles, issue a second provider request, or claim that deleting a session proves provider cancellation. This conservative behavior can keep an evaluation pending past its control deadline when V1 transport never settles. Runtime disposal remains bounded; native provider termination and safe recovery of unknown outcomes require separate acceptance evidence. A deliberately annotated `GenerationError` may represent a known terminal retryable rejection for a trusted host implementation; arbitrary error strings do not.

## Native Effect bridge

Construct the helper inside the actual native setup effect:

```ts
const generation = yield* createV2Generation(
  context.experimental.generate,
  runtime.lifetimeSignal,
)
```

It captures the public `Effect.context()` services and uses `Effect.runPromiseWith(services)(boundEffect,{signal})` for later Promise core calls. It combines caller, lifetime and deadline signals and uses actual `Model.ID.make`/`Provider.ID.make` with native `{id,providerID}` model references. The production helper compiles against the pinned real context, with no fake V1 client or private Core service. Offline service-capture and interruption fixtures pass; C05 also proved native public RPC interruption. Native provider network abort and billed retry behavior remain unverified.

The 2.2.2 stateless text input supports `{prompt,model?}`, with no per-request output token limit. Both host ports advertise `enforcedOutputLimit:false`. The 100,000-character retained response bound protects parsing and storage; it is not a provider token or spend ceiling. See the pinned [generation protocol](https://github.com/anomalyco/opencode/blob/v2.2.2/packages/protocol/src/groups/generate.ts) and [native implementation](https://github.com/anomalyco/opencode/blob/v2.2.2/packages/core/src/generate.ts).

## Evidence and proposal eligibility

`max_score_input_chars` now bounds the entire session evidence block, including tool arguments/results, delegation, XML delimiters, escaped expansion and visible omission markers. The unit is UTF-16 characters after escaping. The existing configuration range is 1,000–50,000. Field caps still apply, and a weighted allocation retains evidence from each selected field within the one shared budget. Tool/delegation counts remain bounded. Instructions and the static rubric are separate; each agent prompt, rules, user guidance and known-weakness section has its own configured `max_agent_guidance_chars` bound. Group identity evidence must fit intact within the merge budget; overflow preserves all patterns without a model call.

Deliberate completed-turn splitting remains supported so an oversized multi-turn history does not checkpoint entirely omitted later turns. Its size estimate now includes escaped tools and delegation. Core does not silently remove tools or response tails before handing them to the scorer. Each large single-turn omission is visible and sets `ScoreCard.evidence_truncated`; configured minimal detail omissions are explicit as well.

Partial observations remain readable in their stored score card and their numerical score can be recorded, but they cannot queue or auto-apply improvements. State aggregate/rebuild/decrement paths exclude their strengths and weaknesses; their suggestions cannot populate future aggregate proposals. Thus later manual improvement cannot reuse an insufficient observation through aggregate counts. Reload and replacement regression tests verify these fences. Mixed complete/partial split results conservatively mark the combined card partial.

Checks: frozen dependency install, actual SDK contract compilation, repository typecheck/build, **643 tests passed / 27 opt-in tests skipped**, and lint with the two pre-existing unused-suppression warnings. Additional focused checks passed after the final small helper and lifecycle refinements. C10 must wire the native setup and expose coverage/cancellation limitations in its result presentation; C11 must qualify provider behavior and packaged host acceptance.
