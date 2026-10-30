import { expect, test } from "bun:test"
import { calendarDate, validateScoreTarget } from "../src/actions.js"
import { renderCompactionFeedback } from "../src/compaction.js"
import { KasperRuntime } from "../src/runtime.js"

test("session revisions revoke only that source and abort its work", async () => {
  const runtime = new KasperRuntime()
  const a = runtime.capture("a"),
    b = runtime.capture("b")
  const signal = runtime.sessionSignal("a")
  runtime.invalidateSession("a")
  expect(signal.aborted).toBe(true)
  expect(runtime.isCurrent("a", a)).toBe(false)
  expect(runtime.isCurrent("b", b)).toBe(true)
  runtime.invalidateAll()
  expect(runtime.isCurrent("b", b)).toBe(false)
  await runtime.dispose()
})

test("dispose cannot release an admission slot while old work is active", async () => {
  const runtime = new KasperRuntime()
  let release!: () => void
  const work = runtime.runOnce(
    "poll",
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      }),
  )
  await Promise.resolve()
  expect(await runtime.runOnce("poll", async () => {})).toBe(false)
  await runtime.dispose(1)
  expect(await runtime.runOnce("poll", async () => {})).toBe(false)
  expect(runtime.lifetimeSignal.aborted).toBe(true)
  release()
  await work
  await expect(runtime.track(async () => 1)).rejects.toThrow("unloaded")
})

test("score selectors reject conflicting, fractional, nonfinite and impossible dates", () => {
  for (const count of [NaN, Infinity, -1, 0, 1.5, 1001])
    expect(validateScoreTarget({ count })).toBeTruthy()
  expect(validateScoreTarget({ session_id: "s", count: 1 })).toBeTruthy()
  expect(validateScoreTarget({ until: "2026-01-01" })).toBeTruthy()
  expect(validateScoreTarget({ since: "2026-02-30" })).toBeTruthy()
  expect(
    validateScoreTarget({ since: "2026-03-02", until: "2026-03-01" }),
  ).toBeTruthy()
  expect(calendarDate("2024-02-29")).toBeInstanceOf(Date)
  expect(calendarDate("2026-02-29")).toBeUndefined()
  expect(validateScoreTarget({ count: 2 })).toBeUndefined()
})

test("compaction renderer uses actual agent and bounds aggregate guidance", () => {
  const aggregate = {
    total_sessions: 2,
    avg_score: 0.8,
    top_weaknesses: [
      { pattern: "x".repeat(10000), count: 1, suggested_fix: "" },
    ],
    top_strengths: [],
    by_agent: {},
  }
  const stats = {
    total_sessions: 1,
    avg_score: 0.9,
    top_weaknesses: [],
    top_strengths: [],
  }
  const text = renderCompactionFeedback(aggregate, "reviewer", stats, 800)
  expect(text.length).toBeLessThanOrEqual(800)
  expect(text).toContain("reviewer Agent Stats")
  expect(text).not.toContain("build Agent Stats")
})
