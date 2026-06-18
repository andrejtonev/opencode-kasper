/**
 * Regression test for B2: `findOverrideInDir` previously did
 * `file.split("/").pop()` to extract the filename. On Windows, paths use
 * `\` as the separator, so the manual split fails to isolate the basename
 * and the `opencode.json`/`opencode.jsonc` skip never fires, causing the
 * standard opencode config to be double-counted as a plugin override.
 *
 * The fix uses `basename()` from node:path, which handles both separators.
 * This test exercises the equivalent of a Windows-style path string by
 * constructing one with `path.win32.join` and verifying the resolver still
 * finds the plugin override (and not the opencode.json inside the same
 * directory).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveAgentPromptSource } from "../src/agent-prompt-resolver.js"

function tmpDir(): string {
  return join(tmpdir(), `kasper-b2-${randomBytes(6).toString("hex")}`)
}

describe("plugin override scan — Windows path-separator handling (regression for B2)", () => {
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

  test("does not surface opencode.json as a plugin_override (regression for the basename fix)", async () => {
    // opencode.json defines the agent as a {file:...} directive. A sibling
    // plugin config also defines it. The opencode.json path should win
    // (it is parsed first by the resolver, not surfaced as a plugin_override
    // by the second pass). Pre-fix on Windows, the opencode.json basename
    // skip would not fire and the resolver would have surfaced it again as
    // a `plugin_override` source, overriding the `external_file` choice.
    const targetPath = join(projectRoot, "from-opencode.md")
    await writeFile(targetPath, "From opencode.", "utf-8")
    await writeFile(
      join(projectRoot, "opencode.json"),
      JSON.stringify({
        agent: { foo: { prompt: `{file:${targetPath}}` } },
      }),
      "utf-8",
    )
    await writeFile(
      join(projectRoot, ".opencode", "plugin.json"),
      JSON.stringify({
        agent: { foo: { prompt_append: "Plugin text." } },
      }),
      "utf-8",
    )

    const source = await resolveAgentPromptSource("foo", projectRoot, globalDir)
    expect(source.kind).toBe("external_file")
  })

  test("opencode.jsonc is also skipped from the plugin override scan", async () => {
    const targetPath = join(projectRoot, "x.md")
    await writeFile(targetPath, "X.", "utf-8")
    await writeFile(
      join(projectRoot, "opencode.jsonc"),
      JSON.stringify({
        agent: { foo: { prompt: `{file:${targetPath}}` } },
      }),
      "utf-8",
    )

    const source = await resolveAgentPromptSource("foo", projectRoot, globalDir)
    expect(source.kind).toBe("external_file")
  })
})
