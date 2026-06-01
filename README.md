# Kasper

Kasper is a plugin for [opencode](https://opencode.ai) that monitors agent sessions, scores adherence to user instructions via LLM-as-judge, and injects corrective instructions into `AGENTS.md` and per-agent prompt files.

> **Unofficial plugin:** This is an independent project and is not affiliated with, endorsed by, or maintained by the opencode team.

## Features

- **LLM-as-Judge Scoring** — Evaluates every session on 5 dimensions: instruction following, completeness, proactiveness, code quality, and communication
- **Automatic Improvements** — Detects recurring weaknesses and injects fixes into `AGENTS.md` or per-agent prompts (auto or manual approval)
- **Idle-Aware Evaluation** — Sessions scored only when idle or complete, preventing partial-turn scoring
- **Per-Agent Scoring** — Separate aggregates and weakness profiles per agent
- **Batch & Retroactive Scoring** — Score past sessions via `/kasper score session <id>` or bulk with `last N`
- **Subagent Tracking** — Tracks subagent calls and evaluates child sessions independently
- **Compaction Feedback** — Top weaknesses injected into session compaction for ongoing agent awareness
- **Backups & Safety** — Timestamped backups before every change; atomic writes with file locks

## Installation

```bash
npm install @atonev/opencode-kasper
```

Add to your opencode config:

```json
{
  "plugin": ["@atonev/opencode-kasper"]
}
```

With options:

```json
{
  "plugin": [
    ["@atonev/opencode-kasper", { "auto_update": true }]
  ]
}
```

**Verify:** Start a session and run `/kasper status`.

## Commands

| Command | Description |
|---|---|
| `/kasper status [agent]` | Aggregate scores, top weaknesses, recent sessions, sparkline trend |
| `/kasper score session <id>` | Evaluate a past session (`last N`, `since YYYY-MM-DD`, `range X Y`) |
| `/kasper improve [agent]` | Numbered table of improvement suggestions |
| `/kasper apply [n\|all]` | Apply pending improvement |
| `/kasper history [agent]` | Session history with score breakdowns |
| `/kasper auto on\|off` | Toggle auto-apply for improvements |
| `/kasper config` | Display current configuration |
| `/kasper reset` | Clear all state |
| `/kasper help` | Show all commands |

## Tools

| Tool | Description |
|---|---|
| `kasper_status` | Aggregate scores, per-agent breakdown, weaknesses |
| `kasper_improve` | Numbered improvement suggestions |
| `kasper_apply` | Apply by `[N]` index |
| `kasper_history` | Adherence history and trends |
| `kasper_score_session` | Evaluate one or more sessions |
| `kasper_reset` | Clear all state |

## Configuration

Loaded from `~/.config/opencode/kasper.jsonc`, `.opencode/kasper.jsonc`, or the `kasper` key in `opencode.json`.

```jsonc
{
  "enabled": true,
  "auto_update": true,              // Auto-apply improvements
  "scoring_threshold": 0.6,         // Score below this triggers suggestions
  "model": "opencode/deepseek-v4-flash-free",
  "weakness_decay_days": 30,
  "detail_level": "standard",       // minimal | standard | thorough
  "quiet": false,
  "evaluate_subagents": false,
  "min_session_messages": 3,
  "debug": false,
  "state_dir": "",                  // Custom state directory
  "evaluation_poll_interval_ms": 10000,
  "scoring_retries": 2,
  "scoring_timeout_ms": 120000,
  "max_score_input_chars": 10000
}
```

## Scoring

Each session is scored 0.0–1.0 across five dimensions:

| Dimension | Description |
|---|---|
| `instruction_following` | Did the agent do exactly what was asked? |
| `completeness` | Did the agent fully complete the task? |
| `proactiveness` | Did the agent act appropriately? |
| `code_quality` | Quality and maintainability of code produced |
| `communication` | Clarity and helpfulness of explanations |

Scores display as 🟢 ≥80%, 🟡 ≥60%, 🔴 <60%. The `/kasper status` command shows an ASCII sparkline of the last 7 session scores.

## How It Works

1. **Observe** — Hooks on `chat.message` and `session.created` accumulate session data; 10s polling catches idle sessions
2. **Evaluate** — LLM-as-judge scores each session across 5 dimensions; large sessions split into per-pair evaluation
3. **Improve** — Recurring weaknesses trigger suggestions (AGENTS.md or per-agent prompt); auto-applied or queued for review
4. **Measure** — Score delta tracking shows before/after improvement impact in `/kasper history`

### Limitations

- **Forward-looking only.** Only sessions created after plugin start are auto-scored. Use `/kasper score session last <N>` for retroactive batch scoring.
- **Current config only.** Scoring uses today's AGENTS.md and prompts, not the versions active when the session originally ran.
- **Subagents.** Auto-scoring of subagent sessions is controlled by `evaluate_subagents` (default: `false`). Child sessions are evaluated during manual `score session`.

## Development

```bash
bun install       # Install dependencies
bun run build     # Compile TypeScript
bun run typecheck # Type-check only
bun test          # 308 tests, all passing
```

## License

MIT — see [LICENSE](LICENSE).
