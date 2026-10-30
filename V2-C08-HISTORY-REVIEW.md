# C08: V2 durable history and shared evaluation

Implemented against the frozen installed `@opencode/plugin`, `@opencode/client`, and `@opencode/schema` **2.2.2**. No provider/model calls, host configuration changes, or ambient credential reads occurred.

## Contracts verified

- Official migration documentation: <https://github.com/anomalyco/opencode/blob/dev/services/www/src/docs/content/build/plugins/migrate-v1.mdx>. This moving documentation is contextual; installed 2.2.2 declarations and executable schemas are the implementation contract.
- Native `SessionDomain` now includes `list`, `get`, and `context`: `node_modules/@opencode/plugin/dist/effect/session.d.ts:182`. Unlike the previously reviewed 2.0.8 plugin, 2.2.2 supports native session enumeration.
- `context` returns durable `SessionMessage.Info` records (`@opencode/client/dist/effect/api/api.d.ts:314`), but remains the current compaction window rather than a complete archive. Historical requests cannot silently substitute this window.
- Complete public history is **top-level `message.list`**, not `session.message.list`: `@opencode/client/dist/effect/api/api.d.ts:1791`. It accepts ascending order, limit and cursor and returns next/previous cursors. Public JSON cursor fields can be `null`.
- Executable `@opencode/schema/dist/session-message.js` defines `user`, `assistant`, `agent-switched`, `compaction`, and `idle`; assistant tools contain their own `state` with `streaming`, `running`, `completed`, or `error`. Real schema decoding is used in tests and for archive JSON responses.
- Model references use `{ id, providerID }`; completed tools use `state.content`; failed tools use structured `state.error`. File results expose URI/MIME/name metadata and are never presented as observed file contents.

## Implementation

- `src/history-port.ts` exposes SDK-independent `HistoryPort`, `SessionDirectoryPort`, explicit coverage, source identity, and typed unsupported results.
- `src/v2-history.ts` normalizes actual durable records, builds native Effect access with cancellation, and reads explicitly supplied archives with bounded ascending pagination. It checks cursor loops, duplicate/order violations, malformed records, native/archive source identity, location, project, creation time, and execution changes during reading.
- `evaluateSession` loads either host history or V1 history, then calls the same `evaluateHistorySession` for complete turns, A-B-A segmentation, saved checkpoint checks and score commits. `evaluateSessions` exposes batch outcomes without interpreting UI strings.
- Current-window scoring is an explicit `purpose: "current"` request. Historical scoring defaults to requiring archive coverage. A missing saved checkpoint fails closed in either coverage mode.
- Actual terminal idle records close executions, including failures; streaming/running tools still block checkpoint advancement. Synthetic/system/compaction summary text never becomes a user request.
- Core instruction manager types now describe public structural surfaces, permitting V2 implementations without imitating private V1 manager fields.

## Trust and integration limits

`TrustedV2Archive.authenticated: true` is an **explicit caller-supplied connection assertion**, not automatic authentication discovery. The constructor requires the same explicit server URL, rejects embedded credentials/query/fragment secrets, and permits HTTPS or loopback HTTP. C10 must construct the client using explicitly provided connection credentials or an explicitly chosen trusted local connection. The port never guesses a URL or reads global credentials. Provenance is checked before archive message enumeration.

Native setup must supply `ctx.historyHost`; automatic scoring must pass `purpose: "current"`. C06 owns generation wiring, and C10 owns native setup/actions and connection construction. The V1 command hook's unsupported output interception remains a separate integration concern; this chunk does not claim zero model calls for V1 commands.

## Validation

- Frozen dependency installation succeeded without manifest changes.
- Full offline suite: **644 passed, 27 skipped, 0 failed**, 1461 assertions.
- Typecheck, build, lint and diff checks passed; lint retains two existing E2E suppression warnings.
- New checks cover actual SDK-schema fixtures, tool states/errors/file metadata, terminal executions, A-B-A boundaries, absent archive support, complete pagination, provenance failures, malformed responses, bounds/order/cursor loops, execution changes, native cancellation, and missing old checkpoints in a current window.

The separately committed C07 disposal fixup is `86944df6aa2bc3977bcdfbaebd5592f71d1dc403`; it is not part of the C08 implementation commit.
