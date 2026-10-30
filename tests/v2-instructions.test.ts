import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Agent } from "@opencode/schema/agent"
import type { Config } from "@opencode/schema/config"
import { Schema } from "effect"
import {
  createV2AgentsMd,
  loadV2AgentOverlays,
  readV2ApplicableInstructions,
  V2AgentPrompts,
  type V2InstructionOptions,
} from "../src/hosts/v2-instructions.js"
import { readInstructionReceipt } from "../src/instruction-transaction.js"

let sandbox: string
let options: V2InstructionOptions
let entries: Config.Entry[]
let effective: string
const id = Schema.decodeUnknownSync(Agent.ID)("team/reviewer")
async function file(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}
function document(
  path: string | undefined,
  system?: string,
  instructions?: string[],
): Config.Entry {
  return {
    type: "document",
    path,
    info: {
      agents: system === undefined ? undefined : { [id]: { system } },
      instructions,
    },
  } as Config.Entry
}
function directory(path: string): Config.Entry {
  return { type: "directory", path } as Config.Entry
}
beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "kasper-v2-instructions-"))
  const projectRoot = join(sandbox, "home", "project")
  await mkdir(join(projectRoot, "sub"), { recursive: true })
  effective = "factory"
  entries = []
  options = {
    projectRoot,
    directory: join(projectRoot, "sub"),
    stateDir: join(projectRoot, ".opencode", "kasper"),
    home: join(sandbox, "home"),
    globalConfigDir: join(sandbox, "global"),
    configEntries: async () => entries,
    catalog: {
      list: async () => [{ id, system: effective }],
      get: async (name) =>
        name === id ? { id, system: effective } : undefined,
    },
  }
})
afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true })
})

describe("native V2 source provenance", () => {
  test("effective plugin-only prompt stays read-only and is scored as effective text", async () => {
    const manager = new V2AgentPrompts(options)
    expect(await manager.read(id)).toBe("factory")
    expect((await manager.resolve(id)).kind).toBe("readonly")
    await expect(
      manager.injectSection(id, "Rules", "guidance"),
    ).rejects.toThrow("no verified editable")
    expect((await manager.resolve("absent")).kind).toBe("unknown")
  })
  test("unavailable authoritative entries never guesses project conventions", async () => {
    options.configEntries = undefined
    await file(
      join(options.projectRoot, ".opencode", "agents", `${id}.md`),
      "factory",
    )
    const source = await new V2AgentPrompts(options).resolve(id)
    expect(source.kind).toBe("readonly")
    expect(source.complete).toBe(false)
  })
  test("equal text is not enough to authorize native inline system", async () => {
    const path = join(options.projectRoot, "opencode.jsonc")
    await file(
      path,
      JSON.stringify({ agents: { [id]: { system: effective } } }),
    )
    entries = [document(path, effective)]
    expect((await new V2AgentPrompts(options).resolve(id)).kind).toBe(
      "readonly",
    )
  })
  test("all layers determine final JSON pointer, preserving nested IDs and exact config bytes", async () => {
    const lower = join(options.projectRoot, "opencode.json")
    const higher = join(options.projectRoot, ".opencode", "opencode.jsonc")
    await file(lower, JSON.stringify({ agents: { [id]: { system: "lower" } } }))
    const raw =
      '{\n // owned comment\n "agents": {"team/reviewer": {"system": "higher"}},\n "instructions": []\n}\n'
    await file(higher, raw)
    effective = "higher"
    entries = [document(lower, "lower"), document(higher, "higher")]
    options.editableAgents = {
      [id]: { path: higher, jsonPath: ["agents", id, "system"] },
    }
    const manager = new V2AgentPrompts(options)
    const source = await manager.resolve(id)
    expect(source.kind).toBe("editable")
    expect(source.candidate?.jsonPath).toEqual(["agents", id, "system"])
    const backup = await manager.injectSection(id, "Rules", "new guidance")
    expect(await readFile(backup!, "utf8")).toBe(raw)
    expect((await readInstructionReceipt(backup!)).target.jsonPath).toEqual([
      "agents",
      id,
      "system",
    ])
    expect(await readFile(higher, "utf8")).toContain("// owned comment")
    expect(await manager.rollback(id, backup)).toBe(true)
    expect(
      JSON.parse(
        (await readFile(higher, "utf8")).replace("// owned comment", ""),
      ).agents[id].system,
    ).toBe("higher")
  })
  test("higher virtual layer invalidates a lower editable target", async () => {
    const path = join(options.projectRoot, "opencode.json")
    await file(
      path,
      JSON.stringify({ agents: { [id]: { system: "factory" } } }),
    )
    entries = [document(path, "factory"), document(undefined, "factory")]
    options.editableAgents = {
      [id]: { path, jsonPath: ["agents", id, "system"] },
    }
    expect((await new V2AgentPrompts(options).resolve(id)).kind).toBe(
      "readonly",
    )
  })
  test("transformed text and composite file substitutions are read-only", async () => {
    const path = join(options.projectRoot, "opencode.json")
    await file(
      path,
      JSON.stringify({ agents: { [id]: { system: "{file:prompt.md}" } } }),
    )
    entries = [document(path, "factory")]
    options.editableAgents = {
      [id]: { path, jsonPath: ["agents", id, "system"] },
    }
    expect((await new V2AgentPrompts(options).resolve(id)).kind).toBe(
      "readonly",
    )
    await file(
      path,
      JSON.stringify({ agents: { [id]: { system: "factory" } } }),
    )
    effective = "factory transformed"
    expect((await new V2AgentPrompts(options).resolve(id)).kind).toBe(
      "readonly",
    )
  })
  test("a newly higher source during locked commit blocks obsolete target mutation", async () => {
    const lower = join(options.projectRoot, "opencode.json")
    const higher = join(options.projectRoot, ".opencode", "opencode.json")
    await file(
      lower,
      JSON.stringify({ agents: { [id]: { system: "factory" } } }),
    )
    await file(
      higher,
      JSON.stringify({ agents: { [id]: { system: "factory" } } }),
    )
    options.editableAgents = {
      [id]: { path: lower, jsonPath: ["agents", id, "system"] },
    }
    let calls = 0
    options.configEntries = async () =>
      ++calls === 1
        ? [document(lower, "factory")]
        : [document(lower, "factory"), document(higher, "factory")]
    await expect(
      new V2AgentPrompts(options).injectSection(id, "Rules", "obsolete"),
    ).rejects.toThrow("precedence changed")
    expect(await readFile(lower, "utf8")).not.toContain("obsolete")
  })
  test("missing provider system and failing config discovery remain honestly incomplete", async () => {
    options.catalog.get = async () => ({ id })
    expect((await new V2AgentPrompts(options).resolve(id)).complete).toBe(false)
    options.configEntries = async () => {
      throw new Error("transport unavailable")
    }
    expect((await readV2ApplicableInstructions(options)).complete).toBe(false)
  })
  test("overlay identity cannot escape Kasper-owned storage", async () => {
    options.overlays = { [id]: join(options.projectRoot, "factory.md") }
    await file(options.overlays[id], "factory")
    expect((await new V2AgentPrompts(options).resolve(id)).kind).toBe(
      "readonly",
    )
  })
  test("overlays are a typed append snapshot and factory catalog text stays intact", async () => {
    const path = join(options.stateDir, "overlays", `${id}.md`)
    options.overlays = { [id]: path }
    await file(path, "owned guidance")
    const snapshot = await loadV2AgentOverlays(options)
    expect(snapshot.get(id)).toBe("owned guidance")
    expect(await new V2AgentPrompts(options).read(id)).toBe("factory")
  })
  test("directory entries rank Markdown after JSON and preserve frontmatter body boundary", async () => {
    const dir = join(options.projectRoot, ".opencode")
    const path = join(dir, "agents", `${id}.md`)
    const raw =
      "---\r\nsystem: ignored frontmatter\r\ndescription: reviewer: safe\r\n---\r\n\r\nbody\r\n"
    await file(path, raw)
    effective = "body"
    entries = [document(undefined, "lower"), directory(dir)]
    options.editableAgents = { [id]: { path } }
    const manager = new V2AgentPrompts(options)
    expect((await manager.resolve(id)).kind).toBe("editable")
    const backup = await manager.injectSection(id, "Rules", "retain body")
    const changed = await readFile(path, "utf8")
    expect(changed.startsWith(raw.slice(0, raw.indexOf("\r\n\r\n") + 2))).toBe(
      true,
    )
    expect(changed).toContain("body")
    expect(changed).toContain("retain body")
    expect(await readFile(backup!, "utf8")).toBe(raw)
  })
  test("legacy frontmatter unresolved and disabled documents cannot be attributed", async () => {
    const dir = join(options.projectRoot, ".opencode")
    const path = join(dir, "agents", `${id}.md`)
    entries = [directory(dir)]
    options.editableAgents = { [id]: { path } }
    effective = "body"
    await file(path, "---\nmode: subagent\nprompt: legacy\n---\nbody")
    expect((await new V2AgentPrompts(options).resolve(id)).kind).toBe(
      "readonly",
    )
    await file(path, "---\ndisabled: true\n---\nbody")
    expect((await new V2AgentPrompts(options).resolve(id)).kind).toBe(
      "readonly",
    )
  })
  test("late guard after discovery stops write, and refresh requires a matching reread", async () => {
    const path = join(options.stateDir, "overlays", `${id}.md`)
    options.overlays = { [id]: path }
    const manager = new V2AgentPrompts(options)
    await expect(
      manager.injectSection(
        id,
        "Rules",
        "late",
        true,
        20,
        "subagent",
        "section",
        () => {
          throw new Error("disposed")
        },
      ),
    ).rejects.toThrow("disposed")
    expect(await Bun.file(path).exists()).toBe(false)
    const backup = await manager.injectSection(id, "Rules", "live")
    expect(manager.refreshStatus.get(id)).toBe("pending")
    expect(await manager.confirmRefresh(id, "factory\n\nlive")).toBe(false)
    effective = "factory\n\nlive"
    expect(await manager.confirmRefresh(id, effective)).toBe(true)
    expect(manager.refreshStatus.get(id)).toBe("confirmed")
    expect(await manager.rollback(id, backup)).toBe(true)
    expect(await Bun.file(path).exists()).toBe(false)
  })
})

describe("V2 applicable instructions and safe local mutations", () => {
  test("global then nearest-first ancestors up to home, deduplicated configured files", async () => {
    await file(join(options.globalConfigDir!, "AGENTS.md"), "global")
    await file(join(options.directory, "AGENTS.md"), "nearest")
    await file(join(options.projectRoot, "AGENTS.md"), "project")
    await file(join(options.home!, "AGENTS.md"), "home")
    await file(join(sandbox, "AGENTS.md"), "must not read above home")
    await file(join(options.projectRoot, "notes.md"), "external configured")
    await file(join(options.directory, "CLAUDE.md"), "must not read Claude")
    entries = [document(undefined, undefined, ["notes.md", "AGENTS.md"])]
    const snapshot = await readV2ApplicableInstructions(options)
    expect(snapshot.complete).toBe(true)
    expect(snapshot.text).toBe(
      "global\n\nnearest\n\nproject\n\nhome\n\nexternal configured",
    )
    expect(snapshot.sources).toHaveLength(5)
  })
  test("remote instructions use host cache only and report absent text", async () => {
    entries = [
      document(undefined, undefined, ["https://example.invalid/rules"]),
    ]
    expect((await readV2ApplicableInstructions(options)).complete).toBe(false)
    options.remoteInstructions = async () =>
      new Map([["https://example.invalid/rules", "host cached"]])
    expect((await readV2ApplicableInstructions(options)).text).toBe(
      "host cached",
    )
  })
  test("combined scoring read cannot copy global rules into project write", async () => {
    const global = join(options.globalConfigDir!, "AGENTS.md")
    await file(global, "global")
    const manager = createV2AgentsMd(options)
    expect(await manager.read()).toBe("global")
    await manager.lockedUpdate(async (existing) =>
      manager.injectSection(existing, "Rules", "local only"),
    )
    expect(await readFile(global, "utf8")).toBe("global")
    expect(
      await readFile(join(options.directory, "AGENTS.md"), "utf8"),
    ).not.toContain("global")
    expect(await manager.read()).toContain("local only")
  })
  test("outside project and disabled project discovery refuse writes without global fallback", async () => {
    options.directory = join(sandbox, "outside")
    const manager = createV2AgentsMd(options)
    await expect(manager.applyGuidance("local")).rejects.toThrow(
      "No project-owned",
    )
    options.directory = options.projectRoot
    options.projectDiscovery = false
    await expect(
      createV2AgentsMd(options).applyGuidance("local"),
    ).rejects.toThrow("No project-owned")
  })
  test("fresh configured glob matches and no invisible refresh/model call", async () => {
    entries = [document(undefined, undefined, ["guides/*.md"])]
    await file(join(options.projectRoot, "guides", "b.md"), "b")
    await file(join(options.projectRoot, "guides", "a.md"), "a")
    const snapshot = await readV2ApplicableInstructions(options)
    expect(snapshot.text).toBe("a\n\nb")
    expect(snapshot.activation).toBe("unconfirmed")
  })
  test("configured glob includes dotfiles, skips directories, and sorts matches across ancestors", async () => {
    entries = [document(undefined, undefined, ["rules/*.md"])]
    await file(join(options.projectRoot, "rules", ".hidden.md"), "hidden")
    await file(join(options.directory, "rules", "a.md"), "near")
    await mkdir(join(options.projectRoot, "rules", "directory.md"), {
      recursive: true,
    })
    const snapshot = await readV2ApplicableInstructions(options)
    expect(snapshot.complete).toBe(true)
    expect(snapshot.text).toBe("hidden\n\nnear")
  })
  test("absolute globs with nonliteral parent match host file-only semantics", async () => {
    await file(join(sandbox, "space dir", "a", "deep", "rules.md"), "absolute")
    entries = [
      document(undefined, undefined, [
        join(sandbox, "space dir", "*", "**", "*.md"),
      ]),
    ]
    const snapshot = await readV2ApplicableInstructions(options)
    expect(snapshot.complete).toBe(true)
    expect(snapshot.text).toBe("absolute")
  })
  test("partial scoring coverage blocks both project and per-agent guidance commits", async () => {
    entries = [
      document(undefined, undefined, ["https://example.invalid/unseen-rules"]),
    ]
    const overlay = join(options.stateDir, "overlays", `${id}.md`)
    options.overlays = { [id]: overlay }
    expect((await new V2AgentPrompts(options).readCoverage(id)).complete).toBe(
      false,
    )
    await expect(
      new V2AgentPrompts(options).injectSection(
        id,
        "Rules",
        "unsafe inference",
      ),
    ).rejects.toThrow("coverage is incomplete")
    await expect(
      createV2AgentsMd(options).applyGuidance("unsafe inference"),
    ).rejects.toThrow("coverage is incomplete")
    expect(await Bun.file(overlay).exists()).toBe(false)
    expect(await Bun.file(join(options.directory, "AGENTS.md")).exists()).toBe(
      false,
    )
  })
})
