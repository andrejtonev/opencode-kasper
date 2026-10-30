# V2 migration review: scoring, history, and judge generation

Reviewed 2026-10-30. Covers migration-guide tasks 2, 5, and 6 separately. No production source edits or paid/model requests. Existing tests and additional probes used mocks or compiler declarations only.

## Evidence boundary and versions

- Kasper declares a V1 plugin dependency. Frozen installed packages are `@opencode-ai/plugin` 1.15.0 and `@opencode-ai/sdk` 1.15.11. Source/API evidence comes from their installed declarations and Kasper source, not a running host scoring demonstration.
- The sibling STM installation contains `@opencode/plugin`, `@opencode/client`, and `@opencode/schema` **2.0.8**. Inspected read-only.
- Official matching source is tag `v2.0.8`, resolved through GitHub to commit **7673ed6bd6547ee0dcb81aab55f1392fb751d652**. Source links below use that immutable commit.
- Latest official documentation inspected is commit **92b2ca0dd727942e00aba3523ed141d53e78ea28**, whose plugin package version is **2.2.2**. Its wider API cannot be substituted for 2.0.8 declarations/runtime.
- `@opencode-ai/sdk/v2` in the public [SDK documentation](https://opencode.ai/docs/sdk/) is a V1-host REST client export; it is distinct from the new `@opencode/plugin` V2 architecture.
- Relevant official documentation: [migration](https://github.com/anomalyco/opencode/blob/92b2ca0dd727942e00aba3523ed141d53e78ea28/services/www/src/docs/content/build/plugins/migrate-v1.mdx), [server API](https://github.com/anomalyco/opencode/blob/92b2ca0dd727942e00aba3523ed141d53e78ea28/services/www/src/docs/content/build/plugins/server.mdx). Server API lines 701-704 describe sessionless native generation; lines 781-816 now describe plugin session listing/removal. Those latter operations are absent from the installed 2.0.8 plugin domain.

## Task 2: scoring rubric and weakness aggregation

**Verdict: portable and feasible, but extracting host calls alone would preserve significant existing correctness defects.** Most rubric, prompt construction, decision thresholds, persistence and improvement logic can remain shared. The guide's low-medium estimate is reasonable for extraction, not for all correctness repairs.

### Actual V1 flow

1. `runEvaluation` holds `evalMutex`, checks deduplication and reads current AGENTS.md/agent prompts (`src/evaluate.ts:89`, `src/evaluate.ts:129`). It builds `ScorerInput` with user request, response, tools, delegation, agent scope, compaction state and known weaknesses.
2. Large multi-pair inputs are evaluated serially (`src/evaluate.ts:174`); `aggregateScoreCards` averages category/overall scores, deduplicates weakness strings and concatenates suggestions (`src/evaluate.ts:60`). Shared code currently loses per-pair judge/model/rubric metadata in this aggregate.
3. `Scorer.evaluate` retries judge attempts, returning a fallback if none succeed (`src/scorer.ts:291`). `tryEvaluate` normalizes output (`src/scorer.ts:1117`). `runEvaluation` excludes fallback cards and scores <=0 from persistence (`src/evaluate.ts:272`), records accepted cards, then invokes global and per-agent LLM merges (`src/evaluate.ts:348`, `src/state.ts:422`). Improvements are considered under the same mutex.

### Findings that require explicit decisions

- **Malformed numeric categories can enter state:** `clamp` receives category fields without runtime numeric/finite validation (`src/scorer.ts:1117`, `src/scorer.ts:1158`). A mocked valid overall score with `communication: 'not a number'` yielded `fallback=false` and `NaN` category in the offline probe.
- **A genuine zero score is treated as an infrastructure failure:** `src/evaluate.ts:272` discards all scores <=0 even though the rubric allows 0.0 (`src/scorer.ts:36`). Use typed successful/failed outcomes rather than score-as-status.
- **Merge truncation silently drops evidence:** only the first 20 weaknesses are sent (`src/scorer.ts:171`, `src/constants.ts:18`), but a successful response replaces the whole list (`src/scorer.ts:244`, `src/state.ts:434`). Offline input of 21 single-count patterns returned total count20 and lost the 21st unprompted pattern.
- **Model-produced counts and identities are trusted:** merge output counts are rounded without finite validation (`src/scorer.ts:246`); renamed patterns lose their fixes because lookup uses exact old text (`src/scorer.ts:238`). It is possible to inflate counts or lose remediation provenance.
- **Tool output can escape the evidence envelope:** requests/responses are escaped, but rendered tool result is inserted directly (`src/scorer.ts:1457`). A result containing `</result>` can alter prompt boundaries. Escaping alone cannot guarantee resistance to prompt injection; schema, explicit untrusted-data wording and write validation remain necessary.
- Shared source `considerImprovement` still accesses host/file capabilities through a broad context. Extract generation first; do not reproduce a giant fake V1 client inside V2.

### Balanced design

Keep existing rubric wording and thresholds initially, preserving intentional policy decisions separately from adapter work. Extract pure `buildJudgePrompt`, `parseJudgeOutput`, and `aggregateEvaluations` functions. A successful `ScoreCard` must have finite scores in [0,1], recognized target enum, bounded strings/arrays and suggestions linked to observed weaknesses. Invalid output is a typed failure and cannot enqueue writes. Record model, rubric, prompt hash, evidence range, truncation and parser version in both single and aggregate records.

Change weakness merging to request **groups of stable input IDs**, not authoritative output counts. Core validates every group, prohibits overlap/unknown IDs, calculates counts itself, preserves unselected/unprompted tail entries and links fixes to source observations. If parsing/group validation fails, keep the original snapshot. Reconcile against a snapshot revision before applying a merge; do not hold the evaluation mutex across optional network merges. Debounce/bound merges independently so one new score does not necessarily launch one global plus N per-agent calls.

## Task 5: conversation history and batch scoring

**Verdict: possible with a full durable-history path and supported enumeration, but not feature complete using only the declared 2.0.8 plugin context.** Normalization needs to repair V1 assumptions as well as adapt V2.

### Actual V1 flow and baseline gaps

- Manual scoring calls `session.messages`, detects agent transitions, builds completed user/assistant pairs and evaluates them (`src/evaluate.ts:759`, `src/evaluate.ts:847`, `src/evaluate.ts:904`). Batch loops selected IDs serially and parses human-readable manual-result text to determine status (`src/evaluate.ts:1196`, `src/evaluate.ts:1223`). Child discovery merges runtime registries with `session.list` (`src/evaluate.ts:1105`).
- `extractToolCallsFromMessages` recognizes only `tool_use` plus same-message `tool_result` (`src/evaluate.ts:488`). Actual installed V1 SDK declares `type:'tool'`, `tool`, `callID`, `state.input`, completed `state.output`, failed `state.error` (`node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts:211`, `:263`). Existing tool-history test uses the synthetic format (`tests/evaluate.test.ts:1108`). Offline actual-shape fixture retained **zero** tool calls. Manual/polled history scoring can therefore lose the strongest evidence even before migration.
- `buildEvalFromMessages` retains only complete pairs but stores the ID of the last raw message (`src/evaluate.ts:699`, `src/evaluate.ts:729`, `src/evaluate.ts:756`). Offline two-turn non-idle fixture scored first pair only but committed cursor `a2` belonging to incomplete second pair. Later incremental reads can permanently skip that evidence.
- Agent detection splits whenever assistant metadata changes (`src/evaluate.ts:440`). A user request before the first assistant agent identity can form a separate segment; A-B-A segments share `${sessionID}|agent:A` and later A work is skipped (`src/evaluate.ts:1036`). Multi-segment path marks parent evaluated even if every `runEvaluation` fails (`src/evaluate.ts:1062`). Segment identity must include range, not merely agent name.
- Manual builder passes `isIdle=true` unconditionally (`src/evaluate.ts:904`) rather than confirming active-generation state. Batch uses UI strings and can classify failed/stale results as successes (`src/evaluate.ts:1258`). These are real correctness concerns, not V2 limitations.
- `agent` selection/mention parts are treated as delegation records (`src/evaluate.ts:403`). A selected agent and an actual subagent call are different facts; use explicit tool/delegation evidence and child linkage.

### V2 contracts and possible flow

- Installed `dist/promise/session.d.ts:143` exposes `context` but not `list`, `remove` or `message.list`. Full client declares `session.list`/`remove` and top-level `message.list` (`../opencode-short-term-memory/node_modules/@opencode/client/dist/promise/generated/client.d.ts:31`, `:41`, `:91`). Both lists return `{data,cursor}` and must be paginated.
- **`session.context` is not full historical evidence after compaction:** [store.ts:179](https://github.com/anomalyco/opencode/blob/7673ed6bd6547ee0dcb81aab55f1392fb751d652/packages/core/src/session/store.ts#L179) calls `SessionHistory.load(...,'latest')`; [history.ts:83-90](https://github.com/anomalyco/opencode/blob/7673ed6bd6547ee0dcb81aab55f1392fb751d652/packages/core/src/session/history.ts#L83) filters to the latest compaction boundary. A summary cannot substantiate original tool execution/results. Use `message.list` for archive/batch parity.
- Durable V2 records are tagged `user`, `assistant`, `agent-switched`, `compaction`, `idle`, etc.; user text is direct `text`, assistant text/tools live in `content` and assistant identifies `agent`. Tool content is `type:'tool',id,name,state`, with `streaming`/`running`/`completed`/`error`; completed result is content blocks, and error includes type/message/status. Source: [session-message.ts](https://github.com/anomalyco/opencode/blob/7673ed6bd6547ee0dcb81aab55f1392fb751d652/packages/schema/src/session-message.ts), installed `dist/session-message.d.ts:1671`, `:1696`, `:1712`, `:1726`, `:1739`. Tool calls/results are not separate durable call/result messages in this contract.
- Provider/model-visible messages from request hooks are a different format from durable `session.context` records. Do not normalize both with one duck-typed text-only reader.

### Balanced design

Normalize at the adapter boundary into ordered immutable evidence records: user requests, assistant outputs with explicit agent/model and finish/error, tool ID/name/input/status/result blocks, agent switches, compaction boundaries, and execution/idle boundaries. Preserve unsupported/file content as metadata; never claim file contents were observed from a URI alone. Keep untrusted tool data delimited and escaped. Mark truncated/paginated/incomplete evidence explicitly. Share the turn/segment builder, which carries the preceding actual user request across agent switches without fabricating an assistant statement as a request.

Have a `HistoryPort` return scoped pages and provenance (`full_archive` vs `current_context`, retention boundary, order, next cursor). `SessionDirectoryPort` enumerates pages with validated location/project provenance. A full client can be injected only with the actual same-server URL, authenticated connection, and verified location scope; no guessed localhost or ambient-account widening. Current 2.0.8 plugin-only path must declare historical/batch enumeration unavailable. A newer version whose public plugin domain covers these operations can remove that limitation after packaged acceptance.

Persist checkpoints only for the final **successfully scored complete evidence range**, keyed by host session + range + agent + rubric. Missing old cursor/compaction means changed evidence coverage, not permission to silently rescore all history and double-count. Return `EvaluationResult = scored | skipped | failed | cancelled` with machine-readable reasons; formatting for tools/commands and batch summaries happens afterward. Traverse children with one visited set and one depth budget; pass `evaluateChildren=false` when manually scoring each child so recursive calls cannot reset the depth limit.

## Task 6: judge and weakness-merge generation

**Verdict: native V2 generation is feasible; a simpler supported sessionless generation path is preferable. Cancellation is not proven by 2.0.8 Promise declarations and is contradicted by its runtime adapter.**

### Actual V1 flow

`mergeWeaknesses` creates a title-marked temporary session, prompts, parses text JSON, and deletes in `finally` (`src/scorer.ts:185`, `:202`, `:268`). It has no timeout. Judge attempts create a scoring session with a timeout race (`src/scorer.ts:443`), optionally create a second paid diagnostic session in debug (`src/scorer.ts:496`), prompt with another timeout race (`src/scorer.ts:606`), use structured/tool/message-history fallbacks when text is empty (`src/scorer.ts:824`, `:960`), then delete in `finally` (`src/scorer.ts:1185`).

These races stop local waiting but do not abort remote generation. A create that resolves after its race times out never assigns its session ID to cleanup. Repeated retries can overlap still-running model calls. Ownership is discovered via session titles/events rather than pre-registered IDs (`src/index.ts:618`). Event guards exist, but ownership-before-create is stronger and should replace timing assumptions. A debug flag enabling extra model calls must be explicit product policy, not normal migration diagnostics.

### Supported V2 alternatives

1. **Preferred: `ctx.generate.text({prompt, model:{providerID,id}}, requestOptions)`**. Declared in installed plugin `Context` (`dist/promise/plugin.d.ts:39`) and generated client (`dist/promise/generated/client.d.ts:98`). Matching native [core/generate.ts:38-73](https://github.com/anomalyco/opencode/blob/7673ed6bd6547ee0dcb81aab55f1392fb751d652/packages/core/src/generate.ts#L38) resolves the host model/provider credentials and calls native `LLM.generate` with only prompt/model, returning text. It does not load session history, discover tools, run session context/generate hooks or persist a session. Model/provider configuration transforms still affect resolution. No owned-session create/delete or recursive session-event loop is required. New docs describe the experimental nature and deprecated alias; keep version selection inside one adapter.
2. **Optional session-native path: `ctx.session.generate({sessionID,prompt})`** returns `{text}` but uses that session's effective agent/instructions/history/tools and selected model; it is not an isolated judge by default. Source [session/generate.ts:29-70](https://github.com/anomalyco/opencode/blob/7673ed6bd6547ee0dcb81aab55f1392fb751d652/packages/core/src/session/generate.ts#L29). It invokes the dedicated `generate` hook; a `context` hook alone does not isolate it. It also lacks a model parameter, so model must be chosen at creation or through session switching.
3. **Owned auxiliary sessions if required by policy:** preselect valid host IDs and fence them before create, persist ownership metadata, use a purpose-specific generate hook to replace system/messages/options/tools for that owned request only, require cleanup capability and bounded cleanup, preserve fences after failed delete, never delete user sessions by title substring alone. Existing STM code is an implementation example, not the contract: `../opencode-short-term-memory/src/v2-native-generation.ts:113`, `:194`, `:234`.

### Cancellation and error mismatch

The compiler accepts `{signal}` for both native Promise operations. **Installed 2.0.8 Promise plugin runtime ignores that second argument.** [promise/adapter.ts:261-276](https://github.com/anomalyco/opencode/blob/7673ed6bd6547ee0dcb81aab55f1392fb751d652/packages/plugin/src/promise/adapter.ts#L261) wraps only `input` and runs the Effect without passing options/signal (`installed dist/promise/adapter.js:185-197`). Thus a local `AbortController` cannot be claimed to cancel those plugin-context calls. Hook/stream cleanup also does not establish cancellation of every in-flight call.

Choose a tested host/SDK version that forwards cancellation, a trusted injected full client whose HTTP path passes signals (verify server/provider cancellation too), or a small Effect-backed V2 adapter that actually interrupts the native generation Effect. An outer Promise timeout is still useful for responsiveness and late-result fencing, but classify the remote outcome as uncertain until interrupted/settled. Do not start another attempt on uncertain prior generation simply because the UI deadline expired. Native 2.0.8 core wraps provider/auth/model failures as generation errors; Promise plugin methods can reject with native errors/Effect failures, while an HTTP client has client/transport errors. Normalize unknown catches into a stable core failure union and distinguish configuration, provider, timeout, cancellation and unsupported capability.

The sessionless 2.0.8 input has no `maxTokens`, temperature, structured-output schema or generic `options`; compiler negative probes confirm it. Do not silently add such fields. Bound input/output locally and request JSON in the shared prompt. If hard provider output limits are mandatory, select a supported generation capability/version or use the isolated session-native path with real generation options. Local output truncation alone does not bound provider spend.

### Reusable shared contract

```ts
type ModelRef = { providerID: string; id: string; variant?: string }
type GenerationRequest = {
  purpose: 'judge' | 'weakness_merge'
  prompt: string
  model: ModelRef
  signal: AbortSignal
  operationID: string
}
type GenerationFailure = {
  kind: 'configuration' | 'provider' | 'timeout' | 'cancelled' | 'unsupported'
  remoteOutcome: 'not_started' | 'settled' | 'uncertain'
  message: string
}
interface GenerationPort {
  readonly capabilities: {
    isolatedFromSession: boolean
    cancellation: 'native' | 'transport' | 'local_only'
    outputTokenLimit: boolean
  }
  generate(request: GenerationRequest): Promise<
    { ok: true; text: string; model: ModelRef } |
    { ok: false; failure: GenerationFailure }
  >
}
```

Core owns deadlines, bounded retry policy, generation concurrency and operation IDs. Adapter owns host model mapping, native invocation and any auxiliary-session lifecycle. Core fences late completions with operation/lifecycle generation and snapshot revision before recording scores or editing files. Dispose cancels work, waits a bounded drain, flushes state and keeps failed/uncertain ownership records if sessions were used. V1 behavior remains its reference adapter while its cancellation limitations are represented honestly.

## Validation performed

- `bun test tests/scorer.test.ts tests/evaluate.test.ts`: **79 passed, 0 failed, 154 assertions**. All are offline mocks; they do not prove native V1/V2 runtime compatibility.
- In-memory TypeScript probe against real installed `@opencode/plugin` 2.0.8 declarations: **0 diagnostics**. Positive calls `generate.text` and `session.context` accept signal and native `{text}` response; expected compile failures prove absent plugin `list`/`remove`, absent `model.resolve`, absent generation options and rejection of V1 `modelID` naming. No test file/manifests written. Runtime source inspection is deliberately stronger than this type result for cancellation.
- Additional offline source probes: actual V1 `tool` retained0 evidence; incomplete pair committed wrong cursor; nonnumeric category accepted as NaN; merge input21/count21 became result1/count20 with dropped tail and lost fix.
- Official source inspected at matching immutable tag commit and separate latest documentation commit. No live V2 host, inference, provider-account change or sibling-repository mutation.

## Required native acceptance before parity

Use packaged installs on supported V1 and selected V2 versions. Test real completed and failed tools, file result metadata, multi-step outputs, agent switch A-B-A, subagents, streaming/interrupted replies, compaction followed by archive replay, paginated batches and missing checkpoints. Verify exact retained evidence ranges and duplicate counts. Inject failure during generation and cleanup, cancel/reload while calls are in flight, delay create resolution past timeout, and prove no late score/write or recursive judge call. Explicitly verify remote cancellation rather than merely an aborted local Promise. Confirm selected native model/credentials and failed-model errors without substituting an unintended fallback model.

The guide's overall feasibility claim stands. Historical parity and cancellation on the currently cited 2.0.8 plugin-only Promise path are blockers; sessionless native judge/merge generation substantially reduces complexity once its version and cancellation contract are chosen.
