import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  backupDirNameFor,
  resolveAgentsMdSource,
} from "../src/agents-md-resolver.js"

/**
 * These tests use the resolver's `homeDir` and `globalOpencodeDir`
 * overrides to keep every test fully sandboxed. We never touch the real
 * `~/.claude/CLAUDE.md` or `~/.config/opencode/AGENTS.md`.
 */
function tmpDir(): string {
  return join(
    process.env.TMPDIR ?? "/tmp",
    `kasper-agentsmd-resolver-${randomBytes(6).toString("hex")}`,
  )
}

describe("resolveAgentsMdSource", () => {
  let sandbox: string
  let projectRoot: string
  let sandboxHome: string
  let sandboxGlobal: string

  beforeEach(async () => {
    sandbox = tmpDir()
    projectRoot = join(sandbox, "project")
    sandboxHome = join(sandbox, "home")
    sandboxGlobal = join(sandbox, "home", ".config", "opencode")
    await mkdir(projectRoot, { recursive: true })
    await mkdir(sandboxHome, { recursive: true })
    await mkdir(sandboxGlobal, { recursive: true })
  })

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true })
  })

  test("falls back to <projectRoot>/AGENTS.md when nothing exists", async () => {
    const source = await resolveAgentsMdSource(projectRoot, {
      homeDir: sandboxHome,
      globalOpencodeDir: sandboxGlobal,
    })
    expect(source.primary).toBe(join(projectRoot, "AGENTS.md"))
    expect(source.reason).toBe("fallback-project-root")
  })

  test("finds <projectRoot>/AGENTS.md via local walk-up (reason: local-walkup)", async () => {
    const target = join(projectRoot, "AGENTS.md")
    await writeFile(target, "rules", "utf-8")
    const source = await resolveAgentsMdSource(projectRoot, {
      homeDir: sandboxHome,
      globalOpencodeDir: sandboxGlobal,
    })
    expect(source.primary).toBe(target)
    expect(source.reason).toBe("local-walkup")
  })

  test("finds CLAUDE.md when AGENTS.md is missing (local-walkup)", async () => {
    const target = join(projectRoot, "CLAUDE.md")
    await writeFile(target, "rules", "utf-8")
    const source = await resolveAgentsMdSource(projectRoot, {
      homeDir: sandboxHome,
      globalOpencodeDir: sandboxGlobal,
    })
    expect(source.primary).toBe(target)
    expect(source.reason).toBe("local-walkup")
  })

  test("AGENTS.md wins over CLAUDE.md at the same level (local-walkup)", async () => {
    const agents = join(projectRoot, "AGENTS.md")
    const claude = join(projectRoot, "CLAUDE.md")
    await writeFile(agents, "A", "utf-8")
    await writeFile(claude, "C", "utf-8")
    const source = await resolveAgentsMdSource(projectRoot, {
      homeDir: sandboxHome,
      globalOpencodeDir: sandboxGlobal,
    })
    expect(source.primary).toBe(agents)
    expect(source.primary).not.toBe(claude)
  })

  test("walks up to an ancestor AGENTS.md", async () => {
    const ancestor = join(sandbox, "AGENTS.md")
    await writeFile(ancestor, "ancestor rules", "utf-8")
    const deepDir = join(projectRoot, "packages", "sub", "deep")
    await mkdir(deepDir, { recursive: true })
    const source = await resolveAgentsMdSource(deepDir, {
      homeDir: sandboxHome,
      globalOpencodeDir: sandboxGlobal,
    })
    expect(source.primary).toBe(ancestor)
    expect(source.reason).toBe("local-walkup")
  })

  test("configured agentsMdPaths takes priority over local walk-up", async () => {
    const local = join(projectRoot, "AGENTS.md")
    await writeFile(local, "local", "utf-8")
    const configuredDir = join(sandbox, "shared-rules")
    await mkdir(configuredDir, { recursive: true })
    const configuredFile = join(configuredDir, "AGENTS.md")
    await writeFile(configuredFile, "configured", "utf-8")
    const source = await resolveAgentsMdSource(projectRoot, {
      agentsMdPaths: [configuredDir],
      homeDir: sandboxHome,
      globalOpencodeDir: sandboxGlobal,
    })
    expect(source.primary).toBe(configuredFile)
    expect(source.reason).toBe("configured-explicit")
  })

  test("configured agentsMdPaths CLAUDE.md is used when AGENTS.md missing (per-entry fallback)", async () => {
    const configuredDir = join(sandbox, "shared-rules")
    await mkdir(configuredDir, { recursive: true })
    const claude = join(configuredDir, "CLAUDE.md")
    await writeFile(claude, "claude rules", "utf-8")
    const source = await resolveAgentsMdSource(projectRoot, {
      agentsMdPaths: [configuredDir],
      homeDir: sandboxHome,
      globalOpencodeDir: sandboxGlobal,
    })
    expect(source.primary).toBe(claude)
    expect(source.reason).toBe("configured-explicit")
  })

  test("configured agentsMdPaths returns first entry's AGENTS.md as write target when nothing exists", async () => {
    const configuredDir = join(sandbox, "shared-rules")
    await mkdir(configuredDir, { recursive: true })
    const source = await resolveAgentsMdSource(projectRoot, {
      agentsMdPaths: [configuredDir],
      homeDir: sandboxHome,
      globalOpencodeDir: sandboxGlobal,
    })
    expect(source.primary).toBe(join(configuredDir, "AGENTS.md"))
    expect(source.reason).toBe("configured-default")
  })

  test("first matching agentsMdPaths entry wins (later entries ignored)", async () => {
    const first = join(sandbox, "first")
    const second = join(sandbox, "second")
    await mkdir(first, { recursive: true })
    await mkdir(second, { recursive: true })
    await writeFile(join(first, "AGENTS.md"), "first", "utf-8")
    await writeFile(join(second, "AGENTS.md"), "second", "utf-8")
    const source = await resolveAgentsMdSource(projectRoot, {
      agentsMdPaths: [first, second],
      homeDir: sandboxHome,
      globalOpencodeDir: sandboxGlobal,
    })
    expect(source.primary).toBe(join(first, "AGENTS.md"))
  })

  test("falls through to global opencode dir when local walk-up is empty", async () => {
    const globalFile = join(sandboxGlobal, "AGENTS.md")
    await writeFile(globalFile, "global", "utf-8")
    const source = await resolveAgentsMdSource(projectRoot, {
      homeDir: sandboxHome,
      globalOpencodeDir: sandboxGlobal,
    })
    expect(source.primary).toBe(globalFile)
    expect(source.reason).toBe("global-opencode")
  })

  test("falls through to ~/.claude/CLAUDE.md (global-claude) when nothing else hits", async () => {
    const claudeGlobal = join(sandboxHome, ".claude", "CLAUDE.md")
    await mkdir(join(sandboxHome, ".claude"), { recursive: true })
    await writeFile(claudeGlobal, "claude", "utf-8")
    const source = await resolveAgentsMdSource(projectRoot, {
      homeDir: sandboxHome,
      globalOpencodeDir: sandboxGlobal,
    })
    expect(source.primary).toBe(claudeGlobal)
    expect(source.reason).toBe("global-claude")
  })

  test("OPENCODE_DISABLE_CLAUDE_CODE=1 skips ~/.claude/CLAUDE.md", async () => {
    const claudeGlobal = join(sandboxHome, ".claude", "CLAUDE.md")
    await mkdir(join(sandboxHome, ".claude"), { recursive: true })
    await writeFile(claudeGlobal, "claude", "utf-8")
    const previousValue = process.env.OPENCODE_DISABLE_CLAUDE_CODE
    process.env.OPENCODE_DISABLE_CLAUDE_CODE = "1"
    try {
      const source = await resolveAgentsMdSource(projectRoot, {
        homeDir: sandboxHome,
        globalOpencodeDir: sandboxGlobal,
      })
      // No local file, no global opencode file, Claude Code disabled →
      // falls through to the final fallback (projectRoot/AGENTS.md).
      expect(source.primary).toBe(join(projectRoot, "AGENTS.md"))
      expect(source.reason).toBe("fallback-project-root")
    } finally {
      if (previousValue === undefined) {
        delete process.env.OPENCODE_DISABLE_CLAUDE_CODE
      } else {
        process.env.OPENCODE_DISABLE_CLAUDE_CODE = previousValue
      }
    }
  })

  test("OPENCODE_DISABLE_CLAUDE_CODE_PROMPT=1 also skips ~/.claude/CLAUDE.md", async () => {
    const claudeGlobal = join(sandboxHome, ".claude", "CLAUDE.md")
    await mkdir(join(sandboxHome, ".claude"), { recursive: true })
    await writeFile(claudeGlobal, "claude", "utf-8")
    const previousValue = process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT
    process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT = "1"
    try {
      const source = await resolveAgentsMdSource(projectRoot, {
        homeDir: sandboxHome,
        globalOpencodeDir: sandboxGlobal,
      })
      expect(source.primary).toBe(join(projectRoot, "AGENTS.md"))
      expect(source.reason).toBe("fallback-project-root")
    } finally {
      if (previousValue === undefined) {
        delete process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT
      } else {
        process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT = previousValue
      }
    }
  })

  test("OPENCODE_CONFIG_DIR is consulted as a configured entry (opencode-config-dir)", async () => {
    const configDir = join(sandbox, "opencode-config")
    await mkdir(configDir, { recursive: true })
    const target = join(configDir, "AGENTS.md")
    await writeFile(target, "config dir rules", "utf-8")
    const previousValue = process.env.OPENCODE_CONFIG_DIR
    process.env.OPENCODE_CONFIG_DIR = configDir
    try {
      const source = await resolveAgentsMdSource(projectRoot, {
        homeDir: sandboxHome,
        globalOpencodeDir: sandboxGlobal,
      })
      expect(source.primary).toBe(target)
      expect(source.reason).toBe("opencode-config-dir")
    } finally {
      if (previousValue === undefined) {
        delete process.env.OPENCODE_CONFIG_DIR
      } else {
        process.env.OPENCODE_CONFIG_DIR = previousValue
      }
    }
  })

  test("~/ path in agentsMdPaths is expanded against homeDir", async () => {
    const homeDir = sandboxHome
    const expandedDir = join(homeDir, "my-rules")
    await mkdir(expandedDir, { recursive: true })
    const target = join(expandedDir, "AGENTS.md")
    await writeFile(target, "from home", "utf-8")
    const source = await resolveAgentsMdSource(projectRoot, {
      agentsMdPaths: ["~/my-rules"],
      homeDir,
      globalOpencodeDir: sandboxGlobal,
    })
    expect(source.primary).toBe(target)
  })

  test("absolute path in agentsMdPaths is used verbatim", async () => {
    const absolute = join(sandbox, "absolute-rules")
    await mkdir(absolute, { recursive: true })
    const target = join(absolute, "AGENTS.md")
    await writeFile(target, "absolute", "utf-8")
    const source = await resolveAgentsMdSource(projectRoot, {
      agentsMdPaths: [absolute],
      homeDir: sandboxHome,
      globalOpencodeDir: sandboxGlobal,
    })
    expect(source.primary).toBe(target)
  })

  test("candidates list contains every path the resolver considered", async () => {
    const source = await resolveAgentsMdSource(projectRoot, {
      homeDir: sandboxHome,
      globalOpencodeDir: sandboxGlobal,
    })
    // At least the local AGENTS.md/CLAUDE.md pair, the global pair, the
    // Claude Code file, and the final fallback should all be there.
    expect(source.candidates).toContain(join(projectRoot, "AGENTS.md"))
    expect(source.candidates).toContain(join(projectRoot, "CLAUDE.md"))
    expect(source.candidates).toContain(join(sandboxGlobal, "AGENTS.md"))
    expect(source.candidates).toContain(
      join(sandboxHome, ".claude", "CLAUDE.md"),
    )
  })
})

describe("backupDirNameFor", () => {
  test("returns just the filename when path has no directory", () => {
    expect(backupDirNameFor("AGENTS.md")).toBe("AGENTS.md")
  })

  test("prefixes the filename and joins the directory with --", () => {
    expect(backupDirNameFor("/home/me/work/rules/AGENTS.md")).toBe(
      "AGENTS.md--home-me-work-rules",
    )
  })

  test("sanitises unsafe characters in directory segments", () => {
    // Spaces, colons, brackets and other shell-unsafe characters become
    // single dashes. Multiple dashes collapse to one.
    expect(backupDirNameFor("/home/me/my rules: project[x]/AGENTS.md")).toBe(
      "AGENTS.md--home-me-my-rules-project-x",
    )
  })

  test("uses forward slashes on POSIX and backslashes on Windows transparently", () => {
    expect(backupDirNameFor("C:\\Users\\me\\rules\\AGENTS.md")).toBe(
      "AGENTS.md--C-Users-me-rules",
    )
  })
})
