# V2 migration review: lifecycle, automatic scoring, commands and compaction

Reviewed 2026-10-30. Assigned migration rows: startup/shutdown (1), automatic scoring (4), commands/tools/results (7), compaction context (10).

This is a source and installed SDK review with one offline code-flow probe. It does not establish native Kasper V2 runtime parity. No production source edits, model requests, package publication, or changes to STM were made.

## Evidence and version boundary

- Kasper `package.json:60-65` retains V1 peers `@opencode-ai/plugin ^1.14.0`; the freshly installed local declaration package reports **1.15.0**. The sibling STM installed `@opencode/plugin/package.json:4` reports **2.0.8**. Its declarations are primary API evidence, not proof that every V2 server exposes extra methods.
- Official current migration documentation, pinned to **92b2ca0dd727942e00aba3523ed141d53e78ea28**: [migrate-v1.mdx](https://github.com/anomalyco/opencode/blob/92b2ca0dd727942e00aba3523ed141d53e78ea28/services/www/src/docs/content/build/plugins/migrate-v1.mdx), [server.mdx](https://github.com/anomalyco/opencode/blob/92b2ca0dd727942e00aba3523ed141d53e78ea28/services/www/src/docs/content/build/plugins/server.mdx). Rendered documentation paths are `/build/plugins/migrate-v1` and `/build/plugins/server`.
- Versioned official sources: [V2.0.32 plugin context](https://github.com/anomalyco/opencode/blob/v2.0.32/packages/plugin/src/promise/plugin.ts), [session hooks](https://github.com/anomalyco/opencode/blob/v2.0.32/packages/plugin/src/promise/session.ts), [command runtime](https://github.com/anomalyco/opencode/blob/v2.0.32/packages/core/src/command.ts), [session events](https://github.com/anomalyco/opencode/blob/v2.0.32/packages/schema/src/session-event.ts), [status events](https://github.com/anomalyco/opencode/blob/v2.0.32/packages/schema/src/session-status-event.ts).
- V1 evidence: [V1.14.25 prompt runtime](https://github.com/anomalyco/opencode/blob/v1.14.25/packages/opencode/src/session/prompt.ts#L1645), [V1.14.25 plugin loader](https://github.com/anomalyco/opencode/blob/v1.14.25/packages/opencode/src/plugin/index.ts#L243), and local `node_modules/@opencode-ai/plugin/dist/index.d.ts`.
- `/docs/sdk` and `@opencode-ai/sdk/v2` describe a different REST SDK generation. They do not establish the native `@opencode/plugin` V2 contracts.

## Task 1: startup, shutdown and dual entrypoints

**Verdict: feasible, but the guide omits a real V1 compatibility decision and overstates current lifecycle correctness.**

V1 flow: `src/index.ts:270` initializes config/state/managers; `:405` starts config reload; `:456` schedules two stale-session cleanup timeouts; `:465` starts evaluation polling; `:507` returns the V1 hooks; `:830` returns an extra `close` callback. `:492-505` clears intervals and write locks, logs unload, and destroys state.

The installed V1 `Hooks` declaration has no `close`/`dispose` member. The inspected pinned V1 loader routes public bus events exclusively to the returned `event` callback (`plugin/index.ts:243-252`); it does not establish a host call to Kasper's extra `close`. Do not call graceful unload a proven existing V1 feature. Route available instance-disposal events through the declared event hook only after confirming the exact supported host event, or explicitly document older-host lifecycle limitations.

V2 flow is supported directly: `setup(context)` may return `Cleanup` (`@opencode/plugin/dist/promise/plugin.d.ts:54-61` and corresponding versioned source). Register hooks/transforms in setup, start one scoped subscription, then return cleanup that cancels owned resources. Official docs say hook/transform registrations are automatically scoped to plugin lifetime; timers, async subscriptions, subprocesses and application work need plugin cleanup.

The official migration docs explicitly recommend a dual object `{ id, setup, server }` and say V1 object entrypoints require **1.18.29+**. Kasper's current peer floor is **1.14.0**, and the locally reported host is **1.18.23**. However, the retrieved `v1.14.25` loader source already includes a `server` object branch at `plugin/index.ts:66-85`. This conflicts with the current documented floor. Neither declarations nor that branch alone prove the packaged loader accepts the particular mixed export. Treat the documented floor as the conservative support contract; resolve the discrepancy by a packaged zero-model loading probe before making a stronger runtime claim. No host was started here because reliable isolation from already configured global plugins was not established.

Safe design:

1. Keep an old-host function entry at the existing package root or `/v1`; add an explicit `/v2` object entry. This retains the old supported range without guessing how loaders discover mixed exports. A single root object is reasonable only after consciously raising the V1 minimum and accepting the packaging change.
2. Avoid eager runtime imports of both SDKs in either entry. Shared core uses local structural interfaces; each entry lazily imports its own adapter. Mark SDK peers optional if dual distribution requires that and verify production-only consumer installations for each generation.
3. One lifecycle object owns `AbortController`, all timeout/interval handles, event-consumer promise and in-flight evaluations. Setup failure calls the same idempotent disposal routine. Cleanup stops admission first, aborts calls, clears every timer including stale-cleanup timeouts, waits for a bounded drain, then flushes/destroys state.
4. The current evaluation timeout at `src/index.ts:468-479` resets a boolean without aborting old work. `runEvaluation` has a mutex (`src/evaluate.ts:90-103`), which reduces simultaneous scoring but does not prevent overlapping polling reads or a late completion after destruction. Keep a per-job generation token and verify token/lifetime immediately before persistence. A timeout is not cancellation.
5. Do not clear process-wide write locks while another plugin instance can still hold them (`src/index.ts:499`). Release instance-owned resources after jobs have stopped; scope locks by the canonical state directory.

## Task 4: automatic scoring, checkpoints and child sessions

**Verdict: event-driven automatic scoring is possible; historical discovery and checkpoint correctness need explicit repairs/capabilities. Current V1 behavior cannot simply be preserved unchanged.**

V1 flow: returned `event` handles idle (`src/index.ts:543-565`); polling lists all sessions, filters installation time/own IDs/deleted IDs/debounce (`:837-859`), reads messages (`:876-880`), finds prior checkpoint (`:884-897`), builds complete pairs (`:902-910`), evaluates (`:951-959`), then walks children (`:961-980`). `src/evaluate.ts:1106-1185` merges runtime child maps with a full session list and recurses to depth three.

The extra returned `session.created`, `session.updated`, `session.deleted`, `message.updated` callbacks (`src/index.ts:609-741`) are not declared V1 hooks and are not called by the inspected V1 bus routing. Those behaviors must move into the declared `event` handler; otherwise current-session identity, ownership fencing, child registration and idle invalidation are not established. The poll path compensates for some metadata but not all event-dependent behavior. Do not infer working raw event-key hooks from mocks.

The V2 installed plugin `SessionDomain` is a `Pick` which includes `create/get/context/wait/...` but excludes `list/remove/active/message.list` (`@opencode/plugin/dist/promise/session.d.ts:143-145`). The full installed client has `session.list/remove/active` (`@opencode/client/dist/promise/client.d.ts:29-42`). Therefore automatic scoring for sessions observed during this plugin lifetime can use supported events plus `get/context/wait`; polling all historical sessions and restart recovery are a separate supported-client access requirement. A dynamic cast asserting `ctx.session.list` exists is not enough. Root's history review should choose the explicit supported client/bootstrap path or advertise a disabled historical capability.

V2 events provide concrete adapters:

- `session.created` data contains `sessionID`, `location`, optional `parentID`, `agent`, metadata (`session-event.ts:48-66`).
- `session.agent.selected` changes agent identity (`:69-77`); a session can contain multiple agent segments.
- `session.execution.started/succeeded/failed/interrupted` distinguishes work lifecycle (`:239-258`).
- `session.status` includes `idle/busy/retry`; `session.idle` exists but is deprecated (`session-status-event.ts:9-51`).
- `session.deleted` removes tracked state (`session-event.ts:177-185`).
- A fork also has `parentID` (`:187-201`). Parent linkage alone does not prove a task child. Keep parent relation separate from child-kind classification, using explicit task provenance where the target host supplies it.

Read V2 `event.data`, not V1 `properties.info`. Scope admission to event/session location and workspace. `ctx.location` is the plugin instance's location, not necessarily the location of every readable session; the official docs call this out.

### Reproduced existing checkpoint defect

`buildEvalFromMessages` correctly filters to complete pairs (`src/evaluate.ts:635-702`) but takes `lastMessageId` from the final raw message, including an unfinished/unscored trailing pair (`:729`, `:756`).

Offline Bun probe executed actual `buildEvalFromMessages` with `u1/a1/u2/a2`, where pair two is unfinished and `isIdle=false`. Output was:

```json
{"firstPairs":["first task"],"checkpoint":"a2"}
```

Adding completed `a3` and incrementing from checkpoint `a2` produced no later pending evaluation. The checkpoint consumed the unscored second user request. This is a correctness blocker in the reusable core, not a V2 API limitation.

Safe design:

- Normalize a bounded durable history with explicit agent segment and terminal boundaries. Compute checkpoint from the last **scored complete turn**, never from the last fetched record. Include stable record/turn boundary and source fingerprint; handle removed/reverted/compacted checkpoints by an explicit reset/recovery decision rather than silent consumption.
- One scheduler per state-directory instance, with per-session debounce and invalidation epochs and a bounded global evaluation concurrency of one initially. Events only invalidate/schedule; the scheduler reads a stable snapshot and rechecks lifetime/deletion/ownership before scoring and commit.
- Persist a unique `(sessionID, agentSegment, throughBoundary)` evaluation identity and update score plus checkpoint together under the same state mutation. Avoid deleting `sessionsEvaluated` outside that ownership boundary as the sole means of admitting incremental work.
- Schedule children independently. Do not score an active child merely because its parent reached idle. Use real child completion and its own checkpoint; bound graph traversal and visited IDs.
- Fence judge/merge IDs before creation-related events can cause scheduler admission, and use exact ownership metadata/recorded IDs for deletion. Titles are corroboration or legacy recovery hints, not proof that a user session belongs to Kasper.

STM's `src/v2-idle-update.ts:180-280` corroborates cancellation epochs, bounded wait/read, scoped subscription and child classification. It deliberately handles primary memory updates, so copying it would exclude children Kasper must score. Its text-only history reader must not replace Kasper's tool-aware evidence.

## Task 7: commands, tools and readable results

**Verdict: supported V2 registration and invoking-session binding; command return values are not a readable UI contract. Existing V1 interception has a confirmed host-contract defect.**

V1 flow: config hook injects `/kasper` template (`src/index.ts:508-528`); command interception calls shared dispatch and assigns `output.message/output.stop` (`:577-606`); tools call shared handlers (`src/tools.ts`). Tools ignore their execution context (`:34`, `:58`, `:72`, `:129`) and score-current fallback uses a process-wide `ctx.lastActiveSessionID` (`src/handlers.ts:502-511`).

Confirmed V1 contract defect: the pinned official V1 command runtime calls `command.execute.before` with `{ parts }`, ignores extra fields, then calls `prompt({..., parts })` (`prompt.ts:1645-1658`). Thus setting `message` and `stop` does not establish interception or zero chat-model dispatch. Kasper may execute the administrative action and then submit the command template to the model, permitting duplicate tool execution. Native acceptance must establish actual behavior on every claimed V1 host. Do not carry this extension into V2 or claim it was a verified V1 UX reference.

V2 installed declarations establish:

- `ctx.command.transform(editor => editor.add({name,description,execute}))`; `execute` receives `{sessionID,prompt,delivery}` and returns `Promise<void>` (`@opencode/plugin/dist/promise/command.d.ts:6-25`). Dispatch parses the invocation prompt text; it must not depend on V1 `arguments` fields.
- `ctx.tool.transform(editor => editor.add({name,input,description,execute}))`, with input schema and structured `Tool.Result` (`promise/tool.d.ts:9-33`). `ToolContext` has the invoking `sessionID/agent/messageID/call ID` via `@opencode/schema/dist/tool.d.ts:10-16`.
- Results contain `content`, optional `output` and metadata (`schema/tool.d.ts:66-78`). Use `{content: renderedText}` for the readable model/tool surface, optionally machine output for callers. A naked string is a V1 contract.
- Transform callbacks are synchronous and replayable (`promise/registration.d.ts` and official docs). Register fixed definitions once; do not perform file writes or run commands inside transform callbacks. Refresh captured catalog/config with the domain reload mechanism where needed.
- Versioned command runtime `packages/core/src/command.ts:81-88` directly runs the definition. It does not render a returned string and it does not automatically create a prompt. Therefore zero chat calls for `status/help/config/apply/reset` is feasible, but UI delivery must be implemented explicitly.

Safe design:

1. Share `dispatch(action, arguments, {invokingSessionID, requestID, signal, origin}) -> ActionResult` across command/tool adapters. Require explicit invoking identity for session-default actions, using an explicit target ID override only when provided. Remove last-active fallback from normal tool/command paths.
2. Use one argument validation layer: mutually exclusive single/batch/date targets, finite bounded counts, positive integer indexes, exact valid dates/ranges and explicit reset confirmation. V1 schema descriptions alone do not enforce these relations (`src/tools.ts:129-150`).
3. Represent queued suggestions by stable IDs/revision, resolving the displayed index under a mutation lock. `src/tools.ts:74-79` currently splices before `applyImprovement` succeeds; failed writes can consume a pending item. Reserve/apply/acknowledge atomically or restore on failure, and reject stale indexes after queue changes.
4. Tool adapter returns structured content. Command adapter executes once and delivers `ActionResult` to a TUI/RPC output component with request/session/location correlation and a bounded receiver timeout. Keep this output outside transcript evidence. STM's `v2-status-output.ts:35-79` and `:131` onwards corroborate these patterns; its entire receiver handshake need not be copied if a smaller supported UI channel suffices.
5. Do not use `session.synthetic` as an invisible command-result transport: V2 synthetic messages are durable model context (official `session-event.ts:279-288`), changing later judge input. If chosen as an explicit product fallback, tag it as Kasper administrative content and exclude it consistently, and state that it enters history.
6. Separate administrative actions from intentional scoring/merge calls; displaying help/status, rendering a panel, refresh and request retries cannot autonomously submit a paid score or reapply a mutation. Only deduped scoring dispatch calls the judge adapter.

## Task 10: compaction context

**Verdict: directly supported with a small adapter; preserve additive semantics and avoid recursive/expensive work in the hook.**

V1 `experimental.session.compacting` reads aggregates and per-agent weaknesses, builds text, and appends to `output.context` (`src/index.ts:760-827`). This is outgoing compaction guidance, not persistent instruction-source editing.

V2 `ctx.session.hook("compaction", callback)` receives mutable `system/messages/options` and optional `result` (`promise/session.d.ts:22-46`, `:129-145`; versioned session.ts:26-47, :141`). The official docs say compaction `messages` is the transcript being summarized and the host appends its summary prompt after hooks. Changes affect the outgoing model call, not persisted history/config. Setting `result` replaces compaction and skips its model; Kasper only needs guidance injection and should leave `result` alone.

Safe design: extract a pure `renderCompactionFeedback(snapshot, agentID)` shared renderer. V1 adapter pushes the string to `output.context`; V2 adapter appends a text `SystemPart` (`{type:"text",text}`) to `event.system`. Resolve the effective agent from `event.agent`, not a stale last-active/global registry entry. Check owner-session exclusion before any work. Render a bounded immutable state snapshot; no judge generation, instruction file editing, queued apply, session creation or draining scoring from inside compaction. Preserve other plugins' system parts and any existing result. The official migration hook mapping supports this exact adapter destination.

For reentrant calls, add a marker identifying the Kasper feedback system part and replace only that part if already present; do not clear or rebuild all system instructions. Hook once for compaction only unless deliberately adding normal-request feedback as a separate product change. Judge `generate`/title request kinds remain separate, avoiding inadvertent feedback contamination.

## Proposed reusable boundary and acceptance

Keep local core contracts small:

```ts
interface SessionEvidenceHost {
  readonly capabilities: { historical: boolean; durableTools: boolean };
  read(sessionID: string, signal: AbortSignal): Promise<HistorySnapshot>;
  enumerate?(query: SessionQuery, signal: AbortSignal): AsyncIterable<SessionSummary>;
}
interface Invocation {
  invokingSessionID: string;
  requestID: string;
  signal: AbortSignal;
  origin: 'command' | 'tool' | 'automatic';
}
interface ActionResult { text: string; data?: unknown }
```

Keep SDK branded identifiers at the V2 adapter edge, validate external inputs, and perform conversions in one place. An adapter can expose capability limitations; do not populate unsupported methods with empty-success results or cast the whole SDK to `any`. Shared scoring accepts normalized evidence, not V1 message objects. Lifecycle/scheduler owns cancellation and commit validity; mutation store owns durable checkpoint and suggestion state.

Required acceptance for these rows:

1. Packaged V1/V2 load on the oldest claimed release, plus setup failure and reload; verify no duplicate registrations/timers and no cross-generation eager dependency requirement.
2. Offline history cases for trailing incomplete turn, multi-message tool continuation, busy/retry/idle, duplicate events, child/fork distinction, agent switch, revert/compaction checkpoint loss and deleted sessions.
3. Shutdown during list/history/judge/config reload; late success cannot write state after disposal. Events from another workspace cannot invoke evaluation against this directory.
4. Native `/kasper status/help/config` output in actual UI with zero prompt/judge dispatch; command action once; tool current-session targeting under concurrent child/user session traffic; fail/retry apply preserves queue item.
5. Compaction receives bounded correct-agent feedback, keeps other system parts, excludes owned auxiliary sessions and does not itself trigger scoring.

Checks performed: installed package/declaration reads; versioned official source/docs retrieval; actual Bun execution of the checkpoint reproducer. No full tests, native host sessions or V2 implementation were run by this agent. A first `bun -e` attempt failed due native PowerShell argument quoting; corrected stdin execution produced the reported reproducible defect.
