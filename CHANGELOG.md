# Changelog

All notable changes to this project will be documented in this file.

## [1.0.0] - 2026-06-01

Project renamed from "Observer" to "Kasper".

### Added
- Idle-aware pair evaluation — sessions are only evaluated when idle or complete, preventing partial-turn scoring
- Subagent call tracking — extracts and reports subagent invocations in evaluation prompts
- Subagent session evaluation — child sessions are evaluated independently with proper agentType tracking
- Per-agent segment evaluation — when agent transitions are detected, each segment is scored separately
- `isIdle` flag in `buildEvalFromMessages` for explicit completion signaling
- `idleSessions` tracking in `KasperContext` with `session.idle` event support
- `SubagentCallRecord` type and `<subagents_used>` / `<subagent_calls>` prompt sections
- Comprehensive test coverage: 308 tests covering evaluation, scoring, handlers, state, and full plugin lifecycle

### Changed
- Evaluation trigger logic now requires complete user→assistant pairs (not just last-message-is-assistant)
- `buildEvalFromMessages` pair-building now tracks `complete` flag per pair
- Diagnostic scoring test gated behind `debug: true` config to reduce overhead
- `input.arguments` backward-compatible fallback for SDK versions passing `argument` singular

### Fixed
- Assistant messages with only subagent calls (no text, no tools) now produce valid `PendingEval`s
- Duplicate diagnostic code block from bad merge removed
- `batchEvaluateSessions` test expectations aligned with actual skip behavior
- `mergeWeaknesses` test access to `makeMockSession` fixed by moving to outer scope
- Bracket fallback test now avoids `parseResponseJSON` interference from embedded JSON

## [0.1.0] - 2026-05-30

### Added
- Initial release
- LLM-as-judge session scoring on 5 dimensions
- Automatic improvement suggestion and injection into AGENTS.md
- Per-agent prompt improvement injection
- Auto-update mode with manual approval fallback
- Batch scoring for retroactive evaluation
- Weakness merge deduplication
- Score pair-splitting for large sessions
- Compaction feedback injection
- Config hot-reload
- Debug logging mode
- Quiet mode for toast suppression
- Atomic writes with stale lock detection
- Timestamped backups before every change
