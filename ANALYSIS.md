# Kasper Plugin — Low-Level Architecture Analysis

## 1. Plugin Lifecycle & Singleton Nature

### 1.1 Invocation Model

The opencode runtime loads plugins from `.opencode/plugins/` (project) or `~/.config/opencode/plugins/` (global). Each plugin directory must contain an entrypoint (e.g., `kasper.ts`) that `export default`s a function matching the plugin contract.

The loader at `.opencode/plugins/kasper.ts` re-exports from the compiled `dist/index.js`:

```ts
export { KasperPlugin } from "../dist/index.js"
export default KasperPlugin
```

OpenCode calls `KasperPlugin()` **once per process**, passing a `{ client, directory }` object. The return value is a record of hook handlers that the runtime calls as events fire.

### 1.2 Singleton Scope

The plugin IS a singleton, but scoped to the **opencode process**, not the machine or the project. Every piece of mutable state is created inside the `KasperPlugin` closure and never escapes it:

```
KasperPlugin({ client, directory })
  ├── pendingEvals: Map<sessionID, PendingEval>        // one entry per active session
  ├── agentRegistry: Map<sessionID, AgentSessionInfo>   // agent type/name per session
  ├── parentToChildren: Map<sessionID, Set<sessionID>>  // subagent tracking
  ├── sessionParents: Map<sessionID, sessionID>         // child → parent lookup
  ├── deletedSessions: Set<sessionID>                   // tombstone set
  ├── sessionsEvaluated: Set<sessionID>                 // dedup set
  ├── improvementsPending: ImprovementRecord[]           // manual-approval queue
  ├── lastIdleTimes: Map<sessionID, number>             // debounce map
  ├── lastActiveSessionID: string                       // current session ref
  ├── stateStore: KasperStateStore                     // persisted state (singleton shared)
  ├── agentsMd: AgentsMdManager                          // AGENTS.md file ops (singleton shared)
  ├── agentPrompts: AgentPromptManager                   // per-agent prompt file ops (singleton shared)
  ├── scorer: Scorer                                     // LLM-as-judge engine (stateless, safe)
  └── logger: KasperLogger                             // JSON-line log writer (singleton shared)
```

All hooks share these references via the `ctx: KasperContext` object. This means:

- **Same process, multiple sessions:** All sessions (primary + subagents) share the same state objects. They are differentiated via Maps keyed by `sessionID`.
- **Multiple processes:** Each process gets its own independent copy of everything. They DO NOT coordinate.

## 2. Concurrency Model

### 2.1 JavaScript Event Loop Model

The opencode runtime (and by extension the plugin) runs on Node.js/Bun's **single-threaded event loop**. There is no true parallelism — only cooperative concurrency via `async/await`.

Key property: **no two pieces of synchronous JavaScript ever execute simultaneously within the same process.** An `await` is the only suspension point where control yields to the event loop.

### 2.2 Intra-Process "Thread Safety"

Because JS is single-threaded, Maps, Sets, and plain objects are safe from torn reads/writes **as long as no `await` intervenes in the middle of a multi-step mutation**. Let's audit each shared structure:

| Shared Structure | Hook Producers | Hook Consumers | Risk |
|---|---|---|---|
| `pendingEvals` (Map) | `chat.message`, `tool.execute.after` | `session.idle` → `runEvaluation()` | Moderate — consumed during idle, which is debounced. Both writers only mutate existing entries (append response parts, push tool calls). `session.idle` reads then deletes. No interleaving risk since each hook runs atomically per event. |
| `agentRegistry` (Map) | `session.created`, `session.updated` | `session.idle`, `chat.message`, compaction | Low — only set/delete mutations with primitive lookups. Immutable once written. |
| `parentToChildren` / `sessionParents` (Maps) | `session.created`, `session.deleted` | aggregation queries | Low — simple set add/delete. |
| `deletedSessions` (Set) | `session.deleted` | `session.idle`, `chat.message`, `tool.execute.after` | Moderate — check-then-act pattern (check `ctx.deletedSessions.has(sid)` then proceed). Between the check and the act, the session could be deleted. However, since hooks are processed in the same event loop tick order, and session deletion comes from the same event source, this is unlikely. Still, a `session.idle` could fire while `session.deleted` is pending if they're in different microtask queues — possible gap. |
| `lastIdleTimes` (Map) | `session.idle` | `session.idle` | Low — simple read-write-update cycle for debouncing. Since idle events fire in sequence, no interleaving. |
| `stateStore` (class) | `recordSession()`, `recordImprovement()` | All read methods | High — see §2.3 below. |
| `agentsMd` / `agentPrompts` | `runEvaluation()`, `/kasper apply`, `/kasper rollback` | All reads | High — file system races. See §2.3. |

### 2.3 State Store Race Condition Analysis

The `KasperStateStore` uses a **dirty-flag + debounced flush** pattern:

```ts
private markDirty(): void {
  this.dirty = true
  if (!this.flushTimer) {
    this.flushTimer = setTimeout(() => this.flush(), 2000)
  }
}
```

**Scenario A — Concurrent writes before flush:**
```
T0: recordSession("A") → markDirty() → sets dirty=true, starts 2s timer
T1: recordSession("B") → markDirty() → sets dirty=true (already true), timer already running
T2: (2s from T0) → flush() fires → writes state.json with BOTH A and B
```
✅ Safe. Multiple in-memory mutations accumulate before the single flush. The debounce coalesces writes.

**Scenario B — Flush racing with a new write:**
```
T0: recordSession("A") → markDirty()
T2: flush() fires → sets dirty=false, reads state, writes temp file
T2.5: recordSession("B") → markDirty() → sets dirty=true, starts new timer
T2.6: flush() renames temp → state.json (but state.json now missing session B)
```
🚨 **DATA LOSS!** The flush that started at T2 captured state BEFORE session B was recorded. Session B is in memory but the on-disk state.json doesn't include it. When the 2nd flush fires (T4.5), it WILL write session B... but if the process crashes between T2.6 and T4.5, session B is lost.

Mitigation: The window is small (2s), and Node.js event loop processes timers in order. The more realistic concern is:

**Scenario C — Flush at `destroy()`:**
At `close()` hook, the plugin calls `stateStore.destroy()`. This clears the timer and calls `flush()` synchronously. If another hook fires after destroy starts but before the process exits, that state could be lost. However, this is a shutdown scenario — opencode should not fire hooks during shutdown.

### 2.4 File System Concurrency (Inter-Process)

**AGENTS.md read/write:**
- `AgentsMdManager.read()` — does `readFile(path, "utf-8")`, no locking
- `AgentsMdManager.write(content)` — does `writeFile(path, content, "utf-8")`, no locking
- `AgentsMdManager.backup(label)` — does `copyFile(source, dest)`, no locking
- `AgentsMdManager.rollback()` — reads backup, writes AGENTS.md

**state.json read/write:**
- `stateStore.init()` — reads state.json on startup
- `stateStore.flush()` — atomic write via temp file + rename (see below)
- `stateStore.flush()` retry loop: 5 attempts with exponential backoff (10ms, 20ms, 30ms, 40ms, 50ms)

**kasper.log write:**
- `KasperLogger.log()` — does `appendFile(logPath, line)`, no locking

Each write operation is atomic at the POSIX level (from the same process), but across processes there are no guarantees.

### 2.5 Atomic Write Protocol in Detail

The state store uses a **write-to-temp, sync, rename** pattern:

```ts
const tmpPath = `${statePath}.tmp-${pid}-${timestamp}-${random}`
open(tmpPath, "w")
  → writeFile(JSON.stringify(state), "utf-8")
  → sync()
  → close()
rename(tmpPath, statePath)  // POSIX: atomic when src/dst on same filesystem
```

The temp filename includes `process.pid`, `Date.now()`, and a random suffix, so two processes writing simultaneously will never collide on the temp file.

On Windows, `rename` can fail with `EPERM`/`EBUSY` if the target is held open by another process (e.g., antivirus, or another opencode instance reading state.json). The fallback in this case is a direct `writeFile()`:

```ts
if (process.platform === "win32" && (errCode === "EPERM" || errCode === "EBUSY")) {
  const data = await readFile(tmpPath, "utf-8")
  await writeFile(statePath, data, "utf-8")  // non-atomic fallback
  return
}
```

This is a best-effort compromise but NOT safe against inter-process races on Windows.

## 3. Multiple Session Handling (Single Instance)

### 3.1 Session Lifecycle Within One Process

```
session.created → agentRegistry.set(sid, info)
                    parentToChildren.set(parent, child)
                    sessionParents.set(child, parent)

chat.message (user) → pendingEvals.set(sid, { instruction, ... })

chat.message (assistant) → pendingEvals.get(sid).agentResponseParts.push(...)

tool.execute.after → pendingEvals.get(sid).toolCalls.push(...)

session.idle → debounce check → runEvaluation(pendingEvals.get(sid))
                → pendingEvals.delete(sid)
                → stateStore.recordSession(sid, ...)

session.deleted → deletedSessions.add(sid)
                  pendingEvals.delete(sid)
                  agentRegistry.delete(sid)
                  parentToChildren cleanup
```

### 3.2 Subagent Observation

Subagents are detected via the `parentID` field on `session.created`:

```ts
const { parentID, agentName } = extractAgentInfo(input)
if (parentID) {
  sessionParents.set(sessionID, parentID)
  parentToChildren.get(parentID).add(sessionID)
}
```

Each subagent gets its own `sessionID`, `pendingEval` entry, and evaluation. The parent-child relationship is tracked but currently used only for cleanup (when parent is deleted, children are cleaned up). It is **not** used for:
- Attributing subagent weaknesses to the parent session
- Cross-referencing scores in the aggregate

### 3.3 PendingEval Lifecycle Risk

A `PendingEval` accumulates data over a session's lifetime:
- Created at first `chat.message` (user)
- Appended with each `chat.message` (assistant)
- Appended with each `tool.execute.after`
- Consumed at `session.idle` (deleted from map)

If a session is very long (many messages/tool calls), the `agentResponseParts` array and `toolCalls` array grow unbounded. There is no trimming or summarization before evaluation. This could lead to:
- Very large prompts sent to the scoring LLM (cost + latency)
- Memory pressure in the Map

**Compaction interaction:** The `experimental.session.compacting` hook fires on the session, not the pendingEval. The pendingEval's accumulated response parts are independent of the compacted context. There's a possible mismatch: the scoring LLM evaluates the FULL raw chat history, while the agent's own context has been compacted.

## 4. Multiple Process Handling (Inter-Instance)

### 4.1 State File Race: Two Processes Writing state.json

```
Instance A: read state.json (sessions: 10)
Instance B: read state.json (sessions: 10)

Instance A: recordSession("A") → flush() → state.json now has 11 sessions
Instance B: recordSession("B") → flush() → state.json now has 11 sessions
                                          → Session A LOST
```

The atomic write protocol prevents corruption (no torn writes), but it does NOT prevent **lost updates**. Each flush overwrites the entire state.json file. Without a read-modify-write cycle under a lock, this is fundamentally vulnerable.

### 4.2 AGENTS.md Race: Two Processes Updating

```
Instance A: read AGENTS.md → inject section → write AGENTS.md
Instance B: read AGENTS.md → inject section → write AGENTS.md
                               (Instance B's write overwrites A's changes)
```

The backup system captures the state before write, so rollback is available. But the last-writer-wins pattern means one instance's improvement is lost.

### 4.3 kasper.log Race

```
Instance A: appendFile("kasper.log", line_a)
Instance B: appendFile("kasper.log", line_b)
```

POSIX `appendFile` with `O_APPEND` on local filesystems is typically atomic for writes smaller than `PIPE_BUF` (4096 bytes on Linux, varying on other OS). Log lines are typically <1KB, so interleaving is unlikely. However, on Windows, `appendFile` behavior depends on the underlying libuv implementation. Line interleaving is possible but unlikely in practice.

### 4.4 Cross-Instance Session Correlation

Two separate opencode processes watching the same project will see different `sessionID` values for what a human would consider "the same session" (the same child window in the TUI). The kasper has no mechanism to correlate sessions across instances. Each instance maintains independent state.

### 4.5 Mitigation Summary

| Resource | Risk | Severity | Mitigation Present | Suggested Fix |
|---|---|---|---|---|
| state.json | Lost updates | High | Atomic temp+rename | File lock (proper-lockfile, flock) or single-instance enforcement |
| AGENTS.md | Lost improvements | Medium | Backups before write | File lock or append-only model |
| kasper.log | Line interleaving | Low | O_APPEND semantics | Per-instance log files (instance-log-{pid}.log) |
| Backups dir | Duplicate backups | Low | Timestamp+random suffix | Separate backup directories per instance |

## 5. User Interaction & Visual Display

### 5.1 Current Toasts

```ts
showToast(client, "Kasper", "AGENTS.md updated.", "success")
// → client.tui.showToast({ body: { title, message, variant, duration } })
```

Toasts fire for:
- Low score (`<0.4` → warning toast)
- Improvement pending (info toast, 6s)
- Improvement auto-applied (success toast, 6s)
- Manual `/kasper apply` (success toast)
- Manual `/kasper rollback` (info toast)

### 5.2 Toast Limitations

- No progress indication during scoring (scoring takes seconds, user sees nothing)
- No inline display of scores (must use `/kasper status`)
- No visual indicator that updates happened to AGENTS.md (must check git diff)
- Toasts disappear — no persistent "last score: 72%" indicator

### 5.3 TUI Plugin Gap

The DESIGN.html references a TUI plugin for a sidebar panel. The opencode plugin API exposes `TuiPlugin` for rendering UI. The kasper currently only uses:
- `tool()` — register custom tools
- `command.execute.before` — intercept slash commands
- `config()` — inject command configuration
- Standard hooks (event, chat.message, tool.execute.*, session.*, compaction)

The compaction hook IS used to inject context:

```ts
"experimental.session.compacting": async (input, output) => {
  // injects top weaknesses + avg score + per-agent stats into compaction context
  output.context.push(lines.join("\n"))
}
```

This is the kasper's feedback loop: the next compaction round includes kasper feedback, so the agent sees its own scores and recurring weaknesses. But this is invisible to the user (it's injected into the system prompt, not shown in chat).


