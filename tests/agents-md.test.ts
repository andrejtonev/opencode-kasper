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

    test("replaces existing section with same name", () => {
      const existing = "## My Section\nold content\n## Other\nother stuff"
      const result = manager.injectSection(
        existing,
        "My Section",
        "new content",
      )
      expect(result).toContain("new content")
      expect(result).not.toContain("old content")
      expect(result).toContain("## Other")
    })

    test("trims trailing whitespace from replacement", () => {
      const existing = "## My Section\nold\n"
      const result = manager.injectSection(existing, "My Section", "new\n\n")
      expect(result).toBe("## My Section\nnew")
    })

    test("section header includes section name", () => {
      const result = manager.injectSection(
        "",
        "Kasper Inferred Instructions",
        "rules",
      )
      expect(result).toContain("## Kasper Inferred Instructions")
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
