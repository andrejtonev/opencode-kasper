/**
 * Regression test for B3: the health check used to hardcode
 * `<cwd>/AGENTS.md` and report it as missing whenever the user
 * configured a non-default `agents_md_paths` entry. After the fix the
 * health check reports the resolved path and reason from
 * `resolveAgentsMdSource`.
 *
 * This test doesn't call `runHealthCheck` directly (it's not exported);
 * it verifies the same property by checking that the resolver correctly
 * identifies the configured path so any caller (the health check, the
 * status command, /kasper status output) sees the same path.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { resolveAgentsMdSource } from "../src/agents-md-resolver.js"

function tmpDir(): string {
  return join(
    process.env.TMPDIR ?? "/tmp",
    `kasper-b3-${randomBytes(6).toString("hex")}`,
  )
}

describe("agents_md resolution — what the health check now reports (regression for B3)", () => {
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

  test("when agents_md_paths is configured, the resolved primary is NOT <projectRoot>/AGENTS.md", async () => {
    // The fix relies on the health check being told the resolved primary
    // rather than hardcoding it. Without a configured file, the resolver
    // returns `configured-default` and a path under the configured dir —
    // the health check will report that path, not the project root.
    const configuredDir = join(sandbox, "shared-rules")
    await mkdir(configuredDir, { recursive: true })

    const source = await resolveAgentsMdSource(projectRoot, {
      agentsMdPaths: [configuredDir],
      homeDir: sandboxHome,
      globalOpencodeDir: sandboxGlobal,
    })
    expect(source.primary).toBe(join(configuredDir, "AGENTS.md"))
    expect(source.reason).toBe("configured-default")
    // The health check used to look for `<projectRoot>/AGENTS.md`. With
    // `agents_md_paths` configured, that file is irrelevant. The fix
    // reports the resolver's choice.
    expect(source.primary).not.toBe(join(projectRoot, "AGENTS.md"))
  })

  test("with no agents_md_paths and no local file, resolves to the configured-opencode fallback", async () => {
    // No project file, no global file, no Claude file — the resolver
    // falls back to <projectRoot>/AGENTS.md. The health check, when
    // told this, will report the same path the kasper will write to.
    const source = await resolveAgentsMdSource(projectRoot, {
      homeDir: sandboxHome,
      globalOpencodeDir: sandboxGlobal,
    })
    expect(source.primary).toBe(join(projectRoot, "AGENTS.md"))
    expect(source.reason).toBe("fallback-project-root")
  })

  test("with a local-walkup AGENTS.md, the health check sees that file, not <projectRoot>/AGENTS.md", async () => {
    // Place AGENTS.md in an ancestor dir. The resolver finds it via
    // walk-up. The health check, after the fix, reports the walk-up
    // target — not the project root.
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
})
