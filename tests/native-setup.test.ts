import { expect, mock, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Context } from "@opencode/plugin/effect/plugin"
import { DateTime, Effect, Stream } from "effect"
import { _stateStoreRegistry } from "../src/registry.js"
import {
  archiveAddress,
  KasperServer,
  readNativeConfig,
} from "../src/server.js"

test("native setup registers direct commands, tools, correlated RPC and scoped cleanup without a legacy client", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kasper-native-"))
  const now = DateTime.makeUnsafe(Date.now())
  const generation = mock(() =>
    Effect.die("A read-only administrative action must not generate"),
  )
  let command: any, tool: any, handlers: any, compaction: any
  const delivered: any[] = []
  const context = {
    location: {
      directory,
      project: { id: "project", directory, canonical: directory },
    },
    options: { enabled: false },
    experimental: { generate: { text: generation } },
    agent: {
      list: () =>
        Effect.succeed({
          data: [{ id: "build", system: "Follow user instructions" }],
        }),
      get: () =>
        Effect.succeed({
          data: { id: "build", system: "Follow user instructions" },
        }),
      transform: () => Effect.void,
      reload: () => Effect.void,
    },
    session: {
      get: () =>
        Effect.succeed({
          id: "ses_native",
          agent: "build",
          projectID: "project",
          location: { directory },
          time: { created: now, updated: now, idle: now },
        }),
      context: () => Effect.succeed([]),
      list: () => Effect.succeed({ data: [], cursor: {} }),
      hook: (_name: string, hook: any) =>
        Effect.sync(() => {
          compaction = hook
        }),
    },
    event: { subscribe: () => Stream.never },
    command: {
      transform: (transform: any) =>
        Effect.sync(() =>
          transform({
            add: (value: any) => {
              command = value
            },
          }),
        ),
    },
    tool: {
      transform: (transform: any) =>
        Effect.sync(() =>
          transform({
            add: (value: any) => {
              tool = value
            },
          }),
        ),
    },
    rpc: {
      register: (_definition: any, value: any) =>
        Effect.sync(() => {
          handlers = value
          return {
            events: {
              emit: (_name: string, value: any) =>
                Effect.sync(() => {
                  delivered.push(value)
                }),
            },
          }
        }),
    },
  } as unknown as Context

  try {
    await Effect.runPromise(
      Effect.scoped(
        KasperServer.effect(context).pipe(
          Effect.flatMap(() =>
            Effect.gen(function* () {
              expect(_stateStoreRegistry.has(directory)).toBe(true)
              expect(command.name).toBe("kasper")
              expect(tool.name).toBe("kasper_control")
              expect(compaction).toBeDefined()
              yield* command.execute({
                sessionID: "ses_native",
                prompt: { text: "status" },
              })
              expect(delivered).toHaveLength(1)
              expect(delivered[0].text).toContain(
                "instruction coverage incomplete",
              )
              const receipt = yield* handlers.execute({
                requestID: "same",
                sessionID: "ses_native",
                location: directory,
                command: "pause",
              })
              const retry = yield* handlers.execute({
                requestID: "same",
                sessionID: "ses_native",
                location: directory,
                command: "pause",
              })
              expect(receipt).toEqual(retry)
              const list = yield* handlers.results({
                sessionID: "ses_native",
                location: directory,
              })
              expect(list).toHaveLength(2)
              expect(generation).not.toHaveBeenCalled()
            }),
          ),
        ),
      ),
    )
    expect(_stateStoreRegistry.has(directory)).toBe(false)
    expect(
      JSON.parse(
        await readFile(
          join(directory, ".opencode", "kasper", "state.json"),
          "utf8",
        ),
      ),
    ).toBeDefined()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("native config is project-local and explicit plugin options take precedence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kasper-config-"))
  try {
    await mkdir(join(directory, ".opencode"))
    await writeFile(
      join(directory, ".opencode", "kasper.jsonc"),
      '{"auto_update":false,"model":"local/model"}',
    )
    await writeFile(
      join(directory, "opencode.json"),
      '{"kasper":{"auto_update":true}}',
    )
    expect(
      (await readNativeConfig(directory, { model: "explicit/model" })).model,
    ).toBe("explicit/model")
    expect((await readNativeConfig(directory, {})).auto_update).toBe(false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
test("archive trust requires explicit secure transport and credentials or local trust assertion", () => {
  expect(archiveAddress("http://127.0.0.1:8765", undefined, true)).toContain(
    "127.0.0.1",
  )
  expect(
    archiveAddress(
      "https://example.test",
      { Authorization: "explicit" },
      false,
    ),
  ).toContain("https:")
  for (const value of [
    "http://example.test",
    "https://name:secret@example.test",
    "https://example.test?token=secret",
  ])
    expect(() =>
      archiveAddress(value, { Authorization: "explicit" }, false),
    ).toThrow()
  expect(() =>
    archiveAddress("https://example.test", undefined, false),
  ).toThrow("explicit authentication")
})
