# Kasper Plugin — Improvement Plan

## 1. `/kasper score session X` completeness

### Current state
- `manualEvaluateSession()` fetches messages via `client.session.messages()` and builds a `PendingEval` from them using `buildEvalFromMessages()`.
- **Tool calls**: extracted from message parts (`tool_use`/`tool_result`) in `extractToolCallsFromMessages()`. Works correctly.
- **Subagent sessions**: `evaluateChildSessions()` recursively scores children. Works.
- **Problem**: `buildEvalFromMessages()` does NOT filter properly. It includes *all* messages between the first user message and the last assistant message — but an LLM error mid-stream can produce garbage responses that get included as "user instruction" or "assistant response". The scorer then sees this noise and penalizes the agent.

### Proposed fix (point 1b — session filtering)

Replace `buildEvalFromMessages()` with a smarter algorithm:

```
function buildEvalFromMessages(msgs):
  segments = []
  for each msg in msgs:
    if role == "user" AND not a registered command:
      if last segment was user-to-user (no assistant between):
        append to previous user instruction (continuation)
      else:
        start a new user→assistant segment with this as userInstruction
    if role == "assistant" AND there's an active segment waiting for response:
      append to agentResponseParts
    if role == "assistant" AND there's no active segment (stray response):
      skip

  keep only complete segments that have BOTH userInstruction AND agentResponseParts
  if no complete segment: return null (don't evaluate)
```

Key rules:
- A segment = a user message followed eventually by an assistant response.
- If the last assistant message is missing (session was interrupted, user sent another message, LLM error), the segment is **incomplete** → discard it.
- Tool calls are only included if they belong to a kept segment.
- Registered commands (`/kasper`, `/dcp`, etc.) are filtered out from being the user instruction — they already are.

**Rationale**: This eliminates the "LLM error interpreted as agent not following instructions" problem. If there's no complete user→assistant turn, we don't score. The scorer only sees well-formed interactions.

### Point 1a — Time-based vs event-based triggering

Originally planned: evaluation triggered by `session.idle` event. This was fragile — if idle events were missed or unreliable, sessions never got evaluated.

IMPLEMENTED: Switched to **periodic poll** approach:
- A `setInterval` every `EVALUATION_POLL_INTERVAL_MS` (10s) in the plugin's main loop.
- On each tick, `pollAndEvaluate()` scans `session.list()` for completed sessions ≥ `SESSION_DEBOUNCE_MS * 3` since last update.
- This replaces the `session.idle` path entirely.
- Event hooks (`session.created`, `message.updated`, `chat.message`) populate the in-memory session tracking.

Benefits:
- No reliance on SDK idle events being fired.
- More predictable: sessions are scored ~30s after the last message.
- Simpler to debug.

---

## 2. `/kasper improve` output format

### Current state
`executeKasperImprove()` returns weaknesses with `[N] index, pattern, count, target label, fix`. It returns ALL in one big chunk and tells the caller to present them one-at-a-time.

### Proposed change
Output format becomes a **numbered table** with 4 columns:

```
## Improvements for <agent>

| # | Weakness | Count | Suggested Fix |
|---|---|---|---|
| 1 | Does not confirm tool completion | 4x | After tool execution, add "Done: X completed" |
| 2 | Response too verbose | 3x | Keep responses under 3 bullet points |
```

The improvement index `[N]` resets after `apply`, so re-running `improve` shows only still-relevant items.

Internally:
- `executeKasperImprove()` queries `ctx.stateStore.getAggregate()` (or per-agent) and filters by `min_observations_for_update`, excludes rejected patterns.
- Returns the filtered list directly (no need to present one-at-a-time — the user just sees the table and runs `/kasper apply N`).
- Remove the "present each one at a time" instruction from the output.

---

## 3. `/kasper apply` resets weakness counter

### Current state
`applyImprovement()` splices the item from `ctx.improvementsPending` and applies it. The weakness pattern remains in the aggregate stats with the same count.

### Proposed change
When an improvement is applied:
1. Remove the weakness pattern(s) from the running `weaknessFreq` map(s) in `KasperStateStore`.
2. Recompute the aggregate (which removes it from `top_weaknesses`).
3. This means the weakness count resets to 0.
4. If subsequent scoring sessions observe the same weakness again, it will re-appear — that's expected and correct.

Implementation:
```typescript
// In state.ts, add:
resetWeaknessCounts(patterns: string[]): void {
  for (const pattern of patterns) {
    this.weaknessFreq.delete(pattern)
    for (const [, ars] of this.byAgentRunning) {
      ars.weaknessFreq.delete(pattern)
    }
  }
  this.computeAggregateFromRunning()
  this.markDirty()
}
```

Call this from `applyImprovement()` in `handlers.ts` after applying.

---

## 4. `/kasper apply N prompt` — applying to agent prompts

### Current state
`buildApplyPromptForPendings()` returns *instructions* for the LLM to manually edit the prompt. It does NOT directly apply the change. For `agents_md` target, there IS direct application via `ctx.agentsMd.injectSection()`. For `agent_prompt`, there is also `ctx.agentPrompts.injectSection()` which writes to `.opencode/agents/<name>.md`.

The problem: some agents don't have user-defined prompts at all — they rely entirely on AGENTS.md. The kasper needs to detect this and **create** a prompt file for them.

### Proposed change — full auto-apply for prompts

**Step 1: Detection** — when an improvement targets an agent prompt:
1. Check `ctx.client.app?.agents()` to see if the agent has a registered prompt.
2. Check `ctx.agentPrompts.exists(agentName)` to see if `.opencode/agents/<name>.md` exists.
3. Check the global agents dir (`~/.config/opencode/agents/<name>.md`).
4. Check `opencode.json` for inline prompts or `{file: ...}` references.

**Step 2: Creation** — if no prompt exists:
1. Create `.opencode/agents/<name>.md` with an initial prompt that includes the agent's purpose (from `ctx.agentRegistry`) and the improvement content.
2. The prompt must be registered with opencode. This requires SDK support — or, as a fallback, a documented manual step.

**Step 3: Registration in opencode config** — this is the hard part:
- opencode agents can have inline prompts in `opencode.json`:
  ```json
  {
    "agent": {
      "build": {
        "prompt": "You are a build agent..."
      }
    }
  }
  ```
  Or file references:
  ```json
  {
    "agent": {
      "build": {
        "prompt": {
          "file": ".opencode/agents/build.md"
        }
      }
    }
  }
  ```
- We need to modify `opencode.json` using the `jsonc-parser` to add/update the agent entry. Key challenges:
  - Preserve comments (jsonc, not plain json).
  - Handle nested `agent.<name>.prompt` paths.
  - If the agent isn't defined at all, create `agent.<name>.prompt.file` pointing to our file.
- **Risk**: opencode's config format may change. We need to verify the exact schema.

**Recommendation**: Start by writing the `.opencode/agents/<name>.md` file and printing **exact instructions** for the user to modify `opencode.json`. Once we have SDK methods for programmatic agent registration, switch to auto-apply. This is safer and more robust.

```typescript
// Proposed strategy in agent-prompts.ts
async ensureAgentPrompt(
  agentName: string,
  improvementContent: string,
): Promise<{ path: string; needsConfigUpdate: boolean }> {
  // 1. Check all locations for existing prompt
  const localPath = this.getAgentPath(agentName)
  const globalPath = this.getGlobalAgentPath(agentName)
  
  if (await exists(localPath)) {
    // Update existing
    await this.injectSection(agentName, "Kasper Inferred Instructions", improvementContent)
    return { path: localPath, needsConfigUpdate: false }
  }
  
  if (await exists(globalPath)) {
    // Can't write to global dir — suggest user copy to local
    return { path: "", needsConfigUpdate: true, message: `Copy ${globalPath} to ${localPath} and configure opencode.json` }
  }
  
  // 3. Create new local prompt file
  const prompt = `# ${agentName} Agent\n\n${improvementContent}\n`
  await this.write(agentName, prompt)
  return { path: localPath, needsConfigUpdate: true }
}
```

---

## 5. Agent prompt + AGENTS.md visibility for agents

### Current understanding
- opencode agents see both AGENTS.md (project-level) and their agent-specific prompt file (`.opencode/agents/<name>.md` or inline in `opencode.json`) in their context at startup.
- The `experimental.session.compacting` event shows that kasper feedback IS injected into the context of the compacted session.
- The kasper reads both AGENTS.md and agent prompts during scoring (see `buildEvalPrompt()` in `scorer.ts`).

### Need to verify
We need to confirm with the opencode SDK/API:
1. Does `client.app?.agents()` return the *effective* prompt (merged AGENTS.md + agent prompt)?
2. Or does it return only the agent-specific prompt defined in config?
3. How does opencode handle the merge internally?

### Action
- Check opencode SDK documentation / source for how agents compose their final prompt.
- If they don't see AGENTS.md by default, the kasper could inject a reference in the agent prompt:
  ```
  Also consult AGENTS.md at the project root for project-wide instructions.
  ```
- This is probably already the case — AGENTS.md is a well-known opencode convention.

---

## 6. Command audit — keep only the essentials

The user wants these commands (what they've actually used):

| Keep | Command | Why |
|------|---------|-----|
| ✅ | `score session [id]` | Manual evaluation |
| ✅ | `status [agent]` | Overall health — scores, weaknesses, trends |
| ✅ | `improve [agent]` | Generate improvement suggestions |
| ✅ | `apply <n>` | Apply an improvement |
| ✅ | `apply <n> [agents_md\|prompt]` | Apply with target override |
| ✅ | `reset` | Clear all state |
| ✅ | `history [agent]` | See past evaluations and improvements |
| ✅ | `help` | Show usage |
| ❌ | Remove `config` | Already viewable via `status`. Config editing is external. |
| ❌ | Remove `log` | Redundant with `history` |
| ❌ | Remove `merge` | Auto-merge happens on `status` query already. No need for manual. |
| ❌ | Remove `tree` | Debug-only; not useful day-to-day |
| ❌ | Remove `steer` | Adds complexity. User guidance can be a config field. |
| ❌ | Remove `pending` | Fold into `improve` — it shows anything pending/available |
| ❌ | Remove `reject` / `rejections` / `unreject` | Complexity for marginal value. If user doesn't want a suggestion, they just don't apply it. |
| ❌ | Remove `pause` / `resume` | Use `enabled: false` in config instead |
| ❌ | Remove `rollback` | Can manually restore from backups in `.opencode/kasper/backups/` |
| ❌ | Remove `auto` | Config-controlled: `auto_update_agents_md` and `auto_update_agent_prompts` |

### Renamed / reworked commands

| New Command | Maps to | Behavior |
|---|---|---|
| `score session <id>` | `kasper_score_session` | Evaluate session(s) |
| `status [agent]` | `kasper_status` | View scores, weaknesses, trends |
| `improve [agent]` | `kasper_improve` | Show top weaknesses with suggested fixes |
| `apply <n> [target]` | `kasper_apply` | Apply Nth improvement from improve output |
| `reset` | `kasper_reset` | Clear all state |
| `history [agent]` | `kasper_history` | Past evaluations |
| `help` | (built-in) | Show usage |

### Commands that become tool-only (not slash commands)

These remain available as MCP tools but don't need dedicated slash command syntax:
- `kasper_score_agent` — deprecated in favor of `status agent X`
- `kasper_reject` / `kasper_rejections` / `kasper_unreject` — keep as tools for advanced users
- `kasper_steer` — keep as tool
- `kasper_merge` — keep as tool, fires automatically

The slash command template in `index.ts` gets simplified to only handle the 7 kept commands. Everything else goes through the tool layer.

---

## Implementation Status

| # | Item | Status | Notes |
|---|------|--------|-------|
| 1a | Time-based evaluation polling | ✅ Done | `pollAndEvaluate()` runs every 10s via `setInterval` in `index.ts:184` |
| 1b | `buildEvalFromMessages()` fixed | ✅ Done | Trailing-user removal now checks `keptMsgs[last] === currentUserMsg` |
| 2 | `/kasper improve` table output | ✅ Done | `executeKasperImprove()` returns numbered table with #, Weakness, Count, Agent, Target |
| 3 | Reset weakness counters on apply | ✅ Done | `resetWeaknessCounts()` in state.ts called from both auto and manual apply paths |
| 4 | `ensureAgentPrompt()` for missing prompts | ✅ Done | `AgentPromptManager.injectSection()` creates prompt file if missing; auto-registration in `opencode.json` is still manual |
| 5 | Investigate agent prompt composition | ✅ Done | Documented in REVIEW.md §7-9: `client.app.agents()` returns effective prompt |
| 6 | Command audit (keep 7) | ✅ Done | 8 commands remain: status, score, improve, apply, history, config, reset, help |

### Additional Implementations (not in original plan)

| Add | Description |
|-----|-------------|
| **Agent prompt file management** | `AgentPromptManager` class with read/write/exists/injectSection/backup — creates `.opencode/agents/<name>.md` |
| **AGENTS.md management** | `AgentsMdManager` with lockedUpdate/backup/rollback/injectSection — concurrent-write safe |
| **Structured logging** | `KasperLogger` — JSON-line logs with rotation, debug levels, `trim()` |
| **Cross-process file locking** | `lock.ts` — POSIX `flock` with stale detection (30s timeout) |
| **Atomic file writes** | `prompt-utils.ts` — temp+rename with PID+random suffix |
| **Config hot-reload** | 5s polling interval (`config_poll_interval_ms`), diffs by JSON equality |
| **Score delta tracking** | `closePendingScoreDeltas()` — measures before/after improvement impact |
| **Weakness merge de-dup** | `mergeAllWeaknesses()` — LLM consolidates similar weakness patterns |
| **Compaction context injection** | `experimental.session.compacting` injects top weaknesses + per-agent stats into agent context |
| **Debug logs** | `manual_eval_msg_diag`, `batch_eval_*`, `state_flush_*`, `state_merge_*`, `run_eval_*` — full pipeline observability |
| **Config keys added** | `state_dir`, `max_score_input_chars`, `scoring_timeout`, `debug`, `log_max_lines`, `detail_level`, `quiet`, `config_poll_interval_ms`, `weakness_decay_days` |

### Removals (from original design)

| Removed | Rationale |
|---------|-----------|
| `/kasper log` | Redundant with `history` |
| `/kasper pending` | Folded into `improve` |
| `/kasper reject/accept/unreject` | Complexity for marginal value |
| `/kasper steer` | User guidance moved to config |
| `/kasper pause/resume` | Use `enabled: false` in config |
| `/kasper rollback` | Manual restore from `.opencode/kasper/backups/` |
| `/kasper tree` | Debug only, not needed day-to-day |

### Remaining Work

- **Auto-register agent prompts in `opencode.json`** — still too risky (jsonc comment preservation). Print clear instructions instead.
- **Batch suggestion mode** (N sessions → one improvement) — not implemented, still per-session.
- **System prompt provenance** via `experimental.chat.system.transform` — not implemented.
- **Global agent prompt fallback** — `AgentPromptManager` already has global dir parameter but fallback behavior not verified.
