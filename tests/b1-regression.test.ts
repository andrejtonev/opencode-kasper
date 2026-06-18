/**
 * Regression test for B1: appendToPluginOverridePrompt previously located
 * the target agent by scanning for an entry whose `prompt`/`prompt_append`
 * VALUE matched `source.value`. When two agents in the same config shared
 * the same prompt text, the first one in insertion order won, and kasper
 * silently edited the WRONG agent's prompt.
 *
 * This test creates a config with two agents that have the same `prompt_append`
 * text but different names, then invokes appendToPluginOverridePrompt and
 * verifies the rule landed in the intended agent's entry — not the other one.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appendToPluginOverridePrompt } from "../src/agent-prompt-resolver.js"

function tmpDir(): string {
  return join(tmpdir(), `kasper-b1-${randomBytes(6).toString("hex")}`)
}

describe("appendToPluginOverridePrompt — agent name disambiguation (regression for B1)", () => {
  let projectRoot: string
  let configPath: string

  beforeEach(async () => {
    projectRoot = tmpDir()
    await mkdir(projectRoot, { recursive: true })
    configPath = join(projectRoot, "oh-my-opencode.json")
  })

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true })
  })

  test("edits the named agent, not the first one sharing the same prompt value", async () => {
    // Two distinct agents with identical `prompt_append` text. The agent
    // we want to edit is `target-agent`; the other (`decoy-agent`) comes
    // first in the file's insertion order. Pre-fix, kasper would have
    // updated `decoy-agent` because it scans by value.
    const sharedPrompt = "Be thorough and be fast."
    await writeFile(
      configPath,
      JSON.stringify(
        {
          agent: {
            "decoy-agent": { prompt_append: sharedPrompt },
            "target-agent": { prompt_append: sharedPrompt },
          },
        },
        null,
        2,
      ),
      "utf-8",
    )

    const newRule = "Prefer the named-agent over the decoy"
    const result = await appendToPluginOverridePrompt(
      {
        kind: "plugin_override",
        agentName: "target-agent",
        target: "config",
        value: sharedPrompt,
        configPath,
        promptField: "prompt_append",
        isAppend: true,
      },
      newRule,
    )

    expect(result.agentName).toBe("target-agent")

    const after = JSON.parse(await readFile(configPath, "utf-8"))
    // The decoy should be untouched.
    expect(after.agent["decoy-agent"].prompt_append).toBe(sharedPrompt)
    // The target should contain the appended rule.
    expect(after.agent["target-agent"].prompt_append).toContain(newRule)
    // Sanity: the target is the one we changed, not the decoy.
    expect(after.agent["target-agent"].prompt_append).toContain(sharedPrompt)
  })
})
