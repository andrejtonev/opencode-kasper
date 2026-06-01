import {
  WEAKNESS_EXACT_WORD_OVERLAP_THRESHOLD,
  WEAKNESS_LEVENSHTEIN_THRESHOLD,
  WEAKNESS_SIMILARITY_THRESHOLD,
  WEAKNESS_SUBSTRING_SCORE,
} from "./constants.js"
import type { OpencodeSessionClient, WeaknessPattern } from "./types.js"

export function weaknessSimilarity(a: string, b: string): number {
  const aLower = a.toLowerCase().trim()
  const bLower = b.toLowerCase().trim()
  if (aLower === bLower) return 1.0

  if (aLower.includes(bLower) || bLower.includes(aLower))
    return WEAKNESS_SUBSTRING_SCORE

  // Exact-match pass on all words including short ones
  const aAllWords = aLower.split(/\s+/)
  const bAllWords = bLower.split(/\s+/)
  const aAllSet = new Set(aAllWords)
  const bAllSet = new Set(bAllWords)
  const allWordsOverlap = [...aAllSet].filter((w) => bAllSet.has(w)).length
  const allWordsUnion = aAllSet.size + bAllSet.size - allWordsOverlap
  const exactShortOverlap =
    allWordsUnion > 0 ? allWordsOverlap / allWordsUnion : 0
  if (exactShortOverlap >= WEAKNESS_EXACT_WORD_OVERLAP_THRESHOLD)
    return exactShortOverlap

  // Fuzzy pass using only longer words (>=3 chars) for Levenshtein comparison
  const aWords = aLower.split(/\s+/).filter((w) => w.length >= 3)
  const bWords = bLower.split(/\s+/).filter((w) => w.length >= 3)
  const aSet = new Set(aWords)
  const bSet = new Set(bWords)

  if (aWords.length > 0 && bWords.length > 0) {
    const aStr = aWords.join(" ")
    const bStr = bWords.join(" ")
    if (aStr.includes(bStr) || bStr.includes(aStr))
      return WEAKNESS_SUBSTRING_SCORE
  }

  let exactOverlap = 0
  for (const w of aSet) {
    if (bSet.has(w)) exactOverlap++
  }

  let fuzzyOverlap = 0
  const unmatchedB = [...bSet].filter((w) => !aSet.has(w))
  for (const wa of aWords) {
    if (bSet.has(wa)) continue
    for (let j = 0; j < unmatchedB.length; j++) {
      if (
        unmatchedB[j] &&
        levenshteinWordSimilarity(wa, unmatchedB[j]) >=
          WEAKNESS_LEVENSHTEIN_THRESHOLD
      ) {
        fuzzyOverlap++
        unmatchedB[j] = ""
        break
      }
    }
  }

  const totalOverlap = exactOverlap + fuzzyOverlap
  const unionSize = aSet.size + bSet.size - exactOverlap
  if (unionSize === 0) return 0
  return totalOverlap / unionSize
}

function levenshteinWordSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return 1
  const m = a.length
  const n = b.length
  const dp: number[] = new Array(n + 1)
  for (let j = 0; j <= n; j++) dp[j] = j
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]
    dp[0] = i
    for (let j = 1; j <= n; j++) {
      const temp = dp[j]
      dp[j] =
        a[i - 1] === b[j - 1] ? prev : 1 + Math.min(dp[j], dp[j - 1], prev)
      prev = temp
    }
  }
  return 1 - dp[n] / maxLen
}

export function findMatchingWeakness(
  weaknesses: string[],
  topWeaknesses: WeaknessPattern[],
  minObservations: number,
): WeaknessPattern | undefined {
  for (const tw of topWeaknesses) {
    if (tw.count < minObservations) continue
    for (const uw of weaknesses) {
      if (weaknessSimilarity(uw, tw.pattern) >= WEAKNESS_SIMILARITY_THRESHOLD)
        return tw
    }
  }
  return undefined
}

function normalizeSessionID(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined
  const s = String(raw).trim()
  return s || undefined
}

export function getSessionID(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined
  const i = input as Record<string, unknown>
  const event = i.event as Record<string, unknown> | undefined
  const props = i.properties as Record<string, unknown> | undefined
  const info = i.info as Record<string, unknown> | undefined
  const session = i.session as Record<string, unknown> | undefined
  const eprops = event?.properties as Record<string, unknown> | undefined
  return (
    normalizeSessionID(i.sessionID) ??
    normalizeSessionID(event?.sessionID) ??
    normalizeSessionID(eprops?.sessionID) ??
    normalizeSessionID(eprops?.sessionId) ??
    normalizeSessionID(props?.sessionID) ??
    normalizeSessionID(props?.sessionId) ??
    normalizeSessionID(session?.id) ??
    normalizeSessionID(info?.sessionID) ??
    normalizeSessionID(info?.sessionId)
  )
}

export function formatScore(score: number): { emoji: string; pct: string } {
  const pct = (score * 100).toFixed(0)
  const emoji =
    score >= 0.8 ? "\u{1F7E2}" : score >= 0.6 ? "\u{1F7E1}" : "\u{1F534}"
  return { emoji, pct }
}

export function showToast(
  client: OpencodeSessionClient,
  title: string,
  message: string,
  variant = "info",
  duration = 8000,
) {
  client.tui
    ?.showToast?.({ body: { title, message, variant, duration } } as unknown)
    ?.catch?.((err: unknown) => {
      process.stderr.write(`[kasper] toast failed: ${err}\n`)
    })
}

export function isRegisteredCommand(
  text: string,
  registeredCommands: Set<string>,
): boolean {
  const firstWord = text.trim().split(/\s+/)[0]
  if (!firstWord.startsWith("/")) return false
  const cmd = firstWord.replace(/^\/+/, "").toLowerCase()
  return cmd.length > 0 && registeredCommands.has(cmd)
}

const KASPER_SESSION_PREFIXES = [
  "kasper-scoring-",
  "kasper-merge-",
  "kasper-diag-",
]

export function renderSparkline(scores: number[]): string {
  if (scores.length < 1) return ""
  const blocks = "▁▂▃▄▅▆▇█"
  const min = Math.min(...scores)
  const max = Math.max(...scores)
  const range = max - min || 1
  return scores
    .map((s) => {
      const idx = Math.round(((s - min) / range) * (blocks.length - 1))
      return blocks[Math.max(0, Math.min(idx, blocks.length - 1))]
    })
    .join("")
}

export function isKasperSession(title: string): boolean {
  const lower = title.toLowerCase()
  return KASPER_SESSION_PREFIXES.some((p) => lower.startsWith(p))
}

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label = "operation",
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    )
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a == null || b == null) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((v, i) => deepEqual(v, b[i]))
  }
  if (typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a as Record<string, unknown>)
    const bKeys = Object.keys(b as Record<string, unknown>)
    if (aKeys.length !== bKeys.length) return false
    for (const k of aKeys) {
      if (!bKeys.includes(k)) return false
      if (
        !deepEqual(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k],
        )
      )
        return false
    }
    return true
  }
  return false
}
