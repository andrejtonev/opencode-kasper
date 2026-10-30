import type { Plugin } from "@opencode/plugin/tui"
import type { CommandResult } from "./command-results.js"
import { kasperRpc } from "./v2-rpc.js"

export const KasperTui: Plugin.Definition = {
  id: "kasper",
  setup(context) {
    const lifetime = new AbortController()
    const rpc = context.client.rpc(kasperRpc)
    const shown = new Set<string>()
    const display = async (result: CommandResult) => {
      const location = context.location ?? context.data.location.default()
      const route = context.ui.router.current()
      if (
        lifetime.signal.aborted ||
        result.location !== location.directory ||
        route.type !== "session" ||
        result.sessionID !== route.sessionID ||
        shown.has(result.requestID)
      )
        return
      shown.add(result.requestID)
      const oldest = shown.values().next().value
      if (shown.size > 1000 && oldest) shown.delete(oldest)
      await context.ui.dialog.alert({
        title: `Kasper ${result.action} (${result.status})`,
        message: result.text,
      })
    }
    const unsubscribe = rpc.events.on(
      "result",
      (event) => {
        void display(event.data)
      },
      { signal: lifetime.signal },
    )
    context.keymap.layer(() => ({
      commands: [
        {
          id: "kasper",
          title: "Kasper",
          description: "Run Kasper directly without a chat turn",
          slash: { name: "kasper", arguments: true },
          run: async (input) => {
            const route = context.ui.router.current(),
              location = context.location ?? context.data.location.default()
            if (route.type !== "session") {
              await context.ui.dialog.alert({
                title: "Kasper",
                message: "Open a session before running Kasper.",
              })
              return
            }
            const request = {
              requestID: crypto.randomUUID(),
              sessionID: route.sessionID,
              location: location.directory,
              command: input ?? "status",
            }
            try {
              await display(
                await rpc.execute(request, {
                  location: { directory: location.directory },
                  signal: lifetime.signal,
                }),
              )
            } catch (error) {
              if (!lifetime.signal.aborted)
                await context.ui.dialog.alert({
                  title: "Kasper",
                  message: String(error),
                })
            }
          },
        },
      ],
    }))
    return () => {
      lifetime.abort()
      unsubscribe()
    }
  },
}
// The old loader also resolves ./tui. It requires tui(), while native V2 selects setup.
export default { ...KasperTui, tui: async () => ({}) }
