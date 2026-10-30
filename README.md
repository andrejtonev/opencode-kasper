# Kasper

Kasper is a plugin for [opencode](https://opencode.ai) that monitors agent sessions, scores adherence to user instructions via LLM-as-judge, and injects corrective instructions into `AGENTS.md` and per-agent prompt files.

> **Unofficial plugin:** This is an independent project and is not affiliated with, endorsed by, or maintained by the opencode team.

This checkout contains the V1/V2 migration work. Package publication is a separate
step; a registry install does not establish that these changes are published.
See [support and verified limitations](SUPPORT.md), [migration steps](MIGRATION.md),
and the [release checklist](RELEASE-CHECKLIST.md) before choosing a host profile.

## Features

- **LLM-as-Judge Scoring** — Evaluates eligible completed turns on 5 dimensions: instruction following, completeness, proactiveness, code quality, and communication
- **Automatic Improvements** — Detects recurring weaknesses and injects fixes into `AGENTS.md` or per-agent prompts (auto or manual approval)
- **Idle-Aware Evaluation** — Sessions scored only when idle or complete, preventing partial-turn scoring
- **Per-Agent Scoring** — Separate aggregates and weakness profiles per agent
- **Batch & Retroactive Scoring** — Score past sessions via `/kasper score session <id>` or bulk with `last N`
- **Subagent Tracking** — Tracks subagent calls and evaluates child sessions independently
- **Real-time Status** — `/kasper status` shows an In Progress banner with the current evaluation pass, weakness merge, and any pending improvements
- **Backups & Safety** — Standard apply paths preserve source receipts and before-byte backups, with conflict-checked rollback and guarded atomic writes
- **Prompt Resolution** — Supported V1 file directives and native V2 explicit provenance opt-ins; unknown native origins remain read-only

## Installation

### Legacy V1 profile

For this unpublished migration checkout, use the packed local installation in
[MIGRATION.md](MIGRATION.md). Once the desired release is verified in the registry,
install it and register its package name in your project `opencode.json`:

```bash
npm install @atonev/opencode-kasper
```

The packaged dual server
entry supplies V1's legacy function and V2's Effect setup; production package
loading was verified on V1 host 1.18.23:

```json
{
  "plugin": ["@atonev/opencode-kasper"]
}
```

That's the entire plugin registration — there are no plugin-level options to pass on the `plugin` line. All kasper configuration (auto-update, model, thresholds, etc.) lives in a separate file, described in [Configuration](#configuration) below.

**Verify:** Start a session and run `/kasper status`.

### Native V2 profile

Native V2 uses the pinned `@opencode/plugin` 2.2.2 contracts and the package's
separate `./server` export. Its configuration uses plural `plugins`, while V1
uses singular `plugin`. The [migration guide](MIGRATION.md) records the packaged
local installation, qualified host evidence and native options. Do not register an
invented package `/v2` subpath or use the older REST SDK `/v2` entry as a plugin API.

## Commands

| Command | Description |
|---|---|
| `/kasper status [agent]` | Aggregate scores, top weaknesses, recent sessions, sparkline trend, and live In Progress banner |
| `/kasper score session <id>` | Evaluate a past session (`last N`, `since YYYY-MM-DD`, `range X Y`) |
| `/kasper improve [agent]` | Numbered table of improvement suggestions; pass `--dry-run` to preview without applying |
| `/kasper apply [n\|all]` | Apply pending improvement (`n` for an index, `all` for everything queued) |
| `/kasper history [agent]` | Session history with score breakdowns |
| `/kasper auto on\|off` | Toggle auto-apply for the current host instance |
| `/kasper migrate <name> [--show]` | V1 inline-prompt extraction; `--show` reports the source. Native migration is unsupported |
| `/kasper reset` | Clear all state (prompts `/kasper reset --force` to confirm) |
| `/kasper help` | Show all commands |

## Tools

Native V2 exposes `kasper_control({action, arg?})` for the direct action boundary.
V1 retains the individual tools below plus `kasper_control`; V1 slash commands
use the supported model/tool flow. Native also provides `/kasper config`,
`/kasper pause`, and `/kasper resume` through direct commands.

| Tool | Description |
|---|---|
| `kasper_control` | Execute a supported action with optional text arguments; native command results are session/location-correlated receipts |
| `kasper_status` | Aggregate scores, per-agent breakdown, weaknesses |
| `kasper_improve` | Numbered improvement suggestions; supports `--dry-run` |
| `kasper_apply` | Apply by `[N]` index, or `all` |
| `kasper_history` | Adherence history and trends |
| `kasper_score_session` | Evaluate one or more sessions (single id, `last N`, `since YYYY-MM-DD`, `range X Y`) |
| `kasper_reset` | Clear all state |

## Configuration

Use a standalone `kasper.jsonc` or `kasper.json`. V1 also accepts a legacy `kasper`
key in the invoking directory's `opencode.json`/`opencode.jsonc`; that legacy key
is applied last and overrides standalone values. Remove it when moving to native
V2, whose host schema and plugin options are separate. Missing fields use the
defaults below. See [configuration precedence](MIGRATION.md#configuration).

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
| `scoring_retries` | integer (0–10) | `2` | Retries completed invalid judge output; unknown transport outcomes are not retried |
| `scoring_timeout_ms` | integer (10000–600000) | `120000` | Per-attempt control deadline; V1 can continue awaiting underlying settlement |
| `max_score_input_chars` | integer (1000–50000) | `10000` | Cap on input sent to the scoring model per session |
| `max_agent_guidance_chars` | integer (200–5000) | `1200` | Cap on the size of each generated improvement (`AGENTS.md` or per-agent) |
| `improvement_expiry_days` | integer (0–365) | `60` | Active improvement metadata retention. Expiry does not remove previously written guidance; use an explicit reviewed rollback. `0` disables expiry |

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

`.opencode/kasper.jsonc` (project-local, supported by both profiles, with JSONC comments):

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

For V1 only, a legacy nested `kasper` key in `opencode.json` is also accepted:

```json
{
  "plugin": ["@atonev/opencode-kasper"],
  "kasper": {
    "auto_update": true,
    "scoring_threshold": 0.65,
    "model": "opencode/minimax-m2.5-free"
  }
}
```

Within each directory `kasper.jsonc` is preferred to `kasper.json`. Standalone
project values override global values; V1's legacy nested `kasper` key overrides
both. The global search honors `XDG_CONFIG_HOME` and Windows fallback locations.

## Agent Prompt Resolution

This section describes the **V1 resolver**. Native V2 reads effective catalog
system text and authoritative layered configuration entries. Editing requires
an explicit source identity or an owned append overlay; unknown or transformed
origins remain read-only. Native V2 combines applicable AGENTS.md sources and
does not use CLAUDE.md fallback. See [native source policy](SUPPORT.md#instructions-and-recovery).

Kasper follows opencode's own agent resolution rules when deciding **where** to read and write an agent's prompt. For an agent named `<name>`:

1. **Project `opencode.json`** — if `agent.<name>.prompt` is defined, that wins. Project config overrides global config.
2. **Global `opencode.json`** — used if no project entry exists.
3. **Convention** — if no `agent.<name>` is defined in either config, kasper falls back to:
   - `<projectRoot>/.opencode/agent/<name>.md`
   - `<projectRoot>/.opencode/agents/<name>.md`
   - `~/.config/opencode/agent/<name>.md`
   - `~/.config/opencode/agents/<name>.md`

The `prompt` value is interpreted in four ways:

- **Raw string** — the prompt is inline. Kasper refuses to edit it; run `/kasper migrate <name>` to extract it to a file.
- **`{file:/abs/path/to/prompt.md}`** — the prompt is loaded from that file. Kasper reads and writes that exact file. `~` is expanded; relative paths resolve against the config file's directory.
- **`{path:/abs/path/to/prompt.md}`** — alias for `{file:...}`.

Plugin override files (`.opencode/<plugin>.json`, e.g. `oh-my-openagent.json`) accept one additional form:

- **`file:///abs/path/to/prompt.md`** — a `file://` URI. Kasper reads and writes the file at that path. `~/...` URIs resolve to `$HOME`. This is the form used by [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) and similar plugins that ship agent prompts in `node_modules` and let users redirect them via a plugin-specific config. **Note:** `file://` URIs in `opencode.json` itself (not in a plugin override file) are not classified as a `file_uri` source — they fall through to inline. Put plugin redirects in a plugin override file.

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
  Self-documenting and easy to review in a diff. Rollback uses the recorded source
  receipt; V1 does not register a `/kasper rollback` command. See [recovery](SUPPORT.md#instructions-and-recovery).
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

The V1 hook flow is below. Native V2 uses scoped Effect services, explicit archive
and instruction coverage, and direct command receipts described in [SUPPORT.md](SUPPORT.md).

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
bun install --frozen-lockfile # Install pinned dependencies
bun run build          # Compile TypeScript
bun run typecheck      # Type-check only
bun run lint           # Lint with biome
bun test               # Offline suite; opt-in native/provider tests are skipped
bun run test:e2e       # End-to-end tests (requires OPENCODE_E2E=1 and the opencode binary)
```

## License

MIT — see [LICENSE](LICENSE).
