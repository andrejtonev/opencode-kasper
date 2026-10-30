import { createServer, type IncomingMessage } from "node:http"

export interface ProviderReceipt {
  id: number
  path: string
  model: string
  request: Record<string, unknown>
  receivedAt: number
  responseAt?: number
  disconnectedAt?: number
  completed: boolean
}
export interface FixtureResponse {
  text: string
  delayMs?: number
  status?: number
  toolCalls?: Array<{
    index: number
    id: string
    type: "function"
    function: { name: string; arguments: string }
  }>
}

/** Local deterministic provider. Never proxies, resolves an external host or uses real credentials. */
export async function nativeProviderFixture() {
  const receipts: ProviderReceipt[] = []
  const responses: FixtureResponse[] = []
  const timers = new Set<ReturnType<typeof setTimeout>>()
  async function body(request: IncomingMessage) {
    let length = 0
    const chunks: Buffer[] = []
    for await (const chunk of request) {
      const buffer = Buffer.from(chunk)
      length += buffer.length
      if (length > 200000)
        throw new Error("Fixture request exceeds local evidence limit")
      chunks.push(buffer)
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("Fixture request must be an object")
    return parsed as Record<string, unknown>
  }
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      if (request.headers.authorization !== "Bearer kasper-local-fixture") {
        response.writeHead(401).end()
        return
      }
      const input = await body(request)
      if (input.model !== "judge" && input.model !== "work") {
        response.writeHead(400).end(
          JSON.stringify({
            error: { message: "Fixture model is not allowed" },
          }),
        )
        return
      }
      const receipt: ProviderReceipt = {
        id: receipts.length + 1,
        path: request.url,
        model: input.model,
        request: input,
        receivedAt: Date.now(),
        completed: false,
      }
      receipts.push(receipt)
      const next = responses.shift() ?? { text: "Local fixture completed." }
      response.on("close", () => {
        if (!receipt.completed) receipt.disconnectedAt = Date.now()
      })
      request.socket.on("close", () => {
        if (!receipt.completed) receipt.disconnectedAt ??= Date.now()
      })
      const timer = setTimeout(() => {
        timers.delete(timer)
        if (response.destroyed) return
        receipt.responseAt = Date.now()
        if ((next.status ?? 200) !== 200) {
          response
            .writeHead(next.status ?? 500, {
              "content-type": "application/json",
            })
            .end(
              JSON.stringify({
                error: { message: next.text, type: "fixture_error" },
              }),
            )
        } else if (input.stream === true) {
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
          })
          const chunk = (
            delta: Record<string, unknown>,
            finish_reason: string | null,
          ) => ({
            id: `fixture-${receipt.id}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: input.model,
            choices: [{ index: 0, delta, finish_reason }],
          })
          response.write(
            `data: ${JSON.stringify(chunk({ role: "assistant", content: next.text, ...(next.toolCalls ? { tool_calls: next.toolCalls } : {}) }, null))}\n\n`,
          )
          response.write(
            `data: ${JSON.stringify(chunk({}, next.toolCalls ? "tool_calls" : "stop"))}\n\n`,
          )
          response.end("data: [DONE]\n\n")
        } else {
          response.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              id: `fixture-${receipt.id}`,
              object: "chat.completion",
              created: Math.floor(Date.now() / 1000),
              model: input.model,
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: next.text },
                  finish_reason: "stop",
                },
              ],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 10,
                total_tokens: 20,
              },
            }),
          )
        }
        receipt.completed = true
      }, next.delayMs ?? 0)
      timers.add(timer)
    } catch (error) {
      response
        .writeHead(400, { "content-type": "application/json" })
        .end(JSON.stringify({ error: { message: String(error) } }))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string")
    throw new Error("No fixture listener")
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    receipts,
    respond(response: FixtureResponse) {
      responses.push(response)
    },
    async close() {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      })
    },
  }
}
