/**
 * Regression test for B4: the config reload timer used to invalidate the
 * AGENTS.md content cache but never re-resolved the rules file or pushed
 * new `prompt_paths` into the agent-prompt manager. Changing
 * `agents_md_paths` or `prompt_paths` in `kasper.json` was therefore
 * silently ignored until opencode restarted.
 *
 * The fix:
 *  - `AgentsMdManager.setResolvedPath(newPath)` updates the rules file
 *    path and recomputes the keyed-on-path backup directory.
 *  - `AgentPromptManager.setResolverInputs(globalDir, customPaths)`
 *    pushes new inputs into the resolver and invalidates the source
 *    cache so subsequent `resolve()` calls re-resolve.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { AgentPromptManager } from "../src/agent-prompts.js"
import { AgentsMdManager } from "../src/agents-md.js"

function tmpDir(): string {
  return join(
    process.env.TMPDIR ?? "/tmp",
    `kasper-b4-${randomBytes(6).toString("hex")}`,
  )
}

describe("AgentsMdManager.setResolvedPath (regression for B4)", () => {
  let stateDir: string
  let oldPath: string
  let newPath: string

  beforeEach(async () => {
    stateDir = tmpDir()
    await mkdir(stateDir, { recursive: true })
    oldPath = join(stateDir, "old", "AGENTS.md")
    newPath = join(stateDir, "new", "AGENTS.md")
    await mkdir(join(stateDir, "old"), { recursive: true })
    await mkdir(join(stateDir, "new"), { recursive: true })
  })

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true })
  })

  test("setResolvedPath updates the write target", async () => {
    const mgr = new AgentsMdManager(oldPath, stateDir, 20)
    await mgr.init()
    expect(mgr.agentsMdPath).toBe(oldPath)

    mgr.setResolvedPath(newPath)
    expect(mgr.agentsMdPath).toBe(newPath)

    // Writes now land at the new path
    await mgr.write("new content")
    const written = await readFile(newPath, "utf-8")
    expect(written).toBe("new content")
  })

  test("setResolvedPath to the same path is a no-op", async () => {
    const mgr = new AgentsMdManager(oldPath, stateDir, 20)
    await mgr.init()
    // Take a backup first, then setResolvedPath to the same path and
    // verify the backup landed where the (unchanged) backup directory
    // points. Indirect check: writes still go to oldPath.
    await mgr.write("before")
    mgr.setResolvedPath(oldPath)
    await mgr.write("after")
    // Both writes went to oldPath (same path → no-op on the directory).
    const content = await readFile(oldPath, "utf-8")
    expect(content).toBe("after")
  })
})

describe("AgentPromptManager.setResolverInputs (regression for B4)", () => {
  let projectRoot: string
  let stateDir: string
  let globalDir: string

  beforeEach(async () => {
    projectRoot = tmpDir()
    stateDir = join(projectRoot, ".opencode", "kasper")
    globalDir = join(projectRoot, "global-opencode")
    await mkdir(globalDir, { recursive: true })
    await mkdir(stateDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true })
  })

  test("new customPromptPaths are visible to resolve() after a set", async () => {
    // Pre-fix, customPromptPaths was `private readonly` and the reload
    // timer couldn't push new values into the manager. After the fix,
    // setResolverInputs updates the inputs and clears the source cache.
    const customDir = join(projectRoot, "prompts")
    await mkdir(join(customDir, "agents"), { recursive: true })
    await writeFile(join(customDir, "agents", "build.md"), "Custom.", "utf-8")

    const mgr = new AgentPromptManager(projectRoot, stateDir, globalDir)
    await mgr.init()
    // Before the config change: no source found.
    const before = await mgr.resolve("build")
    expect(before.kind).toBe("missing")

    // User adds `prompt_paths` to kasper.json → reload handler runs.
    mgr.setResolverInputs(globalDir, [customDir])
    const after = await mgr.resolve("build")
    expect(after.kind).toBe("project_file")
    if (after.kind === "project_file") {
      expect(after.path).toBe(join(customDir, "agents", "build.md"))
    }
  })

  test("new globalOpencodeDir is visible to resolve() after a set", async () => {
    // Put a prompt in a fresh global dir, then push that dir into the
    // manager via setResolverInputs.
    const newGlobalDir = join(projectRoot, "new-global")
    await mkdir(join(newGlobalDir, "agents"), { recursive: true })
    await writeFile(join(newGlobalDir, "agents", "build.md"), "X.", "utf-8")

    const mgr = new AgentPromptManager(projectRoot, stateDir, globalDir)
    await mgr.init()
    expect((await mgr.resolve("build")).kind).toBe("missing")

    mgr.setResolverInputs(newGlobalDir, undefined)
    const after = await mgr.resolve("build")
    expect(after.kind).toBe("global_file")
    if (after.kind === "global_file") {
      expect(after.path).toBe(join(newGlobalDir, "agents", "build.md"))
    }
  })

  test("setResolverInputs clears the source cache (no stale results)", async () => {
    // Cache a result, then change inputs and confirm a re-resolve happens
    // (not the cached `missing`).
    const mgr = new AgentPromptManager(projectRoot, stateDir, globalDir)
    await mgr.init()
    const first = await mgr.resolve("build")
    expect(first.kind).toBe("missing")

    // Add a project file and push it via setResolverInputs.
    const newCustomDir = join(projectRoot, "p2")
    await mkdir(join(newCustomDir, "agents"), { recursive: true })
    await writeFile(join(newCustomDir, "agents", "build.md"), "OK.", "utf-8")
    mgr.setResolverInputs(globalDir, [newCustomDir])

    const second = await mgr.resolve("build")
    expect(second.kind).toBe("project_file")
  })
})
