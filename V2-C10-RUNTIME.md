# C10 native setup and shared action boundary

The implementation compiles against pinned `@opencode/plugin`, `@opencode/client`, and `@opencode/schema` 2.2.2, with Effect 4.0.6. Public contracts are grounded in `V2-SDK-CONTRACTS.md`, `V2-GENERATION-CONTRACTS.md`, `V2-C08-HISTORY-REVIEW.md`, and `V2-C09-INSTRUCTIONS.md`; installed declarations are the executable contract. C11 separately qualifies the actual packed package on native hosts.

## Entry and lifecycle

`./server` exports the public native `{ id, effect }` object plus a lazy `server()` legacy entry. The pinned legacy 1.18.23 loader also prefers `./server`, so retaining only the root export would break package-name installation. C11 proved the dual object classifier on both actual hosts before this implementation. The root V1 function remains free of eager Effect/native imports; native setup does not construct a pretend V1 client.

`./tui` provides native `setup` plus a benign legacy `tui()` entry, with a type-only plugin import. The legacy loader shape is source-verified; C11 must qualify production TUI behavior. Exact ordinary runtime dependencies include client/schema because the native loader does not inject these packages.

Native setup captures Effect services, scopes the event fiber, and owns timers/actions/generation with the shared lifetime/revision runtime. Native session/history/catalog calls use the captured Effect runner. Per-event failure and logger rejection cannot terminate later routing. Unexpected subscription completion or failure aborts the runtime and closes admission; reload is required, and late judgments cannot commit. Poll cadence follows reloaded config, while changing the state directory requires a restart. Deletion removes records by exact source identity, including synthetic agent ranges. Compaction uses the shared bounded pure renderer and the actual compaction agent.

## Options and capabilities

Configuration is the first existing `.opencode/kasper.jsonc`, `.opencode/kasper.json`, `kasper.jsonc`, or `kasper.json` in the plugin directory. Flat plugin options override its Kasper fields. Legacy host `kasper` keys and ambient global config/auth stores are not read. Empty `state_dir` resolves to `.opencode/kasper`.

Additional native options are `server_url`, `archive_headers`, `trust_local_archive`, `global_config_dir`, `project_discovery`, `global_discovery`, `instruction_discovery_verified`, `editable_agents`, and `agent_overlays`. Authentication headers are explicit valid strings; server URLs reject credentials/query/fragment and require HTTPS or loopback HTTP. No-auth transport requires an explicit loopback trust assertion. The connection must match native location/project identity before config access; archive reads also validate native session provenance before enumerating messages.

`instruction_discovery_verified: true` is a **caller assertion** that these discovery settings match the actual host policy; it is not SDK verification and does not configure the host. Its default is false. Missing authoritative config entries, unknown active agent identity, unresolved instructions, or unasserted discovery block judges and writes. Automatic instruction changes also require explicit editable agent ownership or a Kasper-owned overlay, even when guidance would target shared AGENTS. Status/help and capability diagnostics remain available. Native migration is explicitly unsupported; no rollback action is added.

Without an explicit trusted archive, manual historical scoring is typed unsupported. Automatic scoring reads the current compaction window and validates the execution anchor again after context reads. Missing old checkpoints fail closed. Memory preprocessing omissions now propagate `evidence_truncated` through pair/pending/card aggregation, preventing partial observations from producing improvements.

## Commands and receipts

Native `/kasper` commands execute directly, and `kasper_control({ action, arg? })` exposes the same action boundary. Status/help/config/pause/resume/reset/apply do not dispatch a chat model. Scoring invokes the configured generation port only after eligible evidence and instruction coverage; improve renders existing observations. The V1 command-before hook cannot stop a host command with invented `stop/message` fields, so it is nonmutating and V1 slash commands deliberately use the supported model/tool flow.

`./rpc` exports portable `kasperRpc` with ID `kasper`:

- `execute({ requestID, sessionID, location, command })` returns a receipt.
- `results({ sessionID, location })` reads cached receipts and never executes actions.
- Event `result` carries the receipt in its public event envelope's `data`.

Receipts contain request/session/location/action, `status`, text, and timestamp. `ok` means the action handler completed; it does not independently prove instruction activation, unconditional backups, or full evidence coverage. Score outcomes map typed failure/unsupported/cancellation. Applying selected IDs that remain pending yields failure instead of success. Instruction activation is explicitly pending/unconfirmed.

Request IDs bind raw command, session, and location. A matching in-flight retry shares the same promise; mismatched identity is rejected. Cache eviction creates tombstones and never makes an ID executable again. The bounded host lifetime has a maximum request count and rejects admission at capacity. Restart begins a new replay scope; no automatic TUI execute retry exists. TUI displays correlated results in a readable dialog outside durable chat history, filtering location/session and deduplicating event versus RPC delivery.

## Validation and remaining qualification

- Full offline suite: 694 pass, 27 optional E2E skip, 0 fail, 1681 assertions before final flag regression additions; final focused integration suite: 59 pass, 0 fail, 148 assertions.
- Typecheck, pinned SDK contracts, build pass. Native setup fixture checks real Effect registration/lifetime cleanup, direct commands, receipt replay, and zero generation without any V1 client.
- Command tests cover concurrent deduplication, payload binding, eviction/capacity refusal, and pre-admission validation. History tests cover the post-context execution race; preprocessing regression covers more than 25 tiny tools and suppression of improvements.
- Flags regression proves dry-run preserves instructions/pending queue, `--show` preserves the exact agent name and config bytes, unknown flags do not mutate, and the V1 before hook does not reset state.
- Actual production packing, host loading, provider receipts/cancellation, and TUI qualification belong to C11; these local checks do not claim public publication or live provider acceptance. Host retry/model output limits are not a demonstrated physical output/spend ceiling.

## Native acceptance followup

C11 actual packed server qualification found that pagination cursors cannot be combined with an explicit order. Archive message reads now set `order: asc` only on the initial request and omit absent cursors; subsequent pages pass the opaque cursor. Native session listing likewise omits order and filters encoded by its cursor, while validating each returned identity/location/parent. Tests assert the exact public request shapes. The public plugin event domain promises a stream without guaranteeing it cannot terminate. Scoped supervision therefore fails closed on any unexpected completion, typed error or defect, and tolerates handler/logging failures. Deterministic asynchronous tests prove closed admission and canceled late commits. Actual provider/package acceptance remains C11's qualification.
