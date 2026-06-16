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
    // Per-addition provenance: one `<!-- kasper: ... -->` per apply.
    // 2 applies here → 2 provenance lines (one for "rule 1", one for "rule 2").
    expect(countMatches(r2.updated, /<!-- kasper: 2026-06-16/g)).toBe(2)
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
    // 3 applies → 3 per-addition provenance lines
    expect(countMatches(r.updated, /<!-- kasper: 2026-06-16/g)).toBe(3)
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
    // Per-addition shape: existing content + blank line + new provenance + new content.
    expect(updated).toMatch(/first\n\n<!-- kasper:[^>]+-->\nsecond/)
  })

  test("P) provenance line appears immediately after section header", () => {
    const existing = "## Rules\nfirst"
    const { updated } = injectSectionContent(existing, "Rules", "second", NOW)
    // Per-addition shape: header → existing content → blank line → provenance → new content.
    const headerIdx = updated.indexOf("## Rules")
    const existingIdx = updated.indexOf("first")
    const provIdx = updated.indexOf("<!-- kasper:")
    const newContentIdx = updated.indexOf("second")
    expect(headerIdx).toBeGreaterThan(-1)
    expect(existingIdx).toBeGreaterThan(headerIdx)
    // The provenance comment is placed BEFORE the new entry's content, not after the header.
    expect(provIdx).toBeGreaterThan(existingIdx)
    expect(newContentIdx).toBeGreaterThan(provIdx)
  })

  // ---- Per-addition provenance shape ----

  test("R) per-addition: each apply's timestamp appears immediately before its content", () => {
    const T1 = new Date("2026-06-15T10:00:00.000Z")
    const T2 = new Date("2026-06-15T11:00:00.000Z")
    const T3 = new Date("2026-06-16T07:00:00.000Z")
    let doc =
      "# Project\n\nIntro.\n\n## Kasper Inferred Instructions\nold rule\n"
    doc = injectSectionContent(
      doc,
      "Kasper Inferred Instructions",
      "rule A",
      T1,
    ).updated
    doc = injectSectionContent(
      doc,
      "Kasper Inferred Instructions",
      "rule B",
      T2,
    ).updated
    doc = injectSectionContent(
      doc,
      "Kasper Inferred Instructions",
      "rule C",
      T3,
    ).updated

    // The three timestamps are present, in chronological order, each directly
    // above the rule it belongs to.
    expect(doc).toMatch(
      new RegExp(`<!-- kasper: ${T1.toISOString()} -->\nrule A`),
    )
    expect(doc).toMatch(
      new RegExp(`<!-- kasper: ${T2.toISOString()} -->\nrule B`),
    )
    expect(doc).toMatch(
      new RegExp(`<!-- kasper: ${T3.toISOString()} -->\nrule C`),
    )
    // Order is preserved (T1 before T2 before T3)
    expect(doc.indexOf(T1.toISOString())).toBeLessThan(
      doc.indexOf(T2.toISOString()),
    )
    expect(doc.indexOf(T2.toISOString())).toBeLessThan(
      doc.indexOf(T3.toISOString()),
    )
  })

  test("S) per-addition: no section-level timestamp; section header is immediately followed by content", () => {
    let doc = "## Rules\nold\n"
    doc = injectSectionContent(doc, "Rules", "new", NOW).updated
    // The first non-newline content after the `## Rules` header should be
    // `old` (the pre-existing rule), NOT a `<!-- kasper: ... -->` comment.
    const afterHeader = doc.split("## Rules")[1]
    expect(afterHeader).toMatch(/^\nold/)
  })

  test("T) migration: legacy file with section-level timestamp preserves it as legacy block timestamp", () => {
    // Files written by older kasper versions have:
    //   ## Kasper Inferred Instructions
    //   <!-- kasper: OLD_TS -->
    //   <rules>
    // The next apply must preserve the OLD_TS line and add a NEW provenance
    // for the new entry — no destructive rewrite of the legacy block.
    const OLD_TS = "2026-06-10T08:00:00.000Z"
    const NEW_TS = new Date("2026-06-16T07:00:00.000Z")
    const legacy = `# Project\n\n## Kasper Inferred Instructions\n<!-- kasper: ${OLD_TS} -->\nold rule\n`
    const result = injectSectionContent(
      legacy,
      "Kasper Inferred Instructions",
      "new rule",
      NEW_TS,
    ).updated

    // Both timestamps are present
    expect(result).toContain(OLD_TS)
    expect(result).toContain(NEW_TS.toISOString())
    // Legacy block content is preserved
    expect(result).toContain("old rule")
    // New entry is present
    expect(result).toContain("new rule")
    // Only one header
    expect(countMatches(result, /^## Kasper Inferred Instructions/gm)).toBe(1)
  })

  test("U) migration: a SECOND apply after migration uses per-addition for the new entry only", () => {
    const T_OLD = "2026-06-10T08:00:00.000Z"
    const T_NEW1 = new Date("2026-06-16T07:00:00.000Z")
    const T_NEW2 = new Date("2026-06-16T08:00:00.000Z")
    const legacy = `## Rules\n<!-- kasper: ${T_OLD} -->\nold\n`
    let doc = injectSectionContent(legacy, "Rules", "first new", T_NEW1).updated
    doc = injectSectionContent(doc, "Rules", "second new", T_NEW2).updated

    // The legacy timestamp is still there (it belongs to the legacy "old" block)
    expect(doc).toContain(T_OLD)
    // The two new entries each have their own timestamp
    expect(countMatches(doc, /<!-- kasper:/g)).toBe(3)
    expect(doc).toMatch(
      new RegExp(`<!-- kasper: ${T_NEW1.toISOString()} -->\nfirst new`),
    )
    expect(doc).toMatch(
      new RegExp(`<!-- kasper: ${T_NEW2.toISOString()} -->\nsecond new`),
    )
  })

  test("V) per-addition: gap between header and first content stays constant across applies", () => {
    // Regression for a body-normalization bug found while implementing this:
    // if the body's leading newline isn't normalized, the gap between the
    // section header and the first rule grows by 1 newline on every apply.
    let doc = "## Rules\nold\n"
    const apply = (s: string) =>
      injectSectionContent(s, "Rules", "x", NOW).updated
    doc = apply(doc)
    const after1 = doc
    doc = apply(doc)
    const after2 = doc
    doc = apply(doc)
    const after3 = doc
    // The substring between `## Rules` and `old` should be the same in all 3.
    const gap = (s: string) => (s.match(/## Rules([\s\S]*?)old/) || ["", ""])[1]
    expect(gap(after1)).toBe(gap(after2))
    expect(gap(after2)).toBe(gap(after3))
  })
})
