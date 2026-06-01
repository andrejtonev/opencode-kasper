import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import {
  MAX_EVALUATED_SESSION_SET,
  MAX_EVALUATED_SESSIONS_STORED,
  MAX_HISTORY,
  MAX_REJECTED_PATTERNS,
  TOP_STRENGTHS_COUNT,
  TOP_WEAKNESSES_COUNT,
  WEAKNESS_SIMILARITY_THRESHOLD,
} from "./constants.js"
import { acquireLock } from "./lock.js"
import type { KasperLogger } from "./logging.js"
import { writeTextAtomic } from "./prompt-utils.js"
import type { Scorer } from "./scorer.js"
import type {
  ImprovementRecord,
  KasperConfig,
  KasperState,
  OpencodeSessionClient,
  PerAgentStats,
  ScoreCard,
  SessionRecord,
  WeaknessPattern,
} from "./types.js"
import { DEFAULT_CONFIG } from "./types.js"
import { weaknessSimilarity } from "./utils.js"

interface AgentRunningStats {
  sum: number
  count: number
  weaknessFreq: Map<string, number>
  strengthFreq: Map<string, number>
}

function defaultState(config: KasperConfig): KasperState {
  return {
    version: 1,
    sessions: {},
    evaluated_sessions: [],
    aggregate: {
      total_sessions: 0,
      avg_score: 0,
      top_weaknesses: [],
      top_strengths: [],
      by_agent: {},
    },
    improvements_applied: [],
    config,
    rejected_patterns: [],
  }
}

export function computeStats(
  entries: Array<{ score: number; score_card: ScoreCard; timestamp: number }>,
  decayDays = 0,
): PerAgentStats {
  const total = entries.length
  if (total === 0) {
    return {
      total_sessions: 0,
      avg_score: 0,
      top_weaknesses: [],
      top_strengths: [],
    }
  }

  const now = Date.now()
  const avg = entries.reduce((s, e) => s + e.score, 0) / total

  const weaknessMap = new Map<string, number>()
  const strengthMap = new Map<string, number>()

  for (const e of entries) {
    let weight = 1
    if (decayDays > 0) {
      const ageMs = now - e.timestamp
      const ageDays = ageMs / (1000 * 60 * 60 * 24)
      weight = 0.5 ** (ageDays / decayDays)
    }

    for (const w of e.score_card.weaknesses) {
      weaknessMap.set(w, (weaknessMap.get(w) ?? 0) + weight)
    }
    for (const s of e.score_card.strengths) {
      strengthMap.set(s, (strengthMap.get(s) ?? 0) + weight)
    }
  }

  const topWeak: WeaknessPattern[] = [...weaknessMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_WEAKNESSES_COUNT)
    .map(([pattern, count]) => ({
      pattern,
      count: Math.round(count),
      suggested_fix: "",
    }))

  return {
    total_sessions: total,
    avg_score: avg,
    top_weaknesses: topWeak,
    top_strengths: [...strengthMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_STRENGTHS_COUNT)
      .map(([s]) => s),
  }
}

export class KasperStateStore {
  private state: KasperState
  private dirty = false
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private flushingPromise: Promise<void> | null = null
  private version = 0
  private evaluatedSet = new Set<string>()
  private deltaScanCursor: string | undefined = undefined
  private runningSum = 0
  private runningCount = 0
  private weaknessFreq = new Map<string, number>()
  private strengthFreq = new Map<string, number>()
  private byAgentRunning = new Map<string, AgentRunningStats>()
  private weaknessCache = new Map<string, string>()
  private static readonly WEAKNESS_CACHE_MAX = 500
  private configDefaults: KasperConfig

  constructor(
    private statePath: string,
    private backupDir: string,
    config?: Partial<KasperConfig>,
    private logger?: KasperLogger,
  ) {
    this.configDefaults = { ...DEFAULT_CONFIG, ...config }
    this.state = defaultState(this.configDefaults)
  }

  async init(): Promise<void> {
    await mkdir(this.backupDir, { recursive: true })
    try {
      const raw = await readFile(this.statePath, "utf-8")
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        this.state = { ...defaultState(this.configDefaults), ...parsed }
        this.state.config = { ...this.configDefaults, ...parsed.config }
        if (parsed.aggregate) {
          this.state.aggregate = {
            ...this.state.aggregate,
            ...parsed.aggregate,
          }
        }
      }
      if (!this.state.aggregate.by_agent) {
        this.state.aggregate.by_agent = {}
      }
      if (!Array.isArray(this.state.rejected_patterns)) {
        this.state.rejected_patterns = []
      }
      if (!Array.isArray(this.state.evaluated_sessions)) {
        this.state.evaluated_sessions = []
      }
      for (const sid of this.state.evaluated_sessions) {
        this.evaluatedSet.add(sid)
      }
      if (!this.state.installed_at) {
        this.state.installed_at = Date.now()
        this.markDirty()
      }
      if (this.state._running) {
        const sessionCount = Object.keys(this.state.sessions).length
        if (this.state._running.running_count !== sessionCount) {
          this.buildRunningState()
        } else {
          this.restoreRunningState()
        }
      } else {
        this.buildRunningState()
      }
    } catch {
      this.dirty = true
      if (!this.state.installed_at) {
        this.state.installed_at = Date.now()
      }
      await this.flush()
    }
  }

  getConfig(): KasperConfig {
    return this.state.config
  }

  updateConfig(patch: Partial<KasperConfig>): void {
    this.state.config = { ...this.state.config, ...patch }
    this.markDirty()
  }

  recordSession(
    sessionId: string,
    title: string,
    card: ScoreCard,
    agentName?: string,
    agentType?: "primary" | "subagent",
    parentSessionId?: string,
    lastMsgId?: string,
    lastUpdatedAt?: number,
  ): void {
    const existing = this.state.sessions[sessionId]
    this.state.sessions[sessionId] = {
      title,
      agent_name: agentName,
      agent_type: agentType,
      parent_session_id: parentSessionId,
      score: card.overall_score,
      score_card: card,
      weaknesses: card.weaknesses,
      timestamp: card.timestamp,
      agent_prompt_hash: card.agent_prompt_hash,
      agents_md_hash: card.agents_md_hash,
      last_msg_id: lastMsgId,
      last_updated_at: lastUpdatedAt,
    }
    const removed = this.pruneHistory()
    if (existing) {
      this.decrementAggregate([existing])
    }
    this.incrementAggregate(this.state.sessions[sessionId])
    if (removed.length > 0) {
      this.decrementAggregate(removed)
    }
    this.computeAggregateFromRunning()
    this.populateSuggestedFixes(card, agentName)
    this.markDirty()
    if (
      this.logger &&
      (this.runningCount % 100 === 0 ||
        this.runningCount <= 2 ||
        removed.length > 0)
    ) {
      this.logger.log("state_record_session", {
        sessionId: sessionId.slice(0, 12),
        runningCount: this.runningCount,
        runningSum: Math.round(this.runningSum * 1000) / 1000,
        aggTotal: this.state.aggregate.total_sessions,
        aggAvg: Math.round(this.state.aggregate.avg_score * 1000) / 1000,
        sessionsSize: Object.keys(this.state.sessions).length,
        evaluatedSize: this.state.evaluated_sessions.length,
        pruned: removed.length,
        score: card.overall_score,
      })
    }
  }

  private populateSuggestedFixes(card: ScoreCard, agentName?: string): void {
    const populate = (weaknesses: WeaknessPattern[]) => {
      for (const w of weaknesses) {
        if (w.suggested_fix && w.target) continue

        const ws = card.weakness_suggestions?.find(
          (s) =>
            weaknessSimilarity(s.weakness, w.pattern) >=
            WEAKNESS_SIMILARITY_THRESHOLD,
        )

        if (ws) {
          w.suggested_fix = ws.suggested_fix
          w.target = ws.target
          if (!w.agent_name && agentName) w.agent_name = agentName
          if (card.session_id) {
            const entry = Object.values(this.state.sessions).find(
              (s) =>
                s.agent_name &&
                weaknessSimilarity(
                  s.score_card.weaknesses.join(" "),
                  w.pattern,
                ) >= WEAKNESS_SIMILARITY_THRESHOLD,
            )
            if (entry?.agent_name) w.agent_name = entry.agent_name
          }
          continue
        }

        if (w.suggested_fix) continue

        const suggestion =
          card.suggested_agents_md_update ?? card.suggested_agent_prompt_update

        if (suggestion) {
          for (const weakness of card.weaknesses) {
            if (
              weaknessSimilarity(weakness, w.pattern) >=
              WEAKNESS_SIMILARITY_THRESHOLD
            ) {
              w.suggested_fix = suggestion
              w.target = card.suggested_agents_md_update
                ? "agents_md"
                : "agent_prompt"
              break
            }
          }
        }

        if (!w.suggested_fix) {
          w.suggested_fix = `Prevent this issue: "${w.pattern}"`
        }
      }
    }

    populate(this.state.aggregate.top_weaknesses)

    if (agentName && this.state.aggregate.by_agent) {
      const agentAgg = this.state.aggregate.by_agent[agentName]
      if (agentAgg?.top_weaknesses) {
        populate(agentAgg.top_weaknesses)
      }
    }
  }

  recordImprovement(record: ImprovementRecord): void {
    this.state.improvements_applied.push(record)
    this.markDirty()
  }

  setImprovementDelta(id: string, delta: number): void {
    const imp = this.state.improvements_applied.find((i) => i.id === id)
    if (imp && imp.outcome_score_delta === undefined) {
      imp.outcome_score_delta = Math.round(delta * 1000) / 1000
      this.markDirty()
    }
  }

  getSession(sessionId: string): (SessionRecord & { id: string }) | undefined {
    const s = this.state.sessions[sessionId]
    return s ? { id: sessionId, ...s } : undefined
  }

  getRecentSessions(limit = 10): Array<{ id: string } & SessionRecord> {
    return Object.entries(this.state.sessions)
      .map(([id, s]) => ({ id, ...s }))
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit)
  }

  getAgentSessions(
    agentName: string,
    limit = 20,
  ): Array<{ id: string } & SessionRecord> {
    return Object.entries(this.state.sessions)
      .filter(([, s]) => s.agent_name === agentName)
      .map(([id, s]) => ({ id, ...s }))
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit)
  }

  getAggregate() {
    return this.state.aggregate
  }

  setTopWeaknesses(weaknesses: WeaknessPattern[]): void {
    this.state.aggregate.top_weaknesses = weaknesses
    this.markDirty()
  }

  private clearWeaknessCache(): void {
    this.weaknessCache.clear()
  }

  async mergeAllWeaknesses(
    scorer: Scorer,
    sessionClient: OpencodeSessionClient,
  ): Promise<void> {
    this.clearWeaknessCache()
    const globalWeaks: WeaknessPattern[] = [...this.weaknessFreq.entries()]
      .map(([pattern, count]) => ({ pattern, count, suggested_fix: "" }))
      .sort((a, b) => b.count - a.count)

    if (globalWeaks.length > 1) {
      const merged = await scorer.mergeWeaknesses(globalWeaks, sessionClient)
      if (merged.length > 0 && merged.length < globalWeaks.length) {
        const m = new Map(merged.map((w) => [w.pattern, w.count]))
        this.weaknessFreq = m
      }
    }

    let mergedAnyAgent = false
    for (const [_name, ars] of this.byAgentRunning) {
      const agentWeaks: WeaknessPattern[] = [...ars.weaknessFreq.entries()]
        .map(([pattern, count]) => ({ pattern, count, suggested_fix: "" }))
        .sort((a, b) => b.count - a.count)

      if (agentWeaks.length > 1) {
        const merged = await scorer.mergeWeaknesses(agentWeaks, sessionClient)
        if (merged.length > 0 && merged.length < agentWeaks.length) {
          ars.weaknessFreq = new Map(merged.map((w) => [w.pattern, w.count]))
          mergedAnyAgent = true
        }
      }
    }

    if (globalWeaks.length > 1 || mergedAnyAgent) {
      this.computeAggregateFromRunning()
      this.markDirty()
    }
  }

  getAgentAggregate(agentName: string): PerAgentStats | undefined {
    return this.state.aggregate.by_agent[agentName]
  }

  getImprovements() {
    return this.state.improvements_applied
  }

  getRejectedPatterns(): string[] {
    return this.state.rejected_patterns ?? []
  }

  getEvaluatedSessions(): string[] {
    return [...this.evaluatedSet]
  }

  addEvaluatedSession(sessionID: string): void {
    if (this.evaluatedSet.has(sessionID)) return
    this.evaluatedSet.add(sessionID)
    if (this.evaluatedSet.size > MAX_EVALUATED_SESSION_SET) {
      const toRemove = [...this.evaluatedSet].slice(
        0,
        this.evaluatedSet.size - MAX_EVALUATED_SESSION_SET,
      )
      for (const id of toRemove) this.evaluatedSet.delete(id)
    }
    this.markDirty()
  }

  removeEvaluatedSession(sessionID: string): void {
    this.evaluatedSet.delete(sessionID)
    this.markDirty()
  }

  getDeltaScanCursor(): string | undefined {
    return this.deltaScanCursor
  }

  setDeltaScanCursor(cursor: string | undefined): void {
    this.deltaScanCursor = cursor
  }

  addRejectedPattern(pattern: string): void {
    if (!this.state.rejected_patterns.includes(pattern)) {
      this.state.rejected_patterns.push(pattern)
      if (this.state.rejected_patterns.length > MAX_REJECTED_PATTERNS) {
        this.state.rejected_patterns = this.state.rejected_patterns.slice(
          -MAX_REJECTED_PATTERNS,
        )
      }
      this.markDirty()
    }
  }

  removeRejectedPattern(pattern: string): void {
    this.state.rejected_patterns = this.state.rejected_patterns.filter(
      (p) => p !== pattern,
    )
    this.markDirty()
  }

  resetWeaknessCounts(patterns: string[]): void {
    for (const pattern of patterns) {
      this.removeWeaknessFromMap(this.weaknessFreq, pattern)
      for (const [, ars] of this.byAgentRunning) {
        this.removeWeaknessFromMap(ars.weaknessFreq, pattern)
      }
    }
    this.computeAggregateFromRunning()
    this.markDirty()
  }

  private removeWeaknessFromMap(
    map: Map<string, number>,
    pattern: string,
  ): void {
    for (const [key] of map) {
      if (weaknessSimilarity(pattern, key) >= WEAKNESS_SIMILARITY_THRESHOLD) {
        map.delete(key)
      }
    }
  }

  getTotalSessions(): number {
    return Object.keys(this.state.sessions).length
  }

  getInstalledAt(): number {
    return this.state.installed_at ?? Date.now()
  }

  reloadConfig(config: KasperConfig): void {
    this.state.config = config
    this.markDirty()
  }

  async reset(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.flushingPromise) {
      try {
        await this.flushingPromise
      } catch {
        // flush error is non-fatal
      }
      this.flushingPromise = null
    }

    const installedAt = this.state.installed_at

    this.state.sessions = {}
    this.state.evaluated_sessions = []
    this.state.rejected_patterns = []
    this.state.improvements_applied = []
    delete this.state._running
    this.evaluatedSet.clear()
    this.deltaScanCursor = undefined
    this.runningSum = 0
    this.runningCount = 0
    this.weaknessFreq.clear()
    this.strengthFreq.clear()
    this.byAgentRunning.clear()
    this.clearWeaknessCache()
    this.state.aggregate = {
      total_sessions: 0,
      avg_score: 0,
      top_weaknesses: [],
      top_strengths: [],
      by_agent: {},
    }
    if (installedAt) {
      this.state.installed_at = installedAt
    }
    this.dirty = false

    try {
      await rm(this.statePath, { force: true })
      await writeFile(
        this.statePath,
        JSON.stringify(this.state, null, 2),
        "utf-8",
      )
    } catch {
      this.dirty = true
    }
  }

  async destroy(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    await this.flush()
  }

  private pruneHistory(): SessionRecord[] {
    const maxHistory = MAX_HISTORY
    const entries = Object.entries(this.state.sessions)
    if (entries.length <= maxHistory) return []

    const sorted = entries.sort((a, b) => a[1].timestamp - b[1].timestamp)
    const toRemove = sorted.slice(0, entries.length - maxHistory)
    const removed: SessionRecord[] = []
    for (const [id, session] of toRemove) {
      removed.push(session)
      delete this.state.sessions[id]
    }
    return removed
  }

  private mergeWeaknessIntoMap(
    map: Map<string, number>,
    weakness: string,
    delta: number,
  ): void {
    const cached = this.weaknessCache.get(weakness)
    if (cached && map.has(cached)) {
      map.set(cached, (map.get(cached) ?? 0) + delta)
      return
    }
    for (const [key] of map) {
      if (weaknessSimilarity(weakness, key) >= WEAKNESS_SIMILARITY_THRESHOLD) {
        this.weaknessCache.set(weakness, key)
        map.set(key, (map.get(key) ?? 0) + delta)
        return
      }
    }
    if (this.weaknessCache.size >= KasperStateStore.WEAKNESS_CACHE_MAX) {
      const toDelete = [...this.weaknessCache.keys()].slice(0, 250)
      for (const k of toDelete) this.weaknessCache.delete(k)
    }
    this.weaknessCache.set(weakness, weakness)
    map.set(weakness, (map.get(weakness) ?? 0) + delta)
  }

  private unmergeWeaknessFromMap(
    map: Map<string, number>,
    weakness: string,
  ): void {
    let bestKey: string | undefined
    let bestScore = 0
    for (const [key] of map) {
      const score = weaknessSimilarity(weakness, key)
      if (score > bestScore) {
        bestScore = score
        bestKey = key
      }
    }
    if (bestKey && bestScore >= WEAKNESS_SIMILARITY_THRESHOLD) {
      const c = (map.get(bestKey) ?? 0) - 1
      if (c <= 0) map.delete(bestKey)
      else map.set(bestKey, c)
    }
  }

  private buildRunningState(): void {
    this.runningSum = 0
    this.runningCount = 0
    this.weaknessFreq = new Map()
    this.strengthFreq = new Map()
    this.byAgentRunning = new Map()
    this.clearWeaknessCache()

    for (const session of Object.values(this.state.sessions)) {
      this.runningSum += session.score
      this.runningCount++
      for (const w of session.weaknesses) {
        this.mergeWeaknessIntoMap(this.weaknessFreq, w, 1)
      }
      for (const s of session.score_card.strengths) {
        this.strengthFreq.set(s, (this.strengthFreq.get(s) ?? 0) + 1)
      }

      const agent = session.agent_name ?? "unknown"
      let ars = this.byAgentRunning.get(agent)
      if (!ars) {
        ars = {
          sum: 0,
          count: 0,
          weaknessFreq: new Map(),
          strengthFreq: new Map(),
        }
        this.byAgentRunning.set(agent, ars)
      }
      ars.sum += session.score
      ars.count++
      for (const w of session.weaknesses) {
        this.mergeWeaknessIntoMap(ars.weaknessFreq, w, 1)
      }
      for (const s of session.score_card.strengths) {
        ars.strengthFreq.set(s, (ars.strengthFreq.get(s) ?? 0) + 1)
      }
    }
  }

  private restoreRunningState(): void {
    const r = this.state._running
    if (!r) return
    this.runningCount = r.running_count
    this.runningSum = r.running_sum
    this.weaknessFreq = new Map(Object.entries(r.weakness_freq))
    this.strengthFreq = new Map(Object.entries(r.strength_freq))
    this.byAgentRunning = new Map()
    for (const [name, ar] of Object.entries(r.by_agent)) {
      this.byAgentRunning.set(name, {
        sum: ar.sum,
        count: ar.count,
        weaknessFreq: new Map(Object.entries(ar.weakness_freq)),
        strengthFreq: new Map(Object.entries(ar.strength_freq)),
      })
    }
  }

  private incrementAggregate(session: SessionRecord): void {
    this.runningSum += session.score
    this.runningCount++
    for (const w of session.weaknesses) {
      this.mergeWeaknessIntoMap(this.weaknessFreq, w, 1)
    }
    for (const s of session.score_card.strengths) {
      this.strengthFreq.set(s, (this.strengthFreq.get(s) ?? 0) + 1)
    }

    const agent = session.agent_name ?? "unknown"
    let ars = this.byAgentRunning.get(agent)
    if (!ars) {
      ars = {
        sum: 0,
        count: 0,
        weaknessFreq: new Map(),
        strengthFreq: new Map(),
      }
      this.byAgentRunning.set(agent, ars)
    }
    ars.sum += session.score
    ars.count++
    for (const w of session.weaknesses) {
      this.mergeWeaknessIntoMap(ars.weaknessFreq, w, 1)
    }
    for (const s of session.score_card.strengths) {
      ars.strengthFreq.set(s, (ars.strengthFreq.get(s) ?? 0) + 1)
    }
  }

  private decrementAggregate(sessions: SessionRecord[]): void {
    for (const session of sessions) {
      this.runningSum -= session.score
      this.runningCount--
      for (const w of session.weaknesses) {
        this.unmergeWeaknessFromMap(this.weaknessFreq, w)
      }
      for (const s of session.score_card.strengths) {
        const c = (this.strengthFreq.get(s) ?? 0) - 1
        if (c <= 0) this.strengthFreq.delete(s)
        else this.strengthFreq.set(s, c)
      }

      const agent = session.agent_name ?? "unknown"
      const ars = this.byAgentRunning.get(agent)
      if (ars) {
        ars.sum -= session.score
        ars.count--
        for (const w of session.weaknesses) {
          this.unmergeWeaknessFromMap(ars.weaknessFreq, w)
        }
        for (const s of session.score_card.strengths) {
          const c = (ars.strengthFreq.get(s) ?? 0) - 1
          if (c <= 0) ars.strengthFreq.delete(s)
          else ars.strengthFreq.set(s, c)
        }
      }
    }
  }

  private computeAggregateFromRunning(): void {
    const prev = this.state.aggregate

    const topWeak = [...this.weaknessFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_WEAKNESSES_COUNT)
      .map(([pattern, count]) => ({
        pattern,
        count,
        suggested_fix: "",
      }))

    this.state.aggregate = {
      total_sessions: this.runningCount,
      avg_score:
        this.runningCount > 0 ? this.runningSum / this.runningCount : 0,
      top_weaknesses: topWeak,
      top_strengths: [...this.strengthFreq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, TOP_STRENGTHS_COUNT)
        .map(([s]) => s),
      by_agent: {},
    }

    for (const [name, ars] of this.byAgentRunning) {
      const agentTopWeak = [...ars.weaknessFreq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, TOP_WEAKNESSES_COUNT)
        .map(([pattern, count]) => ({
          pattern,
          count,
          suggested_fix: "",
        }))

      this.state.aggregate.by_agent[name] = {
        total_sessions: ars.count,
        avg_score: ars.count > 0 ? ars.sum / ars.count : 0,
        top_weaknesses: agentTopWeak.map((w) => ({ ...w, agent_name: name })),
        top_strengths: [...ars.strengthFreq.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, TOP_STRENGTHS_COUNT)
          .map(([s]) => s),
      }
    }

    if (prev) {
      this.copyWeaknessMetadata(prev)
    }
  }

  private copyWeaknessMetadata(prev: typeof this.state.aggregate): void {
    if (!prev) return

    const copyFrom = (source: WeaknessPattern[], target: WeaknessPattern[]) => {
      for (const tw of target) {
        if (tw.suggested_fix && tw.target) continue
        const match = source.find(
          (s) =>
            weaknessSimilarity(s.pattern, tw.pattern) >=
            WEAKNESS_SIMILARITY_THRESHOLD,
        )
        if (match) {
          if (!tw.suggested_fix && match.suggested_fix)
            tw.suggested_fix = match.suggested_fix
          if (!tw.target && match.target) tw.target = match.target
          if (!tw.agent_name && match.agent_name)
            tw.agent_name = match.agent_name
        }
      }
    }

    for (const [name, pa] of Object.entries(prev.by_agent)) {
      const curPA = this.state.aggregate.by_agent[name]
      if (curPA && pa.top_weaknesses.length > 0) {
        copyFrom(pa.top_weaknesses, curPA.top_weaknesses)
      }
    }
    copyFrom(prev.top_weaknesses, this.state.aggregate.top_weaknesses)
  }

  private markDirty(): void {
    this.version++
    this.dirty = true
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), 2000)
    }
  }

  async flush(): Promise<void> {
    this.flushTimer = null
    if (!this.dirty) return
    const capturedVersion = this.version
    const promise = this.execFlush(capturedVersion)
    this.flushingPromise = promise
    try {
      await promise
    } finally {
      if (this.flushingPromise === promise) {
        this.flushingPromise = null
      }
    }
  }

  private async execFlush(capturedVersion: number): Promise<void> {
    const lockPath = `${this.statePath}.lock`
    let unlock: (() => Promise<void>) | undefined

    this.logger?.log("state_flush_start", {
      version: this.version,
      runningCount: this.runningCount,
      sessionsSize: Object.keys(this.state.sessions).length,
      evaluatedSize: this.state.evaluated_sessions.length,
    })

    try {
      unlock = await acquireLock(lockPath)
      await this.mergeExternalState()
      await this.doFlush()
    } catch (err) {
      this.logger?.log("state_flush_error", { error: String(err) })
      this.dirty = true
      if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => this.flush(), 2000)
      }
      return
    } finally {
      if (unlock) {
        await unlock().catch((err) => {
          this.logger?.log("lock_release_failed", { error: String(err) })
        })
      }
    }

    if (this.version !== capturedVersion) {
      this.logger?.log("state_flush_dirty_again", {
        capturedVersion,
        newVersion: this.version,
      })
      if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => this.flush(), 0)
      }
    } else {
      this.dirty = false
      this.logger?.log("state_flush_done", {
        version: this.version,
        runningCount: this.runningCount,
        sessionsSize: Object.keys(this.state.sessions).length,
        evaluatedSize: this.state.evaluated_sessions.length,
      })
    }
  }

  private async mergeExternalState(): Promise<void> {
    let onDisk: KasperState
    try {
      const raw = await readFile(this.statePath, "utf-8")
      onDisk = JSON.parse(raw)
    } catch {
      return
    }

    const ourIds = new Set(this.state.improvements_applied.map((i) => i.id))

    const newSessions: SessionRecord[] = []
    const ourSessionCount = Object.keys(this.state.sessions).length
    const diskSessionCount = Object.keys(onDisk.sessions ?? {}).length

    for (const [id, session] of Object.entries(onDisk.sessions ?? {})) {
      if (!this.state.sessions[id]) {
        this.state.sessions[id] = session
        newSessions.push(session)
      }
    }

    let newEvalCount = 0
    for (const sid of onDisk.evaluated_sessions ?? []) {
      if (!this.evaluatedSet.has(sid)) {
        this.evaluatedSet.add(sid)
        newEvalCount++
      }
    }

    for (const imp of onDisk.improvements_applied ?? []) {
      if (!ourIds.has(imp.id)) {
        this.state.improvements_applied.push(imp)
      }
    }

    for (const pattern of onDisk.rejected_patterns ?? []) {
      if (!this.state.rejected_patterns.includes(pattern)) {
        this.state.rejected_patterns.push(pattern)
      }
    }

    this.pruneHistory()

    if (newSessions.length > 0) {
      this.logger?.log("state_merge_found_new", {
        newSessions: newSessions.length,
        newEvaluated: newEvalCount,
        ourSessions: ourSessionCount,
        diskSessions: diskSessionCount,
        runningCountBefore: this.runningCount,
      })
      for (const s of newSessions) {
        this.incrementAggregate(s)
      }
      this.computeAggregateFromRunning()
    } else if (newEvalCount > 0) {
      this.logger?.log("state_merge_new_evaluated_only", {
        newEvaluated: newEvalCount,
        ourSessions: ourSessionCount,
        diskSessions: diskSessionCount,
      })
    } else {
      this.logger?.log("state_merge_nothing_new", {
        ourSessions: ourSessionCount,
        diskSessions: diskSessionCount,
        ourEvaluated: this.evaluatedSet.size,
        diskEvaluated: onDisk.evaluated_sessions?.length ?? 0,
      })
    }
  }

  private async doFlush(): Promise<void> {
    const byAgent: Record<
      string,
      {
        count: number
        sum: number
        weakness_freq: Record<string, number>
        strength_freq: Record<string, number>
      }
    > = {}
    for (const [name, ars] of this.byAgentRunning) {
      byAgent[name] = {
        count: ars.count,
        sum: ars.sum,
        weakness_freq: Object.fromEntries(ars.weaknessFreq),
        strength_freq: Object.fromEntries(ars.strengthFreq),
      }
    }
    this.state.evaluated_sessions = [...this.evaluatedSet].slice(
      -MAX_EVALUATED_SESSIONS_STORED,
    )
    this.state._running = {
      weakness_freq: Object.fromEntries(this.weaknessFreq),
      strength_freq: Object.fromEntries(this.strengthFreq),
      running_count: this.runningCount,
      running_sum: this.runningSum,
      by_agent: byAgent,
    }
    await writeTextAtomic(this.statePath, JSON.stringify(this.state, null, 2))
  }
}
