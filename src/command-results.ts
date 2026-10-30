import { calendarDate, positiveInteger } from "./actions.js"
export interface CommandRequest {
  requestID: string
  sessionID: string
  location: string
  command: string
}
export interface CommandResult {
  requestID: string
  sessionID: string
  location: string
  action: string
  status: "ok" | "unsupported" | "failed" | "cancelled"
  text: string
  timestamp: number
}
const actions = new Set([
  "status",
  "history",
  "help",
  "score",
  "improve",
  "apply",
  "reset",
  "auto",
  "pause",
  "resume",
  "migrate",
  "config",
])
export function parseCommand(command: string): { action: string; arg: string } {
  const text = command.trim().replace(/^\/?kasper(?:\s+|$)/i, "")
  const action = text.split(/\s+/)[0]?.toLowerCase() || "status"
  const arg = text.slice(action.length).trim()
  if (!actions.has(action)) throw new Error(`Unknown Kasper action: ${action}`)
  if (text.length > 8000) throw new Error("Command exceeds the supported size")
  if (action === "apply" && arg && arg !== "all" && !/^[1-9]\d*$/.test(arg))
    throw new Error("Apply requires a positive integer or all")
  if (
    (action === "pause" ||
      action === "resume" ||
      action === "help" ||
      action === "config") &&
    arg
  )
    throw new Error(`${action} does not accept arguments`)
  if (action === "auto" && arg && arg !== "on" && arg !== "off")
    throw new Error("Auto requires on or off")
  if (action === "reset" && arg && arg !== "--force")
    throw new Error("Reset accepts only --force")
  if (action === "score") {
    const selector = arg.replace(/^session(?:\s+|$)/i, "")
    const last = selector.match(/^last\s+(\S+)$/i),
      since = selector.match(/^since\s+(\S+)$/i),
      range = selector.match(/^range\s+(\S+)\s+(\S+)$/i)
    if (last && !positiveInteger(Number(last[1])))
      throw new Error("Score count must be a finite positive integer")
    if (since && !calendarDate(since[1]))
      throw new Error("Invalid calendar date")
    if (range) {
      const start = calendarDate(range[1]),
        end = calendarDate(range[2])
      if (!start || !end || end < start)
        throw new Error("Invalid calendar date range")
    }
    if (/^(last|since|range)\b/i.test(selector) && !last && !since && !range)
      throw new Error("Invalid scoring selector")
  }
  if (
    (action === "improve" || action === "migrate") &&
    arg
      .split(/\s+/)
      .some(
        (token) =>
          token.startsWith("--") &&
          token !== (action === "improve" ? "--dry-run" : "--show"),
      )
  )
    throw new Error("Unknown command flag")
  return { action, arg }
}

/** Delivery replay is bounded and scoped to this host lifetime, never an action retry. */
export class CommandResults {
  private readonly entries = new Map<
    string,
    { binding: string; promise: Promise<CommandResult>; result?: CommandResult }
  >()
  private readonly expired = new Set<string>()
  constructor(
    private readonly executeAction: (
      request: CommandRequest,
      parsed: ReturnType<typeof parseCommand>,
    ) => Promise<
      Omit<
        CommandResult,
        "requestID" | "sessionID" | "location" | "action" | "timestamp"
      >
    >,
    private readonly maxResults = 100,
    private readonly maxRequests = 10000,
  ) {}
  execute(request: CommandRequest): Promise<CommandResult> {
    if (
      !request.requestID.trim() ||
      request.requestID.length > 160 ||
      !request.sessionID ||
      !request.location
    )
      return Promise.reject(
        new Error(
          "A bounded request ID, source session, and location are required",
        ),
      )
    const parsed = parseCommand(request.command)
    const binding = JSON.stringify([
      request.sessionID,
      request.location,
      request.command,
    ])
    const prior = this.entries.get(request.requestID)
    if (prior) {
      if (prior.binding !== binding)
        return Promise.reject(
          new Error(
            "Request ID is already bound to different command, session or location",
          ),
        )
      return prior.promise
    }
    if (this.expired.has(request.requestID))
      return Promise.reject(
        new Error(
          "Request result expired; this request ID cannot execute again",
        ),
      )
    if (this.entries.size + this.expired.size >= this.maxRequests)
      return Promise.reject(
        new Error(
          "Host request capacity reached; no additional actions are admitted",
        ),
      )
    const entry: {
      binding: string
      promise: Promise<CommandResult>
      result?: CommandResult
    } = {
      binding,
      promise: Promise.resolve().then(async () => {
        let result: Awaited<ReturnType<typeof this.executeAction>>
        try {
          result = await this.executeAction(request, parsed)
        } catch (error) {
          result = {
            status: "failed",
            text: error instanceof Error ? error.message : String(error),
          }
        }
        const receipt: CommandResult = {
          requestID: request.requestID,
          sessionID: request.sessionID,
          location: request.location,
          action: parsed.action,
          timestamp: Date.now(),
          ...result,
          text: result.text.slice(0, 64000),
        }
        entry.result = receipt
        this.trim()
        return receipt
      }),
    }
    this.entries.set(request.requestID, entry)
    return entry.promise
  }
  private trim(): void {
    for (const [id, entry] of this.entries) {
      if (this.entries.size <= this.maxResults) break
      if (!entry.result) continue
      this.entries.delete(id)
      this.expired.add(id)
    }
  }
  list(sessionID: string, location: string): CommandResult[] {
    return [...this.entries.values()].flatMap((entry) =>
      entry.result &&
      entry.result.sessionID === sessionID &&
      entry.result.location === location
        ? [entry.result]
        : [],
    )
  }
}
