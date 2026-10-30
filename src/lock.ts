import { randomUUID } from "node:crypto"
import {
  type FileHandle,
  mkdir,
  open,
  readFile,
  rm,
  stat,
} from "node:fs/promises"
import { hostname } from "node:os"
import { dirname } from "node:path"

const STALE_LOCK_MS = 30_000
const DEFAULT_TIMEOUT_MS = 5000
const MAX_ATTEMPTS = 100

interface Owner {
  pid: number
  host: string
  token: string
}

function deadOwner(raw: string): boolean {
  let pid: number
  try {
    const parsed = JSON.parse(raw) as Owner | number
    if (typeof parsed === "number")
      pid = parsed // legacy local PID lock
    else {
      if (parsed.host !== hostname() || typeof parsed.token !== "string")
        return false
      pid = parsed.pid
    }
  } catch {
    return false
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH"
  }
}

async function reclaimDeadOwner(
  lockPath: string,
  staleThresholdMs: number,
): Promise<void> {
  // Serialize reclaimers: otherwise two observers of one dead owner could
  // unlink the live successor installed by the first reclaimer.
  const guardPath = `${lockPath}.reclaim`
  let guard: FileHandle
  try {
    guard = await open(guardPath, "wx")
  } catch {
    return
  }
  try {
    const info = await stat(lockPath)
    if (Date.now() - info.mtimeMs <= staleThresholdMs) return
    const raw = await readFile(lockPath, "utf-8")
    if (deadOwner(raw)) await rm(lockPath, { force: true })
  } catch {
    /* lock disappeared; normal acquisition will retry */
  } finally {
    await guard.close()
    await rm(guardPath, { force: true })
  }
}

export async function acquireLock(
  lockPath: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  staleThresholdMs = STALE_LOCK_MS,
): Promise<() => Promise<void>> {
  await mkdir(dirname(lockPath), { recursive: true })
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  let attempt = 0
  while (Date.now() < deadline && attempt < MAX_ATTEMPTS) {
    const owner = JSON.stringify({
      pid: process.pid,
      host: hostname(),
      token: randomUUID(),
    } satisfies Owner)
    try {
      const handle = await open(lockPath, "wx")
      try {
        await handle.writeFile(owner, "utf-8")
      } finally {
        await handle.close()
      }
      let released = false
      return async () => {
        if (released) return
        released = true
        try {
          if ((await readFile(lockPath, "utf-8")) === owner)
            await rm(lockPath, { force: true })
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
        }
      }
    } catch (err) {
      lastError = err
      const code = (err as NodeJS.ErrnoException).code
      if (code === "EEXIST" || code === "EPERM" || code === "EBUSY") {
        await reclaimDeadOwner(lockPath, staleThresholdMs)
      }
      attempt++
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(500, 10 * (attempt + 1))),
      )
    }
  }
  throw new Error(
    `Failed to acquire lock "${lockPath}" after ${timeoutMs}ms: ${(lastError as Error)?.message ?? String(lastError)}`,
  )
}
