import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { KasperLogger } from "../src/logging.js"

function tmpDir(): string {
  return join(tmpdir(), `kasper-test-${randomBytes(6).toString("hex")}`)
}

describe("KasperLogger", () => {
  let testDir: string
  let logPath: string

  beforeEach(() => {
    testDir = tmpDir()
    logPath = join(testDir, "kasper.log")
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  test("init creates log directory", async () => {
    const logger = new KasperLogger(testDir, 300)
    await logger.init()
    // directory exists (no error thrown)
  })

  test("log writes a JSON line to the log file", async () => {
    const logger = new KasperLogger(testDir, 300)
    await logger.init()
    await logger.log("test_event", { key: "value" })

    const raw = await readFile(logPath, "utf-8")
    const entry = JSON.parse(raw.trim())
    expect(entry.event).toBe("test_event")
    expect(entry.key).toBe("value")
    expect(typeof entry.ts).toBe("string")
  })

  test("log writes multiple entries", async () => {
    const logger = new KasperLogger(testDir, 300)
    await logger.init()
    await logger.log("first")
    await logger.log("second")
    await logger.log("third")

    const raw = await readFile(logPath, "utf-8")
    const lines = raw.trim().split("\n")
    expect(lines.length).toBe(3)
  })

  test("tail returns last N lines", async () => {
    const logger = new KasperLogger(testDir, 300)
    await logger.init()
    await logger.log("event", { n: 1 })
    await logger.log("event", { n: 2 })
    await logger.log("event", { n: 3 })
    await logger.log("event", { n: 4 })
    await logger.log("event", { n: 5 })

    const tailed = await logger.tail(2)
    const lines = tailed.split("\n")
    expect(lines.length).toBe(2)
    expect(JSON.parse(lines[0]).n).toBe(4)
    expect(JSON.parse(lines[1]).n).toBe(5)
  })

  test("tail returns empty string for nonexistent log", async () => {
    const logger = new KasperLogger(testDir, 300)
    const result = await logger.tail(10)
    expect(result).toBe("")
  })

  test("tail with 0 returns empty string", async () => {
    const logger = new KasperLogger(testDir, 300)
    await logger.init()
    await logger.log("test")
    expect(await logger.tail(0)).toBe("")
  })

  test("trim truncates log to max lines", async () => {
    const logger = new KasperLogger(testDir, 3)
    await logger.init()
    await logger.log("event", { n: 1 })
    await logger.log("event", { n: 2 })
    await logger.log("event", { n: 3 })
    await logger.log("event", { n: 4 })
    await logger.log("event", { n: 5 })

    await logger.trim()
    const raw = await readFile(logPath, "utf-8")
    const lines = raw.trim().split("\n")
    expect(lines.length).toBe(3)
    expect(JSON.parse(lines[0]).n).toBe(3)
    expect(JSON.parse(lines[2]).n).toBe(5)
  })

  test("trim does nothing when under max lines", async () => {
    const logger = new KasperLogger(testDir, 100)
    await logger.init()
    await logger.log("event")
    await logger.log("event")

    await logger.trim()
    const raw = await readFile(logPath, "utf-8")
    expect(raw.trim().split("\n").length).toBe(2)
  })
})
