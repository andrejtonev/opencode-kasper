import type { AggregateStats, PerAgentStats } from "./types.js"
/** Pure bounded context renderer, used by both host adapters. */
export function renderCompactionFeedback(
  aggregate: AggregateStats,
  agentName?: string,
  agent?: PerAgentStats,
  maxChars = 4000,
): string {
  if (!aggregate.total_sessions) return ""
  const lines = [
    "## Kasper Feedback",
    `Overall adherence score: ${(aggregate.avg_score * 100).toFixed(0)}% across ${aggregate.total_sessions} session(s).`,
  ]
  for (const weakness of aggregate.top_weaknesses.slice(0, 3))
    lines.push(`- ${weakness.pattern.slice(0, 600)} (${weakness.count} times)`)
  if (agentName && agent?.total_sessions) {
    lines.push(
      `### ${agentName.slice(0, 100)} Agent Stats`,
      `Sessions: ${agent.total_sessions}, Avg Score: ${(agent.avg_score * 100).toFixed(0)}%`,
    )
    for (const weakness of agent.top_weaknesses.slice(0, 3))
      lines.push(
        `- ${weakness.pattern.slice(0, 600)} (${weakness.count} times)`,
      )
  }
  return lines.join("\n").slice(0, maxChars)
}
