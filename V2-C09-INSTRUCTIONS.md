# C09: native V2 instruction sources

Implemented against installed `@opencode/plugin`, `@opencode/client`, and
`@opencode/schema` **2.2.2**, with Effect **4.0.6**. Official source references
below are pinned to upstream commit
`92b2ca0dd727942e00aba3523ed141d53e78ea28`.

`src/hosts/v2-instructions.ts` exposes Promise ports; C10 owns their public Effect
bridge and supervised lifetime. No model call, diagnostic generation, external
instruction HTTP fetch, or host reload is performed by this adapter.

## Contracts and provenance

- `V2AgentCatalogPort.list/get` uses actual `Agent.ID` and the SDK's
  `Pick<Agent.Info, "id" | "system">`. Native nested IDs remain slash-preserving.
  `Agent.Info.system` is effective catalog text; it provides no origin metadata.
- `configEntries` supplies the authoritative ordered `Config.Entry[]` from the
  same host/location. SDK `config.get` exposes documents with optional paths and
  directories. No directory/merged-config heuristic replaces a missing port.
- `V2AgentPrompts.resolve` reads every relevant document/directory entry in order.
  Directory entries inspect sorted `agent/agents` Markdown, then `mode/modes`
  Markdown; nested mode paths are excluded. Native Markdown body replaces its
  frontmatter `system`. Frontmatter parsing uses gray-matter and the host's
  unquoted-colon fallback. Unresolved legacy conversions and invalid/disabled
  documents conservatively block source attribution.
- Editing requires `editableAgents[id] = {path,jsonPath?}` to name the exact
  canonical source, agreement with effective catalog text, and complete layer
  resolution. A second resolution inside the transaction rejects changed
  precedence. Text equality alone never grants editability. The default is
  read-only; unavailable agent IDs return `unknown`, avoiding V1's `missing`
  built-in reroute heuristic.
- Config targets use exact `['agents', id, 'system']` JSON pointers. Virtual,
  transformed, substituted `{file:...}`/`{env:...}`, plugin-only, or mismatched
  sources stay read-only. These may be scored from catalog text when available.
- `overlays[id]` explicitly names a Kasper-owned file inside `stateDir`.
  `loadV2AgentOverlays` returns a typed immutable-by-contract snapshot for C10 to
  replay synchronously in `agent.transform`, **appending** to factory system.
  Writing an overlay never writes the factory prompt. A missing catalog system
  is incomplete coverage because provider-selected fallback text is not exposed.

## Applicable guidance and mutation boundary

`readV2ApplicableInstructions` returns `{text,complete,issues,sources,activation}`.
It reads global AGENTS first when enabled, then nearest-first ancestor AGENTS.
For workspaces under home, ascent stops at home; outside home it stops at project
root. Outside the project only global discovery applies. It does not read
CLAUDE.md. Canonical paths deduplicate physical files.

Configured `instructions` are collected from every ordered document. Relative
patterns search workspace to project root; with project discovery unavailable,
they resolve against global config when enabled. Absolute and `~/` patterns are
supported. Pinned glob 13.0.5 uses host options `absolute:true,dot:true,nodir:true,
follow:false`; each pattern's combined matches are sorted across ancestors.
Missing literal files are skipped, while unreadable sources and failed discovery
produce explicit incomplete coverage. Remote text comes only from an optional
host-cache port; an unavailable remote source is incomplete, never fetched again.

`V2AgentPrompts.readCoverage(id)` combines catalog system and applicable guidance.
C10 should expose partial scoring honestly and disable automatic proposals and
guidance writes when this snapshot is incomplete. Both manager write paths
already reject incomplete applicable guidance; per-agent writes additionally
require complete agent coverage. The shared AGENTS port cannot identify a
session's active agent itself, so C10 must check that agent's coverage as well.

`createV2AgentsMd` satisfies the shared structural manager surface. Scoring
`read()` returns combined guidance; `lockedUpdate`, `backup`, and `applyGuidance`
operate only on `<directory>/AGENTS.md` after canonical project ownership checks.
The combined scoring read is never fed back into a file mutation. No global
fallback write occurs. Native resolver targets remain fixed by explicit options.

All mutations reuse C04's canonical source lock, exact revision check, durable
before-byte backup/receipt, guarded atomic rename, and source-keyed rollback.
Markdown writes modify the body while preserving original frontmatter bytes;
JSONC writes preserve unrelated fields and comments. A post-discovery lifecycle
guard runs immediately before actual atomic replacement. Backup retention errors
are recorded separately so they cannot hide a successfully committed write.
Expiry remains active metadata retention; no guidance deactivation is claimed.

## Refresh and practical limits

Agent writes/rollback set `refreshStatus[id] = 'pending'`.
`confirmRefresh(id, expectedText)` confirms only after a fresh actual catalog read
matches expected effective text. Calling `agent.reload` would only request replay
of cached transform data; this adapter never equates that request with activation.
AGENTS mutations remain pending. Every guidance snapshot reports
`activation:'unconfirmed'`: fresh disk discovery does not prove a cached host or
session has consumed it. Already-loaded nested instructions can remain cached;
new glob matches can await config change. Provider defaults, session entries,
MCP/skills and instruction transforms are outside this source snapshot's stated
ambient/configured scope; no claim of complete final model context is made.

Locks coordinate participating Kasper writes. Concurrent external editors, host
watchers, and changes to different instruction files cannot be made one atomic
filesystem transaction. Revision/precedence checks bound stale-source writes;
C10 must retain lifecycle checks and explicit partial-coverage handling. Native
Windows literal/glob/space-path behavior is tested here. Network filesystem and
cross-platform casing behavior have not been qualified.

## Grounding

- [Config entry order and watched reload](https://github.com/anomalyco/opencode/blob/92b2ca0dd727942e00aba3523ed141d53e78ea28/packages/core/src/config.ts#L355): integration/well-known, global, explicit, direct project configs, project directories, virtual content, managed settings. The adapter consumes this order rather than reconstructing it.
- [Agent source loading, transforms and Markdown IDs/body](https://github.com/anomalyco/opencode/blob/92b2ca0dd727942e00aba3523ed141d53e78ea28/packages/core/src/config/plugin/agent.ts#L36).
- [Markdown YAML fallback](https://github.com/anomalyco/opencode/blob/92b2ca0dd727942e00aba3523ed141d53e78ea28/packages/core/src/config/markdown.ts#L5).
- [Instruction discovery/configured matching and host-cached remote text](https://github.com/anomalyco/opencode/blob/92b2ca0dd727942e00aba3523ed141d53e78ea28/packages/core/src/config/plugin/instruction.ts#L35).
- [Host glob options](https://github.com/anomalyco/opencode/blob/92b2ca0dd727942e00aba3523ed141d53e78ea28/packages/util/src/glob.ts#L14) and [upward matching](https://github.com/anomalyco/opencode/blob/92b2ca0dd727942e00aba3523ed141d53e78ea28/packages/util/src/fs-util.ts#L199).
- [Native instruction docs and nested reload limitation](https://github.com/anomalyco/opencode/blob/92b2ca0dd727942e00aba3523ed141d53e78ea28/services/www/src/docs/content/instructions.mdx).
- Installed SDK contracts: `@opencode/schema/dist/config.d.ts` (`Entry`/`Document`/`Directory`), `agent.d.ts` (`ID`/`Info.system`), `@opencode/client/dist/effect/api/api.d.ts` (`ConfigGetOutput`), and `@opencode/plugin/dist/effect/agent.d.ts` (`AgentEditor`, `transform`, `reload`).

Validation: **21 source regressions passed**; complete offline suite **650 passed,
27 skipped, 0 failed**. Build/typecheck passed. The source-specific Biome check
passed; repository lint retains two existing suppression warnings.
