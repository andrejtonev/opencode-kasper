# Kasper V1/V2 migration: collected verification and design

> **Implementation and acceptance update:** Follow [SUPPORT.md](SUPPORT.md) and
> [the execution ledger](V2-IMPLEMENTATION-PLAN.md) for the final contracts.
> Separate root/server exports preserve a legacy function module, but C11 found
> host 1.18.23 also prefers `./server` for ordinary package identity. The final
> dual server entry supplies the legacy function; explicit compiled-file loading
> is an alternative. This assessment remains review history.

Reviewed: 2026-10-30. Repository baseline: `2d9516685670ebebd3c6c811e59460ba883e89d7`, Kasper 1.2.0.

## Decision

The migration is feasible, but the original guide is not sufficient to implement or promise full parity. Keep one scoring/improvement core and explicit V1/V2 adapters. Repair the correctness defects exposed by the review instead of treating current V1 behavior as a complete specification.

Full native V2 compatibility remains unverified. This review traces source, checks official contracts, runs the existing offline suite, and reproduces selected defects without model requests. It does not implement the migration or qualify a published package.

## Evidence and task ownership

Every feature row in `V2-MIGRATION.md` was assigned to an agent. The agents own separate task sections, and this document collects their findings and resolves the shared design.

| Task | Agent/report | Verdict and required change |
| --- | --- | --- |
| 1. Startup/shutdown | [Host review](V2-REVIEW-HOST.md) | Feasible; choose explicit supported entrypoints and implement real lifetime cleanup. |
| 2. Scoring/weakness aggregation | [History review](V2-REVIEW-HISTORY.md) | Reusable after extracting generation; failed/partial scoring must not advance unscored boundaries. |
| 3. State/backups/locking/rollback/expiry | [Storage review](V2-REVIEW-STORAGE.md) | Reusable foundations, substantial safety repairs required for concurrent writers, override backups, deletion and expiry. |
| 4. Automatic scoring/checkpoints/children | [Host review](V2-REVIEW-HOST.md) | Feasible with public event routing, per-session scheduling, completion boundaries and stale-result fencing. |
| 5. History/batch scoring | [History review](V2-REVIEW-HISTORY.md) | Feasible with version-specific durable evidence normalization; 2.0.8 plugin context cannot enumerate historical sessions by its declared API. |
| 6. Judge/merge generation | [History review](V2-REVIEW-HISTORY.md) | Prefer native sessionless generation; 2.0.8 Promise cancellation has a runtime defect. |
| 7. Commands/tools/results | [Host review](V2-REVIEW-HOST.md) | Native V2 registration and direct command execution; explicit invoking-session identity and terminal rendering. |
| 8. AGENTS.md improvements | [Storage review](V2-REVIEW-STORAGE.md) | V2 discovery differs: AGENTS.md sources combine; CLAUDE.md fallback must not be carried forward. |
| 9. Agent prompt improvements | [Storage review](V2-REVIEW-STORAGE.md) | Feasible for verified editable sources; arbitrary plugin-derived effective text has no safe automatic write target. |
| 10. Compaction context | [Host review](V2-REVIEW-HOST.md) | Adapt the dedicated compaction hook; bounded snapshot only, no judge call in the hook. |
| 11. Configuration | [Storage review](V2-REVIEW-STORAGE.md) | Preserve standalone Kasper files; adapt V2 plural host fields/discovery and repair dropped path settings. |

Primary official evidence:

- [V1 plugin docs](https://opencode.ai/docs/plugins/) and [V1 REST SDK docs](https://opencode.ai/docs/sdk/). The latter's `@opencode-ai/sdk/v2` is **not** the OpenCode V2 plugin API.
- [Official V2 migration guide, pinned](https://github.com/anomalyco/opencode/blob/92b2ca0dd727942e00aba3523ed141d53e78ea28/services/www/src/docs/content/build/plugins/migrate-v1.mdx).
- [Official V2 server API, pinned](https://github.com/anomalyco/opencode/blob/92b2ca0dd727942e00aba3523ed141d53e78ea28/services/www/src/docs/content/build/plugins/server.mdx).
- [Promise plugin API implementation guide, pinned](https://github.com/anomalyco/opencode/blob/92b2ca0dd727942e00aba3523ed141d53e78ea28/packages/plugin/src/README.md).

The current official source snapshot declares `@opencode/plugin` **2.2.2**. The locally installed reference in the STM checkout is **2.0.8**. APIs from those snapshots must not be mixed into one presumed contract. STM is corroborating implementation evidence, not the API authority.

## Corrections to the original guide

1. **Entrypoint compatibility needs a support policy.** Official migration docs specify a default object containing `{ id, setup, server }`, with V1 object-entrypoint support documented from **1.18.29**. The current host is **1.18.23**, and Kasper's plugin peer range starts at **1.14.0**. The host review also found older tagged source with an object-loader branch, conflicting with the documented floor. Consequently, neither old-host rejection nor old-host compatibility is established here. Use the documented support floor for a new unified release until native loader tests establish a wider range. Retain the current V1 package version for older users.
2. **The missing session methods are version-specific.** The 2.0.8 plugin `SessionDomain` lacks `list`/`remove`; current 2.2.2 source/docs expose them. Moreover, 2.0.8 `session.context` reads the latest compaction window, not the full archive. Historical/batch evaluation needs an explicitly complete, paginated durable-history path, not merely session enumeration. The 2.0.8 full client has enumeration and message listing, but creating a correctly authenticated client for the same server/location is a separate integration requirement. Do not cast the plugin context to the full client or guess a localhost endpoint.
3. **Auxiliary sessions are not the preferred V2 judge design.** `ctx.generate.text` exists in 2.0.8. Current docs describe `ctx.experimental.generate.text`, retaining the older name as deprecated. This path uses the host's model/provider machinery without a session, tools or session history. It avoids judge-session recursion and cleanup. It is experimental and needs a pinned contract.
4. **A declared signal does not prove cancellation.** The 2.0.8 Promise adapter drops the second `requestOptions` argument on API methods. A local timeout can return control while provider work continues. Require a verified runtime cancellation path before enabling timeout retries or claiming a bounded generation lifetime.
5. **V1 is not an unqualified parity reference.** The review found missed documented tool evidence, unsupported event/close hook assumptions, ignored command `stop/message` fields, a checkpoint that can skip unfinished work, agent-segment collisions, invalid numeric score acceptance, weakness-merge evidence loss, and unsafe prompt override writes. Preserve intended features and UX, then verify the corrected semantics on both hosts.
6. **Instruction/config discovery is not a spelling change.** V2 uses `agents.<id>.system`, combines applicable AGENTS.md sources, and requires explicit handling of transformations and provenance. Current source's treatment of excess config fields also does not support a blanket claim that every unknown key is rejected; a key may instead be ignored/dropped.
7. **The 4–7-day estimate is not validated.** It excludes resolving these baseline defects and version-specific runtime questions. Estimate implementation only after the first contract spike below.

## Architecture

Use a modest internal boundary; avoid building a generic OpenCode framework.

```text
src/index.ts                documented dual entrypoint, once support floor chosen
src/hosts/v1.ts             old SDK envelopes, public bus events, V1 tools/commands
src/hosts/v2.ts             pinned native V2 domains, hooks and transforms
src/hosts/v1-history.ts     documented V1 message/part normalization
src/hosts/v2-history.ts     V2 durable records, location/agent/control transitions
src/core/runtime.ts        lifetime, bounded queue, per-session revisions
src/core/evaluation.ts     eligible turns, scoring orchestration, commit decisions
src/core/actions.ts        pure session-bound action handlers and result values
src/core/contracts.ts      small normalized contracts below
src/instructions/*         host-specific discovery and proven source adapters
src/scorer.ts              shared rubric/prompt/parser, GenerationPort only
src/state.ts               shared persistent data, revisioned commit/delete rules
src/tui.ts                 V2 rendering/RPC only if terminal acceptance requires it
```

Existing small managers/utilities can stay in place during extraction. These paths are a proposed layout, not files implemented in this review. Move code only when the boundary makes a tested flow simpler.

Keep SDK runtime imports behind their respective entrypoint/adapter so V1 consumers do not eagerly load V2 and vice versa. Test production-only dependency installation and package exports; do not infer loader behavior from a subpath export alone. For older V1 support, retaining the current published package line is the established fallback until a separate entrypoint's actual installation syntax is qualified.

### Core contract sketch

The following is an internal design sketch, not a claim that these methods exist on either SDK. Adapter constructors translate and validate the actual pinned host contracts.

```ts
type SessionRef = {
  id: string
  directory: string
  parentId?: string
}

type EvidenceItem =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; input: unknown;
      status: "pending" | "running" | "completed" | "error";
      output?: unknown; error?: string }

type CompletedTurn = {
  session: SessionRef
  userMessageId: string
  throughMessageId: string
  agentId: string
  instruction: string
  evidence: readonly EvidenceItem[]
}

interface HistoryPort {
  // No list implementation = explicit unsupported historical/batch action.
  listPage?: (cursor: string | undefined, signal: AbortSignal) =>
    Promise<{ sessions: SessionRef[]; next?: string }>
  // Snapshot identifies completeness: full archive or current compaction window.
  read(session: SessionRef, signal: AbortSignal): Promise<HistorySnapshot>
}

interface GenerationPort {
  // Capability must come from an implementation/runtime probe, not types alone.
  cancellation: "verified" | "unverified"
  text(request: JudgeRequest, signal: AbortSignal): Promise<JudgeResponse>
}

interface InstructionPort {
  readEffective(session: SessionRef, agentId: string): Promise<InstructionSnapshot>
  plan(target: EditableSource, guidance: string): Promise<WritePlan>
  commit(plan: WritePlan): Promise<ApplyResult>
  rollback(recordId: string): Promise<ApplyResult>
}

type Invocation = {
  session: SessionRef
  signal: AbortSignal
  source: "command" | "tool" | "tui"
}
```

`HistorySnapshot`, `JudgeRequest/Response`, `EditableSource` and `WritePlan` are internal values detailed below. Keep domain values independent of SDK response envelopes. Return explicit `unsupported`, `incomplete`, `conflict`, `cancelled` and `failed` outcomes where appropriate; do not quietly substitute a different session or editable source.

### Capability policy

For a new unified release, start with the documented V1 floor and one pinned V2 SDK/host combination. The 2.2.2 source snapshot is a candidate to investigate, not a runtime-qualified release in this review.

- V2 full parity requires historical enumeration, complete durable evidence, session-bound command execution, instruction provenance and verified generation cancellation.
- A 2.0.8 compatibility mode can explicitly disable historical/batch scoring if no supported same-server client is available. It must not silently promise those features from observed live IDs.
- If generation cancellation is unverified, automatic timeout retries stay disabled and an unresolved operation retains its concurrency slot until settlement. Status reports the limitation. Late results still cannot mutate current state.
- Unsupported editable origins remain readable for scoring. Apply/migrate reports the reason and offers an explicit Kasper-owned source choice through the existing action flow; it does not fabricate a file origin from effective text.
- Capability discovery must be deterministic, without diagnostic LLM calls. Do not probe mutating methods by creating/deleting arbitrary sessions at startup.

## End-to-end flows

### V1 after extraction

The V1 entrypoint initializes the same core, translates SDK envelopes and routes the public `event` bus callback into normalized events. An idle notification schedules a read; it does not run the judge inside the host callback. History normalization handles actual `type: "tool"` records and their state, with any legacy compatibility format treated explicitly. Eligible completed turns become shared judge requests. The V1 generation adapter owns create/prompt/abort/delete behavior and response envelopes. The core validates the response, commits only the successfully scored boundary, then computes improvements through the instruction port. Commands/tools call the shared action handler with the invoking session.

V1 startup/disposal and direct command dispatch require native probes against the selected support floor. Returning undeclared `close` or injecting undeclared `stop` is insufficient evidence that the host honors them.

### V2

`setup(ctx)` builds the V2 adapter and shared runtime. Register hooks/transforms synchronously where required and start a supervised public event subscription. Resolve every event/session's own directory; `ctx.location` only describes the plugin instance's loading location.

Idle/history changes coalesce into one per-session queued job. Read durable history through the pinned public API, normalize agent selections and tool states, and preserve compaction/control records as boundaries rather than scoring them as user requests. Require archive completeness for historical actions; an empty/current window cannot silently stand for the full conversation. Generate a judge response with the selected host model through sessionless native generation. Validate and commit through the same shared core. Improvement writes go through V2 source discovery and a conflict-checked plan. AGENTS.md updates become effective at the next model request according to the reviewed V2 instruction contract; agent-source edits wait for source/catalog refresh and re-read effective instructions before reporting activation. Calling `agent.reload()` alone may replay previously captured source data; Kasper-owned overlays can explicitly update their captured state then reload.

For native commands use command registration/execution that returns control without an agent model request. Tools use JSON schemas, their execution context's session/location and structured content. Keep the result string/structured value shared and adapt rendering at the host edge. Add a small typed RPC/TUI layer only for result presentation that cannot be achieved by server command output. TUI code must never independently perform state or file mutations.

V2 command executors return `void`; a returned string is not a UI result channel. Correlate displayed results by request/session/location and suppress repeat mutations during receiver retries. Do not use durable synthetic model messages as an invisible administrative output channel. Pending improvements use stable IDs/revisions: reserve, apply, then acknowledge; an unsuccessful apply must not consume the queued suggestion. Validate mutually exclusive targets/ranges in the shared action layer, not just schema descriptions.

### Evaluation boundaries and concurrency

1. Normalize history with stable message/tool IDs and explicit completion state. V2 tool records contain their own input/state/content/error; do not invent a mandatory cross-message pairing format. Preserve agent identity per evaluated turn, including mid-session switches and child sessions. A fork can also have a parent ID; keep parent linkage separate from proven task-child classification.
2. Select completed, unscored turns. A user message or unfinished assistant/tool must never become the persisted evaluation cursor. Fetching the last record is not completing an evaluation.
3. Create a bounded job key from location, session, turn boundary, rubric/model version and evidence hash. One active job per session; start with one generation slot per plugin runtime. Coalesce additional event notifications.
4. Snapshot evidence/instructions/config before paid work. Bound aggregate prompt size including tool inputs/outputs, not text alone, and identify omitted evidence. Treat conversation/tool text as evidence data, not judge instructions.
5. Run generation outside state/file locks. Score validation failure, transport failure or fallback cannot produce an automatic instruction update. If only some split turns succeed, record those exact units; never advance through unsuccessful units.
6. Before commit, check lifetime, session deletion/reset revision, job ownership, source evidence revision and cancellation. Apply score plus boundary atomically. A stale result is discarded without altering aggregates or improvements.
7. Preserve successful per-turn results under retries/restarts through a versioned ledger or cursor-plus-boundary records. Persisted migration from today's session-only records must not reinterpret arbitrary raw message IDs as proven completion.

Agent segments include their evidence range so A-B-A does not collide on an agent-name-only key. Carry the actual preceding user request into a new segment, not an assistant statement. Manual scoring reads actual completion/busy state instead of forcing idle. Batch results consume typed outcomes rather than parsing rendered UI strings. A real successful zero score is valid; score magnitude must not double as transport status.

### Judge isolation and cancellation

Use one `GenerationPort` for scores and weakness merges. Both have bounded input/output, deadline, caller/lifetime cancellation and validated results. Parse shared JSON with the current rubric/schema; do not assume the sessionless text API supplies V1 structured-output envelopes.

Validate every category as a finite number in range before creating a successful card. Preserve rubric/model/evidence hashes in multi-turn aggregates. Escape/delimit all tool input/output as untrusted evidence just as carefully as user/assistant text. A suggested write must remain linked to observed weaknesses and pass independent mutation validation.

Weakness merging asks for groups of stable observation IDs. Core verifies group membership/non-overlap, derives counts itself, preserves fixes/provenance and all input entries omitted from the bounded merge request, then commits against the snapshot revision. The judge cannot invent authoritative observation counts. Debounce optional merges separately rather than launching global and per-agent model calls after every score.

V2's reviewed sessionless core path resolves the model and invokes the native LLM directly. It has no conversation/session history or tools; provider/model transforms still influence model resolution. Request only the rubric, explicit evidence and selected guidance. Do not call `session.generate` on the user's session as an interchangeable shortcut.

The 2.0.8 sessionless API accepts prompt/model but has no declared max-token, temperature or structured-schema options. Local input/output bounds improve processing safety but do not cap provider output tokens or spend. Expose output-limit support as a capability; require a verified supported option/version if a hard provider generation limit is part of the product contract. Do not add undeclared options or silently switch to a different model.

For SDKs with broken Promise signal propagation, verify a fixed SDK, a genuinely cancellable supported transport, or Effect interruption before calling cancellation supported. An HTTP client abort proves client-side interruption only until server/provider cancellation is also verified. A `Promise.race` proves a deadline for the waiter, not cancellation or bounded paid work. Do not release slots and start overlapping retries on an uncertain timeout.

The V1 session-backed path remains adapter-local: create, establish ownership, isolate tools/guidance, prompt, recover only owned response history, cancel when supported, clean up in `finally`. Fence early creation events and handle late successful creates after timeout. Persist exact owned IDs when needed for crash cleanup; a title alone never authorizes deletion. The shared core never enumerates/deletes arbitrary sessions to clean judges.

### Safe instructions, state and rollback

`InstructionSnapshot` contains effective text for scoring plus separately discovered sources. Every editable source records its host kind, canonical path or JSON pointer, precedence/scope, provider adapter, exact byte hash and editability reason. A resolved agent's `system` text alone proves no write provenance.

Use explicit adapters for V1/V2 JSON(C) config, agent markdown, AGENTS.md and each supported plugin override. Do not scan arbitrary JSON files and treat every matching `agent`/`agents` key as authoritative. Plugin-defined sources without a documented writable contract remain read-only. V2 reads all applicable AGENTS.md sources; select a configured write target deliberately rather than choosing whichever first file happens to exist.

`WritePlan` includes the target, exact expected bytes/hash, minimal managed-block or JSON-pointer change, backup destination and expected effective result. Immediately before commit, re-read under a short ownership-aware lock. On mismatch, return conflict and rebuild the plan; do not apply cached contents. Preserve unrelated bytes/comments/newlines. Validate path containment and explicit configured global/external targets after real-path resolution.

Back up exact bytes before every supported write, including plugin override edits. Record before/after hashes and the affected JSON pointer/block, then atomically replace. The existing Windows direct-overwrite fallback does not establish crash atomicity; use a verified replacement path or report failure/recoverable journal state instead of silently promising atomic writes. Snapshot mutable target paths before awaiting so a config reload cannot redirect the write under another path's lock. A write to an AGENTS.md file changes one source of a combined instruction set; verify its actual activation separately from successful disk mutation.

Multi-file inline-to-file migration needs a recoverable operation journal: prepare destination, update its reference, commit metadata, then cleanup only owned artifacts. Crash recovery completes or rolls back the identified operation. Avoid pretending two independent atomic renames make a transaction.

Rollback checks the currently applied hash/owned block. Restore an exact backup only when it cannot erase later external edits; otherwise reverse the identified managed change with conflict detection or report conflict. Expiry must explicitly remove/revise owned guidance through the same plan/commit path if expiry is advertised as deactivation. Metadata-only expiry is a different retention policy and must say so.

Persist deletion/expiry/reset tombstones or revisioned operations so external-state merges cannot resurrect removed improvement records. Serialize read-modify-write operations across instances for a shared state path; atomic file replacement alone does not prevent lost updates. Existing age-only lock reclamation needs owner tokens and a verified ownership/liveness policy. Keep critical sections short; no LLM calls under locks.

Preserve standalone `kasper.json/jsonc` and its current policy through a validated shared normalizer, including `prompt_paths` and `agents_md_paths`. V2 `ctx.options` can supply an explicit override layer, with documented precedence and immutable per-job snapshots. Do not write Kasper-private state/settings into unknown host config keys. Preserve the file-backed state store initially so backup/rollback and V1 continuity do not gain an unnecessary storage migration.

Classify settings as live or restart-required. `state_dir` relocation requires a controlled restart/migration; timers and improvement budgets read one authoritative live config, rather than constructor defaults. Preserve V2 nested agent IDs such as `team/reviewer` as IDs while deriving containment-checked paths separately. For builtin/plugin-only origins, an explicitly selected Kasper-owned append overlay can offer safe improvements without rewriting factory instructions; verify transform order and scope before enabling it.

### Lifetime and compaction

The core owns one lifetime controller, supervised background tasks, timers and per-session revisions. Disposal stops admission, aborts jobs/subscription, removes registrations when needed, awaits bounded draining and flushes durable state. Pending work that cannot cancel remains observable and cannot commit; no unmanaged timer/subscription is left running.

Compaction uses a cheap bounded snapshot of aggregate statistics and applicable guidance in the dedicated V1/V2 hook. Exclude internal judge/admin activity and use one deterministic owned block. Do not trigger scoring, mutate instruction files or await a merge model inside compaction. Keep live context and compaction transformations separate because their hook timing differs.

## Implementation order and acceptance

1. **Contract spike:** choose the supported host versions; package-load the dual entrypoint; prove sessionless generation options, runtime cancellation, durable history/agent/tool shapes, session enumeration and direct command result behavior. Use deterministic/no-model checks first and narrowly scoped native provider evidence when implementing. Resolve discrepancies between 2.0.8 and current source before committing a dependency range.
2. **Correct V1 extraction:** adapters plus shared actions/generation; documented tool normalization; repaired event dispatch/checkpoints/rollback/config paths. Run the existing suite and meaningful regression cases for the reproduced defects.
3. **Manual V2 scoring:** read real durable evidence, select correct agent/location, generate one isolated result, validate and commit one completed turn. No automatic improvements until this path is qualified.
4. **Automatic/history parity:** bounded queue, per-turn checkpoints, children, pagination, deletion/reset fencing, retries and lifetime. Unsupported capabilities must surface in status/results.
5. **Instruction and UX parity:** provenance-aware sources, transactional apply/migrate/rollback/expiry, agent reload verification, AGENTS.md activation, commands/tools/TUI and compaction.
6. **Packaged acceptance:** clean global/project installations on both supported hosts; actual terminal results; provider failure/timeout/cancel/reload/restart; concurrent external edits and shared-state writers. Only then update parity claims or publish.

Acceptance must assert behavior, not just registrations: tool success/error evidence reaches the judge; unfinished work is scored later; no recursive/internal session scoring; no overlapping retries after uncertain cancellation; no stale result commits after deletion/reset; no apply/rollback erases an external edit; expiry survives reload/merge; commands don't unexpectedly request agent generation; both old and new configuration paths load as documented.

## Validation performed

- `bun install --frozen-lockfile`: installed existing locked dependencies without changing manifests/lockfile.
- `bun run typecheck` and `bun run build`: passed.
- All 20 top-level test files explicitly selected: **490 passed, 0 failed**, 1,062 assertions. These are offline/unit/in-process integration tests, not native V2 acceptance.
- `bun run lint`: passed with two existing unused-suppression warnings in E2E test files.
- Agent reports record focused source/type/runtime-adapter probes and temporary-file reproductions. Their overlapping subsets are not added to the 490 baseline count.
- No model requests, publishing, host configuration changes or production source changes were made for this review. Native V2 scoring, terminal acceptance and provider cancellation remain required implementation gates.

The original migration assessment is preserved in `V2-MIGRATION.md`. Detailed task evidence and probe limitations are retained in the three linked agent reports.
