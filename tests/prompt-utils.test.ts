import { describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  escapeRegex,
  exists,
  injectSectionContent,
  parseTimestampFromFilename,
  timestampFilename,
  withPathWriteLock,
  writeTextAtomic,
} from "../src/prompt-utils.js"

describe("timestampFilename", () => {
  test("returns a filename containing the label", () => {
    const name = timestampFilename("backup")
    expect(name).toContain("backup")
    expect(name.endsWith(".md")).toBe(true)
  })

  test("returns a filename with ISO timestamp prefix", () => {
    const name = timestampFilename("snapshot")
    const parts = name.split("--")
    expect(parts.length).toBe(3)
    const tsPart = parts[0]
    expect(tsPart).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/)
  })

  test("includes a random suffix between timestamp and label", () => {
    const name = timestampFilename("test")
    const parts = name.split("--")
    const suffix = parts[1]
    expect(suffix.length).toBe(6)
    expect(suffix).toMatch(/^[a-z0-9]{6}$/)
  })

  test("produces different filenames on consecutive calls", () => {
    const a = timestampFilename("label")
    const b = timestampFilename("label")
    const c = timestampFilename("label")
    const unique = new Set([a, b, c])
    expect(unique.size).toBeGreaterThanOrEqual(2)
  })

  test("handles labels with special filename characters", () => {
    const name = timestampFilename("my backup #1")
    expect(name).toContain("my backup #1")
  })
})

describe("exists", () => {
  test("returns true for an existing file", async () => {
    const dir = tmpdir()
    const path = join(dir, `exists-test-${randomBytes(4).toString("hex")}.txt`)
    await writeFile(path, "hello", "utf-8")
    const result = await exists(path)
    expect(result).toBe(true)
    await rm(path, { force: true })
  })

  test("returns false for a non-existing file", async () => {
    const dir = tmpdir()
    const path = join(dir, `nonexistent-${randomBytes(8).toString("hex")}.txt`)
    const result = await exists(path)
    expect(result).toBe(false)
  })

  test("returns true for an existing directory", async () => {
    const result = await exists(tmpdir())
    expect(result).toBe(true)
  })
})

describe("parseTimestampFromFilename", () => {
  test("returns a valid epoch number for a well-formed filename", () => {
    const ts = parseTimestampFromFilename(
      "2025-05-15T12-30-45--abc123--backup.md",
    )
    expect(ts).toBeGreaterThan(0)
    expect(typeof ts).toBe("number")
  })

  test("returns 0 for an invalid timestamp", () => {
    expect(parseTimestampFromFilename("not-a-valid-name.md")).toBe(0)
  })

  test("returns 0 for a filename with too-short timestamp part", () => {
    expect(parseTimestampFromFilename("2025--suffix--label.md")).toBe(0)
  })
})

describe("escapeRegex", () => {
  test("escapes special regex characters", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional regex character test
    expect(escapeRegex(".+*?^${}()[]\\")).toBe(
      "\\.\\+\\*\\?\\^\\$\\{\\}\\(\\)\\[\\]\\\\",
    )
  })

  test("returns unchanged string when no special chars", () => {
    expect(escapeRegex("hello world")).toBe("hello world")
  })
})

describe("withPathWriteLock", () => {
  test("serializes concurrent writes to the same path", async () => {
    const results: number[] = []
    const run = async (id: number) => {
      await withPathWriteLock("/test/lock", async () => {
        results.push(id)
        await new Promise((r) => setTimeout(r, 20))
      })
    }

    await Promise.all([run(1), run(2), run(3)])
    expect(results).toEqual([1, 2, 3])
  })

  test("allows independent paths to run in parallel", async () => {
    const results: number[] = []
    const run = async (id: number, path: string) => {
      await withPathWriteLock(path, async () => {
        results.push(id)
        await new Promise((r) => setTimeout(r, 20))
      })
    }

    await Promise.all([run(1, "/path/a"), run(2, "/path/b")])
    expect(results.sort()).toEqual([1, 2])
  })
})

describe("writeTextAtomic", () => {
  test("writes and reads back content", async () => {
    const dir = join(tmpdir(), `atomic-${randomBytes(4).toString("hex")}`)
    const path = join(dir, "test.txt")
    await writeTextAtomic(path, "hello world")
    const content = await readFile(path, "utf-8")
    expect(content).toBe("hello world")
    await rm(dir, { recursive: true, force: true })
  })
})

describe("injectSectionContent", () => {
  const NOW = new Date("2026-06-16T05:33:11.079Z")
  const countMatches = (s: string, re: RegExp) => (s.match(re) || []).length

  // ---- Section exists — accumulation behavior ----

  test("A) section at start of file — no regression", () => {
    const existing = "## My Section\nold rule\n## Other\nstuff"
    const { updated, existed } = injectSectionContent(
      existing,
      "My Section",
      "new rule",
      NOW,
    )
    expect(existed).toBe(true)
    expect(updated).toContain("old rule")
    expect(updated).toContain("new rule")
    expect(countMatches(updated, /^## My Section/gm)).toBe(1)
    expect(updated).toContain("## Other\nstuff")
  })

  test("B) section preceded by # Title — the bug case (regression test for Issue #1)", () => {
    const existing =
      "# Title\n\nIntro paragraph.\n\n## My Section\nold rule\n\n## Other\nstuff"
    const { updated, existed } = injectSectionContent(
      existing,
      "My Section",
      "new rule",
      NOW,
    )
    expect(existed).toBe(true)
    expect(updated).toContain("Intro paragraph.")
    expect(updated).toContain("old rule")
    expect(updated).toContain("new rule")
    // Critical: exactly ONE ## My Section header, not two.
    expect(countMatches(updated, /^## My Section/gm)).toBe(1)
    // Chronological order: old before new
    expect(updated.indexOf("old rule")).toBeLessThan(
      updated.indexOf("new rule"),
    )
    // Surrounding sections preserved
    expect(updated).toContain("## Other")
  })

  test("C) section preceded by YAML frontmatter — common agent-prompt case", () => {
    const existing =
      "---\nmode: subagent\n---\n\nYou are a build agent.\n\n## Kasper Rules\nold rule\n\n## Other\nstuff"
    const { updated, existed } = injectSectionContent(
      existing,
      "Kasper Rules",
      "new rule",
      NOW,
    )
    expect(existed).toBe(true)
    expect(updated).toContain("mode: subagent")
    expect(updated).toContain("You are a build agent.")
    expect(updated).toContain("old rule")
    expect(updated).toContain("new rule")
    // Critical: exactly ONE ## Kasper Rules header
    expect(countMatches(updated, /^## Kasper Rules/gm)).toBe(1)
  })

  test("D) section at EOF with no trailing newline", () => {
    const existing = "## My Section\nold rule" // no final \n
    const { updated, existed } = injectSectionContent(
      existing,
      "My Section",
      "new rule",
      NOW,
    )
    expect(existed).toBe(true)
    expect(updated).toContain("old rule")
    expect(updated).toContain("new rule")
    expect(countMatches(updated, /^## My Section/gm)).toBe(1)
    // The file should now end with a newline (Issue #3 consistency)
    expect(updated.endsWith("\n")).toBe(true)
  })

  test("E) section preceded by other section content", () => {
    const existing =
      "## Intro\nWelcome.\n\n## Kasper Rules\nfirst\n\n## Notes\nsee below"
    const { updated, existed } = injectSectionContent(
      existing,
      "Kasper Rules",
      "second",
      NOW,
    )
    expect(existed).toBe(true)
    expect(updated).toContain("Welcome.")
    expect(updated).toContain("first")
    expect(updated).toContain("second")
    expect(countMatches(updated, /^## Kasper Rules/gm)).toBe(1)
    expect(countMatches(updated, /^## /gm)).toBe(3) // Intro, Kasper Rules, Notes
  })

  test("F) header-only section (## Section with no body)", () => {
    const existing = "# Title\n\n## My Section"
    const { updated, existed } = injectSectionContent(
      existing,
      "My Section",
      "first rule",
      NOW,
    )
    expect(existed).toBe(true)
    expect(countMatches(updated, /^## My Section/gm)).toBe(1)
    expect(updated).toContain("first rule")
    expect(updated.endsWith("\n")).toBe(true)
  })

  test("G) double-apply accumulation — no nested headers, no stacked provenance", () => {
    const existing = "# Title\n\nintro\n\n## Rules\nold\n"
    const r1 = injectSectionContent(existing, "Rules", "rule 1", NOW)
    const r2 = injectSectionContent(r1.updated, "Rules", "rule 2", NOW)
    expect(r2.existed).toBe(true)
    expect(r2.updated).toContain("old")
    expect(r2.updated).toContain("rule 1")
    expect(r2.updated).toContain("rule 2")
    expect(countMatches(r2.updated, /^## Rules/gm)).toBe(1)
    // Exactly ONE provenance line, not stacked
    expect(countMatches(r2.updated, /<!-- kasper: 2026-06-16/g)).toBe(1)
    // Order: old < rule 1 < rule 2
    expect(r2.updated.indexOf("old")).toBeLessThan(r2.updated.indexOf("rule 1"))
    expect(r2.updated.indexOf("rule 1")).toBeLessThan(
      r2.updated.indexOf("rule 2"),
    )
  })

  test("H) triple-apply accumulation", () => {
    const existing = "# Title\n\n## Rules\nold\n"
    let r = injectSectionContent(existing, "Rules", "a", NOW)
    r = injectSectionContent(r.updated, "Rules", "b", NOW)
    r = injectSectionContent(r.updated, "Rules", "c", NOW)
    expect(r.updated).toContain("old")
    expect(r.updated).toContain("a")
    expect(r.updated).toContain("b")
    expect(r.updated).toContain("c")
    expect(countMatches(r.updated, /^## Rules/gm)).toBe(1)
    expect(countMatches(r.updated, /<!-- kasper: 2026-06-16/g)).toBe(1)
  })

  test("I) section doesn't exist — appends new section at end", () => {
    const existing = "# Title\n\nintro\n\n## Other\nstuff"
    const { updated, existed } = injectSectionContent(
      existing,
      "Kasper Rules",
      "new rule",
      NOW,
    )
    expect(existed).toBe(false)
    expect(updated).toContain("## Kasper Rules")
    expect(updated).toContain("new rule")
    expect(updated).toContain("## Other")
    // New section appears AFTER existing sections
    expect(updated.indexOf("## Other")).toBeLessThan(
      updated.indexOf("## Kasper Rules"),
    )
  })

  test("J) section doesn't exist, empty file", () => {
    const { updated, existed } = injectSectionContent(
      "",
      "Kasper Rules",
      "new rule",
      NOW,
    )
    expect(existed).toBe(false)
    expect(updated).toContain("## Kasper Rules")
    expect(updated).toContain("new rule")
    expect(updated.endsWith("\n")).toBe(true)
  })

  test("K) section name with regex special chars", () => {
    const existing = "## My Section (v2.0)\nold\n"
    const { updated, existed } = injectSectionContent(
      existing,
      "My Section (v2.0)",
      "new",
      NOW,
    )
    expect(existed).toBe(true)
    expect(updated).toContain("old")
    expect(updated).toContain("new")
    expect(countMatches(updated, /^## My Section \(v2\.0\)/gm)).toBe(1)
  })

  test("L) CRLF line endings (Windows file)", () => {
    const existing =
      "# Title\r\n\r\n## My Section\r\nold rule\r\n\r\n## Other\r\nstuff\r\n"
    const { updated, existed } = injectSectionContent(
      existing,
      "My Section",
      "new rule",
      NOW,
    )
    expect(existed).toBe(true)
    expect(updated).toContain("old rule")
    expect(updated).toContain("new rule")
    expect(countMatches(updated, /^## My Section/gm)).toBe(1)
  })

  test("M) section with extra whitespace in header (##   Section)", () => {
    const existing = "# Title\n\n##   My Section\nold\n"
    const { updated, existed } = injectSectionContent(
      existing,
      "My Section",
      "new",
      NOW,
    )
    expect(existed).toBe(true)
    expect(updated).toContain("old")
    expect(updated).toContain("new")
    expect(countMatches(updated, /^##\s+My Section/gm)).toBe(1)
  })

  test("N) middle section preserves order: A < Target < B", () => {
    const existing = "## A\naaa\n\n## Target\nold\n\n## B\nbbb"
    const { updated } = injectSectionContent(existing, "Target", "new", NOW)
    const aIdx = updated.indexOf("## A")
    const tIdx = updated.indexOf("## Target")
    const bIdx = updated.indexOf("## B")
    expect(aIdx).toBeGreaterThan(-1)
    expect(tIdx).toBeGreaterThan(aIdx)
    expect(bIdx).toBeGreaterThan(tIdx)
    expect(updated.indexOf("aaa")).toBeLessThan(updated.indexOf("old"))
    expect(updated.indexOf("old")).toBeLessThan(updated.indexOf("new"))
    expect(updated.indexOf("new")).toBeLessThan(updated.indexOf("bbb"))
  })

  test("O) accumulated content has blank-line separator", () => {
    const existing = "## Rules\nfirst"
    const { updated } = injectSectionContent(existing, "Rules", "second", NOW)
    // The helper should join with `\n\n` between old and new
    expect(updated).toMatch(/first\n\nsecond/)
  })

  test("P) provenance line appears immediately after section header", () => {
    const existing = "## Rules\nfirst"
    const { updated } = injectSectionContent(existing, "Rules", "second", NOW)
    const headerIdx = updated.indexOf("## Rules")
    const provIdx = updated.indexOf("<!-- kasper:")
    const bodyIdx = updated.indexOf("first")
    expect(headerIdx).toBeGreaterThan(-1)
    expect(provIdx).toBeGreaterThan(headerIdx)
    expect(bodyIdx).toBeGreaterThan(provIdx)
  })

  test("Q) repeated apply strips old provenance so it doesn't stack", () => {
    // If the bug is reintroduced, every apply will add a provenance line at
    // the top of the body, leading to N provenance lines after N applies.
    let existing = "# Title\n\n## Rules\nold\n"
    for (let i = 0; i < 5; i++) {
      const r = injectSectionContent(existing, "Rules", `r${i}`, NOW)
      existing = r.updated
    }
    expect(countMatches(existing, /<!-- kasper:/g)).toBe(1)
    // And still only one header
    expect(countMatches(existing, /^## Rules/gm)).toBe(1)
  })
})
