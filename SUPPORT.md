# Support and verification boundaries

This document describes the migration checkout. No package publication or global
OpenCode configuration change is included. [V2-MIGRATION.md](V2-MIGRATION.md) is
the preserved initial assessment; its 2.0.8 API assumptions are historical.

## Host profiles

| Profile | Entrypoint and contracts | Acceptance |
| --- | --- | --- |
| Native V2 | Dual `./server` and companion `./tui`; OpenCode/plugin/client/schema 2.2.2, Effect 4.0.6 | Production packed native setup, real TUI result, durable manual score, receipt replay, reset race and public reload passed on Windows. This qualifies the tested fixture paths, not every provider or all feature parity. |
| Legacy V1 | Ordinary package identity through dual server's lazy legacy function; development plugin 1.15.0/SDK 1.15.11 | Production packed setup and seven registered tools passed on actual host 1.18.23 with consumer plugin peer 1.19.5. Shared behavior has offline coverage; this is not full legacy provider qualification. |
| Other versions | Older reference 2.0.8 and the REST SDK's `/v2` are different contracts | No additional native compatibility claim. |

The V1 peer range in package metadata is not a native acceptance matrix. The
root function module alone does not guarantee V1 package-name loading: host
1.18.23 also prefers `./server`. The final dual server export supplies a lazy
legacy function, verified by the actual packaged V1 host setup test. Mixed-object V1
entrypoints have a documented support floor of 1.18.29; the named 1.18.23 native
result is an explicit tested exception, not a claim about all older versions.
Importing the V1 root remains isolated
from native Effect/plugin imports. See [SDK evidence](V2-SDK-CONTRACTS.md).

The clean native host supplies plugin/Effect services, but does not supply the
schema package to the installed plugin. Client and schema are therefore pinned
ordinary runtime dependencies in the final package. C05's earlier optional-peer
packaging plan is historical contract-spike evidence; a clean installation must
use the actual final manifest. Installing those dependencies does not authorize
V2 imports in the legacy root's runtime graph.

## History, scoring and generation

Native commands execute directly through `kasper.execute`, with request/session/
location-correlated receipts and companion TUI dialogs. Read-only result delivery
and refresh replay receipts; they do not retry mutations. Request de-duplication
is bounded to the native host lifetime and is not a crash-durable action ledger.
The V1 command route remains model-backed through registered tools; model-free
administrative command behavior is not promised for that profile.
Production legacy `tui()` is a compatibility no-op, with no native dialog parity
claim. Its separate dual-TUI loader shape was verified with the packed SDK fixture.

If native event supervision ends or fails, the runtime fails closed and requires
reload; subscription retry/recovery is not promised. This prevents polling or
actions from continuing with a silently lost lifecycle feed.

Automatic evaluation can use the current native compaction window with explicit
coverage, or complete archive history when that connection is available.
Historical/manual/batch scoring requires explicitly complete, paginated
archive access. Native `session.context` is not the full archive; missing old
checkpoints fail closed. An explicitly authenticated connection to the same
server/location is required for archive `message.list` and authoritative
configuration entries. Kasper does not guess a localhost URL or read ambient
credentials to create that connection.

Tools retain their actual input, completed content, structured errors and
execution state. Agent switches preserve A-B-A evidence ranges. Running tools,
failed generation and stale lifetimes cannot advance an unscored checkpoint.
Compaction summaries and synthetic system text are not user requests.

The session evidence budget includes escaped tool input/output, delegation and
omission markers. Partial or truncated observations can display scores, but do
not contribute weakness/strength evidence or queue automatic/manual aggregate
improvements. Incomplete instruction coverage similarly disables guidance
mutations. Native setup rejects incomplete instruction coverage before invoking
the judge. Partial evidence scores remain explicitly marked in their records.

Native judges use sessionless `experimental.generate.text` through the host's
public Effect services. This creates no judge session or diagnostic model call.
The pinned request has no per-request maximum output-token option. Retained text
is bounded separately; neither that limit nor a request for concise output caps
provider tokens or spend. A logical plugin request can contain host/provider
retries. Native Effect interruption is not proof of remote provider cancellation
or billed retry behavior.

The production native reset fixture demonstrated the distinction: the delayed
localhost provider completed after reset, while Kasper returned cancellation,
left sessions empty, made no overlapping retry and committed no late score.
Unknown outcomes must remain quarantined; reset/reload must not be described as
a provider termination or spend-stop mechanism.
Interrupted or unknown dispatched native generation quarantines the current plugin scope;
further judge dispatch requires a new scope through reload. Execution start,
agent changes and reset can invalidate an active judge as well as a timeout.
Reload creates a fresh local scope and does not prove the previous provider
attempt stopped. This restart policy is visible to users, rather than a silent
retry of an uncertain request.

The isolated native 2.2.2 SDK fixture made exactly one localhost streamed judge
request and created no session. Its model metadata specified output limit 512,
but the actual provider request contained neither `max_tokens` nor
`max_completion_tokens`. Even that metadata is not an enforced output ceiling
for the verified stateless path. This fixture qualifies that contract behavior;
production packaged-Kasper judging separately passed with one real fixture
request, an 80% persisted score, preserved tool evidence and no child judge session.

V1 creates an auxiliary session and owns only the exact returned ID. It waits for
underlying create/prompt settlement after cancellation or timeout, discards late
output, and cleans the exact known session. A late create is fenced and deleted
without prompting. Unknown outcomes suspend further dispatch for that generation
port; failed cleanup keeps the known ID fenced. A control deadline can therefore
leave an operation pending. Session-title matching never authorizes deletion,
and in-memory ownership is not crash-durable cleanup. Restarting must not be
presented as proof that the remote provider stopped.

V1 auxiliary score/merge prompts send the supported `tools: {"*": false}` map.
Pinned host 1.18.23 source persists a wildcard session deny rule before the model
loop and filters workspace, MCP and Code Mode tools. SDK serialization and
regressions verify the exact request ([tool isolation evidence](V2-C10-V1-TOOL-ISOLATION.md)).
This source-grounded restriction does not remove the host's normal system/config
context or trusted plugin hooks; it is separate from provider cancellation and
output limits. Forced-tool runtime qualification belongs to the native acceptance report.
The actual packed V1 1.18.23 fixture advertised no tools, rejected a malicious
provider write-tool reply, left the forbidden file absent and deleted the exact
owned auxiliary session. A second local request continued that same attempt to
valid 0.8 JSON; it was not an additional evaluation or diagnostic probe. See the
[native acceptance report](V2-NATIVE-ACCEPTANCE.md) for artifacts and scope.

## Instructions and recovery

Native V2 scoring reads effective agent catalog system text separately from
editable provenance. Global and ancestor AGENTS.md plus configured instructions
combine; no CLAUDE.md fallback is used. Configured URL text must come from the
host's cached source port. Missing authoritative config entries, unreadable
sources, remote text or provider-selected system text are reported as incomplete
coverage and block guidance writes.

Native setup additionally requires `instruction_discovery_verified: true`, an
explicit caller assertion that Kasper's global/project source settings match
the actual host policy. It does not configure the host's discovery. The current
entrypoint does not supply cached remote instruction text, so configured remote
URLs cannot provide complete coverage for judging.

An agent source is editable only through explicit canonical path/JSON-pointer
opt-in, complete layered discovery, agreement with effective catalog text and an
exact revision check. Equal text alone does not authorize editing. Native config
targets are `agents.<id>.system`; nested IDs stay intact. Virtual, transformed,
substituted or plugin-only origins remain read-only. An explicitly configured
Kasper-owned overlay appends guidance while preserving the factory system.
Project guidance writes stay on the owned local AGENTS.md target, never silently
falling back to global rules.
The native runtime also requires explicit agent ownership before automatic
guidance changes, including changes targeting project AGENTS.md.

Writes and rollback reuse canonical target locks, exact before-byte backups,
receipts and guarded atomic replacement. Default application paths create
backups; low-level helpers also expose a `backupEnabled` argument, so backup
creation is not an unconditional property of every possible helper call.
JSONC rollback restores the owned pointer while preserving unrelated edits.
Whole-file rollback rejects later edits to the written file. A receipt records
the original source; the current agent name/path does not redirect recovery.

Old backups without source receipts require manual review. Migration writes use
a journal and reject a differing destination. Recovery restores the owned config
field first, then removes only an unchanged destination created by that
transaction. Preserve backup files, their `.json` receipt sidecars, and migration
journals until recovery is finished. If a conflict occurs, compare the receipt's
before/after/source hashes with current bytes and recover deliberately; do not
overwrite a later edit. Manager rollback helpers exist, but neither command
router registers `/kasper rollback`; use explicitly reviewed helper or manual
recovery rather than assuming a command is available.

`improvement_expiry_days` controls active metadata retention. It does not deactivate
or remove previously injected guidance. Audit backups/receipts have their own
retention and should not be confused with active improvement metadata.

Agent-source writes report refresh pending; confirmation requires an actual
catalog reread matching intended text. `agent.reload` alone can replay captured
data. Disk instruction snapshots remain activation unconfirmed: already loaded
nested rules may be cached, and new glob matches may await a config change. This
snapshot covers discoverable catalog/ambient/configured text, not every provider,
session, skills, MCP or instruction-transform contribution to a model request.

Participating Kasper writes share short locks. Source hashes are checked again
after staging/fsync, including apply, rollback and migration ([staging follow-up](V2-C04-WRITE-CONFLICT.md),
agent `84caa0a`, integrated `ba714ea`). External editors and different source files
cannot be coordinated into one atomic snapshot; the final read-to-filesystem-call
window is not a cross-process CAS guarantee. Live or
unknown lock owners are not reclaimed just because a lease is old. An abandoned
reclaim guard can require manual recovery after checking ownership. On Windows,
sharing violations are retried; failed replacement preserves existing bytes and
does not silently fall back to truncating the destination.

## Validation and release

The [native acceptance report](V2-NATIVE-ACCEPTANCE.md) records the actual packed
package, command, provider-fixture and TUI artifacts. Its tested paths qualify
the matrix above; they do not establish complete automatic/batch/child-session
or guidance-application parity on every host. Complete local checks and chunk
results belong to [the execution ledger](V2-IMPLEMENTATION-PLAN.md). Run the
[release checklist](RELEASE-CHECKLIST.md) and retain fresh artifacts before
expanding the support matrix or publishing.

Implementation evidence is collected in [the execution ledger](V2-IMPLEMENTATION-PLAN.md),
[generation contracts](V2-GENERATION-CONTRACTS.md), [history review](V2-C08-HISTORY-REVIEW.md)
and [instruction contracts](V2-C09-INSTRUCTIONS.md).
