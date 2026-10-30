# V2 migration implementation plan and execution ledger

Recorded: 2026-10-30. Starting commit: `de180b07bbff177740358163958b41de86ca06be`.

This is the executable breakdown of [V2-DESIGN.md](V2-DESIGN.md). Each chunk is implemented by an agent in its own Git worktree/branch, verified against the reviewed official contracts, tested, reviewed again, and committed. The coordinator integrates the commits in dependency order and checks the combined result. No publication is included.

## Support and safety decisions

- Preserve the existing V1 function entrypoint until a packaged loader check justifies changing it. Expose V2 explicitly; a unified entrypoint must follow a verified loader contract, not an untested export shape.
- Investigate pinned SDK/host 2.2.2 first; the installed sibling 2.0.8 is reference evidence only. Do not mix their declarations. Keep host dependencies/imports isolated.
- Shared core must preserve real tools/errors, completed evidence boundaries and agent identity. Failed, cancelled or stale jobs cannot advance checkpoints or write guidance.
- Judge/merge requests use native host generation. Sessionless V2 generation is preferred. Cancellation and output-limit capabilities must reflect actual runtime behavior; uncertain calls cannot produce overlapping retries.
- Source editing requires a verified target, exact source revision, backup, conflict-aware commit/rollback and durable deletion/expiry state. Unknown/plugin-generated origins stay read-only unless explicitly supported.
- Native acceptance uses isolated temporary configuration/workspaces and deterministic local fixtures wherever possible. It must not alter the user's global OpenCode setup or trigger unrestricted provider calls.

## Isolated chunks

| ID | Chunk and owned surface | Dependencies | Acceptance |
| --- | --- | --- | --- |
| C01 | V1 history/evaluation correctness: `evaluate.ts`, history helpers and corresponding tests | None | Real V1 tools/errors retained; incomplete/failed turns not checkpointed; A-B-A segments remain distinct; actual idle state and typed batch outcomes. |
| C02 | Shared scoring validation and safe weakness grouping: `scorer.ts`, pure scoring helpers/tests | None | Finite validated categories and zero scores; tool evidence escaped/bounded; merge groups use stable IDs, conserve counts/tail/fixes; invalid merge leaves original evidence. |
| C03 | Persistent state and lock/write correctness: `state.ts`, `lock.ts`, `prompt-utils.ts`, relevant tests | None | Deletes/expiry/rejections survive merges; same-session revisions reconcile; no successor lock deletion or cached write loss; Windows writes report honest durability; live policy consistent. |
| C04 | Config and instruction mutation repairs: config/resolvers/managers/improvements/tests | C03 | Path settings reach runtime; target snapshots/provenance/backups; stale overrides conflict/rebase; rollback original source preserves edits; migration is recoverable; expiry semantics explicit. |
| C05 | Pinned SDK contract spike, native zero-model fixture and package exports | None | Install exact V2 SDK; inspect cancellation/archive/commands/generation; compile contract tests; isolated packaged load; recorded supported entrypoint/version matrix. |
| C06 | Shared generation boundary and V1 adapter: generation contracts/adapters and scorer integration | C02, C05 | Shared rubric/parser uses generation port; native V1 ownership/late-create cleanup; bounded attempts/merge; uncertain timeout retains slot; no extra diagnostic model calls. |
| C07 | Shared lifecycle/scheduler/actions plus V1 event/tools integration | C01, C03 | Public event routing; session-bound actions; queued apply only consumed on success; supervised timers/jobs; no late commit after delete/reset/dispose; compaction pure. Generation cancellation wiring is reconciled with C06 at integration. |
| C08 | V2 history adapter and manual scoring integration | C01, C02, C05 | Pinned real durable records normalized; complete archive pagination; correct location/agent; manual scoring prepares validated boundaries. Native generation from C06 is connected and verified at integration. |
| C09 | V2 effective instructions and editable-source adapters | C04, C05 | V2 AGENTS sources/system config/nested IDs; no CLAUDE fallback; read-only unknown origins; scoped apply/rollback; reload/activation status honest. |
| C10 | V2 setup/events/commands/tools/compaction and terminal results | C07, C08, C09 | End-to-end host setup; automatic/manual/batch/child paths; command executes once without chat dispatch; readable correlated output; cleanup/reload. |
| C11 | Packaged V1/V2 acceptance and regression integration | C10 | Clean temporary installs; real host load/commands/hooks/events/history; deterministic generation fixture; timeout/failure/reset/reload; full test/build/lint results. |
| C12 | Final support docs and migration/release checklist | C11 | Exact supported versions/install syntax/config/capabilities; tested limitations distinguished from parity; all task commits/results recorded. |

Chunks may add small internal helpers rather than perform unnecessary broad file moves. Agents must coordinate shared `types.ts` changes through the coordinator. Manifest/lockfile edits belong to C05; runtime integration changes belong to C07/C10. Dependent chunks run only after required commits are integrated.

## Required agent procedure

1. Read the design, relevant review report and current implementation; verify contracts against pinned official declarations/source.
2. Reproduce the relevant defect or establish the intended invariant before changing code.
3. Implement only the owned chunk, preserving unrelated user work and documenting material limitations.
4. Run meaningful focused tests and typecheck; run broader checks when the change affects shared behavior.
5. Review the diff and rerun changed behavior checks. Do not claim native acceptance from mocks.
6. Commit only owned files with a focused message. Report commit ID, files, tests, remaining risks and handoff interfaces.

No force resets, global config rewrites, publication, or title-based deletion of user sessions. Independent agents use separate worktrees; the coordinator cherry-picks reviewed commits onto this checkout and resolves integration conflicts with the owning agent.

## Execution ledger

| Chunk | Status | Agent | Commit/evidence |
| --- | --- | --- | --- |
| C01 | Integrated | history_scoring | `87aafe3` (agent `49b60eb`); 19 history regressions; combined C01–C03: 543 top-level tests passed. |
| C02 | Integrated | lifecycle_commands | `e8c1176` (agent `8686b77`); 56 focused tests, 565 offline passed/27 skipped; build/typecheck. |
| C03 | Integrated | storage_instructions | `756bc8b` (agent `91cb886`); 91 final focused tests, two-process/async flush evidence; build/typecheck. |
| C04 | Integrated | storage_instructions | `c1af22c` (agent `c5b0a15`); 163 focused tests; combined C01–C04: 559 top-level tests/typecheck passed. |
| C05 | Integrated | lifecycle_commands | `faafa4d` (agent `ff07140`); exact 2.2.2 compile contracts; native packed `./server` load and Effect interruption passed. |
| C06 | In progress | lifecycle_commands | Isolated `migration/c06-generation`; shared scoring/generation ports and safe request budgets. |
| C07 | Integrated | history_scoring | `73df794` (agent `81790fa`); lifecycle/actions/strict commit fences. Combined integrated tests: 575 top-level passed. |
| C08 | In progress | history_scoring | Isolated `migration/c08-v2-history`; native normalization, archive capability and manual shared flow. |
| C09 | In progress | storage_instructions | Isolated `migration/c09-v2-instructions`; authoritative sources, explicit editable targets/overlays. |
| C10 | Pending | history_scoring | |
| C11 | Pending | lifecycle_commands | |
| C12 | Pending | storage_instructions | |

The baseline review passed 490 offline tests, build and typecheck; lint had two existing unused-suppression warnings. That is the starting baseline, not migration acceptance.
