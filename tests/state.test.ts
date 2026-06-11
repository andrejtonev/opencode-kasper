import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { mkdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { computeStats, KasperStateStore } from "../src/state.js"
import type { KasperConfig, ScoreCard } from "../src/types.js"
import { DEFAULT_CONFIG } from "../src/types.js"

function makeScoreCard(overrides: Partial<ScoreCard> = {}): ScoreCard {
  return {
    session_id: "test-session",
    timestamp: Date.now(),
    overall_score: 0.8,
    categories: {
      instruction_following: 0.9,
      completeness: 0.8,
      proactiveness: 0.7,
      code_quality: 0.8,
      communication: 0.8,
    },
    strengths: [],
    weaknesses: [],
    ...overrides,
  }
}

function tmpDir(): string {
  return join(tmpdir(), `kasper-test-${randomBytes(6).toString("hex")}`)
}

describe("computeStats", () => {
  test("returns zero stats for empty entries", () => {
    const result = computeStats([])
    expect(result.total_sessions).toBe(0)
    expect(result.avg_score).toBe(0)
    expect(result.top_weaknesses).toEqual([])
    expect(result.top_strengths).toEqual([])
  })

  test("computes stats for single entry", () => {
    const entries = [
      {
        score: 0.8,
        score_card: makeScoreCard({ overall_score: 0.8 }),
        timestamp: Date.now(),
      },
    ]
    const result = computeStats(entries)
    expect(result.total_sessions).toBe(1)
    expect(result.avg_score).toBe(0.8)
  })

  test("computes average across multiple entries", () => {
    const now = Date.now()
    const entries = [
      {
        score: 0.5,
        score_card: makeScoreCard({ overall_score: 0.5 }),
        timestamp: now,
      },
      {
        score: 1.0,
        score_card: makeScoreCard({ overall_score: 1.0 }),
        timestamp: now,
      },
    ]
    const result = computeStats(entries)
    expect(result.avg_score).toBe(0.75)
  })

  test("aggregates weaknesses by frequency", () => {
    const now = Date.now()
    const entries = [
      {
        score: 0.8,
        score_card: makeScoreCard({
          weaknesses: ["slow response", "missed detail"],
        }),
        timestamp: now,
      },
      {
        score: 0.7,
        score_card: makeScoreCard({ weaknesses: ["slow response"] }),
        timestamp: now,
      },
      {
        score: 0.9,
        score_card: makeScoreCard({ weaknesses: ["slow response"] }),
        timestamp: now,
      },
    ]
    const result = computeStats(entries)
    expect(result.top_weaknesses.length).toBeGreaterThanOrEqual(2)
    const slow = result.top_weaknesses.find(
      (w) => w.pattern === "slow response",
    )
    expect(slow?.count).toBe(3)
    const missed = result.top_weaknesses.find(
      (w) => w.pattern === "missed detail",
    )
    expect(missed?.count).toBe(1)
  })

  test("sorts weaknesses by count descending", () => {
    const now = Date.now()
    const entries = [
      {
        score: 0.8,
        score_card: makeScoreCard({ weaknesses: ["rare"] }),
        timestamp: now,
      },
      {
        score: 0.7,
        score_card: makeScoreCard({ weaknesses: ["common"] }),
        timestamp: now,
      },
      {
        score: 0.9,
        score_card: makeScoreCard({ weaknesses: ["common"] }),
        timestamp: now,
      },
    ]
    const result = computeStats(entries)
    expect(result.top_weaknesses[0].pattern).toBe("common")
    expect(result.top_weaknesses[0].count).toBe(2)
  })

  test("aggregates strengths by frequency", () => {
    const now = Date.now()
    const entries = [
      {
        score: 0.8,
        score_card: makeScoreCard({
          strengths: ["great code", "clear communication"],
        }),
        timestamp: now,
      },
      {
        score: 0.7,
        score_card: makeScoreCard({ strengths: ["great code"] }),
        timestamp: now,
      },
    ]
    const result = computeStats(entries)
    expect(result.top_strengths[0]).toBe("great code")
    expect(result.top_strengths).toContain("clear communication")
  })

  test("limits weaknesses to top 5", () => {
    const entries = []
    const now = Date.now()
    for (let i = 0; i < 10; i++) {
      entries.push({
        score: 0.8,
        score_card: makeScoreCard({ weaknesses: [`w${i}`] }),
        timestamp: now,
      })
    }
    const result = computeStats(entries)
    expect(result.top_weaknesses.length).toBe(5)
  })

  test("limits strengths to top 5", () => {
    const entries = []
    const now = Date.now()
    for (let i = 0; i < 10; i++) {
      entries.push({
        score: 0.8,
        score_card: makeScoreCard({ strengths: [`s${i}`] }),
        timestamp: now,
      })
    }
    const result = computeStats(entries)
    expect(result.top_strengths.length).toBe(5)
  })

  test("decays old weaknesses with decayDays set", () => {
    const now = Date.now()
    const fortyDaysAgo = now - 40 * 24 * 60 * 60 * 1000
    const entries = [
      {
        score: 0.8,
        score_card: makeScoreCard({ weaknesses: ["old pattern"] }),
        timestamp: fortyDaysAgo,
      },
      {
        score: 0.8,
        score_card: makeScoreCard({ weaknesses: ["old pattern"] }),
        timestamp: fortyDaysAgo,
      },
      {
        score: 0.7,
        score_card: makeScoreCard({ weaknesses: ["recent issue"] }),
        timestamp: now,
      },
      {
        score: 0.7,
        score_card: makeScoreCard({ weaknesses: ["recent issue"] }),
        timestamp: now,
      },
    ]
    const result = computeStats(entries, 30)

    const recent = result.top_weaknesses.find(
      (w) => w.pattern === "recent issue",
    )
    const old = result.top_weaknesses.find((w) => w.pattern === "old pattern")
    expect(result.top_weaknesses[0].pattern).toBe("recent issue")
    expect(recent?.count).toBe(2)
    expect(old?.count).toBeLessThan(2)
  })
})

describe("KasperStateStore", () => {
  let testDir: string
  let statePath: string
  let backupDir: string

  beforeEach(async () => {
    testDir = tmpDir()
    statePath = join(testDir, "state.json")
    backupDir = join(testDir, "backups")
    await mkdir(testDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  function createStore(config?: Partial<KasperConfig>): KasperStateStore {
    return new KasperStateStore(statePath, backupDir, config)
  }

  test("init creates backup directory and default state file", async () => {
    const store = createStore()
    await store.init()
    const raw = await readFile(statePath, "utf-8")
    const state = JSON.parse(raw)
    expect(state.version).toBe(1)
    expect(state.config.enabled).toBe(true)
    expect(state.sessions).toEqual({})
  })

  test("init loads existing state", async () => {
    const store1 = createStore()
    await store1.init()
    store1.recordSession("s1", "test", makeScoreCard({ overall_score: 0.9 }))

    // Force flush — the 2s debounce timer is unreliable on Windows under
    // fast CI runners, and reload() needs the on-disk state.
    await store1.flush()

    const store2 = createStore()
    await store2.init()
    expect(store2.getTotalSessions()).toBe(1)
  })

  describe("state integrity", () => {
    test("init does not warn when on-disk hash matches a fresh flush", async () => {
      const logs: Array<{ event: string; data: unknown }> = []
      const logger = {
        log: async (event: string, data: unknown) => {
          logs.push({ event, data })
        },
      }
      const store1 = new KasperStateStore(
        statePath,
        backupDir,
        undefined,
        logger as never,
      )
      await store1.init()
      store1.recordSession(
        "s1",
        "test",
        makeScoreCard({ overall_score: 0.9, weaknesses: ["missed detail"] }),
      )
      await store1.flush()

      // Drop the warn entry, re-init.
      logs.length = 0
      const store2 = new KasperStateStore(
        statePath,
        backupDir,
        undefined,
        logger as never,
      )
      await store2.init()

      const integrityWarnings = logs.filter(
        (l) => l.event === "state_integrity_warn",
      )
      expect(integrityWarnings).toHaveLength(0)
    })

    test("init warns when on-disk state has been edited outside Kasper", async () => {
      const logs: Array<{ event: string; data: unknown }> = []
      const logger = {
        log: async (event: string, data: unknown) => {
          logs.push({ event, data })
        },
      }
      const store = new KasperStateStore(
        statePath,
        backupDir,
        undefined,
        logger as never,
      )
      await store.init()
      await store.flush()
      // Tamper with the on-disk file.
      const raw = await readFile(statePath, "utf-8")
      const parsed = JSON.parse(raw)
      parsed.sessions = {
        ...parsed.sessions,
        forged: {
          score: 1.0,
          weaknesses: [],
          score_card: {},
          timestamp: Date.now(),
        },
      }
      // Keep the stored hash stale so the integrity check trips.
      const { writeFile } = await import("node:fs/promises")
      await writeFile(statePath, JSON.stringify(parsed, null, 2), "utf-8")

      logs.length = 0
      const store2 = new KasperStateStore(
        statePath,
        backupDir,
        undefined,
        logger as never,
      )
      await store2.init()

      const integrityWarnings = logs.filter(
        (l) => l.event === "state_integrity_warn",
      )
      expect(integrityWarnings).toHaveLength(1)
    })

    test("computeIntegrityHash is stable for identical state", async () => {
      const { KasperStateStore } = await import("../src/state.js")
      const computeIntegrityHash = KasperStateStore.computeIntegrityHash
      const state = {
        version: 1,
        sessions: {
          s1: {
            score: 0.8,
            weaknesses: [],
            score_card: {} as never,
            timestamp: 1,
          },
        },
        evaluated_sessions: ["s1"],
        aggregate: {
          total_sessions: 1,
          avg_score: 0.8,
          top_weaknesses: [],
          top_strengths: [],
          by_agent: {},
        },
        improvements_applied: [],
        config: { enabled: true } as never,
        rejected_patterns: [],
        installed_at: 1,
        _running: {
          weakness_freq: { a: 1 },
          strength_freq: {},
          running_count: 1,
          running_sum: 0.8,
          by_agent: {},
        },
        _integrity: "stale-hash-value",
      }
      const h1 = computeIntegrityHash(state)
      const h2 = computeIntegrityHash(state)
      expect(h1).toBe(h2)
      // The stored hash MUST NOT appear in the digest, otherwise the
      // self-referential fix would be a no-op.
      expect(h1).not.toBe("stale-hash-value")
    })

    test("computeIntegrityHash excludes only _integrity, not _running", async () => {
      const { KasperStateStore } = await import("../src/state.js")
      const computeIntegrityHash = KasperStateStore.computeIntegrityHash
      const base = {
        version: 1,
        sessions: {} as Record<string, never>,
        evaluated_sessions: [] as string[],
        aggregate: {
          total_sessions: 0,
          avg_score: 0,
          top_weaknesses: [] as never[],
          top_strengths: [] as string[],
          by_agent: {},
        },
        improvements_applied: [] as never[],
        config: { enabled: true } as never,
        rejected_patterns: [] as string[],
        installed_at: 1,
        _running: {
          weakness_freq: {},
          strength_freq: {},
          running_count: 0,
          running_sum: 0,
          by_agent: {},
        },
        _integrity: "ignored",
      }
      const tampered = {
        ...base,
        _running: {
          ...base._running,
          running_count: 999, // tampering with cache must change the hash
        },
      }
      expect(computeIntegrityHash(base)).not.toBe(
        computeIntegrityHash(tampered),
      )
    })
  })

  test("recordSession adds session and updates aggregate", () => {
    const store = createStore()
    const card = makeScoreCard({
      overall_score: 0.85,
      strengths: ["good job"],
      weaknesses: ["slow"],
    })
    store.recordSession("s1", "fix bug", card)

    expect(store.getTotalSessions()).toBe(1)
    const agg = store.getAggregate()
    expect(agg.total_sessions).toBe(1)
    expect(agg.avg_score).toBe(0.85)
    expect(agg.top_strengths).toContain("good job")
    expect(agg.top_weaknesses.some((w) => w.pattern === "slow")).toBe(true)
  })

  test("getRecentSessions returns sessions sorted by timestamp desc", () => {
    const store = createStore()
    store.recordSession(
      "old",
      "old",
      makeScoreCard({ timestamp: 1000, overall_score: 0.5 }),
    )
    store.recordSession(
      "new",
      "new",
      makeScoreCard({ timestamp: 2000, overall_score: 0.9 }),
    )

    const recent = store.getRecentSessions(10)
    expect(recent.length).toBe(2)
    expect(recent[0].id).toBe("new")
    expect(recent[1].id).toBe("old")
  })

  test("getRecentSessions respects limit", () => {
    const store = createStore()
    store.recordSession("a", "a", makeScoreCard({ timestamp: 1000 }))
    store.recordSession("b", "b", makeScoreCard({ timestamp: 2000 }))
    store.recordSession("c", "c", makeScoreCard({ timestamp: 3000 }))

    expect(store.getRecentSessions(2).length).toBe(2)
  })

  test("getAgentSessions filters by agent name", () => {
    const store = createStore()
    store.recordSession("s1", "task 1", makeScoreCard(), "build", "primary")
    store.recordSession("s2", "task 2", makeScoreCard(), "general", "primary")
    store.recordSession(
      "s3",
      "task 3",
      makeScoreCard(),
      "build",
      "subagent",
      "s1",
    )

    const buildSessions = store.getAgentSessions("build")
    expect(buildSessions.length).toBe(2)

    const generalSessions = store.getAgentSessions("general")
    expect(generalSessions.length).toBe(1)
  })

  test("pruneHistory removes oldest sessions when over max_history", () => {
    const store = createStore()
    // MAX_HISTORY is hardcoded to 100; record 101 to trigger pruning
    for (let i = 0; i < 101; i++) {
      store.recordSession(
        `session-${i}`,
        `Title ${i}`,
        makeScoreCard({ timestamp: 1000 + i }),
      )
    }

    expect(store.getTotalSessions()).toBe(100)
    const recent = store.getRecentSessions(200)
    expect(recent.find((r) => r.id === "session-0")).toBeUndefined()
    expect(recent.find((r) => r.id === "session-100")).toBeDefined()
  })

  test("recordImprovement appends improvement", () => {
    const store = createStore()
    store.recordImprovement({
      timestamp: Date.now(),
      target: "agents_md",
      agents_md_diff: "added rule",
      reason: "bad behavior",
      backup_path: "/tmp/backup",
    })
    const improvements = store.getImprovements()
    expect(improvements.length).toBe(1)
    expect(improvements[0].reason).toBe("bad behavior")
  })

  test("getAgentAggregate returns per-agent stats", () => {
    const store = createStore()
    store.recordSession(
      "s1",
      "task",
      makeScoreCard({ weaknesses: ["slow"], overall_score: 0.7 }),
      "build",
    )
    store.recordSession(
      "s2",
      "task",
      makeScoreCard({ weaknesses: ["slow"], overall_score: 0.9 }),
      "build",
    )

    const agg = store.getAgentAggregate("build")
    expect(agg?.total_sessions).toBe(2)
    expect(agg.avg_score).toBe(0.8)
    expect(agg.top_weaknesses[0].pattern).toBe("slow")
    expect(agg.top_weaknesses[0].count).toBe(2)
  })

  test("getAgentAggregate returns undefined for unknown agent", () => {
    const store = createStore()
    expect(store.getAgentAggregate("nonexistent")).toBeUndefined()
  })

  test("updateConfig patches config", () => {
    const store = createStore()
    store.updateConfig({ scoring_threshold: 0.9, debug: true })
    expect(store.getConfig().scoring_threshold).toBe(0.9)
    expect(store.getConfig().debug).toBe(true)
    // unchanged defaults remain
    expect(store.getConfig().enabled).toBe(true)
  })

  test("reloadConfig replaces entire config", () => {
    const store = createStore()
    const newConfig = {
      ...DEFAULT_CONFIG,
      scoring_threshold: 0.3,
      model: "openai/gpt-4o",
    }
    store.reloadConfig(newConfig)
    expect(store.getConfig().scoring_threshold).toBe(0.3)
    expect(store.getConfig().model).toBe("openai/gpt-4o")
    expect(store.getConfig().enabled).toBe(true)
  })

  describe("rejected_patterns", () => {
    test("addRejectedPattern stores and persists", () => {
      const store = createStore()
      store.addRejectedPattern("does not write tests")
      store.addRejectedPattern("missing error handling")
      expect(store.getRejectedPatterns()).toEqual([
        "does not write tests",
        "missing error handling",
      ])
    })

    test("addRejectedPattern deduplicates", () => {
      const store = createStore()
      store.addRejectedPattern("does not write tests")
      store.addRejectedPattern("does not write tests")
      expect(store.getRejectedPatterns()).toEqual(["does not write tests"])
    })

    test("removeRejectedPattern removes existing pattern", () => {
      const store = createStore()
      store.addRejectedPattern("pattern a")
      store.addRejectedPattern("pattern b")
      store.removeRejectedPattern("pattern a")
      expect(store.getRejectedPatterns()).toEqual(["pattern b"])
    })

    test("removeRejectedPattern does nothing for missing pattern", () => {
      const store = createStore()
      store.addRejectedPattern("existing")
      store.removeRejectedPattern("nonexistent")
      expect(store.getRejectedPatterns()).toEqual(["existing"])
    })

    test("persists rejected_patterns across store reload", async () => {
      const store = createStore()
      await store.init()
      store.addRejectedPattern("persistent pattern")
      // Force flush — the 2s debounce timer is unreliable on Windows under
      // fast CI runners.
      await store.flush()
      await store.destroy()

      const store2 = createStore()
      await store2.init()
      expect(store2.getRejectedPatterns()).toContain("persistent pattern")
    })

    test("installed_at is set on first init", async () => {
      const store = createStore()
      await store.init()
      const ts = store.getInstalledAt()
      expect(ts).toBeGreaterThan(0)
      expect(ts).toBeLessThanOrEqual(Date.now())
    })

    test("installed_at survives reset", async () => {
      const store = createStore()
      await store.init()
      const original = store.getInstalledAt()
      store.recordSession("s1", "test", makeScoreCard({ overall_score: 0.9 }))
      await store.reset()
      expect(store.getInstalledAt()).toBe(original)
      expect(store.getTotalSessions()).toBe(0)
    })

    test("installed_at persists across store reload", async () => {
      const store = createStore()
      await store.init()
      const original = store.getInstalledAt()
      await store.destroy()

      const store2 = createStore()
      await store2.init()
      expect(store2.getInstalledAt()).toBe(original)
    })
  })
})
