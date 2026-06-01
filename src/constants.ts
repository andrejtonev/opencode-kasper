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
export const LOG_MAX_LINES = 300
export const MAX_HISTORY = 100
export const MIN_OBSERVATIONS_FOR_UPDATE = 2

// Weakness pattern matching thresholds
export const WEAKNESS_SIMILARITY_THRESHOLD = 0.5
export const WEAKNESS_SUBSTRING_SCORE = 0.85
export const WEAKNESS_EXACT_WORD_OVERLAP_THRESHOLD = 0.7
export const WEAKNESS_LEVENSHTEIN_THRESHOLD = 0.8
