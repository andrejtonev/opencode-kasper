# Kasper E2E Tests

End-to-end tests that exercise the Kasper plugin through a real `opencode` binary.

## Prerequisites

- `opencode` binary on `$PATH`
- Set `OPENCODE_E2E=1` to enable (tests are skipped otherwise)
- Kasper plugin symlinked at `~/.config/opencode/plugins/opencode-kasper.ts`
- Tests use `--dangerously-skip-permissions` and free-tier models

## How It Works

### Tool / subagent call tests (NDJSON)

Tests parse the `opencode run --format json` stdout (newline-delimited JSON) to verify:

1. **Tool calls**: `type: "tool_use"` events with `part.tool` indicate tool usage
2. **Subagent calls**: `part.tool: "task"` events indicate subagent spawning
3. **Text output**: `type: "text"` events confirm the agent produced text

No server needed — `opencode run` exits after completion and stdout contains all events.

### Serve-based tests

For subagent session list verification, tests start `opencode serve` in the
background and query `GET /api/session` to find child sessions (sessions with
a `parentID`).

## Running

```bash
OPENCODE_E2E=1 bun test tests/e2e/
```

Or via npm script:

```bash
OPENCODE_E2E=1 npm run test:e2e
```

## Test Scenarios

| Test | What it verifies |
|------|-----------------|
| Single bash tool call | `ls` produces `tool_use` event with `part.tool: "bash"`, completed status |
| Multiple tool calls | Multiple distinct tools used, text output produced |
| Subagent call (task tool) | Agent spawns subagent via `task` tool when prompted |
| Text-only conversation | Simple greeting produces text, no crash |
| Session identity | Session IDs have `ses_` prefix, consecutive runs get distinct IDs |
| Subagent sessions (serve) | Child sessions appear in `GET /api/session` with `parentID` |
| Kasper scoring | `state.json` populated with scored session (poll-based) |

## Known Limitations

- NDJSON approach cannot verify subagent session *content* — only that a `task` tool call was made. Use serve-based test for full subagent session detection.
- Kasper scoring test depends on LLM API availability and may fail if the API is down.
- Tool call counts and subagent call counts are NOT stored in `SessionRecord`/`ScoreCard` (only in `PendingEval`).
- `opencode run` exits before async evaluation poll completes, so the Kasper scoring test uses a separate wait loop.
