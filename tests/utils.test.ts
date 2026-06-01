import { describe, expect, test } from "bun:test"
import type { WeaknessPattern } from "../src/types.js"
import {
  findMatchingWeakness,
  getSessionID,
  weaknessSimilarity,
} from "../src/utils.js"

describe("weaknessSimilarity", () => {
  test("returns 1.0 for identical strings", () => {
    expect(weaknessSimilarity("slow response", "slow response")).toBe(1.0)
  })

  test("returns 0.0 for completely different strings", () => {
    expect(weaknessSimilarity("slow response", "great speed")).toBe(0)
  })

  test("is case insensitive", () => {
    expect(weaknessSimilarity("Slow Response", "slow response")).toBe(1.0)
  })

  test("trims whitespace", () => {
    expect(weaknessSimilarity("  slow response  ", "slow response")).toBe(1.0)
  })

  test("returns 0.85 for substring match", () => {
    expect(weaknessSimilarity("slow response time", "slow response")).toBe(0.85)
    expect(weaknessSimilarity("slow response", "response time is slow")).toBe(
      2 / 3,
    )
  })

  test("computes Jaccard word overlap", () => {
    const sim = weaknessSimilarity(
      "agent missed important detail",
      "agent forgot key detail",
    )
    expect(sim).toBeGreaterThan(0)
    expect(sim).toBeLessThan(1)
  })

  test("returns 1 for empty strings (identical)", () => {
    expect(weaknessSimilarity("", "")).toBe(1)
  })
})

describe("findMatchingWeakness", () => {
  test("returns matching weakness when above threshold and min observations", () => {
    const topWeaknesses: WeaknessPattern[] = [
      { pattern: "slow response", count: 5, suggested_fix: "speed up" },
      { pattern: "misses details", count: 2, suggested_fix: "check details" },
    ]

    const result = findMatchingWeakness(
      ["slow response", "unrelated"],
      topWeaknesses,
      3,
    )
    expect(result).toBeDefined()
    expect(result?.pattern).toBe("slow response")
  })

  test("returns undefined when count below min observations", () => {
    const topWeaknesses: WeaknessPattern[] = [
      { pattern: "slow response", count: 2, suggested_fix: "speed up" },
    ]

    const result = findMatchingWeakness(["slow response"], topWeaknesses, 3)
    expect(result).toBeUndefined()
  })

  test("returns undefined when no similarity above 0.5", () => {
    const topWeaknesses: WeaknessPattern[] = [
      { pattern: "slow response", count: 5, suggested_fix: "speed up" },
    ]

    const result = findMatchingWeakness(
      ["completely different issue"],
      topWeaknesses,
      3,
    )
    expect(result).toBeUndefined()
  })

  test("matches via substring similarity", () => {
    const topWeaknesses: WeaknessPattern[] = [
      { pattern: "misses context", count: 4, suggested_fix: "read more" },
    ]

    const result = findMatchingWeakness(
      ["agent often misses context and makes wrong changes"],
      topWeaknesses,
      3,
    )
    expect(result).toBeDefined()
    expect(result?.pattern).toBe("misses context")
  })
})

describe("getSessionID", () => {
  test("extracts sessionID at top level", () => {
    expect(getSessionID({ sessionID: "abc-123" })).toBe("abc-123")
  })

  test("extracts from event.sessionID", () => {
    expect(getSessionID({ event: { sessionID: "evt-456" } })).toBe("evt-456")
  })

  test("extracts from event.properties.sessionID", () => {
    expect(
      getSessionID({
        event: { properties: { sessionID: "props-789" } },
      }),
    ).toBe("props-789")
  })

  test("extracts from event.properties.sessionId (camelCase)", () => {
    expect(
      getSessionID({
        event: { properties: { sessionId: "camel-101" } },
      }),
    ).toBe("camel-101")
  })

  test("extracts from properties.sessionID", () => {
    expect(getSessionID({ properties: { sessionID: "direct-202" } })).toBe(
      "direct-202",
    )
  })

  test("extracts from session.id", () => {
    expect(getSessionID({ session: { id: "sess-303" } })).toBe("sess-303")
  })

  test("extracts from info.sessionID", () => {
    expect(getSessionID({ info: { sessionID: "info-404" } })).toBe("info-404")
  })

  test("returns undefined for null sessionID", () => {
    expect(getSessionID({ sessionID: null })).toBeUndefined()
  })

  test("returns undefined for undefined input", () => {
    expect(getSessionID(undefined)).toBeUndefined()
  })

  test("returns undefined for empty object", () => {
    expect(getSessionID({})).toBeUndefined()
  })

  test("trims whitespace from sessionID", () => {
    expect(getSessionID({ sessionID: "  spaced-505  " })).toBe("spaced-505")
  })

  test("prefers top-level sessionID over nested", () => {
    expect(
      getSessionID({
        sessionID: "top-level",
        event: { sessionID: "nested" },
      }),
    ).toBe("top-level")
  })

  test("converts numeric sessionID to string", () => {
    expect(getSessionID({ sessionID: 42 })).toBe("42")
  })
})
