import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { OpenCode } from "@opencode/client"
import { nativeProviderFixture } from "./native-provider-fixture.js"
import { verifyPackagedActions } from "./verify-packaged-actions.js"
import { verifyV1Generation } from "./verify-v1-generation.js"

let fixture = fileURLToPath(
  new URL("../tests/fixtures/sdk-host", import.meta.url),
)
const executable = process.argv[2]
const generation = process.argv[3]
const providerTest = process.argv[4] === "provider"
const legacyFileTest = process.argv[4] === "legacy-file"
const v1GenerationTest = process.argv[4] === "v1-generation"
const productionTest = process.argv[4] === "production" || v1GenerationTest
const tuiTest = process.argv[5] === "tui"
if (productionTest) fixture = fileURLToPath(new URL("..", import.meta.url))
if (!executable || (generation !== "v1" && generation !== "v2")) {
  throw new Error(
    "Usage: bun scripts/verify-native-sdk.ts <absolute host executable> <v1|v2> [fixture|legacy-file|provider|production|v1-generation] [tui]",
  )
}
if (!path.isAbsolute(executable))
  throw new Error("Use an absolute host executable")

const root = await mkdtemp(path.join(tmpdir(), "kasper-sdk-native-"))
const project = path.join(root, "project")
const reportPath = path.join(root, "fixture.json")
const configPath = path.join(root, "config.json")
for (const name of [
  "project",
  "home",
  "config",
  "data",
  "state",
  "cache",
  "program-data",
  "tmp",
]) {
  await mkdir(path.join(root, name), { recursive: true })
}

// Whitelist child environment rather than copying credentials/provider/host settings.
const environment: NodeJS.ProcessEnv = {}
for (const key of [
  "PATH",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
]) {
  if (process.env[key]) environment[key] = process.env[key]
}
Object.assign(environment, {
  KASPER_SDK_REPORT_PATH: reportPath,
  OPENCODE_TEST_HOME: path.join(root, "home"),
  HOME: path.join(root, "home"),
  USERPROFILE: path.join(root, "home"),
  APPDATA: path.join(root, "data"),
  LOCALAPPDATA: path.join(root, "data"),
  XDG_CONFIG_HOME: path.join(root, "config"),
  XDG_DATA_HOME: path.join(root, "data"),
  XDG_STATE_HOME: path.join(root, "state"),
  XDG_CACHE_HOME: path.join(root, "cache"),
  ProgramData: path.join(root, "program-data"),
  TEMP: path.join(root, "tmp"),
  TMP: path.join(root, "tmp"),
  OPENCODE_SERVER_PASSWORD: "kasper-sdk-isolated-fixture",
  OPENCODE_CONFIG: configPath,
  OPENCODE_CONFIG_DIR: path.join(root, "config", "opencode"),
  OPENCODE_DISABLE_PROJECT_CONFIG: "true",
  OPENCODE_CONFIG_PROJECT_DISABLE: "true",
  OPENCODE_DISABLE_CLAUDE_CODE: "true",
  OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "true",
  OPENCODE_DISABLE_MODELS_FETCH: "true",
  OPENCODE_DISABLE_DEFAULT_PLUGINS: generation === "v2" ? "true" : "false",
  OPENCODE_DISABLE_FILEWATCHER: "true",
  OPENCODE_FILEWATCHER_DISABLE: "true",
})

function run(
  command: string,
  arguments_: string[],
  cwd = project,
  interactive = false,
) {
  const child = spawn(command, arguments_, {
    cwd,
    env: environment,
    windowsHide: true,
    stdio: [interactive ? "inherit" : "ignore", "pipe", "pipe"],
  })
  let output = ""
  child.stdout.on("data", (data) => {
    output += String(data)
  })
  child.stderr.on("data", (data) => {
    output += String(data)
  })
  const done = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", resolve)
  })
  return { child, done, output: () => output }
}

const version = run(executable, ["--version"])
if ((await version.done) !== 0)
  throw new Error(`Host version failed: ${version.output()}`)
const versionText = version.output().trim()
if (generation === "v2" && !versionText.includes("2.2.2"))
  throw new Error(`Expected pinned 2.2.2, got ${versionText}`)

// Pack the fixture, install its exact bytes into an isolated consumer, and load package exports.
const pack = run(
  process.execPath,
  ["pm", "pack", "--destination", root],
  fixture,
)
if ((await pack.done) !== 0)
  throw new Error(`Fixture pack failed: ${pack.output()}`)
const metadata = JSON.parse(
  await readFile(path.join(fixture, "package.json"), "utf8"),
) as { name: string; version: string }
const archive = path.join(
  root,
  `${metadata.name.replace(/^@/, "").replaceAll("/", "-")}-${metadata.version}.tgz`,
)
const consumer = path.join(root, "consumer")
await mkdir(consumer)
await writeFile(
  path.join(consumer, "package.json"),
  JSON.stringify({
    private: true,
    dependencies: { [metadata.name]: `file:${archive}` },
  }),
)
const install = run(process.execPath, ["install", "--ignore-scripts"], consumer)
if ((await install.done) !== 0)
  throw new Error(`Fixture install failed: ${install.output()}`)
const installed = path.join(consumer, "node_modules", metadata.name)
if (tuiTest && generation === "v1") {
  environment.OPENCODE_TUI_CONFIG = path.join(root, "tui.json")
  await writeFile(
    environment.OPENCODE_TUI_CONFIG,
    JSON.stringify({ plugin: [pathToFileURL(installed).href] }),
  )
}
// A direct file whose directory has no package.json avoids V1's ./server preference.
if (legacyFileTest) {
  await mkdir(path.join(installed, "dist"))
  await writeFile(
    path.join(installed, "dist", "index.js"),
    await readFile(path.join(installed, "index.js")),
  )
}
const provider =
  ((providerTest || productionTest) && generation === "v2") || v1GenerationTest
    ? await nativeProviderFixture()
    : undefined
if (!productionTest) provider?.respond({ text: "native-local-provider-result" })
if (v1GenerationTest) {
  await mkdir(path.join(project, ".opencode"), { recursive: true })
  await writeFile(
    path.join(project, ".opencode", "kasper.json"),
    JSON.stringify({
      enabled: true,
      auto_update: false,
      model: "fixture/judge",
      evaluation_poll_interval_ms: 3600000,
      scoring_retries: 0,
    }),
  )
}
const specification =
  generation === "v2"
    ? {
        plugins: [
          {
            package: installed,
            options: productionTest
              ? {
                  enabled: false,
                  auto_update: false,
                  model: "fixture/judge",
                  state_dir: ".opencode/kasper",
                  scoring_retries: 0,
                  server_url: "SERVER_URL_PENDING",
                  archive_headers: {
                    authorization: `Basic ${Buffer.from("opencode:kasper-sdk-isolated-fixture").toString("base64")}`,
                  },
                  instruction_discovery_verified: true,
                  global_discovery: false,
                  project_discovery: false,
                  editable_agents: {
                    build: {
                      path: configPath,
                      jsonPath: ["agents", "build", "system"],
                    },
                  },
                }
              : { reportPath, provider_test: providerTest },
          },
        ],
        ...(productionTest
          ? {
              agents: {
                build: {
                  system:
                    "You are an isolated deterministic local fixture. Follow the user's requested output and use only the configured local fixture tools.",
                },
              },
            }
          : {}),
        ...(provider
          ? {
              providers: {
                fixture: {
                  package: "@opencode/ai/providers/openai-compatible",
                  settings: {
                    baseURL: provider.baseURL,
                    apiKey: "kasper-local-fixture",
                    name: "fixture",
                  },
                  models: {
                    judge: {
                      name: "judge",
                      cost: { input: 0, output: 0 },
                      limit: { context: 32768, output: 512 },
                    },
                    work: {
                      name: "work",
                      cost: { input: 0, output: 0 },
                      limit: { context: 32768, output: 512 },
                    },
                  },
                },
              },
              policies: [
                { action: "provider.use", resource: "*", effect: "deny" },
                {
                  action: "provider.use",
                  resource: "fixture",
                  effect: "allow",
                },
              ],
            }
          : {}),
      }
    : {
        ...(provider
          ? {
              enabled_providers: ["fixture"],
              provider: {
                fixture: {
                  npm: "@ai-sdk/openai-compatible",
                  name: "fixture",
                  options: {
                    baseURL: provider.baseURL,
                    apiKey: "kasper-local-fixture",
                  },
                  models: {
                    judge: {
                      name: "judge",
                      limit: { context: 32768, output: 512 },
                      cost: { input: 0, output: 0 },
                    },
                  },
                },
              },
            }
          : {}),
        plugin: [
          pathToFileURL(
            productionTest
              ? installed
              : path.join(
                  installed,
                  legacyFileTest ? "dist/index.js" : "index.js",
                ),
          ).href,
        ],
      }
await writeFile(configPath, JSON.stringify(specification))

const listener = createServer()
await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve))
const address = listener.address()
if (!address || typeof address === "string") throw new Error("No fixture port")
const port = address.port
if (productionTest && generation === "v2") {
  if (!("plugins" in specification))
    throw new Error("Missing production plugin")
  specification.plugins[0].options.server_url = `http://127.0.0.1:${port}`
  await writeFile(configPath, JSON.stringify(specification))
}
await new Promise<void>((resolve, reject) =>
  listener.close((error) => (error ? reject(error) : resolve())),
)
const server = run(executable, [
  "--print-logs",
  "--log-level",
  generation === "v2" ? "debug" : "DEBUG",
  "serve",
  "--hostname",
  "127.0.0.1",
  "--port",
  String(port),
])
let report: Record<string, unknown> | undefined
let lastResponse = ""
let lastPayload = ""
try {
  const deadline = Date.now() + (v1GenerationTest ? 60000 : 30000)
  while (Date.now() < deadline) {
    try {
      // Loading is location-scoped. No session prompt or provider endpoint is called.
      const query =
        generation === "v2"
          ? `location[directory]=${encodeURIComponent(project)}`
          : `directory=${encodeURIComponent(project)}`
      const response = await fetch(
        `http://127.0.0.1:${port}/${generation === "v2" ? "api/plugin" : versionText.includes("1.18.23") ? "experimental/tool/ids" : "tool/ids"}?${query}`,
        {
          headers: {
            authorization: `Basic ${Buffer.from("opencode:kasper-sdk-isolated-fixture").toString("base64")}`,
          },
          signal: AbortSignal.timeout(1000),
        },
      )
      lastPayload = await response.text()
      lastResponse = `${response.status}: ${lastPayload.slice(0, 500)}`
      if (response.ok) {
        try {
          if (productionTest) {
            const log = await readFile(
              path.join(project, ".opencode", "kasper", "kasper.log"),
              "utf8",
            )
            const expectedEvent =
              generation === "v2"
                ? '"event":"native_setup"'
                : '"event":"plugin_loaded"'
            if (!log.includes(expectedEvent))
              throw new Error("Production setup not complete")
            report = {
              entrypoint: generation === "v2" ? "server-v2" : "root-v1",
              loaded: true,
              production: true,
            }
          } else report = JSON.parse(await readFile(reportPath, "utf8"))
          break
        } catch {
          /* Setup still running. */
        }
      }
    } catch {
      /* Listener not ready yet. */
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!report && generation === "v1") {
    const response = await fetch(
      `http://127.0.0.1:${port}/config?directory=${encodeURIComponent(project)}`,
      {
        headers: {
          authorization: `Basic ${Buffer.from("opencode:kasper-sdk-isolated-fixture").toString("base64")}`,
        },
        signal: AbortSignal.timeout(2000),
      },
    )
    await writeFile(
      path.join(root, "effective-config.json"),
      await response.text(),
    )
  }
  if (!report)
    throw new Error(
      `Fixture did not load (${lastResponse}); log ${path.join(root, "server.log")}`,
    )
  const expected = generation === "v2" ? "server-v2" : "root-v1"
  if (report.entrypoint !== expected)
    throw new Error(`Wrong export selected: ${JSON.stringify(report)}`)
  if (productionTest && generation === "v1") {
    const ids: unknown = JSON.parse(lastPayload)
    if (!Array.isArray(ids) || !ids.includes("kasper_control"))
      throw new Error("Packaged V1 control tool was not registered")
    report.toolRegistered = "kasper_control"
    await writeFile(path.join(root, "tool-ids.json"), lastPayload)
    if (v1GenerationTest && provider)
      report.generation = await verifyV1Generation(
        installed,
        `http://127.0.0.1:${port}`,
        project,
        provider,
        root,
      )
  }
  if (tuiTest && !productionTest) {
    const terminal = run(
      executable,
      generation === "v2"
        ? ["--server", `http://127.0.0.1:${port}`, project]
        : ["attach", `http://127.0.0.1:${port}`],
      project,
      true,
    )
    try {
      const deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        try {
          report.tui = JSON.parse(await readFile(`${reportPath}.tui`, "utf8"))
          break
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      if (!report.tui) throw new Error("Native TUI fixture did not load")
    } finally {
      terminal.child.kill()
      await writeFile(path.join(root, "tui.log"), terminal.output())
    }
  }
  if (generation === "v2") {
    if (provider && productionTest) {
      const client = OpenCode.make({
        baseUrl: `http://127.0.0.1:${port}`,
        headers: {
          authorization: `Basic ${Buffer.from("opencode:kasper-sdk-isolated-fixture").toString("base64")}`,
        },
      })
      report.acceptance = await verifyPackagedActions(
        client,
        project,
        provider,
        root,
        tuiTest
          ? async (sessionID, command) => {
              const terminal = run(
                executable,
                [
                  "--server",
                  `http://127.0.0.1:${port}`,
                  "--session",
                  sessionID,
                  project,
                ],
                project,
                true,
              )
              try {
                await new Promise((resolve) => setTimeout(resolve, 4000))
                await command()
                const deadline = Date.now() + 10000
                while (
                  Date.now() < deadline &&
                  !terminal.output().includes("Kasper status")
                )
                  await new Promise((resolve) => setTimeout(resolve, 100))
                if (!terminal.output().includes("Kasper status"))
                  throw new Error(
                    "Actual TUI Kasper result dialog was not observed",
                  )
                return {
                  displayed: true,
                  title: "Kasper status",
                  source: "native command result event",
                }
              } finally {
                terminal.child.kill()
                await writeFile(path.join(root, "tui.log"), terminal.output())
              }
            }
          : undefined,
      )
    } else if (provider) {
      const client = OpenCode.make({
        baseUrl: `http://127.0.0.1:${port}`,
        headers: {
          authorization: `Basic ${Buffer.from("opencode:kasper-sdk-isolated-fixture").toString("base64")}`,
        },
      })
      const generated = await client.rpc.call(
        {
          rpcID: "kasper.sdk-host-fixture.wait",
          method: "generate",
          location: { directory: project },
          input: { prompt: "Local deterministic stateless judge fixture." },
        },
        { signal: AbortSignal.timeout(10000) },
      )
      report.providerGeneration = generated.output
    }
    const cancellation = report.cancellation as {
      started?: boolean
      interrupted?: boolean
      completed?: boolean
    }
    if (
      !productionTest &&
      (!cancellation.started ||
        !cancellation.interrupted ||
        cancellation.completed)
    )
      throw new Error(`Cancellation failed: ${JSON.stringify(report)}`)
    if (
      !productionTest &&
      provider &&
      (provider.receipts.length !== 1 || !provider.receipts[0].completed)
    )
      throw new Error("Local native provider request count/completion mismatch")
  }
} finally {
  server.child.kill()
  await Promise.race([
    server.done,
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ])
  await writeFile(
    path.join(root, "server.log"),
    server
      .output()
      .replace(
        /server password .*/g,
        "server password [fixture credential redacted]",
      ),
  )
  if (provider) {
    await writeFile(
      path.join(root, "provider-receipts.json"),
      JSON.stringify(provider.receipts, null, 2),
    )
    await provider.close()
  }
}
await writeFile(
  path.join(root, "result.json"),
  JSON.stringify({ version: versionText, root, report }, null, 2),
)
console.log(
  JSON.stringify({
    version: versionText,
    root,
    entrypoint: report?.entrypoint,
    production: productionTest,
    accepted: true,
    result: path.join(root, "result.json"),
  }),
)
