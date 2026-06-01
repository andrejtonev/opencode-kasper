# Kasper Plugin — Design Document

## Ideal Flow (from user's perspective)

1. **User installs the plugin** — Plugin becomes active for all future sessions.
2. **Pre-install sessions ignored** — Sessions created before plugin installation are never auto-scored. They are only scored if the user manually calls `/kasper score session <id>` or if the session becomes active again (user resumes chatting in it).
3. **Background auto-scoring** — Once running, the plugin periodically polls for new sessions and new messages. Scoring uses the same LLM-as-judge logic as manual scoring. Previously evaluated sessions are re-evaluated only if new messages (not seen before) have been added.
4. **Auto-improve (if enabled)** — When `auto_update_agents_md` or `auto_update_agent_prompts` is on, the plugin automatically applies improvements to AGENTS.md or per-agent prompts. Fixed weaknesses are removed from the frequency map. Subsequent scoring can add the same weakness back if it reappears.
5. **Manual trigger always available** — User can manually score any session (`/kasper score session <id>`) or trigger improvements (`/kasper improve [agent]`). Applied improvements target the correct agent prompt or AGENTS.md.
6. **Status at a glance** — `/kasper status [agent]` shows what's happening. But in auto mode, the user mostly doesn't need to interact.

## Cross-cutting Constraints

| Constraint | Implementation |
|---|---|
| **Multi-process safe** | POSIX `flock` file locking with stale detection (30s). `mergeExternalState()` on flush merges state from disk. |
| **Thread-safe** | Single-threaded JS event loop. `isEvaluating` flag prevents concurrent evaluations. |
| **Project-isolated weaknesses** | Each plugin instance has its own state directory (`.opencode/kasper/` per project). A single opencode instance handling multiple projects spawns one kasper per project. |
| **Disk as source of truth** | All state persisted in `state.json`. Atomic writes (temp+rename). Debounced flush (2s). |
| **Disk coherence** | File lock held during flush. Crash between `markDirty()` and flush loses at most 2s of data. |

## Architecture

### State lifecycle

```
Plugin Load → loadKasperConfig() → KasperController.init()
  │
  ├─ init() reads state.json (or creates if missing)
  ├─ Sets installed_at timestamp (persisted, survives resets)
  ├─ Starts config reload poll (5s interval)
  └─ Starts evaluation poll (10s interval)
       │
       ├─ Filters sessions by: created ≥ max(installed_at, pluginStartTime)
       ├─ Skips sessions: deleted, kasper sessions, recently-updated
       ├─ For already-evaluated sessions with new messages: re-evaluate only new content (via lastMsgId)
       ├─ For new sessions: full evaluation via buildEvalFromMessages()
       └─ On score < threshold: considerImprovement() → auto-apply or queue
```

### Session age detection

```
installed_at (state.json, persists across restarts)

Background poll auto-score: s.time.created >= installed_at
Manual score (/kasper score session <id>): always works (no age filter)
Batch score (/kasper score session last N): always works (no age filter)
```

### Incremental evaluation

When a previously-evaluated session gets new messages (detected via `last_msg_id` comparison):
1. `buildEvalFromMessages()` is called with `lastMsgId` parameter
2. Only messages AFTER `lastMsgId` are considered
3. The new evaluation replaces the old one in state

---

## Philosophy

Two modes with distinct expectations:

| Mode | User expectation | Implementation principle |
|---|---|---|
| **Auto ON** | Set and forget. Zero interaction needed. | Silent operation. Only notify on auto-applied changes. |
| **Auto OFF** | Hands-on but simple. Deliberate approval. | Clear queue, simple approve/reject flow. |

In both modes, the user should be able to inspect what's happening and steer future behavior.

---

## Task 1: Merge `/kasper apply` + `/kasper accept` → `/kasper apply [n]`

### Problem
Two commands do the same thing: `apply` applies first-in-queue, `accept <n>` applies the N-th item. Users see a numbered list from `suggest` and naturally reach for `apply 3`.

### Implementation
- `/kasper apply` → applies first pending (no change)
- `/kasper apply <n>` → applies the N-th pending (was `accept <n>`)
- Remove the `accept` case from the command handler
- Update `help` output and README
- Update tool descriptions

### Files changed
- `src/index.ts:618-645` — merge accept into apply
- `src/handlers.ts:557-583` — update help text
- `README.md` — update command table

---

## Task 2: Add `/kasper pending` command

### Problem
The pending improvement queue is only visible via `/kasper reject` (no arg), which is a counterintuitive discovery path. Users don't think to run "reject" to see what's pending.

### Implementation
- New `/kasper pending` slash command and `kasper_pending` tool
- Shows the queue with indices, targets, and reasons
- `/kasper reject` with no arg shows "Use /kasper pending to view the queue, then /kasper reject <n> to reject"
- Handler function: extract `suggestionListText()` into a dedicated handler

### Files changed
- `src/handlers.ts` — new `executeKasperPending()` function
- `src/index.ts` — add command case + tool registration

---

## Task 3: Fix toast quiet-gating

### Problem
`evaluate.ts:167-173` — the low-score warning toast (`<40%`) is NOT gated by `config.quiet`. Even with `quiet: true`, users get spammed with "Low adherence score" toasts.

Additionally, `evaluate.ts:124-132` — the evaluation-start toast is NOT quiet-gated, but should be (it's pure noise in auto mode).

### Implementation
- Gate ALL score-related toasts behind `!ctx.config.quiet`
- Make the low-score toast respect quiet mode
- Gate evaluation-start toast behind `!ctx.config.quiet`

### Files changed
- `src/evaluate.ts:124-132` — add `!ctx.config.quiet` guard
- `src/evaluate.ts:167-182` — unify the toast gating

---

## Task 4: Simplify `/kasper auto` toggle

### Problem
Four independent states govern auto-update (`config.auto_update_agents_md`, `config.auto_update_agent_prompts`, `ctx.autoUpdateEnabled`, `ctx.autoUpdatePromptsEnabled`). Users see `AGENTS.md=ON, Prompts=OFF` in output and don't understand config-vs-session precedence (OR logic).

### Implementation
- `/kasper auto on` → enables BOTH targets (session override)
- `/kasper auto off` → disables BOTH targets (session override)
- `/kasper auto status` → shows current state for both targets
- Keep `/kasper auto prompts on|off` for rare granular use (but don't advertise it)
- Update the `kasper_auto` tool: `target` param defaults to `"*"` (all)
- Update status output: show a single `Auto-update: ON/OFF` line

### Files changed
- `src/handlers.ts:185-227` — simplify `executeKasperAuto()`
- `src/handlers.ts:109-118` — simplify status auto-update line
- `src/index.ts:400-440` — update `kasper_auto` tool
- `src/evaluate.ts:413-415` — update auto consideration logic (OR both config keys with both session flags)

---

## Task 5: Clean up `/kasper score` tri-mode behavior

### Problem
`/kasper score` has three behaviors:
- Bare → evaluates current session
- `<agent name>` → shows existing scores for agent
- `<session ID>` → retroactively evaluates a session

User intent is guessed: if the arg is in `agents_observed`, it's treated as agent lookup. Otherwise it's a session ID. This breaks silently when a session ID happens to match an agent name, or when a user types an agent name not in the observed list.

### Implementation
- `/kasper score` → evaluates current session (unchanged)
- `/kasper score agent <name>` → view agent scores (was `/kasper score <name>`)
- `/kasper score session <id>` → retroactively evaluate session (was `/kasper score <id>`)
- Backward-compat: bare `/kasper score <name>` still works as before (agent if matches observed list, session otherwise)

### Files changed
- `src/index.ts:586-611` — add `agent` and `session` subcommands

---

## Task 6: Add `/kasper log` command

### Problem
In auto-ON mode, improvements are applied silently. The user has no concise way to see "what changed recently" without digging through `/kasper history` (which mixes sessions with improvements). A simple timeline of auto-applied changes is needed.

### Implementation
- `/kasper log [n]` — shows last N improvements (default 5)
- Each entry: timestamp, target (AGENTS.md or agent name), reason (first 120 chars), score delta if available
- Also add `kasper_log` tool for agent access

### Files changed
- `src/handlers.ts` — new `executeKasperLog()` function
- `src/index.ts` — add command case + tool registration

---

## Task 7: Improve auto-apply notification

### Problem
When auto applies an improvement, the toast shows only 80 chars of the change (`evaluate.ts:368-374`). No context, no rollback hint, no diff. The user can't understand what changed without manually investigating.

### Implementation
- Increase toast duration from 6000ms to 12000ms
- Show more of the change text (160 chars instead of 80)
- Add rollback hint to the toast message: `"Rollback with /kasper rollback"`
- Add a compact summary line in the `applyAgentsMdImprovement` / `applyAgentPromptImprovement` functions

### Files changed
- `src/evaluate.ts:326-332` — improve agent prompt toast
- `src/evaluate.ts:368-374` — improve AGENTS.md toast
- `src/index.ts:74-79` — improve manual-apply toast (applyImprovement)

---

## Task 8: Reduce slash command sprawl

### Goal: 17 → 12 commands

| Keep (12) | Remove/Merge (5) |
|---|---|
| `/kasper` (overview) | ~~`/kasper accept`~~ → merged into `apply [n]` |
| `/kasper status [agent]` | ~~`/kasper rejections`~~ → merged into `pending --rejected` |
| `/kasper score [agent\|session]` | ~~`/kasper unreject`~~ → merged into `reject --undo <pattern>` |
| `/kasper apply [n]` | ~~`/kasper tree`~~ → merged into `status --tree` |
| `/kasper pending` | ~~`/kasper help`~~ → bare `/kasper` already shows help hint |
| `/kasper auto [on\|off]` | |
| `/kasper rollback [agent]` | |
| `/kasper history [agent]` | |
| `/kasper steer <text\|reset>` | |
| `/kasper config` | |
| `/kasper pause/resume` | |
| `/kasper reject <n\|pattern>` | |

### Not implementing this yet
This is a larger change that could break muscle memory. Do it after the other changes settle, if needed.

---

## Results

| Metric | Before | After |
|---|---|---|
| Slash commands | 17 | 18 (+pending, +log, -accept) |
| Tools | 9 | 11 (+pending, +log) |
| Config keys | 15 | 15 (unchanged, but UX simplified) |
| Auto-update states | 4 (config.md, config.prompts, session.md, session.prompts) | 2 visible (both ON or both OFF by default) |
| Score command modes | 3 implicit (bare/agent/session) | 2 explicit subcommands + backward-compat |
| Toast noise in quiet mode | 2-3 per session (score + improvement) | 0-1 (quiet suppresses all, improvement-applied only) |
| Tests | 241 pass | 241 pass |

## Implementation Order

1. **Task 3 (Toast quiet-gating)** — simplest, immediate UX win
2. **Task 1 (Merge apply/accept)** — trivial refactor
3. **Task 2 (Add /kasper pending)** — new command, no breaking change
4. **Task 4 (Simplify auto toggle)** — moderate change, high impact
5. **Task 5 (Clean up score tri-mode)** — moderate change
6. **Task 6 (Add /kasper log)** — new command
7. **Task 7 (Improve auto-apply notification)** — toast adjustments
8. **Task 8 (Reduce command sprawl)** — future consideration

---

## State: Implementation Log

### 2026-05-17 (Design V1 — UX Simplification)
- Document created
- **Task 1 (Merge apply/accept)** — Done. `/kasper apply [n]` replaces both `apply` and `accept`.
- **Task 2 (Add /kasper pending)** — Done. New `/kasper pending` command and `kasper_pending` tool.
- **Task 3 (Toast quiet-gating)** — Done. All score-related toasts now respect `quiet` config.
- **Task 4 (Simplify auto toggle)** — Done. `/kasper auto on|off` toggles both targets by default.
- **Task 5 (Clean up score tri-mode)** — Done. Subcommands `agent` and `session` added.
- **Task 6 (Add /kasper log)** — Done. New `/kasper log [n]` command and `kasper_log` tool.
- **Task 7 (Improve auto-apply notification)** — Done. Rollback hints, 12s duration.
- **Results**: 241 tests pass, typecheck clean, lint clean.

### Post-Design Evolution (Command Audit — PLAN.md §6)
The PLAN.md command audit (written after this design doc) removed several features that V1 had already implemented:
- **`/kasper pending`** → removed. Folded into `improve` (pending=not yet applied improvements).
- **`/kasper log`** → removed. Redundant with `history`.
- **`/kasper reject` / `rejections` / `unreject`** → removed (remains as SDK tool-only).
- **`/kasper steer`** → removed.
- **`/kasper pause/resume`** → removed.
- **`/kasper tree`** → removed.
- **`/kasper rollback`** → removed (manual restore from backups dir).
- **`/kasper config`** → kept (was pending removal).
- **`/kasper auto`** → removed (config-controlled only) — *but was kept in final code.*

**Final slash commands**: `status`, `score`, `improve`, `apply`, `history`, `config`, `reset`, `help` (8 commands).

### Structural Changes (Beyond Original Design)

| Change | Description |
|--------|-------------|
| **Poll-based evaluation** | Replaced `session.idle` debounce with 10s `setInterval` polling via `pollAndEvaluate()` |
| **State dir config** | `state_dir` config key for user-definable kasper directory |
| **Score pair-splitting** | `max_score_input_chars` config splits large sessions into per-pair evaluation |
| **Weakness merge de-dup** | `mergeAllWeaknesses()` uses LLM to consolidate similar weakness patterns |
| **Compaction feedback** | `experimental.session.compacting` injects top weaknesses + per-agent stats |
| **Score delta tracking** | `closePendingScoreDeltas()` measures before/after improvement impact |
| **File locking** | Cross-process `flock`-style locks on state.json with stale detection |
| **Structured logging** | `KasperLogger` class with JSON-line logs, log rotation, debug levels |
| **Debug mode** | `debug: true` enables verbose SDK event logging, diagnostic message dumps |
| **Evaluate subagents** | `evaluate_subagents: false` default — subagent filtering |
| **Detail level** | `detail_level: minimal\|standard\|thorough` controls scoring prompt verbosity |
| **Quiet mode** | `quiet: true` suppresses all non-critical toasts |
| **Atomic writes** | `prompt-utils.ts` — temp+rename atomic file writes for state.json |
| **Backup manager** | `AgentsMdManager` + `AgentPromptManager` with inject, backup, rollback |

### Bug Fixes Applied (Post-Design)

1. **`runEvaluation` marking sessions too early** — `sessionsEvaluated.add()` moved AFTER successful LLM scoring (not before). Previously, scorer exceptions would permanently orphan sessions.

2. **`mergeExternalState` dedup by content** — Changed from content-based (agent_name+weaknesses+timestamp) to ID-only deduplication. Prevented legitimate sessions from being dropped when multiple plugin instances shared state.

3. **`batchEvaluateSessions` no error handling** — Added try/catch around `manualEvaluateSession` calls. Previously, a single failing session crashed the entire batch.

4. **`buildEvalFromMessages` trailing-user bug** — Trailing-user cleanup always removed the last user message even when assistant responses followed it. Fixed to only pop when user is actually last element.

### Current Test Status
- 6 pre-existing failures (4 from missing `resetWeaknessCounts` in mock, 2 from test fixtures ending with trailing user with no response)
- 0 new failures from fixes
- Typecheck: clean
- Lint: clean (biome)
