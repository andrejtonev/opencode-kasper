import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveAgentPromptSource } from "../src/agent-prompt-resolver.js"
import {
  AgentPromptManager,
  appendInlineImprovement,
  InlinePromptError,
} from "../src/agent-prompts.js"
import { escapeRegex } from "../src/prompt-utils.js"

function tmpDir(): string {
  return join(tmpdir(), `kasper-test-${randomBytes(6).toString("hex")}`)
}

describe("escapeRegex (agent-prompts)", () => {
  test("escapes special regex characters", () => {
    expect(escapeRegex("test(special)[chars]")).toBe(
      "test\\(special\\)\\[chars\\]",
    )
  })
})

describe("AgentPromptManager", () => {
  let testDir: string
  let projectRoot: string
  let stateDir: string
  let manager: AgentPromptManager

  beforeEach(async () => {
    testDir = tmpDir()
    projectRoot = testDir
    stateDir = join(testDir, ".opencode", "kasper")
    manager = new AgentPromptManager(projectRoot, stateDir)
    await manager.init()
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  describe("read/write/exists", () => {
    test("exists returns false when agent prompt file missing", async () => {
      expect(await manager.exists("build")).toBe(false)
    })

    test("write creates and exists returns true", async () => {
      await manager.write("build", "You are a build agent.")
      expect(await manager.exists("build")).toBe(true)
    })

    test("read returns empty string for missing agent", async () => {
      expect(await manager.read("nonexistent")).toBe("")
    })

    test("read returns written content", async () => {
      await manager.write("build", "You are a build agent.")
      expect(await manager.read("build")).toBe("You are a build agent.")
    })
  })

  describe("injectSection", () => {
    test("appends section when no sections exist", async () => {
      await manager.write("build", "")
      await manager.injectSection("build", "Kasper Rules", "be faster")
      const content = await manager.read("build")
      expect(content).toContain("## Kasper Rules")
      expect(content).toContain("be faster")
    })

    test("accumulates content in existing section", async () => {
      await manager.write(
        "build",
        "## Kasper Rules\nold rule\n\n## Other\nstuff",
      )
      await manager.injectSection("build", "Kasper Rules", "new rule")
      const content = await manager.read("build")
      expect(content).toContain("new rule")
      expect(content).toContain("old rule")
      expect(content).toContain("## Other")
    })

    test("inserts section before end when other content exists", async () => {
      await manager.write("build", "## Other\ncontent")
      await manager.injectSection("build", "New Section", "fresh")
      const content = await manager.read("build")
      expect(content).toContain("## Other")
      expect(content).toContain("## New Section")
    })

    test("preserves existing section body and adds new content", async () => {
      await manager.write(
        "build",
        "## Kasper Rules\nold rule\n\n## Other\nstuff",
      )
      await manager.injectSection(
        "build",
        "Kasper Rules",
        "new rule",
        true, // backupEnabled
        20, // maxBackups
        "subagent", // mode
        "section", // injectMode
      )
      const content = await manager.read("build")
      expect(content).toContain("old rule")
      expect(content).toContain("new rule")
      expect(content).toContain("## Other")
    })

    test("accumulates multiple improvements", async () => {
      await manager.write("build", "")
      await manager.injectSection(
        "build",
        "Rules",
        "rule 1",
        true,
        20,
        "subagent",
        "section",
      )
      await manager.injectSection(
        "build",
        "Rules",
        "rule 2",
        true,
        20,
        "subagent",
        "section",
      )
      const content = await manager.read("build")
      expect(content).toContain("rule 1")
      expect(content).toContain("rule 2")
    })

    test("default call accumulates existing content", async () => {
      await manager.write(
        "build",
        "## Kasper Rules\nold rule\n\n## Other\nstuff",
      )
      await manager.injectSection("build", "Kasper Rules", "new rule")
      const content = await manager.read("build")
      expect(content).toContain("new rule")
      expect(content).toContain("old rule")
    })

    // ---- Regression tests for the critical regex-anchoring bug (Issue #1) ----

    test("does NOT produce nested headers when section is preceded by frontmatter", async () => {
      // The most common real-world case for an agent prompt file: it
      // starts with YAML frontmatter and a description.
      const frontmatter = [
        "---",
        "description: My agent",
        "mode: subagent",
        "---",
        "",
        "# My Agent",
        "",
        "Follow these rules:",
        "  1. Be polite",
        "  2. Be thorough",
        "",
        "## Kasper Inferred Instructions",
        "old rule",
        "",
      ].join("\n")
      await manager.write("build", frontmatter)
      await manager.injectSection(
        "build",
        "Kasper Inferred Instructions",
        "new rule",
      )
      const content = await manager.read("build")
      // Critical: exactly ONE ## Kasper Inferred Instructions header
      const headerCount = (
        content.match(/^## Kasper Inferred Instructions/gm) || []
      ).length
      expect(headerCount).toBe(1)
      expect(content).toContain("old rule")
      expect(content).toContain("new rule")
      // Frontmatter and pre-section content preserved
      expect(content).toContain("description: My agent")
      expect(content).toContain("Follow these rules:")
      expect(content).toContain("Be polite")
      // Chronological order
      expect(content.indexOf("old rule")).toBeLessThan(
        content.indexOf("new rule"),
      )
    })

    test("does NOT produce nested headers when section is preceded by # Title and intro", async () => {
      const existing =
        "# My Build Agent\n\nIntro paragraph.\n\n## Kasper Inferred Instructions\nold rule\n\n## Other\nstuff"
      await manager.write("build", existing)
      await manager.injectSection(
        "build",
        "Kasper Inferred Instructions",
        "new rule",
      )
      const content = await manager.read("build")
      const headerCount = (
        content.match(/^## Kasper Inferred Instructions/gm) || []
      ).length
      expect(headerCount).toBe(1)
      expect(content).toContain("Intro paragraph.")
      expect(content).toContain("old rule")
      expect(content).toContain("new rule")
    })

    test("double-apply produces ONE provenance line per apply (per-addition provenance)", async () => {
      await manager.write("build", "# Title\n\nintro\n\n## Rules\nold\n")
      await manager.injectSection("build", "Rules", "rule 1")
      await manager.injectSection("build", "Rules", "rule 2")
      const content = await manager.read("build")
      // Per-addition provenance: 2 applies → 2 provenance lines.
      const provenanceCount = (content.match(/<!-- kasper:/g) || []).length
      expect(provenanceCount).toBe(2)
      // Each provenance line should appear IMMEDIATELY before its entry's content.
      expect(content).toMatch(/<!-- kasper:[^>]+-->\nrule 1/)
      expect(content).toMatch(/<!-- kasper:[^>]+-->\nrule 2/)
    })

    test("triple-apply still produces only ONE header (no accumulation bug)", async () => {
      await manager.write("build", "## Rules\nold\n")
      await manager.injectSection("build", "Rules", "a")
      await manager.injectSection("build", "Rules", "b")
      await manager.injectSection("build", "Rules", "c")
      const content = await manager.read("build")
      const headerCount = (content.match(/^## Rules/gm) || []).length
      expect(headerCount).toBe(1)
      expect(content).toContain("old")
      expect(content).toContain("a")
      expect(content).toContain("b")
      expect(content).toContain("c")
    })

    test("preserves trailing newline when section is the last thing in the file", async () => {
      await manager.write("build", "## My Section\nold")
      await manager.injectSection("build", "My Section", "new")
      const content = await manager.read("build")
      expect(content.endsWith("\n")).toBe(true)
    })

    test("preserves content order: A < Target < B when target is in the middle", async () => {
      await manager.write("build", "## A\naaa\n\n## Target\nold\n\n## B\nbbb")
      await manager.injectSection("build", "Target", "new")
      const content = await manager.read("build")
      expect(content.indexOf("## A")).toBeGreaterThan(-1)
      expect(content.indexOf("## Target")).toBeGreaterThan(
        content.indexOf("## A"),
      )
      expect(content.indexOf("## B")).toBeGreaterThan(
        content.indexOf("## Target"),
      )
      expect(content.indexOf("aaa")).toBeLessThan(content.indexOf("old"))
      expect(content.indexOf("old")).toBeLessThan(content.indexOf("new"))
      expect(content.indexOf("new")).toBeLessThan(content.indexOf("bbb"))
    })

    test("CRLF line endings: still produces only one header", async () => {
      await manager.write(
        "build",
        "# Title\r\n\r\n## My Section\r\nold rule\r\n\r\n## Other\r\nstuff\r\n",
      )
      await manager.injectSection("build", "My Section", "new rule")
      const content = await manager.read("build")
      const headerCount = (content.match(/^## My Section/gm) || []).length
      expect(headerCount).toBe(1)
      expect(content).toContain("old rule")
      expect(content).toContain("new rule")
    })

    test("5x repeated apply: exactly one header, 5 provenance lines, all rules preserved", async () => {
      await manager.write("build", "## Rules\nold\n")
      for (let i = 0; i < 5; i++) {
        await manager.injectSection("build", "Rules", `r${i}`)
      }
      const content = await manager.read("build")
      expect((content.match(/^## Rules/gm) || []).length).toBe(1)
      // Per-addition provenance: 5 applies → 5 provenance lines.
      expect((content.match(/<!-- kasper:/g) || []).length).toBe(5)
      expect(content).toContain("old")
      for (let i = 0; i < 5; i++) {
        expect(content).toContain(`r${i}`)
        // Each rule has its own provenance line directly above it.
        expect(content).toMatch(new RegExp(`<!-- kasper:[^>]+-->\\nr${i}\\b`))
      }
    })

    test("per-addition: each entry's timestamp is directly above its content", async () => {
      await manager.write(
        "build",
        "---\nmode: subagent\n---\n\n# Build\n\n## Kasper Inferred Instructions\nold rule\n",
      )
      // No way to inject different timestamps via the public API (it uses
      // `new Date()`), so we just verify the SHAPE: provenance directly
      // above each entry, in order, no section-level provenance.
      await manager.injectSection(
        "build",
        "Kasper Inferred Instructions",
        "rule A",
      )
      await manager.injectSection(
        "build",
        "Kasper Inferred Instructions",
        "rule B",
      )
      await manager.injectSection(
        "build",
        "Kasper Inferred Instructions",
        "rule C",
      )
      const content = await manager.read("build")
      // 3 provenance lines, all at entry-level
      expect((content.match(/<!-- kasper:/g) || []).length).toBe(3)
      // No provenance line directly under the section header (the old
      // section-level format had this; the new per-addition format does not).
      const afterHeader = content.split("## Kasper Inferred Instructions")[1]
      expect(afterHeader).toMatch(/^\nold rule/)
    })

    test("migration: legacy section-level timestamp is preserved on the next apply", async () => {
      // A file written by the previous version of kasper has:
      //   ## Kasper Inferred Instructions
      //   <!-- kasper: OLD_TS -->
      //   old rule
      // The new helper must preserve the OLD_TS line and append a new
      // per-addition provenance for the new entry — no destructive rewrite.
      const OLD_TS = "2026-06-10T08:00:00.000Z"
      await manager.write(
        "build",
        `## Kasper Inferred Instructions\n<!-- kasper: ${OLD_TS} -->\nold rule\n`,
      )
      await manager.injectSection(
        "build",
        "Kasper Inferred Instructions",
        "new rule",
      )
      const content = await manager.read("build")
      // Legacy timestamp is preserved
      expect(content).toContain(OLD_TS)
      // New entry has its own provenance
      expect((content.match(/<!-- kasper:/g) || []).length).toBe(2)
      expect(content).toContain("old rule")
      expect(content).toContain("new rule")
    })
  })

  describe("backup and rollback", () => {
    test("backup creates file in agent backup dir", async () => {
      await manager.write("general", "# v1")
      const path = await manager.backup("general", "before-change")
      const content = await readFile(path, "utf-8")
      expect(content).toBe("# v1")
    })

    test("rollback restores from latest backup", async () => {
      await manager.write("general", "# v1")
      await manager.backup("general", "v1-backup")
      await manager.write("general", "# v2")

      const restored = await manager.rollback("general")
      expect(restored).toBe(true)
      expect(await manager.read("general")).toBe("# v1")
    })

    test("rollback returns false when no backups", async () => {
      expect(await manager.rollback("nonexistent")).toBe(false)
    })

    test("listBackups returns sorted filenames", async () => {
      await manager.write("build", "content")
      await manager.backup("build", "first")
      await new Promise((r) => setTimeout(r, 50))
      await manager.backup("build", "second")

      const backups = await manager.listBackups("build")
      expect(backups.length).toBe(2)
    })

    test("listBackups returns empty for missing agent", async () => {
      expect(await manager.listBackups("nonexistent")).toEqual([])
    })

    test("backup enforces maxBackups automatically", async () => {
      await manager.write("build", "content")
      for (let i = 0; i < 6; i++) {
        await manager.backup("build", `b-${i}`, 3)
        await new Promise((r) => setTimeout(r, 20))
      }
      const backups = await manager.listBackups("build")
      expect(backups.length).toBeLessThanOrEqual(3)
    })
  })

  describe("enforceMaxBackups", () => {
    test("deletes oldest backups when over max", async () => {
      await manager.write("build", "content")
      for (let i = 0; i < 5; i++) {
        await manager.backup("build", `backup-${i}`)
        await new Promise((r) => setTimeout(r, 20))
      }

      await manager.enforceMaxBackups("build", 2)
      const backups = await manager.listBackups("build")
      expect(backups.length).toBe(2)
    })

    test("does nothing when under max", async () => {
      await manager.write("build", "content")
      await manager.backup("build", "only")
      await manager.enforceMaxBackups("build", 5)
      expect((await manager.listBackups("build")).length).toBe(1)
    })
  })

  describe("injectSection — inline mode", () => {
    test("appends wrapped in kasper-injected markers when no section mode", async () => {
      await manager.write("build", "You are a build agent.")
      await manager.injectSection(
        "build",
        "Kasper Inferred Instructions",
        "Be thorough.",
        true,
        20,
        "subagent",
        "inline",
      )
      const content = await manager.read("build")
      expect(content).toContain("You are a build agent.")
      expect(content).toContain("<!-- kasper-injected:begin -->")
      expect(content).toContain("Be thorough.")
      expect(content).toContain("<!-- kasper-injected:end -->")
      // No section header, no `<!-- kasper: ISO -->` provenance line
      expect(content).not.toContain("## Kasper Inferred Instructions")
      expect(content).not.toMatch(/<!-- kasper: \d{4}-/)
    })

    test("inline mode does not create frontmatter when file is empty", async () => {
      await manager.write("build", "")
      await manager.injectSection(
        "build",
        "Kasper Inferred Instructions",
        "First rule.",
        true,
        20,
        "subagent",
        "inline",
      )
      const content = await manager.read("build")
      expect(content).not.toContain("---")
      expect(content).not.toContain("mode: subagent")
      expect(content).toContain("First rule.")
    })

    test("inline mode is idempotent on the same content", async () => {
      await manager.write("build", "Original.\n")
      await manager.injectSection(
        "build",
        "Kasper Inferred Instructions",
        "Be thorough.",
        true,
        20,
        "subagent",
        "inline",
      )
      const firstRead = await manager.read("build")
      await manager.injectSection(
        "build",
        "Kasper Inferred Instructions",
        "Be thorough.",
        true,
        20,
        "subagent",
        "inline",
      )
      const secondRead = await manager.read("build")
      expect(secondRead).toBe(firstRead)
    })

    test("inline mode dedupes whitespace-insensitively", async () => {
      await manager.write("build", "")
      await manager.injectSection(
        "build",
        "Kasper Inferred Instructions",
        "Be  thorough.",
        true,
        20,
        "subagent",
        "inline",
      )
      const before = await manager.read("build")
      await manager.injectSection(
        "build",
        "Kasper Inferred Instructions",
        "Be thorough.",
        true,
        20,
        "subagent",
        "inline",
      )
      const after = await manager.read("build")
      expect(after).toBe(before)
    })

    test("section mode (default) still creates ## header", async () => {
      await manager.write("build", "You are a build agent.")
      await manager.injectSection(
        "build",
        "Kasper Inferred Instructions",
        "Be thorough.",
      )
      const content = await manager.read("build")
      expect(content).toContain("## Kasper Inferred Instructions")
      expect(content).toContain("<!-- kasper: ")
    })

    test("inline mode preserves all pre-existing content", async () => {
      const original = [
        "---",
        "description: My agent",
        "mode: subagent",
        "---",
        "",
        "# My Agent",
        "",
        "Follow these rules:",
        "  1. Be polite",
        "  2. Be thorough",
        "",
      ].join("\n")
      await manager.write("build", original)
      await manager.injectSection(
        "build",
        "Kasper Inferred Instructions",
        "Add documentation.",
        true,
        20,
        "subagent",
        "inline",
      )
      const content = await manager.read("build")
      // Frontmatter untouched
      expect(content).toContain("---")
      expect(content).toContain("description: My agent")
      // Existing content preserved
      expect(content).toContain("Follow these rules:")
      expect(content).toContain("Be polite")
      // New content appended
      expect(content).toContain("Add documentation.")
    })
  })
})

describe("appendInlineImprovement (pure helper)", () => {
  test("returns existing unchanged when empty content", () => {
    expect(appendInlineImprovement("abc", "   \n  ")).toBe("abc")
  })

  test("returns existing unchanged when text is already present", () => {
    const existing =
      "intro\n\n<!-- kasper-injected:begin -->\nbe fast\n<!-- kasper-injected:end -->\n"
    expect(appendInlineImprovement(existing, "be fast")).toBe(existing)
    expect(appendInlineImprovement(existing, "  BE  FAST  ")).toBe(existing)
  })

  test("appends wrapped markers with blank-line separator", () => {
    const out = appendInlineImprovement("hello", "new rule")
    expect(out).toBe(
      "hello\n\n<!-- kasper-injected:begin -->\nnew rule\n<!-- kasper-injected:end -->\n",
    )
  })

  test("appends to empty string without leading blank line", () => {
    const out = appendInlineImprovement("", "rule")
    expect(out.startsWith("<!-- kasper-injected:begin -->")).toBe(true)
  })
})

describe("AgentPromptManager — plugin_override (oh-my-opencode-style layouts)", () => {
  let projectRoot: string
  let kasperState: string
  let globalDir: string
  let manager: AgentPromptManager

  beforeEach(async () => {
    projectRoot = tmpDir()
    kasperState = join(projectRoot, "kasper-state")
    globalDir = join(projectRoot, "global-opencode")
    await mkdir(globalDir, { recursive: true })
    await mkdir(join(projectRoot, ".opencode"), { recursive: true })
    await mkdir(kasperState, { recursive: true })
    manager = new AgentPromptManager(projectRoot, kasperState, globalDir)
    await manager.init()
  })

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true })
  })

  async function writeJsonc(path: string, content: string): Promise<void> {
    await writeFile(path, content, "utf-8")
  }

  test("read() returns the prompt_append value verbatim for a config target", async () => {
    const promptAppend = "You are a built-in agent. Do X."
    await writeJsonc(
      join(projectRoot, ".opencode", "oh-my-opencode.json"),
      JSON.stringify({ agent: { sisyphus: { prompt_append: promptAppend } } }),
    )
    const content = await manager.read("sisyphus")
    expect(content).toBe(promptAppend)
  })

  test("read() returns the file body for a file target", async () => {
    const target = join(projectRoot, "prompts", "sisyphus.md")
    await mkdir(join(projectRoot, "prompts"), { recursive: true })
    await writeFile(target, "Base sisyphus prompt.", "utf-8")
    await writeJsonc(
      join(projectRoot, ".opencode", "oh-my-opencode.json"),
      JSON.stringify({
        agent: { sisyphus: { prompt: `{file:${target}}` } },
      }),
    )
    const content = await manager.read("sisyphus")
    expect(content).toBe("Base sisyphus prompt.")
  })

  test("write() to a prompt_append config target appends to the override value", async () => {
    const configPath = join(projectRoot, ".opencode", "oh-my-opencode.json")
    const initial = "Built-in prompt. "
    await writeJsonc(
      configPath,
      JSON.stringify({ agent: { sisyphus: { prompt_append: initial } } }),
    )
    await manager.write("sisyphus", "New kasper rule.")

    const after = JSON.parse(await readFile(configPath, "utf-8"))
    expect(after.agent.sisyphus.prompt_append).toContain("Built-in prompt.")
    expect(after.agent.sisyphus.prompt_append).toContain("New kasper rule.")
  })

  test("write() is idempotent for an identical block on a config target", async () => {
    const configPath = join(projectRoot, ".opencode", "oh-my-opencode.json")
    await writeJsonc(
      configPath,
      JSON.stringify({ agent: { sisyphus: { prompt_append: "Initial" } } }),
    )
    await manager.write("sisyphus", "Add documentation.")
    await manager.write("sisyphus", "Add documentation.")
    const after = JSON.parse(await readFile(configPath, "utf-8"))
    const occurrences =
      after.agent.sisyphus.prompt_append.match(/Add documentation\./g)
    expect(occurrences?.length).toBe(1)
  })

  test("write() to a {file:...} plugin_override target writes the referenced file", async () => {
    const target = join(projectRoot, "prompts", "sisyphus.md")
    await mkdir(join(projectRoot, "prompts"), { recursive: true })
    await writeFile(target, "Old content.", "utf-8")
    await writeJsonc(
      join(projectRoot, ".opencode", "oh-my-opencode.json"),
      JSON.stringify({
        agent: { sisyphus: { prompt: `{file:${target}}` } },
      }),
    )
    await manager.write("sisyphus", "New content from kasper.")
    const after = await readFile(target, "utf-8")
    expect(after).toBe("New content from kasper.")
  })

  test("write() to a prompt (non-append) plugin_override target throws InlinePromptError", async () => {
    // `agent.<name>.prompt: "raw string"` fully replaces the upstream prompt
    // and should be treated like inline: refuse to mutate directly.
    await writeJsonc(
      join(projectRoot, ".opencode", "oh-my-opencode.json"),
      JSON.stringify({
        agent: { atlas: { prompt: "Raw text override." } },
      }),
    )
    expect(manager.write("atlas", "Should not write")).rejects.toBeInstanceOf(
      InlinePromptError,
    )
  })

  test("injectSection with section mode on a {file:...} target writes a real section", async () => {
    const target = join(projectRoot, "prompts", "sisyphus.md")
    await mkdir(join(projectRoot, "prompts"), { recursive: true })
    await writeFile(target, "# Base\n", "utf-8")
    await writeJsonc(
      join(projectRoot, ".opencode", "oh-my-opencode.json"),
      JSON.stringify({
        agent: { sisyphus: { prompt: `{file:${target}}` } },
      }),
    )
    await manager.injectSection("sisyphus", "Kasper Rules", "Be thorough.")
    const after = await readFile(target, "utf-8")
    expect(after).toContain("## Kasper Rules")
    expect(after).toContain("Be thorough.")
  })

  test("injectSection with a prompt_append config target appends to the value", async () => {
    const configPath = join(projectRoot, ".opencode", "oh-my-opencode.json")
    const initial = "Built-in prompt."
    await writeJsonc(
      configPath,
      JSON.stringify({ agent: { sisyphus: { prompt_append: initial } } }),
    )
    await manager.injectSection(
      "sisyphus",
      "Kasper Rules",
      "Always cite file paths.",
    )
    const after = JSON.parse(await readFile(configPath, "utf-8"))
    expect(after.agent.sisyphus.prompt_append).toContain("Built-in prompt.")
    expect(after.agent.sisyphus.prompt_append).toContain("## Kasper Rules")
    expect(after.agent.sisyphus.prompt_append).toContain(
      "Always cite file paths.",
    )
  })

  test("injectSection with a prompt (non-append) plugin_override target throws InlinePromptError", async () => {
    await writeJsonc(
      join(projectRoot, ".opencode", "oh-my-opencode.json"),
      JSON.stringify({
        agent: { atlas: { prompt: "Raw text override." } },
      }),
    )
    expect(
      manager.injectSection("atlas", "Kasper Rules", "rule"),
    ).rejects.toBeInstanceOf(InlinePromptError)
  })

  test("plugin_override config target shows up as non-missing for a built-in agent", async () => {
    // The whole point: `shouldRerouteBuiltinAgentPrompt` in evaluate.ts/handlers.ts
    // checks `source.kind === "missing"`. A plugin override must prevent the
    // built-in rerouting, which would otherwise throw the improvement away
    // (for subagents) or push it to AGENTS.md (for primary agents).
    const before = await resolveAgentPromptSource(
      "sisyphus",
      projectRoot,
      globalDir,
    )
    expect(before.kind).toBe("missing")
    await writeJsonc(
      join(projectRoot, ".opencode", "oh-my-opencode.json"),
      JSON.stringify({ agent: { sisyphus: { prompt_append: "Hello" } } }),
    )
    const after = await resolveAgentPromptSource(
      "sisyphus",
      projectRoot,
      globalDir,
    )
    expect(after.kind).toBe("plugin_override")
  })
})

describe("AgentPromptManager — custom prompt_paths", () => {
  let projectRoot: string
  let kasperState: string
  let globalDir: string
  let customDir: string
  let manager: AgentPromptManager

  beforeEach(async () => {
    projectRoot = tmpDir()
    kasperState = join(projectRoot, "kasper-state")
    globalDir = join(projectRoot, "global-opencode")
    customDir = join(projectRoot, "team-prompts")
    await mkdir(globalDir, { recursive: true })
    await mkdir(join(projectRoot, ".opencode"), { recursive: true })
    await mkdir(kasperState, { recursive: true })
    await mkdir(join(customDir, "agents"), { recursive: true })
    manager = new AgentPromptManager(projectRoot, kasperState, globalDir, [
      customDir,
    ])
    await manager.init()
  })

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true })
  })

  test("read() returns the file from the custom path", async () => {
    await writeFile(
      join(customDir, "agents", "team-review.md"),
      "Review things carefully.",
      "utf-8",
    )
    const content = await manager.read("team-review")
    expect(content).toBe("Review things carefully.")
  })

  test("write() updates the file in the custom path", async () => {
    const target = join(customDir, "agents", "team-review.md")
    await writeFile(target, "Old prompt.", "utf-8")
    await manager.write("team-review", "New prompt from kasper.")
    const after = await readFile(target, "utf-8")
    expect(after).toBe("New prompt from kasper.")
  })

  test("injectSection() injects into the file in the custom path", async () => {
    const target = join(customDir, "agents", "team-review.md")
    await writeFile(target, "# Base prompt\n", "utf-8")
    await manager.injectSection("team-review", "Kasper Rules", "Be polite.")
    const after = await readFile(target, "utf-8")
    expect(after).toContain("## Kasper Rules")
    expect(after).toContain("Be polite.")
  })
})
