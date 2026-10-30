import { execFileSync } from "node:child_process"

interface CurlOptions {
  input: string
  encoding: "utf8"
  timeout: number
  maxBuffer: number
  env: NodeJS.ProcessEnv
  windowsHide: boolean
}
export type CurlRunner = (
  executable: string,
  args: string[],
  options: CurlOptions,
) => string

/** Synchronous callers keep their API; credentials go only to a private stdin pipe. */
export function curlHTTP(
  url: string,
  auth: { username: string; password: string },
  statusOnly = false,
  run: CurlRunner = (command, args, options) =>
    execFileSync(command, args, options),
): string {
  const target = new URL(url)
  if (
    target.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
    target.username ||
    target.password
  )
    throw new Error("Test HTTP requests require a credential-free loopback URL")
  const args = [
    "--disable", // Disable inherited .curlrc before any other argument.
    "--silent",
    "--noproxy",
    "*",
    "--proto",
    "=http",
    "--max-time",
    "5",
    "--config",
    "-",
    "--url",
    target.href,
  ]
  if (statusOnly)
    args.push(
      "--output",
      process.platform === "win32" ? "NUL" : "/dev/null",
      "--write-out",
      "%{http_code}",
    )
  const input =
    auth.username && auth.password
      ? `header = "Authorization: Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}"\n`
      : ""
  const env: NodeJS.ProcessEnv = {}
  for (const name of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"])
    if (process.env[name]) env[name] = process.env[name]
  try {
    return run(process.platform === "win32" ? "curl.exe" : "curl", args, {
      input,
      encoding: "utf8",
      timeout: 6000,
      maxBuffer: 8 * 1024 * 1024,
      env,
      windowsHide: true,
    })
  } catch {
    // Subprocess errors can contain argv, server data or echoed stdin. Drop them.
    throw new Error("OpenCode test HTTP request failed")
  }
}
