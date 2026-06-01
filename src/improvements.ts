import { BACKUP_ENABLED, BACKUP_MAX_VERSIONS } from "./constants.js"
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
  return `AGENTS.md updated:\n> ${pending.reason.slice(0, 200)}\n\nRestore from .opencode/kasper/backups/ if needed${hint}`
}
