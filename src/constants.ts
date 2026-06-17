export const SESSION_DEBOUNCE_MS = 2000
export const CONFIG_POLL_INTERVAL_MS = 5000
export const MAX_EVALUATED_SESSION_SET = 2000
export const MAX_TRACKED_DELETED_IDS = 2000
export const MAX_AGENT_SESSION_IDS = 50
export const MAX_SESSION_PARENTS = 1000
export const PARENT_CLEANUP_BATCH = 500

export const MAX_USER_INSTRUCTION_CHARS = 5000
export const MAX_MESSAGE_CHARS = 10000
export const MAX_MESSAGE_PARTS = 50
export const MAX_TOOL_CALLS_STORED = 100
export const MAX_TOOL_CALLS_EVAL = 25
export const MAX_PENDING_IMPROVEMENTS = 100

export const MAX_EVALUATED_SESSIONS_STORED = 5000
export const MAX_REJECTED_PATTERNS = 100
export const MAX_WEAKNESSES_FOR_MERGE = 20
export const MAX_EVAL_DURATION_MS = 600_000
export const SDK_TIMEOUT_MS = 30_000
export const TOP_WEAKNESSES_COUNT = 5
export const TOP_STRENGTHS_COUNT = 5

// Hardcoded internal values (previously configurable, now fixed for simplicity)
export const BACKUP_ENABLED = true
export const BACKUP_MAX_VERSIONS = 20
// 5000 lines is large enough to retain the full scoring lifecycle for a few
// dozen consecutive evaluations (a typical one-shot evaluation logs ~50-80
// entries including the diagnostic test in debug mode). 300 was too small:
// the trim would discard the early lifecycle events (run_eval_start,
// scoring_session_created, scoring_prompt_sending) and the e2e tests that
// assert those events were logged would intermittently fail. 5000 still
// bounds the log so a long-lived session doesn't grow without limit.
export const LOG_MAX_LINES = 5000
export const MAX_HISTORY = 100

// Default for the configurable `min_observations_for_update` field
// (KasperConfig / DEFAULT_CONFIG in src/types.ts). Exported for
// symmetry with the other tunable defaults, but the runtime gate at
// src/evaluate.ts:1679 reads `config.min_observations_for_update`,
// NOT this constant. Tests reference this name in comments but the
// import site is zero. Kept here so a future "reset to default" path
// has a single source of truth.
export const MIN_OBSERVATIONS_FOR_UPDATE = 2

// Built-in opencode agent names per https://opencode.ai/docs/agents.
// Primary: build, plan. Subagents: general, explore, scout. Hidden system: compaction, title, summary.
// These agents have hard-coded prompts shipped with opencode. The markdown file
// at `.opencode/agents/<name>.md` is only loaded if the user explicitly sets
// `agent.<name>.prompt` in `opencode.json` to `{file:...}` or to an inline
// string — a bare file at the conventional path is NOT consulted. Kasper must
// therefore avoid creating dead `.opencode/agents/<name>.md` files for these
// agents; if the agent has no defined prompt, improvements are rerouted to
// AGENTS.md (the rule file the built-in agents actually read).
export const BUILTIN_AGENT_NAMES: ReadonlySet<string> = new Set([
  "build",
  "plan",
  "general",
  "explore",
  "scout",
  "compaction",
  "title",
  "summary",
])

export function isBuiltinAgentName(name: string): boolean {
  return BUILTIN_AGENT_NAMES.has(name)
}

// Weakness pattern matching thresholds
export const WEAKNESS_SIMILARITY_THRESHOLD = 0.5
export const WEAKNESS_SUBSTRING_SCORE = 0.85
export const WEAKNESS_EXACT_WORD_OVERLAP_THRESHOLD = 0.7
export const WEAKNESS_LEVENSHTEIN_THRESHOLD = 0.8
