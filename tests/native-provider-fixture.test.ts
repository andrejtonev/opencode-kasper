import { expect, test } from "bun:test"
import { nativeProviderFixture } from "../scripts/native-provider-fixture.js"

test("local provider fixture records deterministic requests and accepts only explicit fixture models", async () => {
  const fixture = await nativeProviderFixture()
  try {
    fixture.respond({ text: "fixture score" })
    const response = await fetch(`${fixture.baseURL}/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer kasper-local-fixture" },
      body: JSON.stringify({
        model: "judge",
        messages: [{ role: "user", content: "evidence" }],
      }),
    })
    expect((await response.json()).choices[0].message.content).toBe(
      "fixture score",
    )
    expect(fixture.receipts).toHaveLength(1)
    expect(fixture.receipts[0].request.messages).toEqual([
      { role: "user", content: "evidence" },
    ])
    expect(fixture.receipts[0].completed).toBe(true)
    const denied = await fetch(`${fixture.baseURL}/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer kasper-local-fixture" },
      body: JSON.stringify({ model: "external-model" }),
    })
    expect(denied.status).toBe(400)
    expect(fixture.receipts).toHaveLength(1)
  } finally {
    await fixture.close()
  }
})

test("client abort is recorded separately from whether the local provider completed", async () => {
  const fixture = await nativeProviderFixture()
  try {
    fixture.respond({ text: "late", delayMs: 100 })
    const controller = new AbortController()
    const pending = fetch(`${fixture.baseURL}/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer kasper-local-fixture" },
      body: JSON.stringify({ model: "judge" }),
      signal: controller.signal,
    }).catch((error: unknown) => error)
    while (!fixture.receipts.length) await Bun.sleep(1)
    controller.abort()
    await pending
    expect(fixture.receipts[0].completed).toBe(false)
    await Bun.sleep(120)
    expect(fixture.receipts).toHaveLength(1)
    expect(
      fixture.receipts[0].disconnectedAt !== undefined ||
        fixture.receipts[0].completed,
    ).toBe(true)
  } finally {
    await fixture.close()
  }
})
