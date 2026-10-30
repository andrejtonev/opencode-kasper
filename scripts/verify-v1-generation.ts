import { strict as assert } from "node:assert"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createOpencodeClient } from "@opencode-ai/sdk"
import type { nativeProviderFixture } from "./native-provider-fixture.js"

/** Execute the installed production port, using the public V1 SDK and a malicious local tool response. */
export async function verifyV1Generation(
  installed: string,
  baseUrl: string,
  directory: string,
  provider: Awaited<ReturnType<typeof nativeProviderFixture>>,
  root: string,
) {
  const production: typeof import("../src/hosts/v1-generation.js") =
    await import(
      pathToFileURL(path.join(installed, "dist", "hosts", "v1-generation.js"))
        .href
    )
  const client = createOpencodeClient({
    baseUrl,
    directory,
    headers: {
      authorization: `Basic ${Buffer.from("opencode:kasper-sdk-isolated-fixture").toString("base64")}`,
    },
  })
  const target = path.join(directory, "forbidden-judge-write.txt")
  const owned: string[] = [],
    released: string[] = []
  const port = production.createV1Generation(client, {
    onOwned: (id) => owned.push(id),
    onReleased: (id) => released.push(id),
  })
  provider.respond({
    text: "",
    toolCalls: [
      {
        index: 0,
        id: "forbidden-write",
        type: "function",
        function: {
          name: "write",
          arguments: JSON.stringify({
            filePath: target,
            content: "FORBIDDEN_JUDGE_MUTATION",
          }),
        },
      },
    ],
  })
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
  let text: string | undefined, error: string | undefined
  try {
    text = await port.generate({
      prompt: "Return a JSON judge score. Never modify the project.",
      model: { providerID: "fixture", modelID: "judge" },
      purpose: "score",
      timeoutMs: 15000,
    })
  } catch (cause) {
    error = String(cause)
  }
  const evidence = {
    owned,
    released,
    text,
    error,
    providerReceipts: provider.receipts,
  }
  await writeFile(
    path.join(root, "v1-generation.json"),
    JSON.stringify(evidence, null, 2),
  )
  assert.equal(
    await readFile(target, "utf8").then(
      () => true,
      () => false,
    ),
    false,
    "judge must not mutate the project",
  )
  assert.ok(
    provider.receipts.length >= 1 && provider.receipts.length <= 2,
    "only intentional forced tool and terminal continuation calls expected",
  )
  assert.equal(
    Object.keys(provider.receipts[0].request.tools ?? {}).length,
    0,
    "judge provider request must expose no tools",
  )
  const transcript = JSON.stringify(
    provider.receipts.slice(1).map((receipt) => receipt.request.messages),
  )
  assert.ok(
    /denied|not available|unknown|invalid|not allowed|permission|disabled/i.test(
      transcript,
    ),
    "forced tool attempt must receive terminal denial evidence",
  )
  assert.equal(error, undefined, error)
  assert.equal(JSON.parse(text ?? "{}").overall_score, 0.8)
  assert.equal(owned.length, 1)
  assert.deepEqual(released, owned)
  const sessions = await client.session.list()
  assert.ok(
    !sessions.data?.some((session) => owned.includes(session.id)),
    "exact owned judge session must be removed",
  )
  return evidence
}
