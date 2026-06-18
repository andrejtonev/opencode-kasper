/**
 * Unit-level regression tests for the four prompt-source shapes the
 * opencode resolver claims to handle. These run in-process against
 * `resolveAgentPromptSource`, `AgentPromptManager`, and
 * `materializeInlinePrompt` — no opencode spawn, no LLM scoring.
 *
 * Per https://opencode.ai/docs/agents and the opencode.json schema, an
 * agent's `prompt` field can be:
 *
 *   1. Inline string:         "prompt": "You are a code reviewer..."
 *   2. `{file:/abs/path}`:    "prompt": "{file:./prompts/build.txt}"
 *   3. `{path:/abs/path}`:    "prompt": "{path:./prompts/build.txt}"
 *   4. `file://...` URI:      recognised only in plugin override files
 *                            (`.opencode/<plugin>.json`), NOT in
 *                            opencode.json — see oh-my-opencode which
 *                            stores `prompt_append: "file://..."`.
 *   5. Plugin override:       ".opencode/<plugin>.json" with
 *                            "agent.<name>.prompt" / "prompt_append"
 *
 * Each test below pins one of these layouts and exercises both the read
 * path (resolver classification) and the write path
 * (`AgentPromptManager.write` and `materializeInlinePrompt`).
 *
 * Why this is needed: prior to this file, the e2e suite only exercised
 * shape 2 (`{file:...}`) and shape 5 (`prompt_append` via the omo
 * plugin config). Shapes 1, 3, and 4 had no direct test of the write
 * path — a regression in the inline→file promote logic or the
 * `file_uri` branch of `buildPluginOverride` would only surface as a
 * production bug.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
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
import {
  materializeInlinePrompt,
  resolveAgentPromptSource,
} from "../../src/agent-prompt-resolver.js"
import { AgentPromptManager } from "../../src/agent-prompts.js"

/**
 * Set up a fresh isolated project directory.
 *
 * `opencode.json` lives at `<projectRoot>/opencode.json` (NOT under
 * `.opencode/`). The resolver's findProjectOpencodeJson walks up from
 * projectRoot looking for `opencode.json` or `opencode.jsonc` at each
 * directory level.
 */
function setupTmpProject(prefix: string): {
  projectDir: string
  opencodeJsonPath: string
  kasperStateDir: string
  opencodeDir: string
} {
  const projectDir = mkdtempSync(
    join(tmpdir(), `kasper-prompt-shapes-${prefix}-`),
  )
  const opencodeJsonPath = join(projectDir, "opencode.json")
  const opencodeDir = join(projectDir, ".opencode")
  mkdirSync(opencodeDir, { recursive: true })
  const kasperStateDir = join(opencodeDir, "kasper")
  mkdirSync(kasperStateDir, { recursive: true })
  return { projectDir, opencodeJsonPath, kasperStateDir, opencodeDir }
}

describe("prompt source shape: inline string in opencode.json", () => {
  let projectDir: string
  let opencodeJsonPath: string
  let kasperStateDir: string

  beforeEach(() => {
    const p = setupTmpProject("inline")
    projectDir = p.projectDir
    opencodeJsonPath = p.opencodeJsonPath
    kasperStateDir = p.kasperStateDir
  })

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
  })

  test("resolver classifies an inline prompt as kind=inline with verbatim text", async () => {
    const inlineText =
      "You are a code reviewer. Focus on security and performance."
    writeFileSync(
      opencodeJsonPath,
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        agent: { reviewer: { prompt: inlineText } },
      }),
      "utf-8",
    )

    const source = await resolveAgentPromptSource(
      "reviewer",
      projectDir,
      projectDir, // globalOpencodeDir (use project for isolation)
    )

    if (source.kind !== "inline") {
      throw new Error(
        `expected kind=inline, got ${source.kind}. ` +
          `The resolver missed the inline string in ${opencodeJsonPath}.`,
      )
    }
    expect(source.prompt).toBe(inlineText)
    expect(source.configPath).toBe(opencodeJsonPath)
  })

  test("AgentPromptManager.read() returns the inline string verbatim", async () => {
    const inlineText =
      "You are an inline reviewer. No file or directive involved."
    writeFileSync(
      opencodeJsonPath,
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        agent: { reviewer: { prompt: inlineText } },
      }),
      "utf-8",
    )

    const manager = new AgentPromptManager(
      projectDir,
      kasperStateDir,
      projectDir,
    )
    const content = await manager.read("reviewer")
    expect(content).toBe(inlineText)
  })

  test(
    "AgentPromptManager.write() refuses inline sources — " +
      "user must run /kasper migrate first (InlinePromptError)",
    async () => {
      const inlineText = "You are an inline reviewer. Do not write me."
      writeFileSync(
        opencodeJsonPath,
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          agent: { reviewer: { prompt: inlineText } },
        }),
        "utf-8",
      )

      const manager = new AgentPromptManager(
        projectDir,
        kasperStateDir,
        projectDir,
      )

      let caught: unknown = null
      try {
        await manager.write("reviewer", "Kasper tried to write inline content.")
      } catch (err) {
        caught = err
      }
      if (!caught) {
        throw new Error(
          "expected manager.write() to throw InlinePromptError on an " +
            "inline source — silent overwrites would clobber the " +
            "user's hand-written prompt.",
        )
      }
      const msg = caught instanceof Error ? caught.message : String(caught)
      expect(msg).toMatch(/inline|migrate/i)

      // Verify the inline prompt is untouched.
      const after = JSON.parse(readFileSync(opencodeJsonPath, "utf-8"))
      expect(after.agent.reviewer.prompt).toBe(inlineText)
    },
  )

  test(
    "materializeInlinePrompt() promotes the inline string to a " +
      "<project>/.opencode/agents/<name>.md file and rewrites the " +
      "config's `prompt` field to a `{file:...}` directive",
    async () => {
      const inlineText =
        "You are the security auditor. Be paranoid. Always assume input is hostile."
      writeFileSync(
        opencodeJsonPath,
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          agent: { auditor: { prompt: inlineText } },
        }),
        "utf-8",
      )

      const result = await materializeInlinePrompt(
        "auditor",
        projectDir,
        projectDir,
      )

      // The migration wrote a new prompt file.
      const expectedFile = join(projectDir, ".opencode", "agents", "auditor.md")
      expect(result.filePath).toBe(expectedFile)
      expect(result.fileCreated).toBe(true)
      expect(existsSync(expectedFile)).toBe(true)

      // The file body preserves the original inline text.
      const fileBody = readFileSync(expectedFile, "utf-8")
      expect(fileBody).toContain(inlineText)
      // It also has the conventional frontmatter kasper writes.
      expect(fileBody).toMatch(/^---\nmode: \w+\n---\n/)

      // The opencode.json was rewritten: the inline `prompt` field is now
      // a `{file:...}` directive pointing at the new file.
      expect(result.configModified).toBe(true)
      const after = JSON.parse(readFileSync(opencodeJsonPath, "utf-8"))
      const newPrompt = after.agent.auditor.prompt
      expect(typeof newPrompt).toBe("string")
      expect(newPrompt).toMatch(/^\s*\{\s*file\s*:/)
      expect(newPrompt).toContain("auditor.md")

      // After migration, the resolver should reclassify the source from
      // `inline` to `external_file` — the write path will now succeed.
      const manager = new AgentPromptManager(
        projectDir,
        kasperStateDir,
        projectDir,
      )
      await manager.write(
        "auditor",
        "Additional rule from kasper post-migrate.",
      )
      const finalBody = readFileSync(expectedFile, "utf-8")
      expect(finalBody).toContain("Additional rule from kasper post-migrate.")
    },
  )
})

describe("prompt source shape: file:// URI in a plugin override file", () => {
  let projectDir: string
  let kasperStateDir: string
  let pluginConfigPath: string
  let promptFilePath: string

  beforeEach(() => {
    const p = setupTmpProject("file-uri")
    projectDir = p.projectDir
    kasperStateDir = p.kasperStateDir
    // Plugin override file (e.g. oh-my-openagent.json). Per the resolver,
    // `file://` URIs are recognised in these files (not in opencode.json).
    pluginConfigPath = join(projectDir, ".opencode", "oh-my-openagent.json")
    // The referenced prompt file lives somewhere on disk.
    promptFilePath = join(projectDir, "external-prompts", "uri-agent.md")
    mkdirSync(join(projectDir, "external-prompts"), { recursive: true })
    writeFileSync(
      promptFilePath,
      "# URI Agent\n\nFollow the URI protocol.\n",
      "utf-8",
    )
  })

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
  })

  test("resolver classifies a file:// URI as plugin_override target=file_uri", async () => {
    writeFileSync(
      pluginConfigPath,
      JSON.stringify({
        agent: { "uri-agent": { prompt_append: `file://${promptFilePath}` } },
      }),
      "utf-8",
    )

    const source = await resolveAgentPromptSource(
      "uri-agent",
      projectDir,
      projectDir,
    )

    if (source.kind !== "plugin_override") {
      throw new Error(
        `expected plugin_override (file_uri), got ${source.kind}. ` +
          `The file:// URI form in a plugin override file was not classified.`,
      )
    }
    if (source.target !== "file_uri") {
      throw new Error(
        `expected target=file_uri, got ${source.target}. ` +
          `The resolver must distinguish file:// URIs from {file:...} directives.`,
      )
    }
    expect(source.path).toBe(promptFilePath)
    expect(source.promptField).toBe("prompt_append")
    expect(source.configPath).toBe(pluginConfigPath)
  })

  test("AgentPromptManager.read() returns the file body for a file:// URI source", async () => {
    writeFileSync(
      pluginConfigPath,
      JSON.stringify({
        agent: { "uri-agent": { prompt_append: `file://${promptFilePath}` } },
      }),
      "utf-8",
    )

    const manager = new AgentPromptManager(
      projectDir,
      kasperStateDir,
      projectDir,
    )
    const content = await manager.read("uri-agent")
    expect(content).toContain("# URI Agent")
    expect(content).toContain("Follow the URI protocol.")
  })

  test(
    "AgentPromptManager.write() edits the file at the URI, leaves the " +
      "plugin config's `prompt_append` field unchanged",
    async () => {
      writeFileSync(
        pluginConfigPath,
        JSON.stringify({
          agent: { "uri-agent": { prompt_append: `file://${promptFilePath}` } },
        }),
        "utf-8",
      )

      const manager = new AgentPromptManager(
        projectDir,
        kasperStateDir,
        projectDir,
      )
      await manager.write(
        "uri-agent",
        "Kasper rule written to the URI-targeted file.",
      )

      // For `file_uri` targets, AgentPromptManager.write() overwrites the
      // referenced file with the new content (it does NOT append — that's
      // the `plugin_override` (config) target behaviour, not `file_uri`).
      const fileAfter = readFileSync(promptFilePath, "utf-8")
      expect(fileAfter.trim()).toBe(
        "Kasper rule written to the URI-targeted file.",
      )

      // The plugin config is untouched — the URI is still the same.
      const configAfter = JSON.parse(readFileSync(pluginConfigPath, "utf-8"))
      expect(configAfter.agent["uri-agent"].prompt_append).toBe(
        `file://${promptFilePath}`,
      )
    },
  )

  test("file:// URI with a ~/... path resolves to $HOME", async () => {
    const homeRel = `file://~/kasper-e2e-uri-home-test-${Date.now()}.md`
    const expandedPath = join(
      process.env.HOME ?? "/home/user",
      homeRel.replace(/^file:\/\/~\//, ""),
    )
    writeFileSync(
      expandedPath,
      "# Home URI Agent\n\nFrom the home directory.\n",
      "utf-8",
    )
    try {
      writeFileSync(
        pluginConfigPath,
        JSON.stringify({
          agent: { "home-uri": { prompt_append: homeRel } },
        }),
        "utf-8",
      )

      const source = await resolveAgentPromptSource(
        "home-uri",
        projectDir,
        projectDir,
      )

      if (source.kind !== "plugin_override" || source.target !== "file_uri") {
        throw new Error(
          `expected plugin_override/file_uri, got ${source.kind}/${source.target ?? "?"}`,
        )
      }
      expect(source.path).toBe(expandedPath)

      const manager = new AgentPromptManager(
        projectDir,
        kasperStateDir,
        projectDir,
      )
      await manager.write("home-uri", "Kasper rule for the home URI file.")
      const fileAfter = readFileSync(expandedPath, "utf-8")
      expect(fileAfter).toContain("Kasper rule for the home URI file.")
    } finally {
      rmSync(expandedPath, { force: true })
    }
  })
})

describe("prompt source shape: {path:...} directive in opencode.json", () => {
  let projectDir: string
  let opencodeJsonPath: string
  let kasperStateDir: string
  let targetPath: string

  beforeEach(() => {
    const p = setupTmpProject("path-directive")
    projectDir = p.projectDir
    opencodeJsonPath = p.opencodeJsonPath
    kasperStateDir = p.kasperStateDir
    targetPath = join(projectDir, "prompts", "path-agent.md")
    mkdirSync(join(projectDir, "prompts"), { recursive: true })
    writeFileSync(
      targetPath,
      "# Path Agent\n\nConfigured via {path:...}.\n",
      "utf-8",
    )
  })

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
  })

  test(
    "resolver classifies {path:...} in opencode.json as kind=external_file " +
      "(the same path as {file:...} — both are direct file directives)",
    async () => {
      writeFileSync(
        opencodeJsonPath,
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          agent: {
            "path-agent": { prompt: `{path:./prompts/path-agent.md}` },
          },
        }),
        "utf-8",
      )

      const source = await resolveAgentPromptSource(
        "path-agent",
        projectDir,
        projectDir,
      )

      // {path:...} in opencode.json is treated identically to {file:...} —
      // both yield `external_file` (a real file on disk). This is the
      // documented behaviour of resolveAgentPromptSource at line 642-650.
      if (source.kind !== "external_file") {
        throw new Error(
          `expected external_file, got ${source.kind}. ` +
            `The {path:...} directive in opencode.json was not classified.`,
        )
      }
      expect(source.path).toBe(targetPath)
      expect(source.configPath).toBe(opencodeJsonPath)
    },
  )

  test("AgentPromptManager.read() returns the file body for a {path:...} source", async () => {
    writeFileSync(
      opencodeJsonPath,
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        agent: { "path-agent": { prompt: `{path:./prompts/path-agent.md}` } },
      }),
      "utf-8",
    )

    const manager = new AgentPromptManager(
      projectDir,
      kasperStateDir,
      projectDir,
    )
    const content = await manager.read("path-agent")
    expect(content).toContain("# Path Agent")
    expect(content).toContain("Configured via {path:...}.")
  })

  test(
    "AgentPromptManager.write() edits the file at the {path:...} " +
      "target, leaves the opencode.json's `prompt` directive unchanged",
    async () => {
      writeFileSync(
        opencodeJsonPath,
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          agent: { "path-agent": { prompt: `{path:./prompts/path-agent.md}` } },
        }),
        "utf-8",
      )

      const manager = new AgentPromptManager(
        projectDir,
        kasperStateDir,
        projectDir,
      )
      await manager.write(
        "path-agent",
        "Kasper rule written to the {path:...} target.",
      )

      // For `external_file` targets (the kind that {file:...} and
      // {path:...} in opencode.json produce), AgentPromptManager.write()
      // overwrites the referenced file with the new content.
      const fileAfter = readFileSync(targetPath, "utf-8")
      expect(fileAfter.trim()).toBe(
        "Kasper rule written to the {path:...} target.",
      )

      const configAfter = JSON.parse(readFileSync(opencodeJsonPath, "utf-8"))
      expect(configAfter.agent["path-agent"].prompt).toBe(
        `{path:./prompts/path-agent.md}`,
      )
    },
  )
})
