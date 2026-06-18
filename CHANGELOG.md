# Changelog

All notable changes to this project will be documented in this file.

## [1.2.0] - 2026-06-18

A feature release that hardens the resolver for opencode plugin ecosystems (oh-my-opencode, omo), tightens test discipline, and adds the deterministic scoring override that the e2e suite had been missing. No breaking changes — the public plugin surface and `kasper.jsonc` / `kasper` key config are unchanged.

### Fixed

- **Plugin-override entries are now located by name, not by value (B1–B4 regression)** — `appendToPluginOverridePrompt` used to scan the agent map for entries whose `prompt`/`prompt_append` text matched `source.value`. With two agents sharing the same prompt text, the first one in insertion order won and kasper silently edited the wrong agent. The writer now uses `source.agentName` (the canonical config key) to locate the entry directly via the jsonc `modify()` path. Regression coverage in `tests/oh-my-opencode.test.ts` (idempotency, B1) and `tests/agent-prompt-resolver.test.ts` (display-name fallback).
- **Display name → canonical key fallback for plugin overrides** — omo registers `sisyphus: "Sisyphus - ultraworker"` in `AGENT_DISPLAY_NAMES`, and opencode's session info reports the display name as `agentName`, not the canonical config key. The resolver's `lookupAgentEntryWithFallback` and the inline fallback in `getAgentEntryAndKey` now try exact → case-insensitive → "display name starts with key" (longest match wins). The writer threads the canonical key through every subsequent lookup so the jsonc `modify()` path targets the right entry. Without this, kasper's write path was a no-op for every omo-managed agent.
- **Display-name fallback now requires a space (or end-of-string) after the matched key** — a follow-up to the above that prevents false positives on hyphenated agent names. A test creating `code-quality-0b16404e` no longer false-positive matches a global `code-quality` agent and silently routes the improvement to the wrong file. The omo convention `<key> - <descriptor>` (with a space after the key) is preserved. Closes a real production bug surfaced by `tests/auto-update.test.ts` "auto-update respects subagent agentType" — that test was failing on master since the resolver fix.
- **`appendToPluginOverridePrompt` no longer reads `actualKey` as `string | undefined`** — pre-existing TypeScript errors in the destructuring of `lookupAgentEntryWithFallback` are now resolved. The build (`npm run build`) and `tsc --noEmit` are clean for the first time since the resolver refactor.
- **`bun run lint` is now clean** — removed unused imports in `tests/e2e/edge-cases-inprocess.test.ts` and applied biome formatting across `tests/`. `prepublishOnly` can now succeed.

### Added

- **`KASPER_E2E_SCORE_OVERRIDE=<float>` test-only env var** — read at the top of `Scorer.evaluate()` in `src/scorer.ts`. When set, returns a synthetic low-score card without calling the LLM, making the e2e write-path tests deterministic. The override is read at the very top of the function so it short-circuits the LLM call entirely; production users never set this env var. This was the missing piece for the e2e auto-apply tests — the LLM judge was too lenient to reliably score the provocation prompt below `scoring_threshold`, so the auto-apply path was never exercised in CI.
- **`{path:...}` and `file://` URI prompt definition support in `opencode.json`** — the resolver now recognises the same four prompt shapes opencode does: inline string, `{file:/abs/path}`, `{path:/abs/path}`, and `file:///abs/path` (in plugin override files). Documentation in the README's "Prompt Resolution" section. The `file://` URI is the form used by oh-my-opencode to redirect built-in agent prompts.
- **11 in-process unit tests covering all four prompt-source shapes** (`tests/e2e/prompt-shapes.test.ts`) — runs in ~40 ms without spawning opencode. Verifies the resolver's classification, the inline→file promote path (`materializeInlinePrompt`), and the write-path `file_uri`/`external_file` replace semantics.
- **5 in-process tests replacing the USELESS EC-2 and EC-7 from the original audit** (`tests/e2e/edge-cases-inprocess.test.ts`) — 4 unit tests of `isKasperSession` (the pure function both filter sites depend on) plus 1 disabled-mode integration test. Verified USEFUL: with the audit's targeted mutations, the new tests fail.
- **Artifact-verification report** (`tests/e2e/ARTIFACT-VERIFICATION.md`) — proves via on-disk evidence that kasper's tests actually produce the artifacts they claim. Each row is the result of running the test with `KASPER_E2E_KEEP_TMP=1` and reading the artifact back. 11 rows covering omo + kasper integration, AGENTS.md auto-apply, state.json lifecycle, different prompt definition types, different AGENTS.md locations, and different agent files. This is a stricter standard than the mutation audit: it proves the test's *claim* about the side effect, not just that some code path was exercised.
- **Mutation audit** (`tests/e2e/MUTATION-AUDIT.md`) — documents the targeted mutations applied per test, which tests are USEFUL (catch the mutation) vs USELESS (vacuous) vs SMOKE (test opencode, not kasper). The audit was the basis for the EC-2 / EC-7 fix in this release.

### Changed

- **Test discipline: silent passes are gone** — every `expect()` in the e2e suite is now load-bearing. The audit found multiple tests that were *vacuous* (the assertion could never fail) or relied on `if (state) { log warn; return }` paths that silently passed on failure. Every e2e describe block now uses `waitForKasperLoaded()` in beforeAll to fail loudly if the plugin symlink is `.disabled`, and assertions that previously only logged are now `expect()`s.
- **`oh-my-opencode-live` test is now a real e2e of the integration** — previously the test's omo config was a dead-drop file (`.opencode/oh-my-opencode.json` was the wrong basename after the package rename to `oh-my-openagent`) and the npm specifier `oh-my-opencode` never actually loaded in `opencode serve` (the serve command is `instance: false` — plugins only load when a per-project instance is created via `opencode run --attach`). The test now uses `plugin: ["file:///path/to/dist/index.js"]` to load the local omo install synchronously, and writes the omo config to `.opencode/oh-my-openagent.json`. With these wiring fixes plus the resolver fixes, the write-path test now produces a real, visible change in the live omo config file: `sisyphus.prompt_append` gains the `## Kasper Inferred Instructions` section, `build.prompt_append` is unchanged.
- **E2E suite is deterministic for the auto-apply path** — the `e2e-correctness :: auto-apply file targeting` describe block and the `e2e-comprehensive :: auto mode` / `manual mode` describe blocks now set `KASPER_E2E_SCORE_OVERRIDE=0.3` in their beforeAll, restoring the previous value in afterAll. The 2 e2e tests that were previously flaky on the LLM judge are now deterministic.
- **`cleanupE2EProject` honors `KASPER_E2E_KEEP_TMP=1`** — every e2e test that produces a durable artifact leaves it on disk for inspection. The inline `rmSync` in `oh-my-opencode.test.ts` was patched to honor the same flag.

### Notes

- No public plugin API changes. `package.json` `main` / `types` / `exports` are unchanged. The new `KASPER_E2E_SCORE_OVERRIDE` is opt-in via env var; existing kasper deployments are unaffected.
- All 542 unit tests pass (up from 308 in 1.0.0); the e2e suite adds another 78 tests (up from 32 in 1.1.0). 27 e2e tests are skipped when the `opencode` binary is not on `$PATH` (gated behind `OPENCODE_E2E=1`).
- The branch `feature/prompt-paths-and-plugin-override` was used for the work; the release is cut from `main` (or the user's default branch) with this commit as the tip.

## [1.1.2] - 2026-06-16

A patch release. Builds on the `injectSection` accumulation fix (see the prior commit on the `fix/injectSection-accumulate` branch) by changing the `<!-- kasper: ISO -->` provenance comment from a single section-level timestamp to a per-addition timestamp attached directly above each new entry.

### Changed

- **Provenance comments are now per-addition, not section-level** — `injectSectionContent()` used to write a single `<!-- kasper: ISO -->` line directly under the section header on every apply, overwriting the previous timestamp. The most recent improvement's timestamp therefore masqueraded as the section's creation time, which made it impossible to tell when each individual rule was added by reading just the file. The new shape attaches a `<!-- kasper: ISO -->` line directly above each new entry:

      ## Kasper Inferred Instructions
      old rule

      <!-- kasper: 2026-06-15T10:00:00Z -->
      rule 1

      <!-- kasper: 2026-06-16T07:00:00Z -->
      rule 2

  Migration is non-destructive: files written by older versions had a section-level `<!-- kasper: ISO -->` line under the header. The new helper preserves that line verbatim (it now reads as the timestamp for the pre-existing rules block above it) and attaches new entries with their own per-addition timestamp from then on. Regression tests `U) migration: a SECOND apply after migration uses per-addition for the new entry only` and `V) per-addition: gap between header and first content stays constant across applies` in `tests/prompt-utils.test.ts` cover the migration case and the body-normalization fix that was caught during this change.

### Notes

- The accumulation fix itself (slice-based body extraction, no nested headers) is on the `fix/injectSection-accumulate` branch. This branch assumes that fix is already in place — `fix/per-addition-provenance` is intended to be merged AFTER `fix/injectSection-accumulate`.

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
