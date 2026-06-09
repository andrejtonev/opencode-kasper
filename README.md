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
- **Real-time Status** — `/kasper status` shows an In Progress banner with the current evaluation pass, weakness merge, and any pending improvements
- **Backups & Safety** — Timestamped backups before every change; atomic writes with file locks
- **Prompt Resolution** — Honours opencode's `agent.<name>.prompt` `{file:...}` and `{path:...}` directives; will not overwrite the wrong file

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
| `/kasper status [agent]` | Aggregate scores, top weaknesses, recent sessions, sparkline trend, and live In Progress banner |
| `/kasper score session <id>` | Evaluate a past session (`last N`, `since YYYY-MM-DD`, `range X Y`) |
| `/kasper improve [agent]` | Numbered table of improvement suggestions; pass `--dry-run` to preview without applying |
| `/kasper apply [n\|all]` | Apply pending improvement (`n` for an index, `all` for everything queued) |
| `/kasper history [agent]` | Session history with score breakdowns |
| `/kasper auto on\|off` | Toggle auto-apply for improvements in the current session |
| `/kasper migrate <name> [--show]` | Extract an inline `opencode.json` agent prompt to a file so kasper can edit it. With `--show`, just reports the current source |
| `/kasper reset` | Clear all state (prompts `/kasper reset --force` to confirm) |
| `/kasper help` | Show all commands |

## Tools

| Tool | Description |
|---|---|
| `kasper_status` | Aggregate scores, per-agent breakdown, weaknesses |
| `kasper_improve` | Numbered improvement suggestions; supports `--dry-run` |
| `kasper_apply` | Apply by `[N]` index, or `all` |
| `kasper_history` | Adherence history and trends |
| `kasper_score_session` | Evaluate one or more sessions (single id, `last N`, `since YYYY-MM-DD`, `range X Y`) |
| `kasper_reset` | Clear all state |

## Configuration

Loaded from `~/.config/opencode/kasper.jsonc`, `.opencode/kasper.jsonc`, or the `kasper` key in `opencode.json`. Project values override global values; missing fields fall back to the defaults below.

### Core

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Master switch. Set to `false` to disable the plugin without uninstalling |
| `auto_update` | boolean | `true` | Auto-apply improvements to `AGENTS.md` / agent prompts. Set to `false` to require `/kasper apply` for every change |
| `scoring_threshold` | number (0.0–1.0) | `0.6` | Sessions scoring strictly below this trigger weakness detection and improvement suggestions |
| `model` | string | `opencode/deepseek-v4-flash-free` | Provider/model used as the LLM judge. Pick a fast, cheap model |
| `detail_level` | `minimal` \| `standard` \| `thorough` | `standard` | How much context the judge sees. `minimal` is cheapest, `thorough` is most accurate |

### Evaluation

| Field | Type | Default | Description |
|---|---|---|---|
| `min_session_messages` | integer (1–50) | `1` | Skip sessions with fewer than this many user messages |
| `min_observations_for_update` | integer (1–10) | `2` | A weakness must be observed at least this many times before an improvement is generated |
| `weakness_decay_days` | integer (0–365) | `30` | After this many days without recurrence, weaknesses are forgotten. `0` disables decay |
| `evaluation_poll_interval_ms` | integer (1000–300000) | `10000` | How often the background loop scans for idle sessions |
| `quiet` | boolean | `false` | Suppress non-warning toast notifications |

### Scoring robustness

| Field | Type | Default | Description |
|---|---|---|---|
| `scoring_retries` | integer (0–10) | `2` | Retries when the scoring model returns invalid JSON |
| `scoring_timeout_ms` | integer (10000–600000) | `120000` | Per-attempt timeout for the scoring model call |
| `max_score_input_chars` | integer (1000–50000) | `10000` | Cap on input sent to the scoring model per session |
| `max_agent_guidance_chars` | integer (200–5000) | `1200` | Cap on the size of each generated improvement (`AGENTS.md` or per-agent) |
| `improvement_expiry_days` | integer (0–365) | `60` | Inactive improvements are pruned after this many days. `0` = never expire |

### Safety

| Field | Type | Default | Description |
|---|---|---|---|
| `strict_sanitize` | boolean | `true` | Reject generated improvements containing URLs, code blocks, or instruction-injection markers |
| `agent_prompt_inject_mode` | `section` \| `inline` | `section` | How kasper writes improvements into an agent prompt file. `section` adds a visible `## Kasper Inferred Instructions` block at the end. `inline` appends the guidance directly with no section header — wrapped only in `<!-- kasper-injected:begin/end -->` HTML comments for dedupe and rollback. AGENTS.md injection is always `section` style |
| `debug` | boolean | `false` | Log SDK events and extra diagnostics. Disable in production |

### Storage

| Field | Type | Default | Description |
|---|---|---|---|
| `state_dir` | string | `.opencode/kasper` (relative to cwd) | Where session scores, state, and backups are written. Absolute path or project-relative |

### Example

```jsonc
{
  "enabled": true,
  "auto_update": true,
  "scoring_threshold": 0.65,
  "model": "opencode/minimax-m2.5-free",
  "min_observations_for_update": 3,
  "quiet": true,
  "state_dir": "/var/lib/kasper"
}
```

## Agent Prompt Resolution

Kasper follows opencode's own agent resolution rules when deciding **where** to read and write an agent's prompt. For an agent named `<name>`:

1. **Project `opencode.json`** — if `agent.<name>.prompt` is defined, that wins. Project config overrides global config.
2. **Global `opencode.json`** — used if no project entry exists.
3. **Convention** — if no `agent.<name>` is defined in either config, kasper falls back to:
   - `<projectRoot>/.opencode/agent/<name>.md`
   - `<projectRoot>/.opencode/agents/<name>.md`
   - `~/.config/opencode/agent/<name>.md`
   - `~/.config/opencode/agents/<name>.md`

The `prompt` value is interpreted in three ways:

- **Raw string** — the prompt is inline. Kasper refuses to edit it; run `/kasper migrate <name>` to extract it to a file.
- **`{file:/abs/path/to/prompt.md}`** — the prompt is loaded from that file. Kasper reads and writes that exact file. `~` is expanded; relative paths resolve against the config file's directory.
- **`{path:/abs/path/to/prompt.md}`** — alias for `{file:...}`.

After `migrate`, the source `opencode.json` is rewritten to replace the inline `prompt` with a `{file:...}` directive, with comments and formatting preserved. **Restart opencode** for the new prompt file to take effect.

> **Why this matters:** before this resolution existed, kasper would silently create an empty `<projectRoot>/.opencode/agents/<name>.md` whenever the real prompt was defined via `{file:...}` — the only signal that anything happened was a stray stub file with the injected section. The resolver eliminates that class of bug entirely.

### Injection style

How kasper writes an improvement into the resolved prompt file is controlled by `agent_prompt_inject_mode`:

- **`section`** (default) — appends a clearly labelled block:
  ```markdown
  ## Kasper Inferred Instructions
  <!-- kasper: 2026-06-08T12:00:00.000Z -->
  <guidance>
  ```
  Self-documenting, easy to spot in a diff, easy to roll back via `/kasper rollback <agent>`.
- **`inline`** — appends the guidance directly at the end of the file with no section header:
  ```markdown
  <!-- kasper-injected:begin -->
  <guidance>
  <!-- kasper-injected:end -->
  ```
  The HTML comments exist only for dedupe and rollback bookkeeping — they render as nothing in the prompt. Use this when the visible `## Kasper Inferred Instructions` heading is unwanted (e.g. you have a strict prompt structure that you don't want kasper touching).

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

1. **Observe** — Hooks on `chat.message` and `session.created` accumulate session data; configurable polling catches idle sessions
2. **Evaluate** — LLM-as-judge scores each session across 5 dimensions; large sessions split into per-pair evaluation
3. **Improve** — Recurring weaknesses trigger suggestions (`AGENTS.md` or per-agent prompt); auto-applied or queued for review
4. **Measure** — Score delta tracking shows before/after improvement impact in `/kasper history`

The `/kasper status` In Progress banner surfaces what's happening right now: paused state, the active evaluation pass (with elapsed time and queued session count), the cross-session weakness merge LLM call, and any pending improvements waiting for the next auto-update tick.

### Limitations

- **Forward-looking only.** Only sessions created after plugin start are auto-scored. Use `/kasper score session last <N>` for retroactive batch scoring.
- **Current config only.** Scoring uses today's `AGENTS.md` and prompts, not the versions active when the session originally ran.
- **Subagents.** Subagent sessions are always eligible for auto-scoring. A subagent session needs only 1 user message to be picked up (primary sessions use `min_session_messages`). The result is rolled up into the parent agent's per-agent stats.

## Development

```bash
bun install            # Install dependencies
bun run build          # Compile TypeScript
bun run typecheck      # Type-check only
bun run lint           # Lint with biome
bun test               # 393 unit tests (387 pass, 6 skip)
bun run test:e2e       # End-to-end tests (requires OPENCODE_E2E=1 and the opencode binary)
```

## License

MIT — see [LICENSE](LICENSE).
