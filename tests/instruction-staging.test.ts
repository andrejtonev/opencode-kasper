import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { AgentPromptManager } from "../src/agent-prompts.js"
import { AgentsMdManager } from "../src/agents-md.js"
import {
  commitInstructionUpdate,
  instructionHash,
  readInstructionReceipt,
  rollbackInstruction,
  writeGuardedInstruction,
} from "../src/instruction-transaction.js"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "kasper-staging-conflict-"))
  roots.push(root)
  const path = join(root, "AGENTS.md")
  await writeFile(path, "original")
  return { root, path, backupDir: join(root, "backups") }
}
function stagedEdit(path: string, edit: string) {
  return async () => {
    const staged = (await readdir(dirname(path))).find((name) =>
      name.startsWith(`${basename(path)}.tmp-`),
    )
    expect(staged).toBeDefined()
    expect(
      (await readFile(join(dirname(path), staged!), "utf8")).length,
    ).toBeGreaterThan(0)
    await writeFile(path, edit)
  }
}
test("guarded replacement rechecks the source after a completed staging write", async () => {
  const { path, root } = await fixture()
  await expect(
    writeGuardedInstruction(path, "ours", undefined, {
      expectedHash: instructionHash("original"),
      beforeReplace: stagedEdit(path, "external edit"),
    }),
  ).rejects.toThrow("source changed while staging")
  expect(await readFile(path, "utf8")).toBe("external edit")
  expect(
    (await readdir(root)).filter((name) => name.includes(".tmp-")),
  ).toHaveLength(0)
})
test("instruction apply leaves external edits and a prepared recovery receipt intact", async () => {
  const { path, backupDir } = await fixture()
  await expect(
    commitInstructionUpdate({ path }, () => "ours", {
      backupDir,
      beforeReplace: stagedEdit(path, "external apply edit"),
    }),
  ).rejects.toThrow("source changed while staging")
  expect(await readFile(path, "utf8")).toBe("external apply edit")
  const backup = (await readdir(backupDir)).find((name) =>
    name.endsWith(".md"),
  )!
  expect(await readFile(join(backupDir, backup), "utf8")).toBe("original")
  expect((await readInstructionReceipt(join(backupDir, backup))).status).toBe(
    "prepared",
  )
})
test("rollback cannot overwrite a user edit made while staging restored bytes", async () => {
  const { path, backupDir } = await fixture()
  const applied = await commitInstructionUpdate({ path }, () => "ours", {
    backupDir,
  })
  await expect(
    rollbackInstruction(applied.backupPath!, backupDir, {
      beforeReplace: stagedEdit(path, "external rollback edit"),
    }),
  ).rejects.toThrow("source changed while staging")
  expect(await readFile(path, "utf8")).toBe("external rollback edit")
  expect((await readInstructionReceipt(applied.backupPath!)).status).toBe(
    "applied",
  )
})
test("JSON pointer rollback preserves an unrelated edit arriving during staging", async () => {
  const { path, backupDir } = await fixture()
  await writeFile(
    path,
    JSON.stringify({ agents: { reviewer: { system: "before" } }, other: 1 }),
  )
  const applied = await commitInstructionUpdate(
    { path, jsonPath: ["agents", "reviewer", "system"] },
    () =>
      JSON.stringify({ agents: { reviewer: { system: "ours" } }, other: 1 }),
    { backupDir },
  )
  const external = JSON.stringify({
    agents: { reviewer: { system: "ours" } },
    other: 2,
  })
  await expect(
    rollbackInstruction(applied.backupPath!, backupDir, {
      beforeReplace: stagedEdit(path, external),
    }),
  ).rejects.toThrow("source changed while staging")
  expect(await readFile(path, "utf8")).toBe(external)
})
test("rollback restoring absence does not delete an external edit after backup awaits", async () => {
  const { path, backupDir } = await fixture()
  await rm(path)
  const applied = await commitInstructionUpdate({ path }, () => "created", {
    backupDir,
  })
  await expect(
    rollbackInstruction(applied.backupPath!, backupDir, {
      beforeReplace: async () => {
        await writeFile(path, "external keep")
      },
    }),
  ).rejects.toThrow("source changed before rollback removal")
  expect(await readFile(path, "utf8")).toBe("external keep")
})
test("manager rollback lifecycle guards prevent writes and created-file removal", async () => {
  const { path, root } = await fixture()
  const manager = new AgentsMdManager(path, join(root, "state"))
  const backup = await manager.applyGuidance("guidance")
  const current = await readFile(path, "utf8")
  await expect(
    manager.rollback(backup, () => {
      throw new Error("disposed")
    }),
  ).rejects.toThrow("disposed")
  expect(await readFile(path, "utf8")).toBe(current)
  const agent = new AgentPromptManager(
    root,
    join(root, "state"),
    join(root, "empty-global"),
  )
  const agentBackup = await agent.injectSection("reviewer", "Rules", "guidance")
  await expect(
    agent.rollback("reviewer", agentBackup, () => {
      throw new Error("reset")
    }),
  ).rejects.toThrow("reset")
  expect(
    await Bun.file(join(root, ".opencode", "agents", "reviewer.md")).exists(),
  ).toBe(true)
})
