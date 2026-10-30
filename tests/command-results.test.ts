import { expect, mock, test } from "bun:test"
import { CommandResults, parseCommand } from "../src/command-results.js"

const request = {
  requestID: "request-1",
  sessionID: "session-1",
  location: "C:/project",
  command: "apply 1",
}
test("a retry of an in-flight command shares its result and mutation executes once", async () => {
  let finish!: () => void
  const gate = new Promise<void>((resolve) => {
    finish = resolve
  })
  const mutate = mock(async () => {
    await gate
    return { status: "ok" as const, text: "Applied" }
  })
  const results = new CommandResults(mutate)
  const first = results.execute(request),
    retry = results.execute({ ...request })
  expect(retry).toBe(first)
  finish()
  expect(await first).toEqual(await retry)
  expect(mutate).toHaveBeenCalledTimes(1)
  expect(results.list(request.sessionID, request.location)).toHaveLength(1)
  expect(results.list("another-session", request.location)).toEqual([])
  expect(mutate).toHaveBeenCalledTimes(1)
})
test("receipt identity binds command, source session and location", async () => {
  const mutate = mock(async () => ({ status: "ok" as const, text: "Done" }))
  const results = new CommandResults(mutate)
  await results.execute(request)
  for (const change of [
    { command: "reset --force" },
    { sessionID: "other" },
    { location: "C:/other" },
  ])
    await expect(results.execute({ ...request, ...change })).rejects.toThrow(
      "already bound",
    )
  expect(mutate).toHaveBeenCalledTimes(1)
})
test("eviction and capacity reject execution replay instead of repeating a mutation", async () => {
  const mutate = mock(async () => ({ status: "ok" as const, text: "Done" }))
  const results = new CommandResults(mutate, 1, 2)
  await results.execute(request)
  await results.execute({ ...request, requestID: "request-2" })
  await expect(results.execute(request)).rejects.toThrow("expired")
  await expect(
    results.execute({ ...request, requestID: "request-3" }),
  ).rejects.toThrow("capacity")
  expect(mutate).toHaveBeenCalledTimes(2)
})
test("invalid action and flags are rejected before command admission", () => {
  expect(() => parseCommand("improve reviewer --dry-run")).not.toThrow()
  expect(parseCommand("migrate show-reviewer --show")).toEqual({
    action: "migrate",
    arg: "show-reviewer --show",
  })
  for (const command of [
    "unknown",
    "apply Infinity",
    "apply 0",
    "improve --invalid",
    "migrate --other",
  ])
    expect(() => parseCommand(command)).toThrow()
})
