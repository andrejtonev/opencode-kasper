import { createHash } from "node:crypto"
import type {
  ScoreCategories,
  WeaknessPattern,
  WeaknessSuggestion,
} from "./types.js"

const CATEGORY_KEYS = [
  "instruction_following",
  "completeness",
  "proactiveness",
  "code_quality",
  "communication",
] as const
const MAX_ITEMS = 100
const MAX_DESCRIPTION = 2000
const MAX_FIX = 4000

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function score(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  )
}

function text(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length <= limit
}

export interface ValidatedJudgeOutput {
  overall_score: number
  categories: ScoreCategories
  strengths: string[]
  weaknesses: string[]
  weakness_suggestions?: WeaknessSuggestion[]
  suggested_agents_md_update?: string
  suggested_agent_prompt_update?: string
}

/** Missing optional observations are harmless; missing/malformed scores are not successes. */
export function validateJudgeOutput(
  value: unknown,
): ValidatedJudgeOutput | undefined {
  const data = record(value)
  const cats = record(data?.categories)
  if (
    !data ||
    !cats ||
    !score(data.overall_score) ||
    CATEGORY_KEYS.some((key) => !score(cats[key]))
  )
    return
  const strings = (value: unknown, weakness = false): string[] | undefined => {
    if (value === undefined) return []
    if (!Array.isArray(value) || value.length > MAX_ITEMS) return
    const result: string[] = []
    for (const item of value) {
      const entry = record(item)
      // Retain the existing useful description/weakness-object compatibility format.
      const normalized =
        weakness && entry ? (entry.description ?? entry.weakness) : item
      if (!text(normalized, MAX_DESCRIPTION) || !normalized.trim()) return
      result.push(normalized)
    }
    return result
  }
  const strengths = strings(data.strengths)
  const weaknesses = strings(data.weaknesses, true)
  if (!strengths || !weaknesses) return
  let suggestions: WeaknessSuggestion[] | undefined
  if (data.weakness_suggestions !== undefined) {
    if (
      !Array.isArray(data.weakness_suggestions) ||
      data.weakness_suggestions.length > MAX_ITEMS
    )
      return
    suggestions = []
    for (const value of data.weakness_suggestions) {
      const item = record(value)
      if (
        !item ||
        !text(item.weakness, MAX_DESCRIPTION) ||
        !weaknesses.includes(item.weakness) ||
        !text(item.suggested_fix, MAX_FIX) ||
        !item.suggested_fix.trim() ||
        (item.target !== "agent_prompt" && item.target !== "agents_md")
      )
        return
      suggestions.push({
        weakness: item.weakness,
        suggested_fix: item.suggested_fix,
        target: item.target,
      })
    }
  }
  for (const key of [
    "suggested_agents_md_update",
    "suggested_agent_prompt_update",
  ] as const) {
    if (
      data[key] !== undefined &&
      (!text(data[key], 16000) || (data[key] !== "" && weaknesses.length === 0))
    )
      return
  }
  return {
    overall_score: data.overall_score,
    categories: Object.fromEntries(
      CATEGORY_KEYS.map((key) => [key, cats[key]]),
    ) as unknown as ScoreCategories,
    strengths,
    weaknesses,
    weakness_suggestions: suggestions,
    suggested_agents_md_update: data.suggested_agents_md_update
      ? (data.suggested_agents_md_update as string)
      : undefined,
    suggested_agent_prompt_update: data.suggested_agent_prompt_update
      ? (data.suggested_agent_prompt_update as string)
      : undefined,
  }
}

export interface WeaknessMergeInput {
  readonly id: string
  readonly source: WeaknessPattern
}

/** IDs identify exact snapshot entries, including duplicate observations. Counts never come from the judge. */
export function weaknessMergeInputs(
  weaknesses: readonly WeaknessPattern[],
  limit: number,
): WeaknessMergeInput[] {
  return weaknesses.slice(0, limit).map((source, index) => ({
    id: `w-${createHash("sha256").update(JSON.stringify(source)).digest("hex").slice(0, 16)}-${index}`,
    source: { ...source },
  }))
}

function provenance(source: WeaknessPattern): string {
  const {
    pattern: _pattern,
    count: _count,
    suggested_fix: _fix,
    evidence_count: _evidence,
    ...rest
  } = source
  return JSON.stringify(
    Object.entries(rest).sort(([a], [b]) => a.localeCompare(b)),
  )
}

/** Reject the entire grouping on ambiguity; untouched entries (including the unprompted tail) survive. */
export function applyWeaknessGroups(
  weaknesses: readonly WeaknessPattern[],
  inputs: readonly WeaknessMergeInput[],
  value: unknown,
): WeaknessPattern[] | undefined {
  const data = record(value)
  if (
    !data ||
    Object.keys(data).some((key) => key !== "groups") ||
    !Array.isArray(data.groups) ||
    data.groups.length > inputs.length
  )
    return
  const expected = weaknessMergeInputs(weaknesses, inputs.length)
  if (
    inputs.length > weaknesses.length ||
    inputs.some(
      (item, index) =>
        item.id !== expected[index].id ||
        JSON.stringify(item.source) !== JSON.stringify(expected[index].source),
    )
  )
    return
  const known = new Map(inputs.map((item) => [item.id, item]))
  const used = new Set<string>()
  const groups: WeaknessPattern[] = []
  for (const raw of data.groups) {
    const group = record(raw)
    if (
      !group ||
      Object.keys(group).some((key) => key !== "ids" && key !== "pattern") ||
      !text(group.pattern, MAX_DESCRIPTION) ||
      !group.pattern.trim() ||
      !Array.isArray(group.ids) ||
      group.ids.length < 2 ||
      group.ids.length > inputs.length
    )
      return
    const members: WeaknessPattern[] = []
    for (const id of group.ids) {
      if (typeof id !== "string" || used.has(id)) return
      const member = known.get(id)
      if (!member) return
      used.add(id)
      members.push(member.source)
    }
    const first = members[0]
    if (
      members.some(
        (member) =>
          provenance(member) !== provenance(first) ||
          !Number.isSafeInteger(member.count) ||
          member.count < 1 ||
          typeof member.suggested_fix !== "string" ||
          (member.evidence_count !== undefined &&
            (!Number.isSafeInteger(member.evidence_count) ||
              member.evidence_count < 0)) ||
          (member.evidence_count === undefined) !==
            (first.evidence_count === undefined),
      )
    )
      return
    const count = members.reduce((sum, member) => sum + member.count, 0)
    const evidence =
      first.evidence_count === undefined
        ? undefined
        : members.reduce((sum, member) => sum + (member.evidence_count ?? 0), 0)
    if (
      !Number.isSafeInteger(count) ||
      (evidence !== undefined && !Number.isSafeInteger(evidence))
    )
      return
    const fixes = [
      ...new Set(members.map((member) => member.suggested_fix).filter(Boolean)),
    ].join("\n\n")
    // Keep remediation intact rather than truncating or silently selecting one source fix.
    if (fixes.length > 16000) return
    groups.push({
      ...first,
      pattern: group.pattern,
      count,
      suggested_fix: fixes,
      ...(evidence === undefined ? {} : { evidence_count: evidence }),
    })
  }
  const removedIndexes = new Set(
    inputs.flatMap((item, index) => (used.has(item.id) ? [index] : [])),
  )
  const untouched = weaknesses
    .filter((_, index) => !removedIndexes.has(index))
    .map((source) => ({ ...source }))
  const patterns = new Set(untouched.map((item) => item.pattern))
  for (const group of groups) {
    if (patterns.has(group.pattern)) return
    patterns.add(group.pattern)
  }
  return [...groups, ...untouched].sort((a, b) => b.count - a.count)
}

/** Truncation is visible evidence loss, never fabricated JSON closing brackets. The escaped result includes its omission marker within the bound. */
export function boundedEvidence(value: string, limit: number): string {
  if (!Number.isSafeInteger(limit) || limit < 64)
    throw new RangeError("Evidence limit must be at least 64 characters")
  const chunks: string[] = []
  let length = 0
  let consumed = 0
  for (const char of value) {
    const escaped =
      char === "&"
        ? "&amp;"
        : char === "<"
          ? "&lt;"
          : char === ">"
            ? "&gt;"
            : char
    if (length + escaped.length > limit) break
    chunks.push(escaped)
    length += escaped.length
    consumed += char.length
  }
  if (consumed === value.length) return chunks.join("")
  let marker = `\n[truncated; ${value.length - consumed} characters omitted]`
  while (length + marker.length > limit) {
    const last = chunks.pop()
    if (last === undefined) break
    length -= last.length
    consumed -=
      last === "&amp;" || last === "&lt;" || last === "&gt;" ? 1 : last.length
    marker = `\n[truncated; ${value.length - consumed} characters omitted]`
  }
  return chunks.join("") + marker
}
