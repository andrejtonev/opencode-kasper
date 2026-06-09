import {
  BACKUP_ENABLED,
  BACKUP_MAX_VERSIONS,
  isBuiltinAgentName,
} from "./constants.js"
import type { ImprovementRecord, KasperContext } from "./types.js"
import { showToast } from "./utils.js"

/**
 * Canonical improvement application. Used by both manual `/kasper apply`
 * and auto-update flows to ensure consistent behaviour.
 */
export async function applyImprovement(
  pending: ImprovementRecord,
  ctx: KasperContext,
): Promise<string> {
  const patterns = pending.weaknesses ?? [pending.reason]

  if (pending.target === "agent_prompt" && pending.agent_name) {
    // Built-in opencode agents (build, plan, general, ...) have hard-coded
    // prompts shipped with opencode. `.opencode/agents/<name>.md` is only
    // consulted when `agent.<name>.prompt` in `opencode.json` is set to a
    // `{file:...}` directive or inline string. If a built-in agent has no
    // defined prompt, creating a markdown file at the conventional path
    // produces a dead file that opencode never reads. Reroute the
    // improvement to AGENTS.md in that case — built-in agents always
    // honour the project rules file.
    const source = await ctx.agentPrompts.resolve(pending.agent_name)
    if (source.kind === "missing" && isBuiltinAgentName(pending.agent_name)) {
      const rerouted: ImprovementRecord = {
        ...pending,
        target: "agents_md",
      }
      return applyAgentsMdImprovement(rerouted, patterns, ctx, {
        rerouteNote: `Rerouted from agent_prompt:"${pending.agent_name}" — built-in agent has no defined prompt; improvement applied to AGENTS.md instead.`,
      })
    }

    const promptExisted = await ctx.agentPrompts.exists(pending.agent_name)

    let agentMode = "subagent"
    for (const [, info] of ctx.agentRegistry) {
      if (info.agentName === pending.agent_name) {
        agentMode = info.agentType === "primary" ? "primary" : "subagent"
        break
      }
    }

    const backupPath = await ctx.agentPrompts.injectSection(
      pending.agent_name,
      "Kasper Inferred Instructions",
      pending.reason,
      BACKUP_ENABLED,
      BACKUP_MAX_VERSIONS,
      agentMode,
      ctx.config.agent_prompt_inject_mode,
    )
    ctx.stateStore.recordImprovement({
      ...pending,
      backup_path: backupPath ?? "",
    })
    ctx.stateStore.resetWeaknessCounts(patterns)

    const restartNote = promptExisted
      ? ""
      : "\n\n**Note**: Restart opencode for the new prompt file to take effect."
    showToast(
      ctx.client,
      "Kasper",
      `${pending.agent_name} agent prompt updated — restore from .opencode/kasper/backups/ if needed`,
      "success",
    )
    const remaining = ctx.improvementsPending.length
    const hint =
      remaining > 0
        ? `\n\nUse /kasper apply <n> to apply remaining (${remaining} pending).`
        : ""
    return `${pending.agent_name} agent prompt updated:\n> ${pending.reason.slice(0, 200)}\n\nRestore from .opencode/kasper/backups/ if needed${hint}${restartNote}`
  }

  return applyAgentsMdImprovement(pending, patterns, ctx)
}

async function applyAgentsMdImprovement(
  pending: ImprovementRecord,
  patterns: string[],
  ctx: KasperContext,
  opts: { rerouteNote?: string } = {},
): Promise<string> {
  let backupPath = ""
  await ctx.agentsMd.lockedUpdate(async (existing) => {
    if (BACKUP_ENABLED) {
      backupPath = await ctx.agentsMd.backup("manual-apply")
    }
    return ctx.agentsMd.injectSection(
      existing,
      "Kasper Inferred Instructions",
      pending.reason,
    )
  })
  ctx.stateStore.recordImprovement({ ...pending, backup_path: backupPath })
  ctx.stateStore.resetWeaknessCounts(patterns)
  showToast(
    ctx.client,
    "Kasper",
    "AGENTS.md updated — restore from .opencode/kasper/backups/ if needed",
    "success",
  )
  const remaining = ctx.improvementsPending.length
  const hint =
    remaining > 0
      ? `\n\nUse /kasper apply <n> to apply remaining (${remaining} pending).`
      : ""
  const reroute = opts.rerouteNote ? `\n\n${opts.rerouteNote}` : ""
  return `AGENTS.md updated:\n> ${pending.reason.slice(0, 200)}\n\nRestore from .opencode/kasper/backups/ if needed${hint}${reroute}`
}
