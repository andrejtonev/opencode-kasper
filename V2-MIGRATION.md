# OpenCode V1/V2 migration assessment

Recorded: 2026-10-30.

Baseline: `main` at `de180b07bbff177740358163958b41de86ca06be`, Kasper 1.2.0. The repository's default branch is `main`; it is not named `master`.

This is a source/API assessment, not an implementation or a successful V2 runtime test. The V2 API reference inspected was the `@opencode/plugin` 2.0.8 SDK installed in the STM repository; STM's working native integration also provides implementation examples for OpenCode 2.0.32. Recheck these contracts against the target host version before implementation.

## Conclusion

Dual V1/V2 support is feasible. Most scoring, aggregation, persistence and improvement logic can remain shared, but the host integration needs a substantial update. Changing the dependency and export alone will not provide feature parity.

Planning estimate: approximately 4–7 focused development days for implementation and native verification. This is a scope estimate, not measured work. A basic V2 scoring prototype should take less time; editable agent-prompt resolution is the largest uncertainty.

## Current implementation and migration scope

| Feature | Current implementation | V2 work | Difficulty |
| --- | --- | --- | --- |
| Plugin startup and shutdown | V1 plugin function in `src/index.ts`; timers, polling and hook object | Add V2 `{ id, setup }` entrypoint and cleanup; retain V1 entrypoint | Medium |
| Scoring rubric and weakness aggregation | `src/scorer.ts`, `src/evaluate.ts`, `src/improvements.ts` | Reuse rules, prompts and parsing; extract host calls | Low–medium |
| State, backups, locking, rollback and expiry | `src/state.ts`, `src/lock.ts`, `src/mutex.ts`, prompt/file managers | Reuse logic; verify paths, lifecycle and concurrent mutations | Low |
| Automatic scoring | Idle tracking, periodic session polling, checkpoints and child-session handling in `src/index.ts` and `src/evaluate.ts` | Adapt V2 events and session enumeration; preserve debounce, incremental boundaries and shutdown behavior | Medium |
| Conversation history and batch scoring | V1 `session.list/messages`; V1 message and tool-part shapes | Normalize V2 durable messages, agent changes, tool calls/results and completion boundaries; provide historical session enumeration | High |
| Judge and weakness-merge sessions | V1 create/prompt/delete lifecycle and response-history fallbacks in `src/scorer.ts` | Native V2 auxiliary generation, model resolution, cancellation, response normalization and owned-session cleanup | Medium–high |
| Commands, tools and results | V1 tools and command hooks in `src/index.ts`, `src/tools.ts`, `src/handlers.ts` | Native V2 registration, current-session identity and readable result UI | Medium |
| AGENTS.md improvements | Portable file operations and managed guidance blocks | Verify V2 instruction discovery and when updates become effective | Low–medium |
| Per-agent prompt improvements | V1 config/file/plugin-override resolution in `src/agent-prompt-resolver.ts` and `src/agent-prompts.ts` | Resolve V2 effective instructions to the correct editable source; preserve apply/migrate/rollback semantics | High |
| Compaction context | V1 `experimental.session.compacting` hook | Adapt V2 compaction hook and retain stats/weakness context | Medium |
| Configuration | Separate `kasper.json/jsonc` plus legacy host-config support | Preserve standalone config behavior; verify V2 global/project paths and strict host config schema | Medium |

## Specific API differences and risks

- Kasper depends on `@opencode-ai/plugin` and has a V1-only default export. It currently has no `@opencode/plugin` dependency or V2 setup export.
- V2 exposes domains such as `ctx.session`, `ctx.agent`, `ctx.command`, `ctx.tool` and `ctx.event`, rather than Kasper's V1 client/hook interface.
- V2's declared plugin session domain has `context` for history, but does not expose `list` or `remove`. The full V2 client has session enumeration/removal and message listing. Choose and verify a supported access path before promising historical/batch scoring and cleanup parity; do not assume those methods exist on the declared plugin context. STM currently checks native removal availability at runtime.
- V2 durable records differ from V1 `info.role` and `parts`. Kasper needs tool input/output and agent transitions for accurate evaluation. STM's projected text-only history reader is unsuitable as a direct replacement because it intentionally excludes tool evidence.
- Judge requests should use native OpenCode generation so provider behavior remains consistent with the host. Preserve isolation from conversation guidance, fence owned judge sessions before events can trigger scoring, and clean up on success, failure and cancellation. Avoid introducing additional diagnostic LLM calls into the normal path.
- Kasper command interception writes `message` and `stop` fields outside the declared V1 hook output contract. Verify actual V1 behavior and implement native V2 dispatch/results rather than carrying this assumption forward.
- V1 agent config uses `agent.<name>.prompt`; V2 uses `agents` configuration and resolved agent `system` text. Effective text alone does not identify its editable source. File-backed, inline, global, project and plugin-defined instructions need explicit resolution and safe write behavior.
- V2 tools have different registration, execution-context and result contracts. Bind actions to the invoking session rather than relying on a global last-active session.
- Existing V1 mocks and unit tests can verify shared logic but cannot prove native V2 compatibility. Catalog detection of a V2 export is also insufficient to prove feature parity.

## Recommended implementation

Keep one shared core and two small host adapters. Extract contracts for session enumeration/history, judge generation, events/lifecycle, commands/results, and effective/editable instruction sources. Keep V1 behavior as the feature and UX reference.

1. Establish dual entrypoints and cleanup, and move existing V1 host calls behind adapters without changing behavior.
2. Implement V2 history normalization and native judge generation; prove manual scoring with real tool evidence.
3. Add automatic scoring, checkpoints, child-session handling, historical/batch scoring and owned-session cleanup.
4. Implement commands/tools, configuration, compaction and safe instruction-source editing.
5. Run packaged native acceptance on both V1 and V2 before declaring parity or publishing.

Reuse STM's proven patterns for native generation, session ownership and UI where appropriate. Do not copy its entire runtime layer or its text-only history projection.

## Required acceptance coverage

- Fresh global and project installations on V1 and V2; config discovery and reload.
- Automatic, manual and historical/batch scoring, including incremental checkpoints and duplicate suppression.
- Correct agent identity and independent child-session scoring.
- Tool calls, arguments, successful results and failures preserved in judge input.
- No evaluation of Kasper's own judge, merge or diagnostic sessions; no recursive model-call loop.
- Judge timeout, cancellation, provider failure and cleanup; no stale completion corrupting current state.
- Queued and automatic improvements, apply/reject, expiry, backups and rollback.
- AGENTS.md and agent prompts from project/global files, inline config and supported plugin overrides; no edits to the wrong source.
- Compaction context parity and graceful plugin reload/shutdown.
- Readable command/tool results in the actual terminal UI; administrative actions do not unexpectedly invoke the chat model.

No Kasper source changes, dependency installation, tests or model requests were performed for this assessment.
