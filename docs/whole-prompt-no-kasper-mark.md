# Design note: a third `agent_prompt_inject_mode` value for whole-prompt rewrite

Status: design + implementation plan. Tracks the new mode to be added to
the existing two-value enum in `src/types.ts:27` and `src/config.ts:48`.

## Context

The `agent_prompt_inject_mode` config flag (README.md:101, 165) currently
takes two values:

- **`section`** (default) — append to a `## Kasper Inferred Instructions`
  section. Visible. Per-addition `<!-- kasper: ISO -->` provenance comments
  (after the 1.1.2 fix). Accumulating.
- **`inline`** — append to the end of the file, wrapped in
  `<!-- kasper-injected:begin/end -->` markers. Invisible. Whitespace-
  normalized dedupe. Accumulating.

Both modes **append** to the prompt file. The user is adding a third mode
that does a **full rewrite** of the prompt, producing a fresh consolidated
prompt that absorbs the existing `## Kasper Inferred Instructions` section.

## The new mode: `whole`

When `agent_prompt_inject_mode = "whole"` is set, on each apply:

1. Read the current prompt file.
2. Strip the `## Kasper Inferred Instructions` section if present (so the
   LLM doesn't see its own prior guidance and keep it verbatim).
3. Call the LLM with a rewrite prompt: "given the current prompt and the
   new guidance to add, produce a fresh consolidated prompt that integrates
   the guidance naturally into the prompt's voice."
4. Write the result back as the new prompt file content, with:
   - **No** `<!-- kasper: ISO -->` provenance comments
   - **No** `<!-- kasper-injected:begin/end -->` markers
   - The LLM's output is the new file content as-is.
5. Backup before the rewrite (same `backup("pre-improvement")` path).
6. Log `agent_prompt_rewritten` to `kasper.log` with the agent name, the
   new guidance, and the LLM model used.

## Why no mark

The mark's semantic is "this entry was added by kasper at time T". A whole
file rewrite is the opposite — the whole file is now a single LLM-generated
artifact, not an accumulation of individually-marked entries. Putting a
mark at the top of a fully-regenerated file would be both wrong (the file
is not "an addition") and useless (the mark has nothing to point at).

The audit trail of who-asked-for-what still lives in `state.json`
(`recordImprovement` is called as today) and in `kasper.log`
(`agent_prompt_rewritten` event). The backup file is the rollback
mechanism, not a file-level mark.

## Config shape

Extend the zod schema in `src/config.ts:48`:

```ts
agent_prompt_inject_mode: z.enum(["section", "inline", "whole"]).default("section"),
```

And the type in `src/types.ts:27`:

```ts
agent_prompt_inject_mode: "section" | "inline" | "whole"
```

## Code location (when implemented)

`src/agent-prompts.ts`:
- Extend `AgentPromptManager.injectSection`'s `injectMode` parameter to
  accept `"whole"`.
- For `"whole"`, the section-mode branch (line 287) instead calls a new
  private method `rewritePrompt(agentName, content)` that does the LLM
  call and write.
- A new `promptBuilder.ts` (or just inside `agent-prompts.ts`) for the
  LLM call to keep it testable.

`src/handlers.ts`:
- Update the help text on line 1105 to document the new value.
- The build-apply-prompt guidance (line 1132) needs to mention the
  behavior change: in `whole` mode, kasper REWRITES the prompt file, so
  the LLM that produces the improvement should produce the full
  replacement text, not a small appendable chunk.

`src/evaluate.ts` and `src/improvements.ts`:
- No changes — they just pass the config flag through.

## Open questions

1. **What does the LLM rewrite prompt look like?** My draft: a system prompt
   that says "you are rewriting an agent prompt; the new guidance below
   must be integrated naturally; preserve the existing prompt's structure
   and voice unless the guidance requires a change." This is similar to
   how Anthropic's prompt improver works.
2. **Token cost.** A whole rewrite is far more expensive than an append
   (potentially 10–100× the tokens). Should we warn the user on first
   enable? Log a cost estimate?
3. **Model selection.** Should the rewrite use the same model as scoring,
   or a different (potentially stronger) one? The latter is safer for
   quality but adds a config knob.
4. **Section stripping.** Confirm: strip the entire `## Kasper Inferred
   Instructions` section before sending the prompt to the rewrite LLM.
   Otherwise the LLM will see its own prior guidance and keep it verbatim,
   which defeats the point of consolidation.
5. **Backup naming.** Use `pre-rewrite` instead of `pre-improvement` to
   make the audit log self-documenting.

## Test plan

- `tests/agent-prompts.test.ts`:
  - New `injectSection(..., "whole")` test that mocks the LLM and asserts
    the file is rewritten end-to-end with NO `<!-- kasper:` mark.
  - New migration test: existing `## Kasper Inferred Instructions`
    section in the source prompt is stripped before the LLM call.
- `tests/e2e/`:
  - New E2E test that exercises `/kasper apply` end-to-end with
    `agent_prompt_inject_mode = "whole"` and asserts the file has no
    kasper marks and the new guidance is integrated.
- `tests/config.test.ts`:
  - Schema validation: `agent_prompt_inject_mode` accepts the new value.
