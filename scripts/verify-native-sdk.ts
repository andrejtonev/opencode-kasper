import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const fixture = fileURLToPath(
  new URL("../tests/fixtures/sdk-host", import.meta.url),
)
const executable = process.argv[2]
const generation = process.argv[3]
if (!executable || (generation !== "v1" && generation !== "v2")) {
  throw new Error(
    "Usage: bun scripts/verify-native-sdk.ts <absolute host executable> <v1|v2>",
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
  OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
  OPENCODE_DISABLE_FILEWATCHER: "true",
  OPENCODE_FILEWATCHER_DISABLE: "true",
})

function run(command: string, arguments_: string[], cwd = project) {
  const child = spawn(command, arguments_, {
    cwd,
    env: environment,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
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
const archive = path.join(root, "kasper-sdk-host-fixture-0.0.0.tgz")
const consumer = path.join(root, "consumer")
await mkdir(consumer)
await writeFile(
  path.join(consumer, "package.json"),
  JSON.stringify({
    private: true,
    dependencies: { "kasper-sdk-host-fixture": `file:${archive}` },
  }),
)
const install = run(process.execPath, ["install", "--ignore-scripts"], consumer)
if ((await install.done) !== 0)
  throw new Error(`Fixture install failed: ${install.output()}`)
const installed = path.join(consumer, "node_modules", "kasper-sdk-host-fixture")
const specification =
  generation === "v2"
    ? { plugins: [{ package: installed, options: { reportPath } }] }
    : {
        plugin: [
          [
            new URL(
              `file:///${path.join(installed, "index.js").replaceAll("\\", "/")}`,
            ).href,
            { reportPath },
          ],
        ],
      }
await writeFile(configPath, JSON.stringify(specification))

const listener = createServer()
await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve))
const address = listener.address()
if (!address || typeof address === "string") throw new Error("No fixture port")
const port = address.port
await new Promise<void>((resolve, reject) =>
  listener.close((error) => (error ? reject(error) : resolve())),
)
const server = run(executable, [
  "serve",
  "--hostname",
  "127.0.0.1",
  "--port",
  String(port),
])
let report: Record<string, unknown> | undefined
let lastResponse = ""
try {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    try {
      // Loading is location-scoped. No session prompt or provider endpoint is called.
      const query =
        generation === "v2"
          ? `location[directory]=${encodeURIComponent(project)}`
          : `directory=${encodeURIComponent(project)}`
      const response = await fetch(
        `http://127.0.0.1:${port}/${generation === "v2" ? "api/plugin" : "experimental/tool/ids"}?${query}`,
        {
          headers: {
            authorization: `Basic ${Buffer.from("opencode:kasper-sdk-isolated-fixture").toString("base64")}`,
          },
          signal: AbortSignal.timeout(1000),
        },
      )
      lastResponse = `${response.status}: ${(await response.text()).slice(0, 500)}`
      if (response.ok) {
        try {
          report = JSON.parse(await readFile(reportPath, "utf8"))
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
  if (!report)
    throw new Error(
      `Fixture did not load (${lastResponse}); log ${path.join(root, "server.log")}`,
    )
  const expected = generation === "v2" ? "server-v2" : "root-v1"
  if (report.entrypoint !== expected)
    throw new Error(`Wrong export selected: ${JSON.stringify(report)}`)
  if (generation === "v2") {
    const cancellation = report.cancellation as {
      started?: boolean
      interrupted?: boolean
      completed?: boolean
    }
    if (
      !cancellation.started ||
      !cancellation.interrupted ||
      cancellation.completed
    )
      throw new Error(`Cancellation failed: ${JSON.stringify(report)}`)
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
}
await writeFile(
  path.join(root, "result.json"),
  JSON.stringify({ version: versionText, root, report }, null, 2),
)
console.log(JSON.stringify({ version: versionText, root, report }))
