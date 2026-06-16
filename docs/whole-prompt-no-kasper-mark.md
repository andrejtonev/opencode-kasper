# Design note: no `<!-- kasper: ... -->` mark for whole-prompt rewrites

Status: open question / design intent (no implementation in this branch yet).

## Context

The `<!-- kasper: ISO -->` HTML comment in `## Kasper Inferred Instructions`
sections has a precise semantic: it identifies the timestamp at which a
**specific entry** (a single rule the user added) was appended to the section.

Each apply writes one such comment directly above the new entry. The most
recent comment's timestamp therefore also serves incidentally as a
"section last updated" marker, but the canonical meaning is per-entry.

## The problem

The "whole-prompt re-evaluation/update" flow — the one that takes the agent's
current prompt plus all accumulated kasper guidance and asks the LLM to
produce a fresh, consolidated prompt — does **not** add a `## Kasper Inferred
Instructions` section. It rewrites the whole file. Putting a `<!-- kasper:
... -->` comment at the top of a fully regenerated prompt would be misleading
because:

1. The mark's semantic is "this entry was added by kasper", not "this whole
   file was rewritten by kasper".
2. A whole-prompt rewrite is the agent's intent becoming the prompt — the
   user's `## Kasper Inferred Instructions` is being **absorbed** into the
   new prompt, not added to.
3. Rolling back via the existing `<!-- kasper-injected:begin/end -->` block
   logic (used for inline mode) wouldn't work because the comments are gone
   after the rewrite.

## Design intent

When the whole-prompt regen path is implemented:

- **No** `<!-- kasper: ISO -->` provenance comments anywhere in the new
  file. The user wrote it, the LLM produced it, kasper is just the conduit.
- **No** `<!-- kasper-injected:begin/end -->` markers either. Those are
  inline-mode artifacts and the whole-prompt path doesn't use inline mode.
- Backup before the rewrite: yes, exactly the same `backup("pre-rewrite")`
  path that `injectSection` uses today. The backup is the rollback mechanism,
  not the file-level mark.
- A log event `agent_prompt_rewritten` (or similar) emitted via
  `ctx.logger.log(...)` so the audit trail of who-asked-for-what lives in
  `state.json` — same as today.

## Code location (when implemented)

Likely a new method `AgentPromptManager.rewritePrompt(agentName, content)`
in `src/agent-prompts.ts` next to the existing `write()` and `injectSection()`
methods. The flow lives in `src/handlers.ts:1180 applyImprovement()` — a
new branch when `pending.rewrite_whole_prompt === true` (or whatever the
config flag ends up being).

## Open questions

1. Should the `## Kasper Inferred Instructions` section be stripped from the
   current prompt **before** sending it to the LLM, so the LLM regenerates
   the prompt without a stale section to absorb? (My instinct: yes, otherwise
   the LLM will keep the section verbatim and the rewrite won't actually
   consolidate.)
2. After the rewrite, the kasper state still has the old improvements
   recorded. Should the rewrite clear them? (My instinct: no — the audit
   trail in `state.json` is historical and shouldn't be mutable. But the
   weakness counts should reset, since the new prompt is supposed to fix
   the old weaknesses.)
3. Should there be a confirmation step ("this will replace your agent
   prompt entirely — continue?") or is silent rewrite OK?
