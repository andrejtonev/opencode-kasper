import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentsMdManager } from "../src/agents-md.js"
import { escapeRegex, parseTimestampFromFilename } from "../src/prompt-utils.js"

function tmpDir(): string {
  return join(tmpdir(), `kasper-test-${randomBytes(6).toString("hex")}`)
}

describe("escapeRegex", () => {
  test("escapes special regex characters", () => {
    expect(escapeRegex("test.string*with+special(chars)")).toBe(
      "test\\.string\\*with\\+special\\(chars\\)",
    )
  })

  test("returns unchanged string with no special chars", () => {
    expect(escapeRegex("hello_world")).toBe("hello_world")
  })
})

describe("parseTimestampFromFilename", () => {
  test("parses ISO timestamp from filename", () => {
    const result = parseTimestampFromFilename("2025-01-15T10-30-00--label.md")
    expect(result).toBeGreaterThan(0)
    expect(new Date(result).toISOString().slice(0, 10)).toBe("2025-01-15")
  })

  test("returns 0 for invalid timestamp", () => {
    expect(parseTimestampFromFilename("not-a-timestamp")).toBe(0)
  })
})

describe("AgentsMdManager", () => {
  let testDir: string
  let projectRoot: string
  let stateDir: string
  let manager: AgentsMdManager

  beforeEach(async () => {
    testDir = tmpDir()
    projectRoot = testDir
    stateDir = join(testDir, ".opencode", "kasper")
    manager = new AgentsMdManager(projectRoot, stateDir, 5)
    await manager.init()
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  describe("read/write", () => {
    test("read returns empty string when no AGENTS.md exists", async () => {
      expect(await manager.read()).toBe("")
    })

    test("write creates and read returns content", async () => {
      await manager.write("# AGENTS\nBe helpful.")
      expect(await manager.read()).toBe("# AGENTS\nBe helpful.")
    })
  })

  describe("injectSection", () => {
    test("appends section when no sections exist", () => {
      const result = manager.injectSection("", "My Section", "do X and Y")
      expect(result).toContain("## My Section")
      expect(result).toContain("do X and Y")
    })

    test("inserts section at end when other sections exist", () => {
      const existing = "## Existing\ncontent here"
      const result = manager.injectSection(
        existing,
        "New Section",
        "new content",
      )
      expect(result).toContain("## Existing")
      expect(result).toContain("## New Section")
      expect(result.indexOf("## Existing")).toBeLessThan(
        result.indexOf("## New Section"),
      )
    })

    test("accumulates content in existing section", () => {
      const existing = "## My Section\nold content\n## Other\nother stuff"
      const result = manager.injectSection(
        existing,
        "My Section",
        "new content",
      )
      expect(result).toContain("new content")
      expect(result).toContain("old content")
      expect(result).toContain("## Other")
    })

    test("trims trailing whitespace and preserves old", () => {
      const existing = "## My Section\nold\n"
      const result = manager.injectSection(existing, "My Section", "new\n\n")
      expect(result).toContain("## My Section")
      expect(result).toContain("new")
      expect(result).toContain("old")
      expect(result).toMatch(/<!-- kasper:/)
    })

    test("section header includes section name", () => {
      const result = manager.injectSection(
        "",
        "Kasper Inferred Instructions",
        "rules",
      )
      expect(result).toContain("## Kasper Inferred Instructions")
    })

    test("preserves existing section body and adds new content", () => {
      const existing = "## My Section\nold rule\n## Other\nstuff"
      const result = manager.injectSection(existing, "My Section", "new rule")
      expect(result).toContain("old rule")
      expect(result).toContain("new rule")
      expect(result).toContain("## Other")
      expect(result).toMatch(/<!-- kasper:/)
    })

    test("when section doesn't exist, creates it as normal", () => {
      const existing = "## Existing\nstuff"
      const result = manager.injectSection(
        existing,
        "New Section",
        "fresh content",
      )
      expect(result).toContain("fresh content")
      expect(result).toContain("## New Section")
      expect(result).toContain("## Existing")
    })

    test("accumulates multiple improvements in order", () => {
      let doc = "## Rules\ncode of conduct\n"
      doc = manager.injectSection(doc, "Rules", "first rule")
      doc = manager.injectSection(doc, "Rules", "second rule")
      expect(doc).toContain("first rule")
      expect(doc).toContain("second rule")
      expect(doc).toContain("code of conduct")
    })

    // ---- Regression tests for the critical regex-anchoring bug (Issue #1) ----

    test("does NOT produce nested headers when section is preceded by # Title", () => {
      // This is the real-world case that the original PR did not cover: a
      // typical AGENTS.md starts with a # Title and intro paragraphs.
      const existing =
        "# My Project\n\nIntro paragraph.\n\n## Kasper Inferred Instructions\nold rule\n\n## Other\nstuff"
      const result = manager.injectSection(
        existing,
        "Kasper Inferred Instructions",
        "new rule",
      )
      // Critical assertion: exactly ONE ## Kasper Inferred Instructions header
      const headerCount = (
        result.match(/^## Kasper Inferred Instructions/gm) || []
      ).length
      expect(headerCount).toBe(1)
      expect(result).toContain("old rule")
      expect(result).toContain("new rule")
      expect(result).toContain("## Other")
      expect(result).toContain("# My Project")
      // Chronological order: old < new
      expect(result.indexOf("old rule")).toBeLessThan(
        result.indexOf("new rule"),
      )
    })

    test("does NOT produce nested headers when section is preceded by another ## section", () => {
      const existing =
        "## Intro\nWelcome.\n\n## Kasper Inferred Instructions\nold\n\n## Notes\nsee below"
      const result = manager.injectSection(
        existing,
        "Kasper Inferred Instructions",
        "new",
      )
      const headerCount = (
        result.match(/^## Kasper Inferred Instructions/gm) || []
      ).length
      expect(headerCount).toBe(1)
      const totalHeaders = (result.match(/^## /gm) || []).length
      expect(totalHeaders).toBe(3)
    })

    test("double-apply produces only ONE provenance line (no stacking)", () => {
      let doc = "# Title\n\nintro\n\n## Rules\nold\n"
      doc = manager.injectSection(doc, "Rules", "rule 1")
      doc = manager.injectSection(doc, "Rules", "rule 2")
      const provenanceCount = (doc.match(/<!-- kasper:/g) || []).length
      expect(provenanceCount).toBe(1)
    })

    test("triple-apply still produces only ONE header (no accumulation bug)", () => {
      let doc = "## Rules\nold\n"
      doc = manager.injectSection(doc, "Rules", "a")
      doc = manager.injectSection(doc, "Rules", "b")
      doc = manager.injectSection(doc, "Rules", "c")
      const headerCount = (doc.match(/^## Rules/gm) || []).length
      expect(headerCount).toBe(1)
      expect(doc).toContain("old")
      expect(doc).toContain("a")
      expect(doc).toContain("b")
      expect(doc).toContain("c")
    })

    test("preserves trailing newline when section is the last thing in the file", () => {
      // Issue #3: the new-section path always ended with \n; the old
      // replace path sometimes dropped the trailing newline.
      const result = manager.injectSection(
        "## My Section\nold",
        "My Section",
        "new",
      )
      expect(result.endsWith("\n")).toBe(true)
    })

    test("preserves content order: A < Target < B when target is in the middle", () => {
      const existing = "## A\naaa\n\n## Target\nold\n\n## B\nbbb"
      const result = manager.injectSection(existing, "Target", "new")
      const aIdx = result.indexOf("## A")
      const tIdx = result.indexOf("## Target")
      const bIdx = result.indexOf("## B")
      expect(aIdx).toBeGreaterThan(-1)
      expect(tIdx).toBeGreaterThan(aIdx)
      expect(bIdx).toBeGreaterThan(tIdx)
      expect(result.indexOf("aaa")).toBeLessThan(result.indexOf("old"))
      expect(result.indexOf("old")).toBeLessThan(result.indexOf("new"))
      expect(result.indexOf("new")).toBeLessThan(result.indexOf("bbb"))
    })

    test("handles section name with regex special characters", () => {
      const existing = "## My Section (v2.0)\nold\n"
      const result = manager.injectSection(existing, "My Section (v2.0)", "new")
      const headerCount = (result.match(/^## My Section \(v2\.0\)/gm) || [])
        .length
      expect(headerCount).toBe(1)
      expect(result).toContain("old")
      expect(result).toContain("new")
    })

    test("CRLF line endings: still produces only one header", () => {
      const existing =
        "# Title\r\n\r\n## My Section\r\nold rule\r\n\r\n## Other\r\nstuff\r\n"
      const result = manager.injectSection(existing, "My Section", "new rule")
      const headerCount = (result.match(/^## My Section/gm) || []).length
      expect(headerCount).toBe(1)
      expect(result).toContain("old rule")
      expect(result).toContain("new rule")
    })
  })

  describe("removeSection", () => {
    test("removes specified section", () => {
      const existing =
        "## Keep\nkeep content\n## Remove\nbad content\n## AlsoKeep\nmore"
      const result = manager.removeSection(existing, "Remove")
      expect(result).toContain("## Keep")
      expect(result).not.toContain("bad content")
      expect(result).toContain("## AlsoKeep")
    })

    test("removes last section", () => {
      const existing = "## Keep\ncontent\n## Remove\nbad"
      const result = manager.removeSection(existing, "Remove")
      expect(result).toContain("## Keep")
      expect(result).not.toContain("bad")
    })

    test("does nothing when section not found", () => {
      const existing = "## Keep\ncontent"
      const result = manager.removeSection(existing, "Missing")
      expect(result.trim()).toBe("## Keep\ncontent")
    })
  })

  describe("backup and rollback", () => {
    test("backup creates a file in backups directory", async () => {
      await manager.write("# Original")
      const backupPath = await manager.backup("before-change")
      const content = await readFile(backupPath, "utf-8")
      expect(content).toBe("# Original")
    })

    test("rollback restores from latest backup and saves pre-rollback backup", async () => {
      await manager.write("# v1")
      await manager.backup("before-v2")
      await manager.write("# v2")

      const restored = await manager.rollback()
      expect(restored).toBe(true)
      expect(await manager.read()).toBe("# v1")

      const backups = await manager.listBackups()
      const preRollback = backups.find((b) => b.label === "pre-rollback")
      expect(preRollback).toBeDefined()
    })

    test("rollback returns false when no backups", async () => {
      expect(await manager.rollback()).toBe(false)
    })

    test("listBackups returns sorted backups", async () => {
      await manager.write("content")
      await manager.backup("first")
      await new Promise((r) => setTimeout(r, 50))
      await manager.backup("second")

      const backups = await manager.listBackups()
      expect(backups.length).toBe(2)
      expect(backups[0].label).toBe("second")
    })
  })

  describe("sectionHeader", () => {
    test("returns markdown header", () => {
      expect(manager.sectionHeader("Test")).toBe("## Test")
    })
  })
})
