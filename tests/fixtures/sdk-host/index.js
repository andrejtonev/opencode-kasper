import { writeFile } from "node:fs/promises"

// A packaged legacy entry with no V2 runtime import. Never invokes a model.
export default async function legacy(_context, options) {
  await writeFile(
    options.reportPath,
    JSON.stringify({ entrypoint: "root-v1", loaded: true }),
  )
  return {}
}
