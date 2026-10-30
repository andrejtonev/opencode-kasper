import { writeFile } from "node:fs/promises"

// A packaged legacy entry with no V2 runtime import. Never invokes a model.
export default async function legacy(_context) {
  const reportPath = process.env.KASPER_SDK_REPORT_PATH
  if (!reportPath)
    throw new Error("Native fixture report path was not explicitly supplied")
  await writeFile(
    reportPath,
    JSON.stringify({ entrypoint: "root-v1", loaded: true }),
  )
  return {}
}
