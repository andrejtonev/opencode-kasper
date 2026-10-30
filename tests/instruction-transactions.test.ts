import { afterEach, describe, expect, test } from "bun:test"
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appendToPluginOverridePrompt } from "../src/agent-prompt-resolver.js"
import { AgentPromptManager } from "../src/agent-prompts.js"
import { AgentsMdManager } from "../src/agents-md.js"
import {
  ensureDefaultKasperConfigFile,
  loadKasperConfig,
  normalizeKasperConfig,
} from "../src/config.js"
import {
  migrateInstructionSource,
  recoverInstructionMigration,
} from "../src/instruction-migration.js"
import {
  commitInstructionUpdate,
  instructionHash,
  readInstructionReceipt,
  rollbackInstruction,
} from "../src/instruction-transaction.js"

const directories: string[] = []
afterEach(async () => {
  for (const dir of directories.splice(0))
    await rm(dir, { recursive: true, force: true })
})
async function scope() {
  const dir = await mkdtemp(join(tmpdir(), "kasper-instruction-test-"))
  directories.push(dir)
  await mkdir(join(dir, ".opencode"))
  return dir
}
async function override(dir: string, text = "original") {
  const configPath = join(dir, ".opencode", "plugin.json")
  await writeFile(
    configPath,
    JSON.stringify({
      agents: { reviewer: { prompt_append: text } },
      unrelated: 1,
    }),
  )
  return {
    kind: "plugin_override" as const,
    target: "config" as const,
    agentName: "reviewer",
    configPath,
    promptField: "prompt_append" as const,
    isAppend: true,
    value: text,
    jsonPath: ["agents", "reviewer", "prompt_append"],
  }
}

describe("instruction transactions", () => {
  test("cached override appends rebase on current value and concurrent changes survive", async () => {
    const dir = await scope()
    const source = await override(dir)
    const raw = JSON.parse(await readFile(source.configPath, "utf-8"))
    raw.agents.reviewer.prompt_append = "external update"
    await writeFile(source.configPath, JSON.stringify(raw))
    await Promise.all([
      appendToPluginOverridePrompt(source, "rule A"),
      appendToPluginOverridePrompt(source, "rule B"),
    ])
    const updated = JSON.parse(await readFile(source.configPath, "utf-8"))
    expect(updated.agents.reviewer.prompt_append).toContain("external update")
    expect(updated.agents.reviewer.prompt_append).toContain("rule A")
    expect(updated.agents.reviewer.prompt_append).toContain("rule B")
    expect(updated.unrelated).toBe(1)
  })

  test("config receipts restore only the original field and preserve later unrelated edits", async () => {
    const dir = await scope()
    const source = await override(dir)
    const result = await appendToPluginOverridePrompt(
      source,
      "rule",
      join(dir, "backups"),
    )
    expect(result.backupPath).toBeDefined()
    const raw = JSON.parse(await readFile(source.configPath, "utf-8"))
    raw.unrelated = 2
    await writeFile(source.configPath, JSON.stringify(raw))
    await rollbackInstruction(result.backupPath!, join(dir, "backups"))
    const rolledBack = JSON.parse(await readFile(source.configPath, "utf-8"))
    expect(rolledBack.agents.reviewer.prompt_append).toBe("original")
    expect(rolledBack.unrelated).toBe(2)
  })

  test("later edits to the target field cause conflict, preserving all bytes", async () => {
    const dir = await scope()
    const source = await override(dir)
    const result = await appendToPluginOverridePrompt(
      source,
      "rule",
      join(dir, "backups"),
    )
    const changed = JSON.stringify({
      agents: { reviewer: { prompt_append: "user changed instructions" } },
    })
    await writeFile(source.configPath, changed)
    await expect(
      rollbackInstruction(result.backupPath!, join(dir, "backups")),
    ).rejects.toThrow("target field changed")
    expect(await readFile(source.configPath, "utf-8")).toBe(changed)
  })

  test("source shape changes fail closed rather than appending inside a file directive", async () => {
    const dir = await scope()
    const source = await override(dir)
    await writeFile(
      source.configPath,
      JSON.stringify({
        agents: { reviewer: { prompt_append: "{file:new.md}" } },
      }),
    )
    await expect(appendToPluginOverridePrompt(source, "rule")).rejects.toThrow(
      "file reference",
    )
  })

  test("agent rollback restores the recorded original path after source configuration changes", async () => {
    const dir = await scope()
    const config = join(dir, "opencode.json")
    const oldPath = join(dir, "old.md")
    const newPath = join(dir, "new.md")
    await writeFile(oldPath, "old instructions")
    await writeFile(newPath, "new source")
    await writeFile(
      config,
      JSON.stringify({ agent: { reviewer: { prompt: "{file:old.md}" } } }),
    )
    const manager = new AgentPromptManager(
      dir,
      join(dir, "state"),
      join(dir, "empty-global"),
    )
    await manager.injectSection("reviewer", "Kasper", "rule")
    await writeFile(
      config,
      JSON.stringify({ agent: { reviewer: { prompt: "{file:new.md}" } } }),
    )
    expect(await manager.rollback("reviewer")).toBe(true)
    expect(await readFile(oldPath, "utf-8")).toBe("old instructions")
    expect(await readFile(newPath, "utf-8")).toBe("new source")
  })

  test("rules target and nested backup remain bound across a configuration reload", async () => {
    const dir = await scope()
    const oldPath = join(dir, "AGENTS.md")
    const newPath = join(dir, "NEW.md")
    await writeFile(oldPath, "original")
    await writeFile(newPath, "new target")
    const manager = new AgentsMdManager(oldPath, join(dir, "state"))
    await manager.lockedUpdate(async (existing) => {
      manager.setResolvedPath(newPath)
      await manager.backup("during-update")
      return `${existing}\nrule`
    })
    expect(await readFile(oldPath, "utf-8")).toBe("original\nrule")
    expect(await readFile(newPath, "utf-8")).toBe("new target")
    manager.setResolvedPath(oldPath)
    const backups = await manager.listBackups()
    expect((await readInstructionReceipt(backups[0].path)).target.path).toBe(
      oldPath,
    )
  })

  test("cancelled commit after backup cannot mutate the target", async () => {
    const dir = await scope()
    const path = join(dir, "AGENTS.md")
    await writeFile(path, "original")
    await expect(
      commitInstructionUpdate({ path }, () => "new", {
        backupDir: join(dir, "backups"),
        assertCurrent: () => {
          throw Error("cancelled")
        },
      }),
    ).rejects.toThrow("cancelled")
    expect(await readFile(path, "utf-8")).toBe("original")
  })

  test("guard invalidated during staging prevents the actual replacement", async () => {
    const dir = await scope()
    const path = join(dir, "AGENTS.md")
    await writeFile(path, "original")
    let checks = 0
    await expect(
      commitInstructionUpdate({ path }, () => "new", {
        assertCurrent: () => {
          if (++checks >= 2) throw new Error("cancelled during staging")
        },
      }),
    ).rejects.toThrow("cancelled during staging")
    expect(await readFile(path, "utf-8")).toBe("original")
    expect(
      (await readdir(dir)).filter((name) => name.includes(".tmp-")),
    ).toEqual([])
  })

  test("explicit revision conflicts preserve newer file contents", async () => {
    const dir = await scope()
    const path = join(dir, "AGENTS.md")
    await writeFile(path, "newer")
    await expect(
      commitInstructionUpdate({ path }, () => "stale", {
        expectedHash: instructionHash("original"),
      }),
    ).rejects.toThrow("revision changed")
    expect(await readFile(path, "utf-8")).toBe("newer")
  })

  test("invalid source JSONC is not partially accepted or rewritten", async () => {
    const dir = await scope()
    const source = await override(dir)
    const invalid =
      '{"agents":{"reviewer":{"prompt_append":"original"}}, BROKEN}'
    await writeFile(source.configPath, invalid)
    await expect(appendToPluginOverridePrompt(source, "rule")).rejects.toThrow(
      "invalid JSONC",
    )
    expect(await readFile(source.configPath, "utf-8")).toBe(invalid)
  })
})

describe("configuration and migration safety", () => {
  test("file-loaded path arrays survive validation and force reload", async () => {
    const dir = await scope()
    const config = join(dir, ".opencode", "kasper.jsonc")
    await writeFile(
      config,
      '{"prompt_paths":["./prompts"],"agents_md_paths":["./rules"]}',
    )
    expect((await loadKasperConfig(dir, true)).agents_md_paths).toEqual([
      "./rules",
    ])
    expect((await loadKasperConfig(dir, true)).prompt_paths).toEqual([
      "./prompts",
    ])
    expect(normalizeKasperConfig({ prompt_paths: ["   "] })).toEqual({})
    await writeFile(config, '{"prompt_paths":["./updated"]}')
    expect((await loadKasperConfig(dir, true)).prompt_paths).toEqual([
      "./updated",
    ])
  })

  test("malformed standalone config rejects reload and default creation preserves user bytes", async () => {
    const dir = await scope()
    const config = join(dir, ".opencode", "kasper.jsonc")
    const invalid = '{"enabled":false, BROKEN}'
    await writeFile(config, invalid)
    await expect(loadKasperConfig(dir, true)).rejects.toThrow("Invalid JSONC")
    await Promise.all([
      ensureDefaultKasperConfigFile(join(dir, ".opencode")),
      ensureDefaultKasperConfigFile(join(dir, ".opencode")),
    ])
    expect(await readFile(config, "utf-8")).toBe(invalid)
  })

  test("journaled migration can recover both files after commit", async () => {
    const dir = await scope()
    const config = join(dir, "opencode.json")
    await writeFile(
      config,
      '{"agent":{"reviewer":{"prompt":"original"}},"other":1}',
    )
    const target = join(dir, ".opencode", "agents", "reviewer.md")
    const migrated = await migrateInstructionSource(
      config,
      ["agent", "reviewer", "prompt"],
      "reviewer",
      "prompt",
      "original",
      target,
      dir,
      "subagent",
    )
    const raw = JSON.parse(await readFile(config, "utf-8"))
    raw.other = 2
    await writeFile(config, JSON.stringify(raw))
    await recoverInstructionMigration(migrated.journalPath)
    const recovered = JSON.parse(await readFile(config, "utf-8"))
    expect(recovered.agent.reviewer.prompt).toBe("original")
    expect(recovered.other).toBe(2)
    expect(
      await readFile(target).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
  })

  test("failure after destination creation leaves an explicit recoverable journal", async () => {
    const dir = await scope()
    const config = join(dir, "opencode.json")
    const original = '{"agent":{"reviewer":{"prompt":"original"}}}'
    await writeFile(config, original)
    const target = join(dir, ".opencode", "agents", "reviewer.md")
    let calls = 0
    await expect(
      migrateInstructionSource(
        config,
        ["agent", "reviewer", "prompt"],
        "reviewer",
        "prompt",
        "original",
        target,
        dir,
        "subagent",
        () => {
          if (++calls >= 3) throw Error("cancelled")
        },
      ),
    ).rejects.toThrow("cancelled")
    expect(await readFile(config, "utf-8")).toBe(original)
    const journals = (
      await readdir(join(dir, ".opencode", "kasper", "migrations"))
    ).filter((name) => name.endsWith(".json") && !name.endsWith(".md.json"))
    expect(journals.length).toBe(1)
    await recoverInstructionMigration(
      join(dir, ".opencode", "kasper", "migrations", journals[0]),
    )
    expect(
      await readFile(target).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
  })

  test("global config is not silently redirected to a project-local destination", async () => {
    const project = await scope()
    const global = await scope()
    const config = join(global, "opencode.json")
    const original = '{"agent":{"reviewer":{"prompt":"original"}}}'
    await writeFile(config, original)
    await expect(
      migrateInstructionSource(
        config,
        ["agent", "reviewer", "prompt"],
        "reviewer",
        "prompt",
        "original",
        join(project, "reviewer.md"),
        project,
        "subagent",
      ),
    ).rejects.toThrow("global/external")
    expect(await readFile(config, "utf-8")).toBe(original)
  })
})
