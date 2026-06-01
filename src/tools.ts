import type { ToolDefinition } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import {
  applyImprovement,
  executeKasperHistory,
  executeKasperImprove,
  executeKasperReset,
  executeKasperScoreSession,
  executeKasperStatus,
  handleBatchScoreSession,
} from "./handlers.js"
import type { KasperContext } from "./types.js"

const $z = tool.schema

export function createKasperTools(
  ctx: KasperContext,
): Record<string, ToolDefinition> {
  return {
    kasper_status: tool({
      description:
        "Get the Kasper plugin's current status — aggregate scores, weaknesses with per-agent targeting, recent sessions, and improvement history. Use agent param for detailed per-agent breakdown (e.g., status agent build).",
      args: {
        agent: $z
          .string()
          .optional()
          .describe("Filter to a specific agent name for detailed breakdown"),
        limit: $z
          .number()
          .optional()
          .default(10)
          .describe("Number of recent sessions to show"),
      },
      execute: async (args, _toolCtx) => {
        const a = args as { agent?: string; limit: number }
        return executeKasperStatus(a, ctx)
      },
    }),
    kasper_improve: tool({
      description:
        "Get a numbered table of suggested improvements for AGENTS.md or agent prompts. AFTER calling this, show the user the table. Apply suggestions via /kasper apply <n>.",
      args: {
        agent: $z
          .string()
          .optional()
          .describe("Filter suggestions to a specific agent"),
        force: $z
          .boolean()
          .optional()
          .describe(
            "Show all weaknesses regardless of min observation threshold",
          ),
      },
      execute: async (args, _toolCtx) => {
        const a = args as { agent?: string; force?: boolean }
        return executeKasperImprove(a, ctx)
      },
    }),
    kasper_apply: tool({
      description:
        "Apply a pending Kasper improvement by its index number [N] from /kasper improve. This directly applies the improvement to AGENTS.md or the agent prompt file and resets the weakness counter.",
      args: {
        index: $z.number().describe("The [N] index from the improve list"),
      },
      execute: async (args, _toolCtx) => {
        const a = args as { index: number }
        const idx = a.index - 1
        if (idx < 0 || idx >= ctx.improvementsPending.length) {
          return `Invalid index ${a.index}. There are ${ctx.improvementsPending.length} pending improvements. Use /kasper improve to see the list.`
        }
        const [selected] = ctx.improvementsPending.splice(idx, 1)
        return applyImprovement(selected, ctx)
      },
    }),
    kasper_history: tool({
      description:
        "Get the full adherence history from the Kasper, including score trends and all improvements applied",
      args: {
        agent: $z.string().optional().describe("Filter to a specific agent"),
        limit: $z
          .number()
          .optional()
          .default(25)
          .describe("Max number of entries"),
      },
      execute: async (args, _toolCtx) => {
        return executeKasperHistory(
          args as { agent?: string; limit: number },
          ctx,
        )
      },
    }),
    kasper_score_session: tool({
      description:
        "Evaluate one or more sessions. Use session_id for a single session, or count to batch-score recent sessions, or since/range for date-based scoring.",
      args: {
        session_id: $z
          .string()
          .optional()
          .describe(
            "Single session ID to evaluate. Omit to evaluate the current active session.",
          ),
        count: $z
          .number()
          .optional()
          .describe(
            "Evaluate the last N sessions (e.g., 10). Mutually exclusive with session_id and since.",
          ),
        since: $z
          .string()
          .optional()
          .describe(
            "Evaluate sessions since this date (YYYY-MM-DD). Mutually exclusive with session_id and count.",
          ),
        until: $z
          .string()
          .optional()
          .describe(
            "End date for range scoring (YYYY-MM-DD). Only used with since.",
          ),
      },
      execute: async (args, _toolCtx) => {
        const a = args as {
          session_id?: string
          count?: number
          since?: string
          until?: string
        }
        if (a.count !== undefined) {
          return handleBatchScoreSession(a.count, undefined, undefined, ctx)
        }
        if (a.since) {
          const sinceDate = new Date(a.since)
          const untilDate = a.until ? new Date(a.until) : new Date()
          if (Number.isNaN(sinceDate.getTime())) {
            return `Invalid since date: ${a.since}. Use YYYY-MM-DD format.`
          }
          if (a.until && Number.isNaN(untilDate.getTime())) {
            return `Invalid until date: ${a.until}. Use YYYY-MM-DD format.`
          }
          return handleBatchScoreSession(undefined, sinceDate, untilDate, ctx)
        }
        return executeKasperScoreSession(a.session_id, ctx)
      },
    }),
    kasper_reset: tool({
      description:
        "Clear all kasper state — sessions, scores, rejected patterns, and pending improvements",
      args: {},
      execute: async (_args, _toolCtx) => {
        return executeKasperReset(ctx)
      },
    }),
  }
}
