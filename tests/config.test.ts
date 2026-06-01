import { describe, expect, test } from "bun:test"
import { normalizeKasperConfig } from "../src/config.js"

describe("normalizeKasperConfig", () => {
  test("returns empty object for empty input", () => {
    expect(normalizeKasperConfig({})).toEqual({})
  })

  test("normalizes boolean fields from boolean values", () => {
    expect(normalizeKasperConfig({ enabled: true })).toHaveProperty(
      "enabled",
      true,
    )
    expect(normalizeKasperConfig({ enabled: false })).toHaveProperty(
      "enabled",
      false,
    )
    expect(normalizeKasperConfig({ auto_update: false })).toHaveProperty(
      "auto_update",
      false,
    )
    expect(normalizeKasperConfig({ evaluate_subagents: true })).toHaveProperty(
      "evaluate_subagents",
      true,
    )
  })

  test("normalizes boolean fields from string values", () => {
    expect(normalizeKasperConfig({ enabled: "true" })).toHaveProperty(
      "enabled",
      true,
    )
    expect(normalizeKasperConfig({ enabled: "false" })).toHaveProperty(
      "enabled",
      false,
    )
    expect(normalizeKasperConfig({ enabled: "TRUE" })).toHaveProperty(
      "enabled",
      true,
    )
    expect(normalizeKasperConfig({ enabled: "FALSE" })).toHaveProperty(
      "enabled",
      false,
    )
  })

  test("normalizes scoring_threshold with clamping 0-1", () => {
    expect(normalizeKasperConfig({ scoring_threshold: 0.7 })).toHaveProperty(
      "scoring_threshold",
      0.7,
    )
    expect(normalizeKasperConfig({ scoring_threshold: 0 })).toHaveProperty(
      "scoring_threshold",
      0,
    )
    expect(normalizeKasperConfig({ scoring_threshold: 1 })).toHaveProperty(
      "scoring_threshold",
      1,
    )
    expect(normalizeKasperConfig({ scoring_threshold: 2 })).toHaveProperty(
      "scoring_threshold",
      1,
    )
    expect(normalizeKasperConfig({ scoring_threshold: -0.5 })).toHaveProperty(
      "scoring_threshold",
      0,
    )
  })

  test("rejects non-numeric scoring_threshold", () => {
    expect(
      normalizeKasperConfig({ scoring_threshold: "bad" }),
    ).not.toHaveProperty("scoring_threshold")
    expect(
      normalizeKasperConfig({ scoring_threshold: NaN }),
    ).not.toHaveProperty("scoring_threshold")
  })

  test("normalizes model string with trimming", () => {
    expect(normalizeKasperConfig({ model: "  openai/gpt-4  " })).toHaveProperty(
      "model",
      "openai/gpt-4",
    )
  })

  test("rejects empty/whitespace model strings", () => {
    expect(normalizeKasperConfig({ model: "   " })).not.toHaveProperty("model")
    expect(normalizeKasperConfig({ model: "" })).not.toHaveProperty("model")
  })

  test("rejects non-string model", () => {
    expect(normalizeKasperConfig({ model: 123 })).not.toHaveProperty("model")
    expect(normalizeKasperConfig({ model: true })).not.toHaveProperty("model")
  })

  test("normalizes detail_level enum", () => {
    expect(normalizeKasperConfig({ detail_level: "minimal" })).toHaveProperty(
      "detail_level",
      "minimal",
    )
    expect(normalizeKasperConfig({ detail_level: "standard" })).toHaveProperty(
      "detail_level",
      "standard",
    )
    expect(normalizeKasperConfig({ detail_level: "thorough" })).toHaveProperty(
      "detail_level",
      "thorough",
    )
    expect(
      normalizeKasperConfig({ detail_level: "invalid" }),
    ).not.toHaveProperty("detail_level")
  })

  test("normalizes weakness_decay_days with clamping 0-365", () => {
    expect(normalizeKasperConfig({ weakness_decay_days: 30 })).toHaveProperty(
      "weakness_decay_days",
      30,
    )
    expect(normalizeKasperConfig({ weakness_decay_days: 0 })).toHaveProperty(
      "weakness_decay_days",
      0,
    )
    expect(normalizeKasperConfig({ weakness_decay_days: -1 })).toHaveProperty(
      "weakness_decay_days",
      0,
    )
    expect(normalizeKasperConfig({ weakness_decay_days: 400 })).toHaveProperty(
      "weakness_decay_days",
      365,
    )
  })

  test("normalizes min_session_messages with clamping 1-50", () => {
    expect(normalizeKasperConfig({ min_session_messages: 3 })).toHaveProperty(
      "min_session_messages",
      3,
    )
    expect(normalizeKasperConfig({ min_session_messages: 1 })).toHaveProperty(
      "min_session_messages",
      1,
    )
    expect(normalizeKasperConfig({ min_session_messages: 0 })).toHaveProperty(
      "min_session_messages",
      1,
    )
    expect(normalizeKasperConfig({ min_session_messages: 60 })).toHaveProperty(
      "min_session_messages",
      50,
    )
  })

  test("normalizes debug from boolean and string", () => {
    expect(normalizeKasperConfig({ debug: true })).toHaveProperty("debug", true)
    expect(normalizeKasperConfig({ debug: false })).toHaveProperty(
      "debug",
      false,
    )
    expect(normalizeKasperConfig({ debug: "true" })).toHaveProperty(
      "debug",
      true,
    )
    expect(normalizeKasperConfig({ debug: "false" })).toHaveProperty(
      "debug",
      false,
    )
  })

  test("normalizes evaluation_poll_interval_ms with clamping 1000-300000", () => {
    expect(
      normalizeKasperConfig({ evaluation_poll_interval_ms: 5000 }),
    ).toHaveProperty("evaluation_poll_interval_ms", 5000)
    expect(
      normalizeKasperConfig({ evaluation_poll_interval_ms: 500 }),
    ).toHaveProperty("evaluation_poll_interval_ms", 1000)
    expect(
      normalizeKasperConfig({ evaluation_poll_interval_ms: 400000 }),
    ).toHaveProperty("evaluation_poll_interval_ms", 300000)
  })

  test("normalizes scoring_retries with clamping 0-10", () => {
    expect(normalizeKasperConfig({ scoring_retries: 3 })).toHaveProperty(
      "scoring_retries",
      3,
    )
    expect(normalizeKasperConfig({ scoring_retries: -1 })).toHaveProperty(
      "scoring_retries",
      0,
    )
    expect(normalizeKasperConfig({ scoring_retries: 15 })).toHaveProperty(
      "scoring_retries",
      10,
    )
  })

  test("normalizes scoring_timeout_ms with clamping 10000-600000", () => {
    expect(normalizeKasperConfig({ scoring_timeout_ms: 60000 })).toHaveProperty(
      "scoring_timeout_ms",
      60000,
    )
    expect(normalizeKasperConfig({ scoring_timeout_ms: 5000 })).toHaveProperty(
      "scoring_timeout_ms",
      10000,
    )
    expect(
      normalizeKasperConfig({ scoring_timeout_ms: 700000 }),
    ).toHaveProperty("scoring_timeout_ms", 600000)
  })

  test("normalizes max_score_input_chars with clamping 1000-50000", () => {
    expect(
      normalizeKasperConfig({ max_score_input_chars: 15000 }),
    ).toHaveProperty("max_score_input_chars", 15000)
    expect(
      normalizeKasperConfig({ max_score_input_chars: 500 }),
    ).toHaveProperty("max_score_input_chars", 1000)
    expect(
      normalizeKasperConfig({ max_score_input_chars: 60000 }),
    ).toHaveProperty("max_score_input_chars", 50000)
  })

  test("ignores unknown keys", () => {
    const result = normalizeKasperConfig({ unknown_field: "value" })
    expect(result).not.toHaveProperty("unknown_field")
  })

  test("handles multiple fields at once", () => {
    const result = normalizeKasperConfig({
      enabled: "true",
      scoring_threshold: 0.42,
      model: "test/model",
      debug: "false",
      min_session_messages: 5,
      evaluation_poll_interval_ms: 5000,
      scoring_retries: 3,
      scoring_timeout_ms: 60000,
      max_score_input_chars: 15000,
    })
    expect(result.enabled).toBe(true)
    expect(result.scoring_threshold).toBe(0.42)
    expect(result.model).toBe("test/model")
    expect(result.debug).toBe(false)
    expect(result.min_session_messages).toBe(5)
    expect(result.evaluation_poll_interval_ms).toBe(5000)
    expect(result.scoring_retries).toBe(3)
    expect(result.scoring_timeout_ms).toBe(60000)
    expect(result.max_score_input_chars).toBe(15000)
  })
})
