import { describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  escapeRegex,
  exists,
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
