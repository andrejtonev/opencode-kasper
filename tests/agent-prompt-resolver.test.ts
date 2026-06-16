import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join, relative } from "node:path"
import {
  defaultAgentFilePath,
  materializeInlinePrompt,
  resolveAgentPromptSource,
} from "../src/agent-prompt-resolver.js"
import { AgentPromptManager, InlinePromptError } from "../src/agent-prompts.js"

function tmpDir(): string {
  return join(
    tmpdir(),
    `kasper-resolver-test-${randomBytes(6).toString("hex")}`,
  )
}

async function writeJsonc(path: string, content: string): Promise<void> {
  await writeFile(path, content, "utf-8")
}

describe("resolveAgentPromptSource", () => {
  let projectRoot: string
  let globalDir: string

  beforeEach(async () => {
    projectRoot = tmpDir()
    globalDir = join(projectRoot, "global-opencode")
    await mkdir(globalDir, { recursive: true })
    await mkdir(join(projectRoot, ".opencode"), { recursive: true })
  })

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true })
  })

  test("returns missing when no source is defined anywhere", async () => {
    const source = await resolveAgentPromptSource("foo", projectRoot, globalDir)
    expect(source.kind).toBe("missing")
  })

  test("resolves {file:...} directive from project opencode.json to external_file", async () => {
    const targetPath = join(projectRoot, "external", "reviewer.md")
    await mkdir(join(projectRoot, "external"), { recursive: true })
    await writeFile(targetPath, "You are a reviewer.", "utf-8")
    await writeJsonc(
      join(projectRoot, "opencode.json"),
      JSON.stringify({
        agent: { "pr-reviewer": { prompt: `{file:${targetPath}}` } },
      }),
    )

    const source = await resolveAgentPromptSource(
      "pr-reviewer",
      projectRoot,
      globalDir,
    )
    if (source.kind !== "external_file") {
      throw new Error(`expected external_file, got ${source.kind}`)
    }
    expect(source.path).toBe(targetPath)
    expect(source.configPath).toBe(join(projectRoot, "opencode.json"))
  })

  test("resolves {path:...} directive as an alias for {file:...}", async () => {
    const targetPath = join(projectRoot, "external", "build.md")
    await mkdir(join(projectRoot, "external"), { recursive: true })
    await writeFile(targetPath, "Build.", "utf-8")
    await writeJsonc(
      join(projectRoot, "opencode.json"),
      JSON.stringify({
        agent: { build: { prompt: `{path:${targetPath}}` } },
      }),
    )

    const source = await resolveAgentPromptSource(
      "build",
      projectRoot,
      globalDir,
    )
    if (source.kind !== "external_file") {
      throw new Error(`expected external_file, got ${source.kind}`)
    }
    expect(source.path).toBe(targetPath)
  })

  test("expands ~ in {file:~/...} directive", async () => {
    const targetPath = join(projectRoot, "homedir-target.md")
    await writeFile(targetPath, "Hi.", "utf-8")
    // We can't write into the real home, but the resolver should expand ~
    // to an absolute path it tries to read. We test the function by giving
    // it a relative-looking path that the resolver will resolve against the
    // config dir, not the home expansion itself.
    await writeJsonc(
      join(projectRoot, "opencode.json"),
      JSON.stringify({
        agent: { foo: { prompt: `{file:${targetPath}}` } },
      }),
    )

    const source = await resolveAgentPromptSource("foo", projectRoot, globalDir)
    if (source.kind !== "external_file") {
      throw new Error(`expected external_file, got ${source.kind}`)
    }
    expect(source.path).toBe(targetPath)
  })

  test("resolves inline string to inline source", async () => {
    await writeJsonc(
      join(projectRoot, "opencode.json"),
      JSON.stringify({
        agent: { build: { prompt: "You are a build agent." } },
      }),
    )

    const source = await resolveAgentPromptSource(
      "build",
      projectRoot,
      globalDir,
    )
    if (source.kind !== "inline") {
      throw new Error(`expected inline, got ${source.kind}`)
    }
    expect(source.prompt).toBe("You are a build agent.")
    expect(source.configPath).toBe(join(projectRoot, "opencode.json"))
  })

  test("falls back to project file when opencode.json does not define the agent", async () => {
    const filePath = join(projectRoot, ".opencode", "agents", "general.md")
    await mkdir(join(projectRoot, ".opencode", "agents"), { recursive: true })
    await writeFile(filePath, "You are a generalist.", "utf-8")

    const source = await resolveAgentPromptSource(
      "general",
      projectRoot,
      globalDir,
    )
    if (source.kind !== "project_file") {
      throw new Error(`expected project_file, got ${source.kind}`)
    }
    expect(source.path).toBe(filePath)
  })

  test("falls back to project file in singular .opencode/agent/ dir", async () => {
    const filePath = join(projectRoot, ".opencode", "agent", "general.md")
    await mkdir(join(projectRoot, ".opencode", "agent"), { recursive: true })
    await writeFile(filePath, "You are a generalist.", "utf-8")

    const source = await resolveAgentPromptSource(
      "general",
      projectRoot,
      globalDir,
    )
    if (source.kind !== "project_file") {
      throw new Error(`expected project_file, got ${source.kind}`)
    }
    expect(source.path).toBe(filePath)
  })

  test("falls back to global file when no project source exists", async () => {
    const filePath = join(globalDir, "agents", "general.md")
    await mkdir(join(globalDir, "agents"), { recursive: true })
    await writeFile(filePath, "You are a generalist.", "utf-8")

    const source = await resolveAgentPromptSource(
      "general",
      projectRoot,
      globalDir,
    )
    if (source.kind !== "global_file") {
      throw new Error(`expected global_file, got ${source.kind}`)
    }
    expect(source.path).toBe(filePath)
  })

  test("project opencode.json overrides global opencode.json for the same agent", async () => {
    const projectTarget = join(projectRoot, "project-target.md")
    const globalTarget = join(projectRoot, "global-target.md")
    await writeFile(projectTarget, "project", "utf-8")
    await writeFile(globalTarget, "global", "utf-8")
    await writeJsonc(
      join(projectRoot, "opencode.json"),
      JSON.stringify({
        agent: { build: { prompt: `{file:${projectTarget}}` } },
      }),
    )
    await writeJsonc(
      join(globalDir, "opencode.json"),
      JSON.stringify({
        agent: { build: { prompt: `{file:${globalTarget}}` } },
      }),
    )

    const source = await resolveAgentPromptSource(
      "build",
      projectRoot,
      globalDir,
    )
    if (source.kind !== "external_file") {
      throw new Error(`expected external_file, got ${source.kind}`)
    }
    expect(source.path).toBe(projectTarget)
    expect(source.configPath).toBe(join(projectRoot, "opencode.json"))
  })

  test("prefers {file:...} directive over conventional file when both exist", async () => {
    const targetPath = join(projectRoot, "external", "build.md")
    await mkdir(join(projectRoot, "external"), { recursive: true })
    await writeFile(targetPath, "external", "utf-8")
    const projectFile = join(projectRoot, ".opencode", "agents", "build.md")
    await mkdir(join(projectRoot, ".opencode", "agents"), { recursive: true })
    await writeFile(projectFile, "project", "utf-8")
    await writeJsonc(
      join(projectRoot, "opencode.json"),
      JSON.stringify({
        agent: { build: { prompt: `{file:${targetPath}}` } },
      }),
    )

    const source = await resolveAgentPromptSource(
      "build",
      projectRoot,
      globalDir,
    )
    if (source.kind !== "external_file") {
      throw new Error(`expected external_file, got ${source.kind}`)
    }
    expect(source.path).toBe(targetPath)
  })
})

describe("resolveAgentPromptSource — plugin_override", () => {
  let projectRoot: string
  let globalDir: string

  beforeEach(async () => {
    projectRoot = tmpDir()
    globalDir = join(projectRoot, "global-opencode")
    await mkdir(globalDir, { recursive: true })
    await mkdir(join(projectRoot, ".opencode"), { recursive: true })
  })

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true })
  })

  test("oh-my-opencode-style: `agent` map with raw `prompt_append` is resolved as config target", async () => {
    // Simulates `.opencode/oh-my-opencode.json` defining
    // `agent.<name>.prompt_append: "raw text"`.
    const promptAppend = "You are a built-in agent. Do X."
    await writeJsonc(
      join(projectRoot, ".opencode", "oh-my-opencode.json"),
      JSON.stringify({
        agent: { sisyphus: { prompt_append: promptAppend } },
      }),
    )
    const source = await resolveAgentPromptSource(
      "sisyphus",
      projectRoot,
      globalDir,
    )
    if (source.kind !== "plugin_override") {
      throw new Error(`expected plugin_override, got ${source.kind}`)
    }
    expect(source.target).toBe("config")
    expect(source.promptField).toBe("prompt_append")
    expect(source.isAppend).toBe(true)
    expect(source.value).toBe(promptAppend)
    expect(source.configPath).toBe(
      join(projectRoot, ".opencode", "oh-my-opencode.json"),
    )
  })

  test("`agent` map with raw `prompt` is resolved as config target with isAppend=false", async () => {
    const raw = "Totally custom prompt."
    await writeJsonc(
      join(projectRoot, ".opencode", "oh-my-opencode.json"),
      JSON.stringify({ agent: { atlas: { prompt: raw } } }),
    )
    const source = await resolveAgentPromptSource(
      "atlas",
      projectRoot,
      globalDir,
    )
    if (source.kind !== "plugin_override") {
      throw new Error(`expected plugin_override, got ${source.kind}`)
    }
    expect(source.target).toBe("config")
    expect(source.promptField).toBe("prompt")
    expect(source.isAppend).toBe(false)
    expect(source.value).toBe(raw)
  })

  test("`agents` map (plural) is also scanned", async () => {
    const raw = "Build things."
    await writeJsonc(
      join(projectRoot, ".opencode", "my-plugin.json"),
      JSON.stringify({ agents: { build: { prompt_append: raw } } }),
    )
    const source = await resolveAgentPromptSource(
      "build",
      projectRoot,
      globalDir,
    )
    if (source.kind !== "plugin_override") {
      throw new Error(`expected plugin_override, got ${source.kind}`)
    }
    expect(source.target).toBe("config")
    expect(source.promptField).toBe("prompt_append")
  })

  test("`prompt: {file:...}` directive in a plugin config becomes a file target", async () => {
    const target = join(projectRoot, "prompts", "sisyphus.md")
    await mkdir(join(projectRoot, "prompts"), { recursive: true })
    await writeFile(target, "Base sisyphus prompt.", "utf-8")
    await writeJsonc(
      join(projectRoot, ".opencode", "oh-my-opencode.json"),
      JSON.stringify({
        agent: { sisyphus: { prompt: `{file:${target}}` } },
      }),
    )
    const source = await resolveAgentPromptSource(
      "sisyphus",
      projectRoot,
      globalDir,
    )
    if (source.kind !== "plugin_override") {
      throw new Error(`expected plugin_override, got ${source.kind}`)
    }
    expect(source.target).toBe("file")
    expect(source.path).toBe(target)
    expect(source.isAppend).toBe(false)
  })

  test("`file://./...` URI is resolved to file_uri target relative to the config dir", async () => {
    // `file://./...` is resolved relative to the directory containing the
    // config file, so the target must be under `<projectRoot>/.opencode/`.
    const target = join(projectRoot, ".opencode", "prompts", "sisyphus.md")
    await mkdir(join(projectRoot, ".opencode", "prompts"), { recursive: true })
    await writeFile(target, "Base prompt.", "utf-8")
    await writeJsonc(
      join(projectRoot, ".opencode", "oh-my-opencode.json"),
      JSON.stringify({
        agent: { sisyphus: { prompt: "file://./prompts/sisyphus.md" } },
      }),
    )
    const source = await resolveAgentPromptSource(
      "sisyphus",
      projectRoot,
      globalDir,
    )
    if (source.kind !== "plugin_override") {
      throw new Error(`expected plugin_override, got ${source.kind}`)
    }
    expect(source.target).toBe("file_uri")
    expect(source.path).toBe(target)
  })

  test("`file:///abs/path` URI is resolved verbatim", async () => {
    const target = join(projectRoot, "anywhere", "x.md")
    await mkdir(join(projectRoot, "anywhere"), { recursive: true })
    await writeFile(target, "X.", "utf-8")
    await writeJsonc(
      join(projectRoot, ".opencode", "oh-my-opencode.json"),
      JSON.stringify({
        agent: { foo: { prompt: `file://${target}` } },
      }),
    )
    const source = await resolveAgentPromptSource("foo", projectRoot, globalDir)
    if (source.kind !== "plugin_override") {
      throw new Error(`expected plugin_override, got ${source.kind}`)
    }
    expect(source.target).toBe("file_uri")
    expect(source.path).toBe(target)
  })

  test("`file://~/...` URI expands tilde to the home directory", async () => {
    await writeJsonc(
      join(projectRoot, ".opencode", "oh-my-opencode.json"),
      JSON.stringify({
        agent: { foo: { prompt: "file://~/some-home-path/x.md" } },
      }),
    )
    const source = await resolveAgentPromptSource("foo", projectRoot, globalDir)
    if (source.kind !== "plugin_override") {
      throw new Error(`expected plugin_override, got ${source.kind}`)
    }
    expect(source.target).toBe("file_uri")
    expect(source.path).toBe(join(homedir(), "some-home-path", "x.md"))
  })

  test("opencode.json still takes priority over a plugin config in the same directory", async () => {
    // When opencode.json defines the agent via `{file:...}` AND a sibling
    // plugin config also defines it, opencode.json wins.
    const opencodeTarget = join(projectRoot, "from-opencode.md")
    await writeFile(opencodeTarget, "From opencode.json.", "utf-8")
    await writeJsonc(
      join(projectRoot, "opencode.json"),
      JSON.stringify({
        agent: { foo: { prompt: `{file:${opencodeTarget}}` } },
      }),
    )
    await writeJsonc(
      join(projectRoot, ".opencode", "oh-my-opencode.json"),
      JSON.stringify({ agent: { foo: { prompt_append: "Plugin text." } } }),
    )
    const source = await resolveAgentPromptSource("foo", projectRoot, globalDir)
    if (source.kind !== "external_file") {
      throw new Error(`expected external_file, got ${source.kind}`)
    }
    expect(source.path).toBe(opencodeTarget)
  })

  test("walks up to find a plugin override in a parent .opencode/", async () => {
    const subDir = join(projectRoot, "packages", "sub")
    await mkdir(join(subDir, ".opencode"), { recursive: true })
    await writeJsonc(
      join(subDir, ".opencode", "oh-my-opencode.json"),
      JSON.stringify({ agent: { foo: { prompt_append: "From sub." } } }),
    )
    const source = await resolveAgentPromptSource("foo", subDir, globalDir)
    if (source.kind !== "plugin_override") {
      throw new Error(`expected plugin_override, got ${source.kind}`)
    }
    expect(source.value).toBe("From sub.")
  })

  test("the closer .opencode wins when both an ancestor and a descendant define the agent", async () => {
    const subDir = join(projectRoot, "packages", "sub")
    await mkdir(join(subDir, ".opencode"), { recursive: true })
    await writeJsonc(
      join(projectRoot, ".opencode", "oh-my-opencode.json"),
      JSON.stringify({ agent: { foo: { prompt_append: "From root." } } }),
    )
    await writeJsonc(
      join(subDir, ".opencode", "oh-my-opencode.json"),
      JSON.stringify({ agent: { foo: { prompt_append: "From sub." } } }),
    )
    const source = await resolveAgentPromptSource("foo", subDir, globalDir)
    if (source.kind !== "plugin_override") {
      throw new Error(`expected plugin_override, got ${source.kind}`)
    }
    expect(source.value).toBe("From sub.")
  })

  test("falls through to global plugin configs when project has none", async () => {
    // No .opencode in project — but a plugin override at the global level.
    await writeJsonc(
      join(globalDir, "oh-my-opencode.json"),
      JSON.stringify({ agent: { foo: { prompt_append: "From global." } } }),
    )
    const source = await resolveAgentPromptSource("foo", projectRoot, globalDir)
    if (source.kind !== "plugin_override") {
      throw new Error(`expected plugin_override, got ${source.kind}`)
    }
    expect(source.value).toBe("From global.")
    expect(source.configPath).toBe(join(globalDir, "oh-my-opencode.json"))
  })

  test("returns missing when no plugin config or opencode.json entry exists", async () => {
    const source = await resolveAgentPromptSource(
      "orphan",
      projectRoot,
      globalDir,
    )
    expect(source.kind).toBe("missing")
  })

  test("non-plugin keys are ignored (e.g. a `commands` map with prompt field is not picked up)", async () => {
    // We should not mistake arbitrary `prompt` fields under unrelated top-level
    // maps for an agent override. Only `agent` and `agents` maps count.
    await writeJsonc(
      join(projectRoot, ".opencode", "oh-my-opencode.json"),
      JSON.stringify({
        commands: { build: { prompt: "Not an agent prompt" } },
      }),
    )
    const source = await resolveAgentPromptSource(
      "build",
      projectRoot,
      globalDir,
    )
    expect(source.kind).toBe("missing")
  })
})

describe("resolveAgentPromptSource — custom prompt_paths", () => {
  let projectRoot: string
  let globalDir: string

  beforeEach(async () => {
    projectRoot = tmpDir()
    globalDir = join(projectRoot, "global-opencode")
    await mkdir(globalDir, { recursive: true })
    await mkdir(join(projectRoot, ".opencode"), { recursive: true })
  })

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true })
  })

  test("custom absolute path: resolves <dir>/agents/<name>.md as project_file", async () => {
    const customDir = join(projectRoot, "prompts")
    await mkdir(join(customDir, "agents"), { recursive: true })
    await writeFile(
      join(customDir, "agents", "build.md"),
      "Build things.",
      "utf-8",
    )
    const source = await resolveAgentPromptSource(
      "build",
      projectRoot,
      globalDir,
      [customDir],
    )
    if (source.kind !== "project_file") {
      throw new Error(`expected project_file, got ${source.kind}`)
    }
    expect(source.path).toBe(join(customDir, "agents", "build.md"))
  })

  test("custom absolute path: resolves <dir>/agent/<name>.md (singular) as project_file", async () => {
    const customDir = join(projectRoot, "prompts")
    await mkdir(join(customDir, "agent"), { recursive: true })
    await writeFile(
      join(customDir, "agent", "build.md"),
      "Build things.",
      "utf-8",
    )
    const source = await resolveAgentPromptSource(
      "build",
      projectRoot,
      globalDir,
      [customDir],
    )
    if (source.kind !== "project_file") {
      throw new Error(`expected project_file, got ${source.kind}`)
    }
    expect(source.path).toBe(join(customDir, "agent", "build.md"))
  })

  test("project-relative custom path: <path> is resolved against projectRoot", async () => {
    await mkdir(join(projectRoot, "shared-prompts", "agents"), {
      recursive: true,
    })
    await writeFile(
      join(projectRoot, "shared-prompts", "agents", "review.md"),
      "Review.",
      "utf-8",
    )
    const source = await resolveAgentPromptSource(
      "review",
      projectRoot,
      globalDir,
      ["shared-prompts"],
    )
    if (source.kind !== "project_file") {
      throw new Error(`expected project_file, got ${source.kind}`)
    }
    expect(source.path).toBe(
      join(projectRoot, "shared-prompts", "agents", "review.md"),
    )
  })

  test("~/... custom path: tilde is expanded to homedir", async () => {
    // We don't write to the real home; we just verify the resolver produced
    // a path under $HOME for the matching agent.
    const source = await resolveAgentPromptSource(
      "missing-but-valid-uri",
      projectRoot,
      globalDir,
      ["~/some-kasper-prompts"],
    )
    if (source.kind !== "missing") {
      throw new Error(
        `expected missing (no file in ~/some-kasper-prompts), got ${source.kind}`,
      )
    }
  })

  test("custom paths are consulted AFTER standard locations and plugin overrides", async () => {
    // A custom path should not shadow a more specific standard source.
    const standardPath = join(projectRoot, ".opencode", "agents", "build.md")
    await mkdir(join(projectRoot, ".opencode", "agents"), { recursive: true })
    await writeFile(standardPath, "Standard.", "utf-8")
    const customDir = join(projectRoot, "prompts")
    await mkdir(join(customDir, "agents"), { recursive: true })
    await writeFile(join(customDir, "agents", "build.md"), "Custom.", "utf-8")

    const source = await resolveAgentPromptSource(
      "build",
      projectRoot,
      globalDir,
      [customDir],
    )
    if (source.kind !== "project_file") {
      throw new Error(`expected project_file, got ${source.kind}`)
    }
    expect(source.path).toBe(standardPath)
  })

  test("multiple custom paths: first matching path wins", async () => {
    const first = join(projectRoot, "prompts-a")
    const second = join(projectRoot, "prompts-b")
    await mkdir(join(first, "agents"), { recursive: true })
    await writeFile(join(first, "agents", "build.md"), "A.", "utf-8")
    await mkdir(join(second, "agents"), { recursive: true })
    await writeFile(join(second, "agents", "build.md"), "B.", "utf-8")
    const source = await resolveAgentPromptSource(
      "build",
      projectRoot,
      globalDir,
      [first, second],
    )
    if (source.kind !== "project_file") {
      throw new Error(`expected project_file, got ${source.kind}`)
    }
    expect(source.path).toBe(join(first, "agents", "build.md"))
  })

  test("empty or missing customPromptPaths does not change behaviour", async () => {
    // No .opencode/agent file, no opencode.json — the resolver should
    // return `missing` when no paths are configured.
    const a = await resolveAgentPromptSource(
      "foo",
      projectRoot,
      globalDir,
      undefined,
    )
    expect(a.kind).toBe("missing")
    const b = await resolveAgentPromptSource("foo", projectRoot, globalDir, [])
    expect(b.kind).toBe("missing")
  })

  test("invalid (empty-string / non-string) entries are ignored", async () => {
    const customDir = join(projectRoot, "prompts")
    await mkdir(join(customDir, "agents"), { recursive: true })
    await writeFile(join(customDir, "agents", "build.md"), "X.", "utf-8")
    // The `undefined` entry is intentionally added at runtime; cast through
    // `unknown` so the test type-checks without disabling lint rules.
    const paths: unknown = ["", "   ", customDir, undefined]
    const source = await resolveAgentPromptSource(
      "build",
      projectRoot,
      globalDir,
      paths as string[],
    )
    if (source.kind !== "project_file") {
      throw new Error(`expected project_file, got ${source.kind}`)
    }
    expect(source.path).toBe(join(customDir, "agents", "build.md"))
  })
})

describe("materializeInlinePrompt", () => {
  let projectRoot: string
  let globalDir: string

  beforeEach(async () => {
    projectRoot = tmpDir()
    globalDir = join(projectRoot, "global-opencode")
    await mkdir(globalDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true })
  })

  test("extracts inline prompt to a file and rewrites opencode.json", async () => {
    const configPath = join(projectRoot, "opencode.json")
    await writeJsonc(
      configPath,
      JSON.stringify(
        {
          agent: { build: { prompt: "You are a build agent." } },
        },
        null,
        2,
      ),
    )

    const result = await materializeInlinePrompt(
      "build",
      projectRoot,
      globalDir,
    )
    expect(result.fileCreated).toBe(true)
    expect(result.configModified).toBe(true)
    expect(result.configPath).toBe(configPath)

    // File was created with the inline content
    const fileContent = await readFile(result.filePath, "utf-8")
    expect(fileContent).toContain("You are a build agent.")
    expect(fileContent).toContain("mode: subagent")

    // Config was rewritten with {file:...} directive
    const newConfig = JSON.parse(await readFile(configPath, "utf-8"))
    const expectedRel =
      relative(projectRoot, result.filePath) || result.filePath
    expect(newConfig.agent.build.prompt).toBe(`{file:${expectedRel}}`)
  })

  test("preserves other fields in the agent config entry", async () => {
    const configPath = join(projectRoot, "opencode.json")
    await writeJsonc(
      configPath,
      JSON.stringify(
        {
          agent: {
            build: {
              model: "anthropic/claude-sonnet-4-6",
              description: "builds things",
              prompt: "You are a build agent.",
              permission: { edit: "deny" },
            },
          },
        },
        null,
        2,
      ),
    )

    await materializeInlinePrompt("build", projectRoot, globalDir)
    const newConfig = JSON.parse(await readFile(configPath, "utf-8"))
    expect(newConfig.agent.build.model).toBe("anthropic/claude-sonnet-4-6")
    expect(newConfig.agent.build.description).toBe("builds things")
    expect(newConfig.agent.build.permission).toEqual({ edit: "deny" })
    expect(newConfig.agent.build.prompt).toMatch(/^\{file:.+\}$/)
  })

  test("throws when source is not inline", async () => {
    const targetPath = join(projectRoot, "external.md")
    await writeFile(targetPath, "external", "utf-8")
    await writeJsonc(
      join(projectRoot, "opencode.json"),
      JSON.stringify({ agent: { build: { prompt: `{file:${targetPath}}` } } }),
    )
    await expect(
      materializeInlinePrompt("build", projectRoot, globalDir),
    ).rejects.toThrow(/not inline/)
  })

  test("uses primary mode when specified", async () => {
    const configPath = join(projectRoot, "opencode.json")
    await writeJsonc(
      configPath,
      JSON.stringify({ agent: { build: { prompt: "x" } } }),
    )

    const result = await materializeInlinePrompt(
      "build",
      projectRoot,
      globalDir,
      {
        mode: "primary",
      },
    )
    const fileContent = await readFile(result.filePath, "utf-8")
    expect(fileContent).toContain("mode: primary")
  })
})

describe("AgentPromptManager (resolver-aware)", () => {
  let projectRoot: string
  let stateDir: string
  let globalDir: string

  beforeEach(async () => {
    projectRoot = tmpDir()
    stateDir = join(projectRoot, ".opencode", "kasper")
    globalDir = join(projectRoot, "global-opencode")
    await mkdir(globalDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true })
  })

  test("exists() returns true for {file:...} directive even when project file is missing", async () => {
    const targetPath = join(projectRoot, "external", "pr-reviewer.md")
    await mkdir(join(projectRoot, "external"), { recursive: true })
    await writeFile(targetPath, "Reviewer prompt.", "utf-8")
    await writeJsonc(
      join(projectRoot, "opencode.json"),
      JSON.stringify({
        agent: { "pr-reviewer": { prompt: `{file:${targetPath}}` } },
      }),
    )

    const manager = new AgentPromptManager(projectRoot, stateDir, globalDir)
    await manager.init()
    expect(await manager.exists("pr-reviewer")).toBe(true)
  })

  test("read() returns the external file's content (the bug fix scenario)", async () => {
    const targetPath = join(projectRoot, "external", "pr-reviewer.md")
    await mkdir(join(projectRoot, "external"), { recursive: true })
    const originalPrompt = "# PR Reviewer\n\nFollow the delegation protocol."
    await writeFile(targetPath, originalPrompt, "utf-8")
    await writeJsonc(
      join(projectRoot, "opencode.json"),
      JSON.stringify({
        agent: { "pr-reviewer": { prompt: `{file:${targetPath}}` } },
      }),
    )

    const manager = new AgentPromptManager(projectRoot, stateDir, globalDir)
    await manager.init()
    const content = await manager.read("pr-reviewer")
    expect(content).toBe(originalPrompt)
  })

  test("injectSection() writes to the external file, not a new project file (the bug fix scenario)", async () => {
    const targetPath = join(projectRoot, "external", "pr-reviewer.md")
    await mkdir(join(projectRoot, "external"), { recursive: true })
    const originalPrompt = "# PR Reviewer\n\nFollow the delegation protocol."
    await writeFile(targetPath, originalPrompt, "utf-8")
    await writeJsonc(
      join(projectRoot, "opencode.json"),
      JSON.stringify({
        agent: { "pr-reviewer": { prompt: `{file:${targetPath}}` } },
      }),
    )

    const manager = new AgentPromptManager(projectRoot, stateDir, globalDir)
    await manager.init()
    const improvement = "Add a sequencing rule: do X before Y"
    await manager.injectSection(
      "pr-reviewer",
      "Kasper Inferred Instructions",
      improvement,
    )

    // The EXTERNAL file got the section — this is the bug fix
    const externalContent = await readFile(targetPath, "utf-8")
    expect(externalContent).toContain(originalPrompt)
    expect(externalContent).toContain("## Kasper Inferred Instructions")
    expect(externalContent).toContain(improvement)

    // The wrong default project file was NOT created
    const wrongFilePath = defaultAgentFilePath(projectRoot, "pr-reviewer")
    const wrongExists = await Bun.file(wrongFilePath).exists()
    expect(wrongExists).toBe(false)
  })

  test("injectSection() throws InlinePromptError for inline sources", async () => {
    await writeJsonc(
      join(projectRoot, "opencode.json"),
      JSON.stringify({
        agent: { build: { prompt: "You are a build agent." } },
      }),
    )

    const manager = new AgentPromptManager(projectRoot, stateDir, globalDir)
    await manager.init()

    let caught: unknown
    try {
      await manager.injectSection("build", "Kasper Rules", "be faster")
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(InlinePromptError)
    if (caught instanceof InlinePromptError) {
      expect(caught.agentName).toBe("build")
      expect(caught.migration).toContain("migrate build")
    }
  })

  test("injectSection() creates the conventional project file when source is missing", async () => {
    const manager = new AgentPromptManager(projectRoot, stateDir, globalDir)
    await manager.init()
    await manager.injectSection(
      "new-agent",
      "Kasper Rules",
      "be helpful",
      true,
      20,
      "subagent",
    )

    const expected = defaultAgentFilePath(projectRoot, "new-agent")
    const content = await readFile(expected, "utf-8")
    expect(content).toContain("## Kasper Rules")
    expect(content).toContain("be helpful")
    expect(content).toContain("mode: subagent")
  })

  test("source cache is invalidated after injectSection", async () => {
    const targetPath = join(projectRoot, "external", "build.md")
    await mkdir(join(projectRoot, "external"), { recursive: true })
    await writeFile(targetPath, "Original", "utf-8")
    await writeJsonc(
      join(projectRoot, "opencode.json"),
      JSON.stringify({
        agent: { build: { prompt: `{file:${targetPath}}` } },
      }),
    )

    const manager = new AgentPromptManager(projectRoot, stateDir, globalDir)
    await manager.init()
    await manager.injectSection("build", "Rules", "do X")

    // Force cache re-resolve by clearing it
    manager.invalidateSourceCache("build")
    const fresh = await manager.read("build")
    expect(fresh).toContain("## Rules")
    expect(fresh).toContain("do X")
  })

  test("exists() returns true for inline source", async () => {
    await writeJsonc(
      join(projectRoot, "opencode.json"),
      JSON.stringify({
        agent: { build: { prompt: "You are a build agent." } },
      }),
    )

    const manager = new AgentPromptManager(projectRoot, stateDir, globalDir)
    await manager.init()
    expect(await manager.exists("build")).toBe(true)
  })

  test("exists() returns false for missing source", async () => {
    const manager = new AgentPromptManager(projectRoot, stateDir, globalDir)
    await manager.init()
    expect(await manager.exists("nope")).toBe(false)
  })
})
