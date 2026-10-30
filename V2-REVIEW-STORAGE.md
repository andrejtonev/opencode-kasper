# V2 review: persistence, instruction editing and configuration

Reviewed 2026-10-30. Tasks correspond to rows 3, 8, 9 and 11 in `V2-MIGRATION.md`. No production source, manifests or STM files were changed. No model requests or native V2 acceptance were run.

## Grounding and versions

- Installed SDK inspected read-only: `../opencode-short-term-memory/node_modules/@opencode/plugin/package.json:4`, version **2.0.8**. `dist/promise/plugin.d.ts:26-62` declares `location`, `options`, domains, and setup cleanup; there is no mutable global host-config hook. `dist/promise/agent.d.ts:5-15` declares agent transforms and `reload()`. `../opencode-short-term-memory/node_modules/@opencode/schema/dist/agent.d.ts:10-88` declares `Agent.Info`, including optional `system`, with **no editable source/provenance field**. STM is corroboration, not the API authority.
- Official V2 docs/source pinned to upstream `anomalyco/opencode` **92b2ca0dd727942e00aba3523ed141d53e78ea28**, observed 2026-10-30. The coordinator verified its plugin package version is **2.2.2**, distinct from the installed **2.0.8** declarations. This development snapshot must be checked against the selected native host before parity claims.
- [Official migration guide](https://github.com/anomalyco/opencode/blob/92b2ca0dd727942e00aba3523ed141d53e78ea28/services/www/src/docs/content/build/plugins/migrate-v1.mdx): context location is the loaded plugin location, not necessarily every observed session's location; transforms must be synchronous, replayable and free of one-time effects; external data should load before registration and be refreshed before domain reload. Plugin storage is durable and ID-scoped. Dual `{server, setup}` object export needs V1 **1.18.29+**, so it is not suitable for the currently observed V1 1.18.23 without separate entrypoints or a changed minimum version.
- [V2 instructions](https://github.com/anomalyco/opencode/blob/92b2ca0dd727942e00aba3523ed141d53e78ea28/services/www/src/docs/content/instructions.mdx#L19), [V2 agents](https://github.com/anomalyco/opencode/blob/92b2ca0dd727942e00aba3523ed141d53e78ea28/services/www/src/docs/content/agents.mdx#L50), [V2 config](https://github.com/anomalyco/opencode/blob/92b2ca0dd727942e00aba3523ed141d53e78ea28/services/www/src/docs/content/config.mdx#L71).
- Public V1 docs fetched successfully: [rules](https://opencode.ai/docs/rules/), [agents](https://opencode.ai/docs/agents/), [config](https://opencode.ai/docs/config/). Their V1 shapes corroborate `agent.<name>.prompt`, file substitution and CLAUDE fallback; do not substitute the older REST SDK `/v2` documentation for the native `@opencode/plugin` V2 contract.

## Task 3: state, backups, locking, rollback and expiry

**Verdict: feasible shared core, but the guide's “Low” difficulty underestimates safety repairs already needed in V1. Reuse the data model and pure operations; do not carry forward all mutation behavior unchanged.**

V1 flow: startup selects `<cwd>/.opencode/kasper` or `state_dir` (`src/index.ts:275-284`), initializes state and managers, and records improvements after file writes (`src/improvements.ts:49-63`, `:91-102`). State changes debounce for two seconds, acquire a disk lock, merge external state, then write a snapshot (`src/state.ts:884-958`). Markdown operations take disk locks around read/update/backup/write (`src/agents-md.ts:108-119`, `src/agent-prompts.ts:413-452`). Pure guidance formatting, hashes and aggregation can remain host independent.

Concrete gaps:

1. **Expiry resurrects records and does not remove guidance.** Expiry is invoked after evaluation (`src/evaluate.ts:354-357`), but filters only `improvements_applied` (`src/state.ts:358-365`). The next flush imports IDs absent in memory from disk (`src/state.ts:967-990`). A controlled probe removed one expired record, then flush restored its ID. File guidance is untouched. Durable tombstones/status transitions are needed; define whether expiry means disabling guidance or just archival. Do not claim existing expiry removes instructions.
2. **Cached config overrides lose edits and have no backup/rollback.** `AgentPromptManager.backup()` returns undefined for config targets (`src/agent-prompts.ts:268-280`), while `injectSection()` says it backs up config (`:375-378`). Rollback returns false (`:294-299`). `appendToPluginOverridePrompt()` rereads the config but derives the new value from cached `source.value`, not the freshly parsed field (`src/agent-prompt-resolver.ts:771-836`); locking only the final atomic write does not protect the read-modify-write operation. A probe overwrote an external update. Fix this before considering those layouts supported.
3. **Age-only lock reclamation can break mutual exclusion.** `src/lock.ts:3-5`, `:25-33`, `:39-46` reclaim a lock after 30 seconds solely by mtime and release by unlinking its path regardless of owner. An active old owner can later delete a replacement owner's lock. Keep commit sections short and free of model/network work; use owner tokens, safe lease renewal and ownership-checked release. Age alone cannot establish a dead owner.
4. **State merge is additive, not a full conflict protocol.** `src/state.ts:973-990` imports only missing session IDs and improvements, so same-session newer checkpoints do not reconcile and removals can reappear. Rejected-pattern removals have the same union risk (`:994-998`). Use a bounded revision/tombstone-aware repository or explicit single-writer ownership per canonical scope. Do not introduce a general CRDT framework for this small state model.
5. **Reload does not refresh constructor-based policy.** `recordImprovement()` and guidance budget use `configDefaults` (`src/state.ts:350-370`); `reloadConfig()` only replaces `state.config` (`:552-555`). `state_dir` is startup-only although refreshed config is accepted (`src/index.ts:278-284`, `:412-414`). Make fields explicitly live or restart-required and use one authoritative effective config for live policy.
6. **Rollback identifies the current agent name, not the original source.** Agent backups are bucketed by sanitized name (`src/agent-prompts.ts:245-247`) and rollback resolves the current source (`:289-290`), so a changed source can receive another file's snapshot. Rules backup buckets sanitize paths (`src/agents-md-resolver.ts:253-278`), which is readable but not collision-proof. Store canonical target hash plus exact target locator and improvement ID; rollback the recorded target, checking its post-apply hash. Full-file restore can otherwise erase unrelated later edits.
7. **Atomic write has limits.** `src/prompt-utils.ts:89-111` uses temp-file fsync and rename, but Windows EPERM/EBUSY fallback directly overwrites the destination (`:118-123`) and can leave a temp file after success. `withPathWriteLock()`'s map stores `prev.then(() => next)` but compares it with `next` on cleanup (`:62-75`), so entries are retained. Fix bookkeeping and explicitly report fallback durability rather than promise crash-atomic behavior. Atomic writing does not make a read/modify/write transaction atomic.
8. **Mutable target during awaited work.** `AgentsMdManager.lockedUpdate()` computes lock path first, then uses mutable `agentsMdPath` after awaits (`src/agents-md.ts:108-117`). Config reload can call `setResolvedPath()` concurrently. Snapshot target and backup directory into the transaction before awaiting; never write a different target under an old target's lock.

V2 choice: keeping the explicit filesystem repository initially gives V1/V2 format continuity and backups users can inspect. `ctx.storage` is suitable for plugin-owned bookkeeping, but the declared `get/set/delete/keys` API is not evidence of transactional compare-and-swap. Do not move a multi-writer state document there and assume concurrency solved. Do not duplicate authoritative state between filesystem and host storage.

## Task 8: AGENTS.md improvements

**Verdict: supported in V2, but instruction discovery requires a separate adapter. Portable writes alone do not preserve correct scope or prove refresh.**

Current resolver returns the first existing explicit/local AGENTS or CLAUDE, then a global fallback (`src/agents-md-resolver.ts:103-239`). This can write a global file when a project has none, and its first-match result is not the set of effective instructions. `src/improvements.ts:84-115` applies a managed section without verifying that the host consumes that file in the scored session.

Official V2 differs materially:

- `instructions.mdx:19-42`: loads global and all eligible upward `AGENTS.md` files; **V2 has no CLAUDE.md fallback**. Workspace/project/home boundaries and `OPENCODE_DISABLE_PROJECT_CONFIG` matter.
- `instructions.mdx:47-76`: nested files load as the agent explores; configured instructions add further files/globs/URLs. One selected write target cannot stand for the whole effective set.
- `instructions.mdx:80-97`: ambient edits are detected before the next model request and emitted as instruction updates; transient read failures preserve prior guidance. Configured local files also update (`:126`), while newly matching glob files wait for config changes.
- [Official instruction discovery source](https://github.com/anomalyco/opencode/blob/92b2ca0dd727942e00aba3523ed141d53e78ea28/packages/core/src/instruction-discovery.ts#L80): explicit file identities/change rendering; inspect actual durable instruction-update records in native acceptance.

Design: `InstructionCatalog` returns effective sources separately from an explicit mutation target. Default project improvements to a project-owned `AGENTS.md` whose applicability is verified for the invoking session location. Never select a global write target merely because it is first/only effective guidance. External/global configured targets can be supported when explicitly selected; preserve the session scope recorded when the improvement was queued. Return `{written, refresh: pending|confirmed|restartRequired}` instead of equating a successful file write with active guidance. No model request should be added solely to prove refresh.

## Task 9: per-agent prompt improvements

**Verdict: possible for known editable sources; arbitrary plugin-defined effective text cannot safely be mapped back to a file using current APIs. High difficulty is justified.**

Current V1 flow: `resolveAgentPromptSource()` searches the first project and global host configs, reads `agent.<name>.prompt`, then conventional files, generic plugin JSON overrides and custom paths (`src/agent-prompt-resolver.ts:632-733`). Manager caches the result for 30 seconds (`src/agent-prompts.ts:121-140`), refuses replacement-inline writes, permits append overrides, and creates a conventional markdown file for missing sources (`:219-239`, `:360-447`). Built-in missing prompts are rerouted to project rules (`src/improvements.ts:15-35`). `materializeInlinePrompt()` and plugin materialization create a file then rewrite config using V1 keys (`src/agent-prompt-resolver.ts:862-999`); existing destination files are preserved even if their contents differ from the effective inline prompt.

Official V2 grounding:

- `agents.mdx:40-55` supports nested IDs such as `team/reviewer` and Markdown body as `system`; `:228-238` describes native `agents.<id>.system`. Current slash sanitization flattens nested IDs, so it cannot be the V2 source resolver.
- [Agent config implementation](https://github.com/anomalyco/opencode/blob/92b2ca0dd727942e00aba3523ed141d53e78ea28/packages/core/src/config/plugin/agent.ts#L94) merges documents and changes `agent.system` only when a source specifies it (`:114`). A markdown file can update an existing/built-in agent; do not carry the V1 “dead built-in file” comment forward as a V2 fact.
- Same source watches config and agent files, debounces 100 ms and reloads agent catalog (`:55-80`). Merely calling public `ctx.agent.reload()` does not prove a private config plugin has reread captured source documents first; wait for normal watcher/catalog refresh and confirm resulting effective system. Use an explicit owned transform to refresh Kasper overlays.
- `Agent.Info.system` is effective text without origin. Third-party transforms can replace/remove earlier results. Equality of effective text and a candidate file is insufficient provenance.

Recommended source contract:

```ts
type EditableInstruction =
  | { kind: "markdown"; canonicalPath: string; bodyRange: [number, number]; scope: Scope; revision: string }
  | { kind: "jsonc"; canonicalPath: string; jsonPath: readonly string[]; scope: Scope; revision: string }
  | { kind: "kasper-overlay"; agentID: string; scope: Scope; revision: string }
  | { kind: "readonly"; reason: "builtin" | "plugin" | "remote" | "managed" | "ambiguous" };

interface ResolvedInstructions {
  agentID: string;
  effectiveHash: string;
  sources: readonly SourceDescriptor[];
  editable: EditableInstruction;
}
```

Host adapters supply verified source maps for their exact config/discovery versions. JSON locators record exact native key (`agents/<id>/system`) or V1 key, never locate by display-name prefix or matching value. Known third-party plugins need an explicit resolver extension with a supported schema and refresh contract; scanning every `.opencode/*.json[c]` for a matching `agent` map is not proof the host uses it.

For builtin/plugin-only agents, a reusable V2 fallback is a **Kasper-owned append overlay**, persisted by stable agent ID, applied through a cheap `ctx.agent.transform()` or narrowly scoped session context hook. Preserve base system text; do not replace it with only inferred guidance, materialize factory prompts into user config, or reroute agent-specific guidance to project-wide instructions silently. A context overlay must apply only to intended normal agent requests and exclude judge/merge sessions. Validate transform order and refresh using the actual host; an overlay is a supported design option, not established feature parity yet.

Migration is an explicit operation: read current proven source under lock, refuse an existing destination whose contents differ, preserve markdown metadata, back up source/config, write destination exclusively, then change the exact config pointer. Record both files in a small recoverable journal; two individually atomic writes do not make a two-file transaction. Global configs must not be redirected to a project-local file without an explicit chosen scope. Generic plugin `{file:...}` substitution support cannot be assumed from OpenCode host substitution.

## Task 11: configuration

**Verdict: standalone `kasper.json/jsonc` is feasible and preferable; existing config load/reload needs correction and V2 discovery must be explicit.**

Current merge is candidate global directories, `OPENCODE_CONFIG_DIR`, first upward `.opencode/kasper` and finally direct `directory/opencode.json.kasper` (`src/config.ts:128-205`); cache lasts 30 seconds. It does not load legacy `opencode.jsonc.kasper` or all layered project configs. Runtime reload changes scorer/config/resolver inputs (`src/index.ts:405-427`), but normalizer schema omits **both `prompt_paths` and `agents_md_paths`** (`src/config.ts:23-48`) although the types and reload code use them (`src/types.ts:35-49`). A probe confirms both fields normalize to `{}`. Existing B4 tests inject manager inputs directly, so they do not prove configuration-file end-to-end behavior.

[V2 config discovery](https://github.com/anomalyco/opencode/blob/92b2ca0dd727942e00aba3523ed141d53e78ea28/packages/core/src/config/discovery.ts#L66) has system/global/explicit/direct/project sources, resolves symlink aliases and excludes global roots from project walk. `config.mdx:78-106` describes all direct files first, then `.opencode` configs. This differs from Kasper's first-found resolver. Keep the plugin's own documented merge independent of the host schema, but use authoritative host location and distinguish machine/global/project policy.

The guide's “strict host config schema” is too broad if it means every unknown key is rejected: pinned V2 [`normalize.ts:44`](https://github.com/anomalyco/opencode/blob/92b2ca0dd727942e00aba3523ed141d53e78ea28/packages/core/src/config/normalize.ts#L44) sets `onExcessProperty: "ignore"` and constructs recognized native fields. A custom `kasper` key is not a supported plugin option transport and can be discarded. V2-native plugin options are `ctx.options` under `plugins[].options`; specify precedence with standalone files instead of relying on undeclared host keys. Native host behavior still needs version-specific verification.

Balanced approach: retain standalone files as authoritative user configuration; optionally accept declared `ctx.options` as an installation override with documented precedence. Validate arrays, reject/report parse errors (current parsers collect JSONC errors without checking them), bound values, and publish the exact effective config plus origin paths. Validate `state_dir` as restart-required; live-update timers and budgets only via an immutable effective-config snapshot. Discovery rescans/invalidation must cover additions, removals, environment/path changes and file edits. `ensureDefaultKasperConfigFile()` (`src/config.ts:210-267`) should use exclusive creation rather than check-then-overwrite during concurrent startup.

## Reusable mutation boundary

Use one `InstructionEditor` for markdown, JSONC and overlay changes, with pure planning and one short commit method. Resolve the invoking session location first. A plan records target identity, current revision, exact before/after bytes, improvement ID and intended refresh scope. At commit, canonicalize paths and symlinks, lock exact targets in stable order, reread, compare revision, create exact-byte backups, perform the bounded write, record commit/journal state, release, then wait for or report refresh. On revision conflict, regenerate a deterministic append plan or return a conflict; never overwrite the user's newer content using cached text.

Do not hold locks while scoring/generating, awaiting providers, or waiting for reload. Durable improvement states should be `pending -> applying -> applied -> expired|rolledBack|rejected`, with idempotent IDs and target revisions. Persist deletes/transitions so merge cannot resurrect them. Prefer removing the precise owned block by ID for rollback/expiry; whole-file restoration is an explicit recovery operation with revision checks. Preserve audit/backup records until retention removes them intentionally. Hashes are consistency checks, not authentication of untrusted persisted data.

## Verification performed and remaining gates

Executed with Bun 1.3.13, frozen root dependencies installed by coordinator:

```text
bun test tests/state.test.ts tests/lock.test.ts tests/prompt-utils.test.ts tests/config.test.ts 
  tests/agents-md.test.ts tests/agents-md-resolver.test.ts tests/agent-prompts.test.ts 
  tests/agent-prompt-resolver.test.ts tests/b4-regression.test.ts
259 pass, 0 fail, 586 expect calls, 9 files, 3.63 seconds
```

Temporary isolated probe output (only fresh OS temp files; directory cleaned):

```text
normalized-paths {}
stale-override-write {"agents":{"reviewer":{"prompt_append":"ORIGINAL\n\nKASPER RULE\n"}}}
override-backup undefined
override-rollback false
expired-removed 1 0
expired-after-flush [ "expired" ]
```

The override was externally changed from ORIGINAL to EXTERNAL UPDATE after resolution; the write erased that update. Expiry was exercised against an already flushed improvement. These are reproducible V1 baseline defects, not V2 runtime failures.

To reproduce the config-field omission without creating files, from the repository root:

```powershell
bun -e 'import { normalizeKasperConfig } from "./src/config.ts"; console.log(normalizeKasperConfig({prompt_paths:["./custom"], agents_md_paths:["./rules"]}))'
```

To reproduce stale append without touching user files, execute this with Bun from a temporary script, replacing `repo` with the absolute checkout directory:

```ts
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const { appendToPluginOverridePrompt } = await import("./src/agent-prompt-resolver.ts");
const temporary = await mkdtemp(join(tmpdir(), "kasper-review-"));
try {
  const configPath = join(temporary, "plugin.json");
  await writeFile(configPath, JSON.stringify({agents:{reviewer:{prompt_append:"EXTERNAL UPDATE"}}}));
  await appendToPluginOverridePrompt({kind:"plugin_override", agentName:"reviewer",
    target:"config", value:"ORIGINAL", configPath, promptField:"prompt_append", isAppend:true}, "KASPER RULE");
  console.log(await readFile(configPath, "utf8"));
} finally { await rm(temporary, {recursive:true, force:true}); }
```

Existing tests verify happy-path backups, lock exclusion/timeouts, shared formatting and resolver heuristics, but do not prove host discovery, instruction effectiveness, multi-process conflicts or native refresh. Required additional acceptance: two independent processes append to one rules/config file without losses; stale owner cannot unlock a successor; source changes between propose/apply do not redirect edits; expiry survives restart and removes only owned guidance if that is the chosen contract; rollback preserves unrelated later edits; live config files actually pass path settings through normalizer; system/managed/plugin-only sources remain read-only; V2 nested agent IDs and workspace moves preserve scope; global/local ambient and agent-system refresh are observed without extra model diagnostics. Until those pass, this is a grounded feasible design with explicit gaps, not a validated V2 implementation.
