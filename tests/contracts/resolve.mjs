import { Host } from "@opencode/plugin/host"

const resolved = Host.resolve({ directory: process.argv[2] })
const server = await Host.load(resolved.server)
console.log(
  JSON.stringify({
    entry: resolved.server,
    id: server.default.id,
    effect: typeof server.default.effect,
  }),
)
