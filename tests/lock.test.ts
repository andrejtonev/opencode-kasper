import { describe, expect, test } from "bun:test"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireLock } from "../src/lock.js"

async function tmpLockDir(): Promise<string> {
  const dir = join(
    tmpdir(),
    `lock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  await mkdir(dir, { recursive: true })
  return dir
}

describe("acquireLock", () => {
  test("acquires and releases lock", async () => {
    const dir = await tmpLockDir()
    const lockPath = join(dir, "test.lock")
    const unlock = await acquireLock(lockPath, 1000)
    expect(unlock).toBeInstanceOf(Function)
    await unlock()
    await rm(dir, { recursive: true, force: true })
  })

  test("prevents concurrent acquisition", async () => {
    const dir = await tmpLockDir()
    const lockPath = join(dir, "test.lock")
    const unlock1 = await acquireLock(lockPath, 5000)

    let acquired2 = false
    const p2 = acquireLock(lockPath, 500).then((u) => {
      acquired2 = true
      return u
    })

    await new Promise((r) => setTimeout(r, 100))
    expect(acquired2).toBe(false)

    await unlock1()
    const unlock2 = await p2
    if (unlock2) await unlock2()

    await rm(dir, { recursive: true, force: true })
  })

  test("throws on timeout when lock is held", async () => {
    const dir = await tmpLockDir()
    const lockPath = join(dir, "test.lock")
    const unlock1 = await acquireLock(lockPath, 1000)

    await expect(acquireLock(lockPath, 100)).rejects.toThrow()

    await unlock1()
    await rm(dir, { recursive: true, force: true })
  })

  test("can acquire after release", async () => {
    const dir = await tmpLockDir()
    const lockPath = join(dir, "test.lock")
    const unlock1 = await acquireLock(lockPath, 1000)
    await unlock1()
    const unlock2 = await acquireLock(lockPath, 1000)
    await unlock2()
    await rm(dir, { recursive: true, force: true })
  })

  test("detects stale lock and reclaims it", async () => {
    const dir = await tmpLockDir()
    const lockPath = join(dir, "test.lock")

    await writeFile(lockPath, "99999", "utf-8")

    const unlock = await acquireLock(lockPath, 1000, 0)
    expect(unlock).toBeInstanceOf(Function)

    const content = await readFile(lockPath, "utf-8")
    expect(content.trim()).toBe(String(process.pid))

    await unlock()
    await rm(dir, { recursive: true, force: true })
  })

  test("unlock removes the lock file", async () => {
    const dir = await tmpLockDir()
    const lockPath = join(dir, "test.lock")

    const unlock = await acquireLock(lockPath, 1000)
    await unlock()

    const exists = await readFile(lockPath, "utf-8").then(
      () => true,
      () => false,
    )
    expect(exists).toBe(false)

    await rm(dir, { recursive: true, force: true })
  })

  test("double unlock does not throw", async () => {
    const dir = await tmpLockDir()
    const lockPath = join(dir, "test.lock")

    const unlock = await acquireLock(lockPath, 1000)
    await unlock()
    await unlock()

    await rm(dir, { recursive: true, force: true })
  })

  test("creates lock directory if missing", async () => {
    const dir = await tmpLockDir()
    const nestedDir = join(dir, "nested", "subdir")
    const lockPath = join(nestedDir, "test.lock")

    const unlock = await acquireLock(lockPath, 1000)
    await unlock()

    await rm(dir, { recursive: true, force: true })
  })
})
