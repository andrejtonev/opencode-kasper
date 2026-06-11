# Changelog

All notable changes to this project will be documented in this file.

## [1.1.1] - 2026-06-11

A patch release. Fixes a false-positive on every startup, removes a startup-time hang in the worst case, and corrects a misleading example in the README.

### Fixed

- **`state_integrity_warn` firing on every startup** — the integrity-hash strip regex only matched string-valued fields, but `_running` is an object. Read-time and write-time hash inputs were never equal, so the stored hash never matched a recomputation. Replaced the strip-and-stringify approach with a static `KasperStateStore.computeIntegrityHash(state)` helper that destructures `_integrity` out of the state and hashes the rest with `JSON.stringify(..., null, 2)`. Both `init()` and `doFlush()` use the same helper, so the canonicalization is symmetric by construction. The user-facing message has also been softened from "data may be corrupted" to "data may have been edited outside Kasper. A fresh hash will be written on the next save." — it still fires on real corruption, but is no longer alarming on out-of-band edits. Regression tests cover both directions.
- **Latent: `_integrity` was never persisted** — `doFlush` was hashing the in-memory state, then writing the **pre-hash** JSON to disk (a leftover local variable). After the fix, the freshly-computed hash is set on the state and the post-hash state is what gets written, so the on-disk file always carries a valid hash. A new test asserts `state.json` contains an `_integrity` field after a flush.

### Performance

- **Defer stale-session cleanup to `setTimeout(0)`** — `KasperPlugin` was awaiting `client.session.list()` synchronously during init. If the opencode server's HTTP listener wasn't yet bound at that point, the call waited the full `SDK_TIMEOUT_MS` (30s) before timing out, blocking opencode startup. The cleanup is purely cosmetic (the polling loop already filters kasper sessions out of its polling set), so it now runs on the next event-loop tick, with a short retry. Init returns in ~10 ms in the typical case.
- **Parallelize the 5 health-check `stat()` calls** with `Promise.all` over a new `probePaths` helper. Each check is a single syscall; sequential awaiting was adding ~5 stat-roundtrips to startup on a cold cache.

### Documentation

- **README Installation section rewritten** — the previous "With options" example showed a plugin tuple like `["@atonev/opencode-kasper", { "auto_update": true }]`, implying that the second element was how to configure kasper. It is not: opencode's plugin tuple second element is a generic plugin-arg convention, and kasper only reads its config from `kasper.jsonc` / the `kasper` key in `opencode.json` (see `src/config.ts`). The misleading example is gone; the Configuration section now shows both a standalone `kasper.jsonc` and a `kasper` key in `opencode.json`, with a clear precedence note.

## [1.1.0] - 2026-06-09

A consolidation release. Brings the plugin to feature parity with opencode's agent-resolution model, fixes a long-standing silent-failure path on built-in agents, expands the safety and audit story, and adds end-to-end test coverage for the production auto-update loop.

### Added

- **Agent prompt resolution** — Kasper now resolves the agent prompt source using the same rules opencode uses (`agent.<name>.prompt` in `opencode.json` as inline, `{file:/abs/path/to/prompt.md}`, or `{path:...}`; otherwise the convention path `<projectRoot>/.opencode/agents/<name>.md`). Improvements read and write the exact file the prompt lives in; no more dead files. The new `src/agent-prompt-resolver.ts` is covered by `tests/agent-prompt-resolver.test.ts` (508 lines).
- **Agent prompt injection mode** — New `agent_prompt_inject_mode` config (`section` | `inline`, default `section`). `inline` mode appends guidance with no section header, wrapped only in `<!-- kasper-injected:begin/end -->` HTML comments for dedupe and rollback. Use this when the visible `## Kasper Inferred Instructions` heading is unwanted.
- **`/kasper migrate <name>` command** — Extracts an inline `opencode.json` agent prompt to a file so kasper can edit it. Rewrites the source `opencode.json` to use `{file:...}` while preserving comments and formatting. With `--show`, just reports the current source.
- **In-progress banner on `/kasper status`** — Shows a live banner with paused state, active evaluation pass (elapsed time, queued session count), the cross-session weakness-merge LLM call, and any pending improvements waiting for the next auto-update tick.
- **Weakness categories** — Auto-classifies weaknesses into 8 categories (`tool-use`, `reasoning`, `planning`, `communication`, `safety`, `code-quality`, `completeness`, `unknown`). Cross-category merging is prevented, reducing false semantic merges.
- **Confidence and evidence tracking** — `WeaknessPattern` now carries `confidence`, `evidence_count`, and `expires_at` fields in aggregate stats.
- **Prompt sanitization pipeline** — Blocks URLs, code blocks, XML instruction tags, role redefinition, and instruction-hijack phrases from generated improvements before writing to AGENTS.md or agent prompts. Controlled via `strict_sanitize` config (default true).
- **Improvement deduplication** — Checks for verbatim, sentence-level, and 80%+ word-overlap matches in target files before applying improvements.
- **Improvement expiry** — `expires_at` timestamps on improvements; auto-pruned during evaluation cycles. Configurable via `improvement_expiry_days` (default 60).
- **Instruction budget enforcement** — `max_agent_guidance_chars` (default 1200) rejects oversized generated improvements.
- **Startup health check** — Verifies state dir, state file, AGENTS.md, backup dir, stale locks, and model config on plugin load.
- **Scoring version tracking** — `judge_version`, `rubric_version`, and `model_name` emitted on every `ScoreCard` for audit trail and regression analysis.
- **Dangerous command confirmation** — `/kasper reset` now requires `--force` to execute (also exposed as a `force` flag on the `kasper_reset` tool).
- **Provenance metadata** — `<!-- kasper: ISO-timestamp -->` HTML comments injected into AGENTS.md and agent prompt files alongside every automated change.
- **State integrity verification** — SHA-256 hash embedded in state file; verified on load with a warning on mismatch (continues with parsed state, never throws).
- **Config version field** — `config_version` for future schema migration support.
- **Dry-run mode** — `/kasper improve --dry-run` previews improvements without queuing them.
- **`min_observations_for_update` config** — A weakness must be observed at least this many times before an improvement is generated (default 2). The `/kasper improve` tool also accepts a `force` flag to override.
- **End-to-end test suite** — `tests/e2e/` covers tool calls, subagent spawning via the `task` tool, session identity, serve-based subagent detection, kasper scoring integration, agent prompt resolution, and `agent_prompt_inject_mode`. Harness boots a real `opencode serve` instance per suite and parses NDJSON event output. Gated behind `OPENCODE_E2E=1`; see `tests/e2e/README.md`.
- New config keys: `max_agent_guidance_chars`, `improvement_expiry_days`, `min_observations_for_update`, `strict_sanitize`, `agent_prompt_inject_mode`, `config_version`.

### Fixed

- **Dead-file injection on built-in agents** — When kasper targeted a built-in opencode agent (`build`, `plan`, `general`, `explore`, `scout`, `compaction`, `title`, `summary`) with `target: "agent_prompt"` and the agent had no defined prompt, the resolver returned `missing` and kasper wrote a dead `.opencode/agents/<name>.md` that opencode never read. Built-in agents ship with hard-coded prompts and only consult that file path when the user has explicitly set `agent.<name>.prompt` in `opencode.json` to `{file:...}` or to an inline string. Kasper now reroutes those improvements to AGENTS.md (which built-in agents always read via the rules system), drops the change if the source was a subagent session, and respects user-defined overrides. `tests/auto-update.test.ts` exercises both the reroute path (literal `build` with no defined prompt) and the override path (`{file:...}` pointing at a real file).
- **Improvements applied to wrong target** — The scoring prompt instructs the LLM to use `weakness_suggestions` (with `target: "agent_prompt" | "agents_md"`) and leave the deprecated `suggested_agent_prompt_update` / `suggested_agents_md_update` fields empty. But `considerImprovement` only checked the deprecated fields, so the LLM's explicit target selection was ignored. Improvements now use `weakness_suggestions` as the primary source, falling back to deprecated fields only for backward compatibility.
- **Auto-poll not evaluating subagent children** — `pollAndEvaluate` only called `runEvaluation` on the parent session but never invoked `evaluateChildSessions`. Manual scoring (`/kasper score`) did this correctly, so subagents were only evaluated when explicitly triggered. Auto-poll now recursively evaluates subagent children after scoring a primary session.
- **Subagent sessions blocked by `evaluate_subagents` config** — The `isSubagent` check in `pollAndEvaluate` and `manualEvaluateSession` required `evaluate_subagents: true` to use `minUserMsgs=1`. This meant subagents were skipped by default. Subagent detection now always uses `minUserMsgs=1` regardless of the (now-removed) `evaluate_subagents` flag.
- **Agent type not set on auto-poll evaluations** — `pending.agentType` and `pending.parentSessionID` were never populated in `pollAndEvaluate`, causing subagent metadata to be lost in state records. These are now derived from the `agentRegistry` or `session.parentID`.
- **Subagent sessions never evaluated** — `buildEvalFromMessages` required `role === "user"` messages to start building eval pairs, but real subagent sessions have no user-role messages (the task prompt arrives from the parent agent). The filtering pass now treats the first text-containing message as the instruction regardless of role; the pair-building pass uses a catch-all `else` branch to collect responses with any (or no) role.
- **Subagent sessions blocked by `min_session_messages`** — Subagent sessions typically have only one instruction+response pair. When known to be a subagent, `buildEvalFromMessages` now uses `min(1, min_session_messages)` instead of the full config minimum.
- **Improvements rejected for legitimate formatting** — `isValidGuidanceText` and `sanitizeImprovementText` blocked any text containing code blocks, inline code, URLs, or markdown links — all standard formatting in LLM-generated improvement suggestions. Removed these from the poison pattern list; only instruction hijacking, XML tag injection, and role redefinition patterns are now blocked.
- **Scoring diagnostic timeout** — The diagnostic prompt was using the full `scoring_timeout_ms`; it now caps at 15 s and surfaces a clean error if the model is unavailable. Scoring also gained explicit "scoring_prompt_timeout_fired" and "scoring_prompt_late_response" log events.
- **Test flakiness on Windows** — Three tests that relied on a 2.1s sleep for the `KasperStateStore` debounced flush now call `store.flush()` directly. The `materializeInlinePrompt` path-rewrite test uses `path.relative` instead of `replace(/^\//, "")` to strip the project-root prefix, so it works on both POSIX and Windows path separators. Several unused imports and an unused `PLUGIN_PATH` constant in the e2e harness were also removed to keep `bun run lint` clean.

### Changed

- All weakness similarity/merge logic now uses category-aware comparison (`weaknessesMergeable`).
- `applyAgentPromptImprovement` and `applyAgentsMdImprovement` now validate, sanitize, deduplicate, and budget-check before applying.
- `KasperJudgeVersion` bumped to `1.1.0`.
- **Default `min_session_messages` reduced from 3 to 1** — Most real-world sessions have only 1-2 user messages (especially with tool-heavy workflows). The previous default of 3 meant most sessions were silently skipped by auto-poll.
- **Plugin entry point hardened** — `flushKasperState` and the internal `_stateStoreRegistry` are no longer named exports of the plugin module (the opencode plugin loader iterates exports and would crash registering `flushKasperState` as a plugin). They live in a new `src/registry.ts` module; tests updated to import from there.
- README refreshed to document `migrate`, the in-progress banner, the agent prompt resolver, `agent_prompt_inject_mode`, and the full current config surface.

### Removed

- **`evaluate_subagents` config field** — The field was a no-op. The polling and manual evaluation paths already required `minUserMsgs=1` for subagent sessions unconditionally, and no other code path consulted the flag. The field, the schema entry, the default, the README documentation, and 9 e2e test config writes have all been removed. Subagent sessions are always eligible for auto-scoring (subject to `min_session_messages` for primaries).
- **`/kasper config` command** — The config command was redundant with `kasper_status` and direct editing of `kasper.jsonc` / `opencode.json`. `min_observations_for_update` is now a regular config field, not a command argument.
- **Stray e2e debug scripts** — `tests/e2e/debug-{api,promise-race,scoring}.ts` were one-off scratch files from initial scoring-diagnosis work and have been removed. Pattern added to `.gitignore`.

## [1.0.1] - 2026-06-03

### Fixed
- **Critical:** Removed `flushKasperState` named export from plugin entry point (`src/index.ts`). The opencode plugin loader iterates over all exports and attempts to register each as a plugin; `flushKasperState` is an async function, not a valid plugin, causing `undefined is not an object (evaluating 'O.config')` crash on startup. Moved `_stateStoreRegistry` and `flushKasperState` to a new `src/registry.ts` module; tests updated to import from `src/registry.js`
- Assistant messages with only subagent calls (no text, no tools) now produce valid `PendingEval`s
- Duplicate diagnostic code block from bad merge removed
- `batchEvaluateSessions` test expectations aligned with actual skip behavior
- `mergeWeaknesses` test access to `makeMockSession` fixed by moving to outer scope
- Bracket fallback test now avoids `parseResponseJSON` interference from embedded JSON

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
