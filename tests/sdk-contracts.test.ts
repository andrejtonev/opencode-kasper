import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"

test("the pinned loader prefers ./server while the legacy root remains a function", async () => {
  const directory = fileURLToPath(
    new URL("./fixtures/sdk-host", import.meta.url),
  )
  // Node exercises the installed package's standard resolver. OpenCode supplies its own
  // resolver inside Bun; standalone Bun's missing-export errors have a different shape.
  const script = fileURLToPath(
    new URL("./contracts/resolve.mjs", import.meta.url),
  )
  const result = spawnSync("node", [script, directory], {
    encoding: "utf8",
    windowsHide: true,
  })
  if (result.status !== 0) throw new Error(result.stderr)
  const resolved = JSON.parse(result.stdout)
  expect(resolved.entry).toContain("server.js")
  expect(resolved.id).toBe("kasper.sdk-host-fixture")
  expect(resolved.effect).toBe("function")
  const root = await import(path.join(directory, "index.js"))
  expect(typeof root.default).toBe("function")
})

test("the pinned Effect runtime propagates caller abort and finalizes the operation", async () => {
  let started = false
  let finalized = false
  let completed = false
  const operation = Effect.callback<void>((resume) => {
    started = true
    const timer = setTimeout(() => {
      completed = true
      resume(Effect.void)
    }, 1000)
    return Effect.sync(() => {
      finalized = true
      clearTimeout(timer)
    })
  })
  const controller = new AbortController()
  const pending = Effect.runPromise(operation, { signal: controller.signal })
  controller.abort()
  await expect(pending).rejects.toThrow()
  expect(started).toBe(true)
  expect(finalized).toBe(true)
  expect(completed).toBe(false)
})
