/**
 * Quick test script: sends a simple prompt to the configured scoring model
 * and logs the raw response. Run from the project root with opencode running
 * in the same workspace.
 *
 * Usage: opencode --eval "run this script: npx tsx scripts/test-prompt.mjs"
 * Or manually while opencode is running in another terminal.
 */

import { createClient } from "@opencode-ai/plugin"

const MODEL = process.env.SCORE_MODEL ?? "opencode/minimax-m2.5"
const PROMPT_TEXT =
  process.env.TEST_PROMPT ??
  'Reply with exactly: {"test": true, "message": "hello"}'

async function main() {
  console.log(`Model: ${MODEL}`)
  console.log(`Prompt: ${PROMPT_TEXT}\n`)

  const client = createClient()
  const session = await client.session.create({
    body: { title: "kasper-test-prompt" },
  })
  const sessionId = session.data?.id
  if (!sessionId) {
    console.error("Failed to create session")
    process.exit(1)
  }
  console.log(`Session: ${sessionId}`)

  // Parse model string
  const parts = MODEL.split("/")
  const providerID = parts[0]
  const modelID = parts.slice(1).join("/")

  // Test 1: With json_schema
  console.log("\n--- Test 1: With json_schema ---")
  try {
    const result1 = await client.session.prompt({
      path: { id: sessionId },
      body: {
        parts: [{ type: "text", text: PROMPT_TEXT }],
        model: { providerID, modelID },
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              test: { type: "boolean" },
              message: { type: "string" },
            },
            required: ["test", "message"],
          },
        },
      },
    })
    const text1 =
      result1.data?.parts
        ?.filter((p) => p.type === "text")
        ?.map((p) => p.text ?? "")
        ?.join("") ?? ""
    console.log(`Response length: ${text1.length}`)
    console.log(`Response: ${JSON.stringify(text1.slice(0, 500))}`)
  } catch (err) {
    console.error(`Error: ${err}`)
  }

  // Test 2: Without format forcing
  console.log("\n--- Test 2: Without format forcing ---")
  try {
    const result2 = await client.session.prompt({
      path: { id: sessionId },
      body: {
        parts: [{ type: "text", text: PROMPT_TEXT }],
        model: { providerID, modelID },
      },
    })
    const text2 =
      result2.data?.parts
        ?.filter((p) => p.type === "text")
        ?.map((p) => p.text ?? "")
        ?.join("") ?? ""
    console.log(`Response length: ${text2.length}`)
    console.log(`Response: ${JSON.stringify(text2.slice(0, 500))}`)
  } catch (err) {
    console.error(`Error: ${err}`)
  }

  // Cleanup
  await client.session.delete({ path: { id: sessionId } })
  console.log("\nSession deleted.")
}

main().catch(console.error)
