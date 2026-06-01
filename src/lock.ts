import { mkdir, open, rm, stat } from "node:fs/promises"
import { dirname } from "node:path"

const STALE_LOCK_MS = 30_000
const DEFAULT_TIMEOUT_MS = 5000
const MAX_ATTEMPTS = 100

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
    try {
      const handle = await open(lockPath, "wx")
      await handle.writeFile(String(process.pid), "utf-8")
      await handle.close()

      return async () => {
        try {
          await rm(lockPath, { force: true })
        } catch {
          /* lock already gone */
        }
      }
    } catch (err: unknown) {
      lastError = err
      const errCode = (err as { code?: string }).code

      if (errCode === "EEXIST" || errCode === "EPERM" || errCode === "EBUSY") {
        try {
          const info = await stat(lockPath)
          if (Date.now() - info.mtimeMs > staleThresholdMs) {
            await rm(lockPath, { force: true })
            continue
          }
        } catch {
          /* stat failed (file vanished) — retry acquire */
          continue
        }
      }

      attempt++
      const waitMs = Math.min(500, 10 * (attempt + 1))
      await new Promise((resolve) => setTimeout(resolve, waitMs))
    }
  }

  throw new Error(
    `Failed to acquire lock "${lockPath}" after ${timeoutMs}ms: ${(lastError as Error)?.message ?? String(lastError)}`,
  )
}
