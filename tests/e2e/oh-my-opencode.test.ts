/**
 * E2E: kasper correctly resolves and writes to oh-my-opencode plugin
 * overrides in a real installation of the plugin.
 *
 * Scenario:
 *   1. Install `oh-my-opencode` from npm in a tmp dir (real plugin files).
 *   2. Create a project that configures a built-in omo agent
 *      (`sisyphus`) with a user-defined `prompt_append` via
 *      `.opencode/oh-my-opencode.json` (the omo config file).
 *   3. Verify the kasper resolver finds the override as a
 *      `plugin_override` source, NOT as `missing` (which would have been
 *      the pre-fix behavior — kasper would have created a dead
 *      `.opencode/agents/sisyphus.md` file).
 *   4. Verify that a kasper `write()` lands the change in the
 *      `prompt_append` field of the user's config file, leaving the
 *      rest of the config untouched.
 *   5. Verify idempotency: a second `write()` with the same content
 *      does not duplicate the section.
 *
 * Why this test exists:
 *   The unit tests in `tests/agent-prompts.test.ts` cover the resolver
 *   with hand-rolled config files. This e2e test installs the REAL
 *   `oh-my-opencode` package from npm, so it catches breaking changes
 *   in the plugin's config schema (e.g. if omo renames
 *   `oh-my-opencode.json` to `oh-my-openagent.json`, or if its agent
 *   override schema changes) and confirms kasper still finds the
 *   user's prompt override.
 *
 * Skip conditions:
 *   - `OPENCODE_E2E != 1` (e2e suite disabled)
 *   - `npm install oh-my-opencode` fails (offline / network)
 *   - `oh-my-opencode` package is unavailable on npm
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { execSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { AgentPromptManager } from "../../src/agent-prompts.js"

const ENABLED = process.env.OPENCODE_E2E === "1"

interface OmoInstall {
  /** Root of the project where omo is installed. */
  projectDir: string
  /** The npm-installed `oh-my-opencode` package directory. */
  packageDir: string
  /** The user config file we will create. */
  configPath: string
  /** The agent name we will override. */
  agentName: string
}

let install: OmoInstall
let manager: AgentPromptManager
let kasperStateDir: string

function npmInstallOmo(projectDir: string): string {
  // 180s timeout. omo has ~140 transitive deps; first install can be slow
  // but the test suite is already long-running so this is acceptable.
  try {
    execSync("npm install --no-audit --no-fund oh-my-opencode", {
      cwd: projectDir,
      stdio: "pipe",
      timeout: 180_000,
    })
  } catch (err) {
    // Surface stderr/stdout for debugging.
    const e = err as { stdout?: Buffer; stderr?: Buffer; message?: string }
    const out = e.stdout?.toString() ?? ""
    const errOut = e.stderr?.toString() ?? ""
    throw new Error(
      `oh-my-opencode install failed: ${e.message}\n` +
        `STDOUT: ${out.slice(-2000)}\n` +
        `STDERR: ${errOut.slice(-2000)}`,
    )
  }
  const pkg = join(projectDir, "node_modules", "oh-my-opencode")
  if (!existsSync(join(pkg, "package.json"))) {
    throw new Error(`oh-my-opencode install failed: ${pkg} is missing`)
  }
  return pkg
}

describe.skipIf(!ENABLED)(
  "e2e: kasper writes to oh-my-opencode plugin overrides",
  () => {
    beforeAll(() => {
      // The npm install below can take 30-60s on cold cache. Override
      // bun's default 5s per-test timeout for the hook itself.
      // 1. Fresh tmp project + install the real omo package.
      install = (() => {
        const projectDir = mkdtempSync(join(tmpdir(), "kasper-e2e-omo-"))
        const packageDir = npmInstallOmo(projectDir)
        // 2. Create the user config in the project's .opencode/.
        const opencodeDir = join(projectDir, ".opencode")
        mkdirSync(opencodeDir, { recursive: true })
        const configPath = join(opencodeDir, "oh-my-opencode.json")
        // 3. Override a known omo built-in agent with a `prompt_append`.
        //    `sisyphus` is the canonical omo orchestrator agent and is
        //    present in every recent release of the plugin.
        const agentName = "sisyphus"
        const userPromptAppend =
          "# Kasper test\n\nApply the user override via the plugin config."
        writeFileSync(
          configPath,
          JSON.stringify(
            {
              agent: { [agentName]: { prompt_append: userPromptAppend } },
            },
            null,
            2,
          ),
          "utf-8",
        )
        return { projectDir, packageDir, configPath, agentName }
      })()

      kasperStateDir = join(install.projectDir, ".opencode", "kasper")
      mkdirSync(kasperStateDir, { recursive: true })
      manager = new AgentPromptManager(
        install.projectDir,
        kasperStateDir,
        install.projectDir, // globalOpencodeDir (use the project dir for isolation)
      )
    })

    afterAll(() => {
      if (install?.projectDir) {
        rmSync(install.projectDir, { recursive: true, force: true })
      }
    })

    test("npm-installed oh-my-opencode is on disk", () => {
      // Sanity check that the install actually produced a package.
      const pkgJson = JSON.parse(
        readFileSync(join(install.packageDir, "package.json"), "utf-8"),
      )
      expect(pkgJson.name).toBe("oh-my-opencode")
      // Major version guard: omo 4.x uses the config schema we expect.
      // If a future major breaks the schema, this test should fail loudly.
      expect(pkgJson.version).toMatch(/^[4-9]\./)
    })

    test("user config file is created at the expected path", () => {
      expect(existsSync(install.configPath)).toBe(true)
      const cfg = JSON.parse(readFileSync(install.configPath, "utf-8"))
      expect(cfg.agent.sisyphus.prompt_append).toContain("Kasper test")
    })

    test("kasper resolver finds the sisyphus agent via plugin_override, not missing", async () => {
      // This is the central regression test. Before the plugin_override
      // feature, kasper would have returned `missing` for sisyphus
      // (because the real prompt lives in node_modules/oh-my-opencode
      // and the only user-facing config is the omo JSON file, not
      // opencode.json). That would have triggered the AGENTS.md reroute
      // path in evaluate.ts/handlers.ts, or — worse — caused kasper to
      // write a dead `.opencode/agents/sisyphus.md` file that opencode
      // would never read.
      const source = await manager.resolve(install.agentName)
      if (source.kind !== "plugin_override") {
        throw new Error(
          `expected plugin_override, got ${source.kind}. ` +
            `This means kasper did not see the user's oh-my-opencode.json ` +
            `override and would have silently created a dead ` +
            `.opencode/agents/${install.agentName}.md file.`,
        )
      }
      expect(source.target).toBe("config")
      expect(source.promptField).toBe("prompt_append")
      expect(source.isAppend).toBe(true)
      expect(source.configPath).toBe(install.configPath)
      expect(source.value).toContain("Kasper test")
    })

    test("kasper.read() returns the user-defined prompt_append verbatim", async () => {
      const content = await manager.read(install.agentName)
      expect(content).toContain("Kasper test")
      expect(content).toContain(
        "Apply the user override via the plugin config.",
      )
    })

    test(
      "kasper.write() appends to the user's prompt_append in-place; " +
        "rest of config is preserved",
      async () => {
        const beforeRaw = readFileSync(install.configPath, "utf-8")
        const beforeParsed = JSON.parse(beforeRaw)
        const beforePromptAppend: string =
          beforeParsed.agent[install.agentName].prompt_append
        const beforeKeys = Object.keys(beforeParsed).sort()

        await manager.write(install.agentName, "New rule from kasper e2e test.")

        const afterRaw = readFileSync(install.configPath, "utf-8")
        const afterParsed = JSON.parse(afterRaw)
        const afterPromptAppend: string =
          afterParsed.agent[install.agentName].prompt_append

        // The kasper rule landed in the user's override.
        expect(afterPromptAppend).toContain("New rule from kasper e2e test.")
        // The original user content is preserved (kasper doesn't clobber).
        expect(afterPromptAppend).toContain(beforePromptAppend)
        // No new top-level keys were introduced.
        expect(Object.keys(afterParsed).sort()).toEqual(beforeKeys)
        // The agent entry still has `prompt_append` and kasper didn't
        // introduce any kasper-specific pollution. We deliberately do NOT
        // assert the entry has ONLY `prompt_append` — oh-my-opencode
        // could legitimately add sibling fields (e.g. `model`) in a
        // future release and this test should keep passing.
        expect(afterParsed.agent[install.agentName]).toHaveProperty(
          "prompt_append",
        )
        const agentKeys = Object.keys(afterParsed.agent[install.agentName])
        for (const k of agentKeys) {
          expect(k).not.toMatch(/^kasper[-_]/)
        }
      },
    )

    test("kasper.write() is idempotent — second call with same content does not duplicate", async () => {
      await manager.write(install.agentName, "New rule from kasper e2e test.")
      const afterRaw = readFileSync(install.configPath, "utf-8")
      const afterParsed = JSON.parse(afterRaw)
      const occurrences = (
        afterParsed.agent[install.agentName].prompt_append.match(
          /New rule from kasper e2e test\./g,
        ) ?? []
      ).length
      expect(occurrences).toBe(1)
    })

    test("the agent's resolve result is stable across calls (no drift)", async () => {
      // After kasper has written to the override, the resolver should
      // still find the same source. This guards against cache invalidation
      // bugs where a write would cause subsequent reads to see `missing`.
      const s1 = await manager.resolve(install.agentName)
      const s2 = await manager.resolve(install.agentName)
      expect(s1.kind).toBe("plugin_override")
      expect(s2.kind).toBe("plugin_override")
      if (s1.kind === "plugin_override" && s2.kind === "plugin_override") {
        expect(s1.configPath).toBe(s2.configPath)
        expect(s1.promptField).toBe(s2.promptField)
      }
    })
  },
)
