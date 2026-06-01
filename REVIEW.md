# Kasper Plugin — Architectural Review

Each comment from the review session is listed below, analyzed against the current codebase, and followed by concrete implementation recommendations.

---

## 1. Kasper dir should be user-definable

**Current state:** The kasper directory is hardcoded to `.opencode/kasper/` under `cwd` (`index.ts:122` — `join(cwd, ".opencode", "kasper")`). The global config dir (`~/.config/opencode/`) is resolved via `resolveGlobalOpencodeDir()` but only used for the global config file and default config generation, not for the state/log storage.

**Analysis:**
- This is a valid feature request for CI and shared project setups — multiple instances on the same codebase would share state
- Thread/multi-process safety is already handled: file locks with stale detection (30s), atomic writes (temp+rename), and debounced flushes (2s). A shared directory would inherit these protections automatically.
- The concern about AGENTS.md being local is valid — the kasper state tracks global aggregates, but improvements modify the local `AGENTS.md`. If two project copies share kasper state, the improvements queue would reflect both — but the AGENTS.md mutations would only apply locally. This is inconsistent.

**Recommendation:** Add a `state_dir` config key (optional, defaults to `.opencode/kasper/`). Users can point it at a shared location. Document the caveat: improvements applied automatically will only modify the AGENTS.md in the *current* working copy. State-level aggregates and improvement tracking would be shared.

---

## 2. Config reload interval could be optimized

**Current state:** Config reloads every 5 seconds via `setInterval` (`index.ts:202`). Only acts if JSON-serialized config differs.

**Analysis:**
- 5s is reasonable for a CLI tool — the overhead is one JSON file read per interval, negligible
- File system watchers (`fs.watch`) on Windows are unreliable (false positives, crashers with nested dirs); on Windows specifically, polling is safer
- The current approach is already efficient — it reads the config on each interval and compares. Failed reads are non-fatal
- Moving to 60s would delay config hot-reloads unacceptably (e.g., user changes threshold and waits a full minute)

**Recommendation:** Keep 5s polling. Add a `config_poll_interval_ms` config key (default 5000) so users who want longer intervals can set it. Do NOT use fs.watch on Windows — the polling approach is battle-tested.

---

## 3. Subagent session tracking

**Current state:**
- `session.created` stores agent name and type in `agentRegistry` (`index.ts:668`), with `agentType: parentID ? "subagent" : "primary"`
- `parentToChildren` map and `sessionParents` map track parent-child relationships (`index.ts:687-693`)
- Subagent sessions get their own `PendingEval` since `chat.message` user events create one if absent (`index.ts:790`)
- `pollAndEvaluate()` evaluates subagents via the polling loop — there is **no** filter to skip subagent sessions

**Analysis:**
- Subagents ARE evaluated. The guard at the top of `pollAndEvaluate()` only checks `deletedSessions` and `sessionsEvaluated` — it does not check `agentType === "subagent"`
- This means subagent sessions contribute their own scores to the aggregate
- Parent-child relationship IS tracked via `parentToChildren` / `sessionParents` maps, but this information is NOT used during evaluation or scoring

**Recommendation:** Consider whether subagent evaluations are meaningful. A subagent's "user instruction" is whatever the primary agent delegated to it — scoring it against that may not reflect user intent. Options:
  - **Filter subagents** from auto-evaluation in the `pollAndEvaluate()` handler by checking `agentInfo?.agentType === "subagent"`  
  - Keep evaluating but mark subagent scores with a `subagent` flag in the score card to exclude them from primary agent aggregates  
  - Add a config key `evaluate_subagents: boolean` (default `false`)

---

## 4. Nested subagent chains

**Current state:** The `session.created` handler detects subagents via `parentID` (`index.ts:679`) and registers them in `parentToChildren` / `sessionParents` maps. Subagents can have their own `parentID`, so chains (primary → subagent A → subagent B) are tracked correctly.

**Analysis:**
- The data structure supports arbitrary nesting
- BUT: there is no UI or state feature that exposes the nesting (e.g., no tree view, no per-chain scoring)
- The `sessionParents` map has a 1000-entry limit with partial cleanup — if a chain is very deep, tracking could degrade
- The `parent_id` field is stored in state on recordSession (`state.ts:135`), so relationships survive restarts

**Recommendation:** This is already handled structurally. Add a `/kasper tree` command that visualizes the parent-child relationships of recent sessions. Add a limit to the chain depth (e.g., track at most 3 levels) to prevent unbounded map growth.

---

## 5. Detail level setting — is it working?

**Current state:** Yes, `detail_level` is wired through correctly:
- `config.detail_level` defaults to `"standard"` (`types.ts` — `DEFAULT_CONFIG`)
- `buildEvalPrompt()` reads `this.config.detail_level ?? "standard"` (`scorer.ts:284`)
- Three behaviors:
  - **minimal**: tool names only (`- toolName`), no args/results; no AGENTS.md or agent prompt content in prompt; context note only
  - **standard**: tool args + 500-char results; AGENTS.md + agent prompt included
  - **thorough**: tool args + 2000-char results; AGENTS.md + agent prompt included
- Minimal mode drastically reduces token usage — only tool names, no config content

**Analysis:** Fully implemented and functional. No issues.

**Recommendation:** None. Add a note in the README about estimated token savings per level if useful.

---

## 6. Message sections should be clearly labelled

**Current state:** The `buildEvalPrompt()` method DOES label sections with markdown headers:
- `## Agent` (if agent name present)
- `## User's Instruction`
- `## Agent's Response`
- `## Tools Used` (minimal) / `## Tool Calls Made` (standard/thorough)
- `## Current Agent Prompt` (non-minimal)
- `## Current AGENTS.md Content` (non-minimal)
- `## User Guidance (evaluation focus)` (if guidance set)
- `## Note` (if compacted)

**Analysis:** This is already implemented. The scorer prompt clearly segments each input type.

**Recommendation:** Already done. No changes needed.

---

## 7. Agent prompts — global vs project scope

**Current state:** The `AgentPromptManager` only reads/writes from the project directory:
- Path: `.opencode/agents/{agentName}.md` (`agent-prompts.ts:30-35`)
- No global fallback or merge

The `AgentsMdManager` reads from project-root `AGENTS.md` with fallback to `.opencode/AGENTS.md`.

**SDK verified:** `client.app.agents()` returns `Array<Agent>` where each `Agent` has `prompt?: string` — the authoritative effective prompt (file + inline config merged). Global config at `~/.config/opencode/` also has `agents/` directory per opencode convention. Both `client.app.agents()` and `client.config.get()` work.

**Analysis:**
- There is **no global agent prompt loading**. If a user has a global `~/.config/opencode/agents/build.md`, the plugin won't see it
- `client.app.agents()` would return the effective prompt without file I/O — includes inline config overrides
- OpenCode itself supports global agent prompts in `~/.config/opencode/agents/`

**Recommendation:**
- Change `AgentPromptManager.read()` to fall back to the global `~/.config/opencode/agents/{name}.md` if the project-level file doesn't exist
- At evaluation time, call `ctx.client.app.agents()` to get the authoritative agent prompt (SDK-verified), fall back to file-read

---

## 8. Can opencode agents and subagents have custom prompts?

**SDK verified:** Yes — `client.app.agents()` returns `Array<Agent>` with `prompt?: string` per agent. Config has `agent?: { [key: string]: AgentConfig }` which can set `prompt` inline. Agent prompt files at `.opencode/agents/{name}.md` are the file-based convention. All three sources exist.

**Current state:** The plugin reads agent prompts only from disk files via `AgentPromptManager`. Inline config prompts from `opencode.json` are NOT captured via file reads. The `client.app.agents()` API (SDK-verified) would return the authoritative effective prompt.

**Recommendation:** At evaluation time, call `ctx.client.app.agents()` to get the effective prompt (SDK-verified available). This captures inline config + file content. Fall back to file-read if the API call fails.

## 9. Do agents and subagents see AGENTS.md in their context?

**SDK verified:**
- `experimental.chat.system.transform` hook exists — receives `{ sessionID?, model }` and mutates `output: { system: string[] }` — this IS the full system prompt array (AGENTS.md + agent prompt + skill context + framework instructions)
- `UserMessage.system?: string` field exists in both v1 and v2 — system overrides per user message
- `client.session.messages()` returns message history, where `UserMessage` has `system?: string`
- `client.session.init()` exists — creates AGENTS.md, confirming it's fundamental to sessions

**Current state:** The plugin does NOT use `experimental.chat.system.transform`. The scorer reads AGENTS.md from disk at evaluation time — this is the *current* state, not what was active during the session. No system prompt capture happens at session start.

**Analysis:** AGENTS.md IS part of the system prompt for all agents/subagents. The `experimental.chat.system.transform` hook exposes the full `system: string[]` array at runtime. Retroactive viewing is possible via `UserMessage.system` from `client.session.messages()`.

**Recommendation:** Use `experimental.chat.system.transform` to capture the system prompt at session start. Store it in `PendingEval`. At evaluation time, hash-compare with the current AGENTS.md — if they differ, note it in the scoring prompt ("AGENTS.md changed mid-session"). This provides full prompt provenance.

---

## 10. Aggregation strategy — per-session or batch?

**Current state:**
- Each session is evaluated independently (`runEvaluation` per polling tick via `pollAndEvaluate()`)
- `considerImprovement()` checks if a weakness has been seen ≥ `min_observations_for_update` times across ALL sessions via the state store's aggregate data
- Time-decayed weighting (`weakness_decay_days`) is applied during aggregate recalculation
- Each evaluation suggests improvements based on that single session's score card, but the decision to queue/apply is based on the aggregate pattern frequency

**SDK verified:** No scoring/evaluation API exists in the SDK — `client.session.evaluate()` does NOT exist. The plugin's approach (creating ephemeral child sessions for scoring) is the correct and only viable path. There's no batch-analysis API either.

**Analysis:**
- The aggregation is **cross-session** — weaknesses are tracked globally and per-agent across all sessions
- The actual suggestion text comes from the *latest* score card's `suggested_*_update` field, not from a batch analysis
- This means the suggestion quality depends entirely on the LLM's per-session judgment, not on cross-session pattern synthesis

**Recommendation:** The current approach is correct. Optionally add a "batch review" mode that sends the last N low-scoring sessions to the LLM together for a synthesized improvement suggestion. Add a config key `batch_suggestion_size` (default 1, meaning per-session).

## 11. Cross-instance deduplication

**Current state:**
- Each opencode instance runs its own copy of the plugin in-process
- State is stored on disk at `{cwd}/.opencode/kasper/state.json`
- **Cross-process merging is implemented** (`state.ts:339` — `mergeExternalState()`):
  - Acquires file lock before writing
  - Reads current on-disk state
  - Merges external sessions, improvements, rejected patterns
  - Deduplicates improvements by `id` field
  - Atomic writes (temp file + rename)
- Debounced writes (2s)

**Analysis:**
- Two instances on the same project will share state via the same `state.json` file
- The merging logic is active — `mergeExternalState()` runs on every flush
- BUT: evaluation work is NOT deduplicated across instances. `sessionsEvaluated` is in-memory (`Set<string>`), not persisted. Instance restart means it could re-evaluate sessions another instance already scored

**Recommendation:**
- Persist `sessionsEvaluated` to the state file (small — just session IDs)
- Add a "last evaluated by" field to session records so instances can skip sessions already scored by another instance

## 12. Evaluation granularity — per-message vs per-session

**SDK verified:**
- `experimental.chat.system.transform` hook exists — captures system prompt at chat time, can store in PendingEval
- `client.session.messages()` returns message history including `UserMessage.system?: string` — provides retroactive system context
- Session events: `pollAndEvaluate()` replaces the old `session.idle` trigger — sessions are polled at 10s intervals via `setInterval`. `session.created` fires with `{ info: Session }` (v1) or `{ sessionID, info: Session }` (v2)
- All plugin hooks verified functional: `"chat.message"`, `"tool.execute.after"`, `"command.execute.before"` are separate named hooks (not dispatched through `event` handler)
- `client.session.delete()` takes `{ sessionID }` (v2) or `{ path: { id } }` (v1), returns `boolean`
- `client.config.get()` returns full `Config`, `client.config.update()` exists (not `patch`)

---

## Summary of Implementable Fixes

### High priority (real bugs or missing functionality)

| # | Fix | Effort | Impact |
|---|---|---|---|
| 11 | Persist `sessionsEvaluated` to state file | Small | Prevents duplicate LLM calls across restarts + instances |
| 3 | Add `evaluate_subagents` config (default false) + filter in polling handler | Small | Prevents noisy subagent scores in primary aggregates |
| 7 | Global agent prompt fallback in `AgentPromptManager` | Small | Captures global agent prompts, not just project ones |
| 8 | Use `client.app.agents()` API for authoritative agent prompts | Medium | Eliminates file I/O races, captures inline config prompts |

### Medium priority (enhancements)

| # | Fix | Effort | Impact |
|---|---|---|---|
| 1 | Add `state_dir` config key for shared kasper state | Medium | Multi-instance / CI support |
| 12 | Hash AGENTS.md at session start, detect mid-session changes | Small | Better evaluation accuracy |
| 12 | Capture system prompt via `experimental.chat.system.transform` hook | Medium | Full prompt provenance for scoring |
| 10 | Optional batch suggestion mode (N sessions → one improvement) | Large | Higher quality LLM suggestions |
| 4 | Add `/kasper tree` command for session hierarchy | Small | Visibility into subagent chains |

### Low priority (nice to have)

| # | Fix | Effort | Impact |
|---|---|---|---|
| 2 | Add `config_poll_interval_ms` config key | Trivial | User control over reload frequency |
| 11 | Add "last evaluated by instance" field to session records | Small | Cross-instance dedup metadata |

### Not needed

| # | Why |
|---|---|
| 5 | `detail_level` is already fully implemented and working |
| 6 | Prompt sections are already clearly labeled with markdown headers |

---

## SDK API Audit Summary

All SDK APIs referenced in this review were verified against `@opencode-ai/sdk` types (v1 and v2).

| SDK API | Status | Used by plugin? |
|---|---|---|
| `client.app.agents()` → `Array<Agent>` with `prompt?: string` | EXISTS | **No** — plugin could use this for authoritative agent prompts |
| `client.config.get()` → `Config` | EXISTS | **No** — plugin reads config from JSONC files only |
| `client.session.create()` | EXISTS | **Yes** — for ephemeral scoring sessions |
| `client.session.prompt()` | EXISTS | **Yes** — for scoring LLM call |
| `client.session.delete()` | EXISTS | **Yes** — cleanup scoring sessions |
| `client.session.messages()` | EXISTS | **Yes** — manual historical evaluation |
| `client.session.init()` | EXISTS | **No** |
| `client.session.evaluate()` | DOES NOT EXIST | Plugin's child-session scoring is the only viable path |
| `experimental.chat.system.transform` hook | EXISTS | **No** — key gap for prompt provenance |
| `experimental.session.compacting` hook | EXISTS | **Yes** — injects score context |
| `"chat.message"` named hook | EXISTS | **Yes** — accumulates PendingEval |
| `"tool.execute.after"` named hook | EXISTS | **Yes** — records tool calls |
| `"command.execute.before"` named hook | EXISTS | **Yes** — intercepts /kasper commands |
| `"session.created"` named hook | EXISTS (dynamic dispatch) | **Yes** — registers agent info |
| `session.idle` SSE event | EXISTS | Deprecated — poll-based evaluation via `pollAndEvaluate()` replaces idle-event trigger |
| `UserMessage.system?: string` | EXISTS | **No** — could provide retroactive system context |

**Key finding:** The plugin already uses all available hooks correctly. The gaps are (a) not calling `client.app.agents()` for authoritative prompts, (b) not using `experimental.chat.system.transform` for prompt provenance, and (c) not persisting `sessionsEvaluated` for cross-instance dedup. These are the three most impactful fixes.
