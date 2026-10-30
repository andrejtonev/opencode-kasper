import { writeFile } from "node:fs/promises"

export default {
  id: "kasper.sdk-host-fixture",
  async tui() {
    await writeFile(
      `${process.env.KASPER_SDK_REPORT_PATH}.tui`,
      JSON.stringify({ entrypoint: "legacy-tui", loaded: true }),
    )
    return {}
  },
  async setup(context) {
    await writeFile(
      `${process.env.KASPER_SDK_REPORT_PATH}.tui`,
      JSON.stringify({
        entrypoint: "native-tui",
        loaded: true,
        version: context.app.version,
      }),
    )
    return () => {}
  },
}
