import { strict as assert } from "node:assert"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type { OpenCode } from "@opencode/client"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import type { nativeProviderFixture } from "./native-provider-fixture.js"

export async function verifyPackagedActions(
  client: ReturnType<typeof OpenCode.make>,
  directory: string,
  provider: Awaited<ReturnType<typeof nativeProviderFixture>>,
  root: string,
  observeCommand?: (
    sessionID: string,
    command: () => Promise<void>,
  ) => Promise<unknown>,
) {
  const session = await client.session.create({
    title: "Kasper isolated acceptance",
    agent: Agent.ID.make("build"),
    model: {
      id: Model.ID.make("work"),
      providerID: Provider.ID.make("fixture"),
    },
    location: { directory },
  })
  const evidence: Record<string, unknown> = { sessionID: session.id }
  const invoke = async (requestID: string, command: string) =>
    (
      await client.rpc.call(
        {
          rpcID: "kasper",
          method: "execute",
          location: { directory },
          input: {
            requestID,
            sessionID: session.id,
            location: directory,
            command,
          },
        },
        { signal: AbortSignal.timeout(15000) },
      )
    ).output as { status: string; text: string; requestID: string }
  const status = await invoke("status-once", "status")
  assert.equal(status.status, "ok")
  assert.deepEqual(await invoke("status-once", "status"), status)
  const directCommand = () =>
    client.session.command({
      sessionID: session.id,
      name: "kasper",
      text: "status",
    })
  if (observeCommand)
    evidence.tui = await observeCommand(session.id, directCommand)
  else await directCommand()
  assert.equal(
    provider.receipts.length,
    0,
    "administrative commands must not generate",
  )
  const before = await client.message.list({
    sessionID: session.id,
    limit: 100,
  })
  assert.equal(
    before.data.length,
    0,
    "administrative command must not add chat",
  )
  evidence.administrative = {
    status,
    idempotent: true,
    nativeCommand: true,
    providerCalls: 0,
    chatMessages: 0,
  }

  await writeFile(
    path.join(root, "packaged-actions.json"),
    JSON.stringify(evidence, null, 2),
  )
  provider.respond({
    text: "",
    toolCalls: [
      {
        index: 0,
        id: "fixture-tool-1",
        type: "function",
        function: {
          name: "execute",
          arguments: JSON.stringify({
            code: 'return await tools.kasper_control({action:"status"})',
          }),
        },
      },
    ],
  })
  provider.respond({ text: "Local work completed: fixture answer." })
  await client.session.prompt({
    sessionID: session.id,
    text: "Return a short local fixture answer.",
  })
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const active = await client.session.active()
    if (provider.receipts.length && !active[session.id]) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.equal(
    provider.receipts.length,
    2,
    "two local work requests including one tool round-trip expected",
  )
  assert.equal(provider.receipts[0].model, "work")
  const history = await client.message.list({
    sessionID: session.id,
    limit: 100,
  })
  assert.ok(history.data.some((message) => message.type === "user"))
  assert.ok(history.data.some((message) => message.type === "assistant"))
  evidence.history = history.data
  await writeFile(
    path.join(root, "packaged-actions.json"),
    JSON.stringify(evidence, null, 2),
  )
  provider.respond({
    text: JSON.stringify({
      overall_score: 0.8,
      categories: {
        instruction_following: 0.8,
        completeness: 0.8,
        proactiveness: 0.8,
        code_quality: 0.8,
        communication: 0.8,
      },
      strengths: ["Fixture response follows request"],
      weaknesses: [],
    }),
  })
  const score = await invoke("score-once", "score")
  evidence.score = score
  await writeFile(
    path.join(root, "packaged-actions.json"),
    JSON.stringify(evidence, null, 2),
  )
  assert.equal(score.status, "ok", score.text)
  assert.equal(
    provider.receipts.length,
    3,
    "exactly one judge request expected",
  )
  assert.equal(provider.receipts[2].model, "judge")
  const judgeRequest = JSON.stringify(provider.receipts[2].request)
  assert.ok(
    judgeRequest.includes("Return a short local fixture answer."),
    "judge must receive durable user evidence",
  )
  assert.ok(
    judgeRequest.includes("kasper_control"),
    "judge must receive tool arguments",
  )
  assert.ok(
    judgeRequest.includes("Native capabilities"),
    "judge must receive actual tool output",
  )
  assert.ok(
    judgeRequest.includes("fixture answer"),
    "judge must receive assistant evidence",
  )
  assert.deepEqual(await invoke("score-once", "score"), score)
  assert.equal(
    provider.receipts.length,
    3,
    "receipt refresh must not rerun scoring",
  )
  const sessions = await client.session.list({ directory })
  assert.equal(
    sessions.data.length,
    1,
    "native stateless judge must not create a child session",
  )
  const state = JSON.parse(
    await readFile(
      path.join(directory, ".opencode", "kasper", "state.json"),
      "utf8",
    ),
  )
  evidence.state = state
  evidence.receipts = provider.receipts
  evidence.noJudgeChildSession = true
  // Reset while a real local judge request is outstanding. Provider completion is logged separately.
  provider.respond({ text: "A second completed local turn." })
  await client.session.prompt({
    sessionID: session.id,
    text: "Return a second fixture answer.",
  })
  const workDeadline = Date.now() + 15000
  while (Date.now() < workDeadline) {
    const active = await client.session.active()
    if (provider.receipts.length >= 4 && !active[session.id]) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.equal(provider.receipts.length, 4)
  provider.respond({
    text: JSON.stringify({
      overall_score: 0.9,
      categories: {
        instruction_following: 0.9,
        completeness: 0.9,
        proactiveness: 0.9,
        code_quality: 0.9,
        communication: 0.9,
      },
      strengths: [],
      weaknesses: [],
    }),
    delayMs: 800,
  })
  const inFlight = invoke("score-reset-race", "score").catch(
    (error: unknown) => ({ status: "transport-failed", text: String(error) }),
  )
  const dispatchDeadline = Date.now() + 10000
  while (Date.now() < dispatchDeadline && provider.receipts.length < 5)
    await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(
    provider.receipts.length,
    5,
    "race must reach the actual provider before reset",
  )
  const reset = await invoke("reset-race", "reset --force")
  const cancelled = await inFlight
  await new Promise((resolve) => setTimeout(resolve, 1000))
  const afterReset = JSON.parse(
    await readFile(
      path.join(directory, ".opencode", "kasper", "state.json"),
      "utf8",
    ),
  )
  evidence.resetRace = {
    reset,
    cancelled,
    state: afterReset,
    providerReceipt: provider.receipts[4],
  }
  assert.equal(reset.status, "ok", reset.text)
  assert.equal(cancelled.status, "cancelled", cancelled.text)
  assert.equal(
    Object.keys(afterReset.sessions ?? {}).length,
    0,
    "late judge completion must not restore reset state",
  )
  assert.equal(
    provider.receipts.length,
    5,
    "reset must not trigger overlapping judge retries",
  )
  await client.location.reload({ signal: AbortSignal.timeout(10000) })
  const reloaded = await invoke("status-after-reload", "status")
  assert.equal(reloaded.status, "ok", reloaded.text)
  const logs = await readFile(
    path.join(directory, ".opencode", "kasper", "kasper.log"),
    "utf8",
  )
  assert.ok(
    logs.split("\n").filter((line) => line.includes('"event":"native_setup"'))
      .length >= 2,
    "public location reload must create a new plugin scope",
  )
  assert.equal(provider.receipts.length, 5, "reload must not generate")
  evidence.reload = { status: reloaded, newPluginScope: true, providerCalls: 0 }
  const child = await client.session.create({
    title: "Historical child after reload",
    parentID: session.id,
    agent: Agent.ID.make("build"),
    model: {
      id: Model.ID.make("work"),
      providerID: Provider.ID.make("fixture"),
    },
    location: { directory },
  })
  assert.equal(
    child.parentID,
    session.id,
    "public child creation must retain exact parent",
  )
  provider.respond({ text: "Completed historical child fixture answer." })
  await client.session.prompt({
    sessionID: child.id,
    text: "Return a historical child fixture answer.",
  })
  const childDeadline = Date.now() + 15000
  while (Date.now() < childDeadline) {
    const active = await client.session.active()
    if (provider.receipts.length >= 6 && !active[child.id]) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.equal(provider.receipts.length, 6, "one child work request expected")
  await client.location.reload({ signal: AbortSignal.timeout(10000) })
  provider.respond({
    text: JSON.stringify({
      overall_score: 0.8,
      categories: {
        instruction_following: 0.8,
        completeness: 0.8,
        proactiveness: 0.8,
        code_quality: 0.8,
        communication: 0.8,
      },
      strengths: [],
      weaknesses: [],
    }),
  })
  const childScore = await invoke(
    "historical-child-score",
    `score session ${child.id}`,
  )
  const childState = JSON.parse(
    await readFile(
      path.join(directory, ".opencode", "kasper", "state.json"),
      "utf8",
    ),
  )
  evidence.childAfterReload = {
    parentSessionID: session.id,
    childSessionID: child.id,
    score: childScore,
    state: childState,
  }
  await writeFile(
    path.join(root, "packaged-actions.json"),
    JSON.stringify(evidence, null, 2),
  )
  assert.equal(childScore.status, "ok", childScore.text)
  assert.equal(
    provider.receipts.length,
    7,
    "one historical child judge request expected",
  )
  const childRecord = childState.sessions[child.id]
  assert.equal(childRecord.agent_type, "subagent")
  assert.equal(childRecord.parent_session_id, session.id)
  assert.equal(childRecord.source_session_id, child.id)
  assert.equal(childRecord.agent_name, "build")
  assert.equal(childRecord.score, 0.8)
  assert.equal(
    childState.sessions[session.id],
    undefined,
    "parent-invoked child scoring must not commit a parent score",
  )
  await writeFile(
    path.join(root, "packaged-actions.json"),
    JSON.stringify(evidence, null, 2),
  )
  return evidence
}
