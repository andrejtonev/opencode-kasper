import type { AgentPromptManager } from "./agent-prompts.js"
import type { AgentsMdManager } from "./agents-md.js"
import type { KasperLogger } from "./logging.js"
import type { AsyncMutex } from "./mutex.js"
import type { Scorer } from "./scorer.js"
import type { KasperStateStore } from "./state.js"

export interface KasperConfig {
  enabled: boolean
  auto_update: boolean
  scoring_threshold: number
  model: string
  weakness_decay_days: number
  detail_level: "minimal" | "standard" | "thorough"
  quiet: boolean
  evaluate_subagents: boolean
  min_session_messages: number
  debug: boolean
  state_dir: string
  evaluation_poll_interval_ms: number
  scoring_retries: number
  scoring_timeout_ms: number
  max_score_input_chars: number
}

export const DEFAULT_CONFIG: KasperConfig = {
  enabled: true,
  auto_update: true,
  scoring_threshold: 0.6,
  model: "opencode/deepseek-v4-flash-free",
  weakness_decay_days: 30,
  detail_level: "standard",
  quiet: false,
  evaluate_subagents: false,
  min_session_messages: 3,
  debug: false,
  state_dir: "",
  evaluation_poll_interval_ms: 10000,
  scoring_retries: 2,
  scoring_timeout_ms: 120000,
  max_score_input_chars: 10000,
}

export interface ScoreCard {
  session_id: string
  message_id?: string
  timestamp: number
  overall_score: number
  categories: ScoreCategories
  strengths: string[]
  weaknesses: string[]
  suggested_agents_md_update?: string
  suggested_agent_prompt_update?: string
  weakness_suggestions?: WeaknessSuggestion[]
  fallback?: boolean
  scoring_prompt_hash?: string
  agent_prompt_hash?: string
  agents_md_hash?: string
}

export interface ScoreCategories {
  instruction_following: number
  completeness: number
  proactiveness: number
  code_quality: number
  communication: number
}

export interface WeaknessSuggestion {
  weakness: string
  suggested_fix: string
  target: "agents_md" | "agent_prompt"
}

export interface WeaknessPattern {
  pattern: string
  count: number
  suggested_fix: string
  agent_name?: string
  target?: "agents_md" | "agent_prompt"
}

export interface KasperRunningData {
  weakness_freq: Record<string, number>
  strength_freq: Record<string, number>
  running_count: number
  running_sum: number
  by_agent: Record<
    string,
    {
      count: number
      sum: number
      weakness_freq: Record<string, number>
      strength_freq: Record<string, number>
    }
  >
}

export interface KasperState {
  version: number
  sessions: Record<string, SessionRecord>
  evaluated_sessions: string[]
  aggregate: AggregateStats
  improvements_applied: ImprovementRecord[]
  config: KasperConfig
  rejected_patterns: string[]
  installed_at?: number
  _running?: KasperRunningData
}

export interface PerAgentStats {
  total_sessions: number
  avg_score: number
  top_weaknesses: WeaknessPattern[]
  top_strengths: string[]
}

export interface SessionRecord {
  title: string
  agent_name?: string
  agent_type?: "primary" | "subagent"
  parent_session_id?: string
  score: number
  score_card: ScoreCard
  weaknesses: string[]
  timestamp: number
  agent_prompt_hash?: string
  agents_md_hash?: string
  last_msg_id?: string
  last_updated_at?: number
}

export interface AggregateStats {
  total_sessions: number
  avg_score: number
  top_weaknesses: WeaknessPattern[]
  top_strengths: string[]
  by_agent: Record<string, PerAgentStats>
}

export interface ImprovementRecord {
  id: string
  timestamp: number
  target: "agents_md" | "agent_prompt"
  agent_name?: string
  agents_md_diff: string
  reason: string
  backup_path: string
  score_before?: number
  outcome_score_delta?: number
  weaknesses?: string[]
}

export interface BackupEntry {
  path: string
  timestamp: number
  label: string
}

export interface AgentPromptEntry {
  type: "markdown_file" | "json_config"
  path: string
  content: string
}

export interface ToolCallRecord {
  tool: string
  args: string
  result: string
}

export interface SubagentCallRecord {
  agent: string
  input?: string
}

export interface OpencodeSessionClient {
  session: {
    create(opts: {
      body?: { title?: string; parentID?: string }
      query?: { directory?: string }
    }): Promise<{ data?: { id?: string } }>
    prompt(opts: {
      path: { id: string }
      body?: {
        parts: Array<{ type: string; text?: string }>
        model?: { providerID: string; modelID: string }
        agent?: string
        format?: { type: string; schema?: Record<string, unknown> }
      }
    }): Promise<{
      data?: {
        info?: { id?: string; role?: string; sessionID?: string }
        parts?: Array<{ type: string; text?: string }>
      }
    }>
    delete(opts: { path: { id: string } }): Promise<unknown>
    messages?(opts: {
      path: { id: string }
      query?: { directory?: string }
    }): Promise<{
      data?: Array<{
        info?: { id: string; role: string; sessionID: string }
        parts?: Array<{ type: string; text?: string }>
      }>
    }>
    list?(opts?: { query?: { directory?: string } }): Promise<{
      data?: Array<{
        id: string
        title: string
        agent?: string
        agentName?: string
        subagent_type?: string
        parentID?: string
        time: { created: number; updated: number }
      }>
    }>
    get?(opts: {
      path: { id: string }
      query?: { directory?: string }
    }): Promise<{
      data?: {
        id: string
        title: string
        parentID?: string
        time: { created: number; updated: number }
      }
    }>
  }
  app?: {
    agents(): Promise<unknown>
    log?(opts: {
      body: {
        service: string
        level: "debug" | "info" | "warn" | "error"
        message: string
        extra?: Record<string, unknown>
      }
    }): Promise<unknown>
  }
  config?: {
    get(): Promise<Record<string, unknown>>
  }
  tui?: {
    showToast?(opts: unknown): Promise<unknown>
  }
}

export interface EvalPair {
  userInstruction: string
  agentResponse: string
  toolCalls: ToolCallRecord[]
  subagentCalls: SubagentCallRecord[]
}

export interface PendingEval {
  sessionID: string
  agentName?: string
  agentType?: "primary" | "subagent"
  parentSessionID?: string
  userInstruction: string
  agentResponseParts: string[]
  toolCalls: ToolCallRecord[]
  subagentCalls: SubagentCallRecord[]
  compacted: boolean
  agentsMdHash?: string
  createdAt: number
  pairs: EvalPair[]
  lastMessageId?: string
  existingWeaknesses?: string[]
}

export interface AgentSessionInfo {
  agentName: string
  agentType: "primary" | "subagent"
  parentSessionID?: string
}

export interface KasperConfigContext {
  config: KasperConfig
  autoUpdateEnabled: boolean
  kasperPaused: boolean
}

export interface KasperStateContext {
  stateStore: KasperStateStore
  sessionsEvaluated: Set<string>
  deletedSessions: Set<string>
  kasperSessionIDs: Set<string>
  sessionMsgCount: Map<string, number>
  agentSessionIDs: Map<string, string[]>
}

export interface KasperAgentContext {
  agentRegistry: Map<string, AgentSessionInfo>
  parentToChildren: Map<string, Set<string>>
  sessionParents: Map<string, string>
}

export interface KasperScoringContext {
  scorer: Scorer
  evalMutex: AsyncMutex
  evaluationRunning: boolean
  evaluationStartedAt: number | undefined
  isMergingWeaknesses: boolean
  improvementsPending: ImprovementRecord[]
}

export interface KasperPluginContext {
  pluginStartTime: number
  lastActiveSessionID?: string
  evaluationPollTimer?: ReturnType<typeof setInterval>
  configReloadTimer?: ReturnType<typeof setInterval>
}

export interface KasperUserContext {
  userGuidance: Map<string, string>
  rejectedPatterns: Set<string>
  registeredCommands: Set<string>
}

export interface KasperClientContext {
  client: OpencodeSessionClient
  logger: KasperLogger
  agentsMd: AgentsMdManager
  agentPrompts: AgentPromptManager
}

export interface KasperContext
  extends KasperConfigContext,
    KasperStateContext,
    KasperAgentContext,
    KasperScoringContext,
    KasperPluginContext,
    KasperUserContext,
    KasperClientContext {
  idleSessions: Set<string>
}
