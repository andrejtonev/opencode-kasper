import { afterEach, expect, test } from "bun:test"
import { type ChildProcess, spawn } from "node:child_process"
import { curlHTTP } from "./helpers/http-client.js"

let server: ChildProcess | undefined
afterEach(() => {
  if (server?.exitCode === null && server.signalCode === null) server.kill()
  server = undefined
})

test("credentials are stdin-only, and subprocess failure cannot echo them", () => {
  const auth = {
    username: "user",
    password: 'special"$(echo not-executed) & secret',
  }
  const encoded = Buffer.from(`${auth.username}:${auth.password}`).toString(
    "base64",
  )
  expect(() =>
    curlHTTP("http://127.0.0.1:1/", auth, false, (_exe, args, options) => {
      expect(args.join(" ")).not.toContain(auth.password)
      expect(args.join(" ")).not.toContain(encoded)
      expect(args[0]).toBe("--disable")
      expect(options.input).toContain(`Authorization: Basic ${encoded}`)
      expect(options.env.OPENCODE_SERVER_PASSWORD).toBeUndefined()
      expect(options.env.AZURE_OPENAI_API_KEY).toBeUndefined()
      throw new Error(`${options.input} ${auth.password}`)
    }),
  ).toThrow("OpenCode test HTTP request failed")
  expect(() => curlHTTP("https://foreign.invalid/", auth)).toThrow("loopback")
  expect(() => curlHTTP("http://user:secret@localhost/", auth)).toThrow(
    "credential-free",
  )
})

test("real curl authenticates special-character credentials without a shell", async () => {
  const auth = {
    username: "fixture",
    password: 'quotes" dollar$() & line\nend',
  }
  const expected = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`
  const env: NodeJS.ProcessEnv = { EXPECTED_AUTH: expected }
  for (const name of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"])
    if (process.env[name]) env[name] = process.env[name]
  server = spawn(
    process.execPath,
    [
      "-e",
      `
    const http = require('node:http');
    const server = http.createServer((request, response) => {
      const correct = request.headers.authorization === process.env.EXPECTED_AUTH;
      response.writeHead(correct ? 200 : 401, {'content-type':'application/json'});
      response.end(JSON.stringify({ authenticated: correct }));
    });
    server.listen(0, '127.0.0.1', () => console.log(server.address().port));
  `,
    ],
    { env, stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
  )
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Fixture startup timed out")),
      5000,
    )
    server?.once("error", reject)
    server?.stdout?.once("data", (chunk) => {
      clearTimeout(timer)
      resolve(Number(String(chunk).trim()))
    })
  })
  expect(JSON.parse(curlHTTP(`http://127.0.0.1:${port}/`, auth))).toEqual({
    authenticated: true,
  })
  expect(curlHTTP(`http://127.0.0.1:${port}/`, auth, true)).toBe("200")
})
