# C11 native package acceptance

Verified on Windows on 2026-10-30, against actual OpenCode 1.18.23 and `@opencode/cli@2.2.2`. The package tested was built from C10 commit `5ad57cc` plus instruction staging fix `87e991c` and pagination/lifecycle fix `dbe991d`, then packed and installed into isolated consumers. This is local package and local provider acceptance, not publication or external-provider qualification.

## Results

| Boundary | Result | Evidence |
|---|---|---|
| Production package / V1 1.18.23 | Passed: package directory resolves `./server`; dual default selects legacy `server()`; actual tool registry contains `kasper_control` and six compatibility tools | `kasper-sdk-native-xRYz5P/result.json`, `tool-ids.json`, project `kasper.log` |
| Production V1 judge tool isolation | Passed: installed production port exposes no tools; malicious provider `write` response receives terminal unavailable-tool denial; isolated file remains absent; exact owned judge session is deleted | `kasper-sdk-native-HNb8RR/v1-generation.json`, provider receipts |
| Production package / V2 2.2.2 | Passed: same package resolves `./server`; Effect setup completes | `kasper-sdk-native-RUKLFE/result.json`, `server.log` |
| Production native administrative action | Passed: RPC status, same-request replay and native session command produce no provider requests and no durable chat messages | `packaged-actions.json` administrative section |
| Production native TUI result | Passed: actual native terminal renderer displays `Kasper status` from native command result event | `tui.log`, `packaged-actions.json` tui section |
| Native tool evidence | Passed: real work execution calls Code Mode `execute`, which calls `tools.kasper_control({action:"status"})`; settled input/output are present in durable history and judge evidence | `packaged-actions.json` history; provider receipts |
| Historical scoring | Passed: explicit authenticated same-server archive, verified explicit agent system source, exactly one judge request, 0.8 persisted score; replay makes no new judge request | `packaged-actions.json` score/state; receipt model `judge` |
| Native judge isolation | Passed: judge creates no child session; only one source session exists before reset | acceptance `noJudgeChildSession` |
| Reset during actual judge request | Passed: forced reset cancels evaluation, clears state, prevents late commit and retry | acceptance `resetRace` |
| Public location reload | Passed: public reload creates a new plugin scope, status works, no provider call occurs | acceptance `reload`; at least two `native_setup` log entries |
| Historical child after reload | Passed: public parent/child creation, real child work, reload clearing the registry, parent-invoked child score; persisted child source/parent IDs and `agent_type: subagent`, no parent score | `kasper-sdk-native-eiZlgf/packaged-actions.json` childAfterReload |
| SDK Effect interruption | Passed in actual native host: RPC handler finalizer runs; delayed handler does not complete | SDK fixture `kasper-sdk-native-w7IIZj/result.json` |
| Dual TUI classifier / V1 1.18.23 | Passed for packed SDK fixture with default `{id,setup,tui}` and explicit separate TUI configuration | `kasper-sdk-native-brLSVJ/result.json`, `tui.log` |
| Dual TUI classifier / V2 2.2.2 | Passed for same packed SDK fixture | `kasper-sdk-native-w7IIZj/result.json` |

Production V1 TUI result delivery is intentionally not a parity claim: its compatibility `tui()` is a no-op, and legacy commands retain their legacy interaction model. The actual production V1 **server and registered tools** were verified; the separate dual-TUI loader shape was verified with a packed SDK fixture. Provider-specific system prompts remain unsupported when the native catalog cannot expose their effective text. The production probe first returned `unsupported` for that real condition, then succeeded after an explicit fixed `agents.build.system` source and exact `editable_agents` locator were configured.

## Retained artifacts

All artifact paths below are relative to `%TEMP%`.

- Final production V2: `kasper-sdk-native-RUKLFE/`. Contains `result.json`, `packaged-actions.json`, complete `provider-receipts.json`, raw ANSI `tui.log`, `server.log`, packed archive, installed consumer and isolated project/state.
- Subsequent production V2 child-provenance qualification: `kasper-sdk-native-eiZlgf/`, including trusted child guard `34183bc`. All prior native V2 checks pass, followed by one real child work request and one historical child judge request after another reload.
- Final production V1: `kasper-sdk-native-xRYz5P/`. Contains `result.json`, actual `tool-ids.json`, server logs, exact packed archive, installed consumer and isolated project/state.
- Final guarded production V1 generation: `kasper-sdk-native-HNb8RR/`, built with guard commit `88b33c5`. Contains `result.json`, `v1-generation.json`, complete provider receipts, archive and installed consumer.
- Earlier complete V2 reset/TUI evidence: `kasper-sdk-native-oBzapW/`.
- Real built-in instruction coverage rejection: `kasper-sdk-native-wal0UA/`.
- Real initial archive pagination rejection: `kasper-sdk-native-lJTy5e/`; fixed before final acceptance.
- SDK dual server classifier: V1 `kasper-sdk-native-nbJAqB/`, V2 `kasper-sdk-native-HeJz6O/`.
- SDK dual TUI classifier: V1 `kasper-sdk-native-brLSVJ/`, V2 `kasper-sdk-native-w7IIZj/`.

The TUI evidence uses a supervised Windows PTY running the real native CLI. The child terminal's stdout/stderr are captured as ANSI renderer output, not an `ui.dialog.alert` mock. The harness starts the actual source session and invokes its public native command. It waits until captured renderer output contains `Kasper status`. Result replay and zero-generation assertions are separately enforced through public RPC and provider receipts. Keyboard selection, dismissal, accessibility, terminal resizing and repeated visual refresh interactions are not qualified by this check.

## Cancellation and output limits

The final delayed provider receipt records:

- request received: `1793356450453`;
- evaluation cancellation receipt: `1793356450462`;
- completed reset receipt: `1793356450477`;
- provider response completed: `1793356451267`, with `completed: true` and no observed disconnection.

Thus native Effect interruption and lifecycle fences prevented the late score from restoring cleared state, while the actual local HTTP provider still completed its delayed response. Neither transport interruption nor these tests prove provider termination, avoided billing, or a spend ceiling. No overlapping retry was dispatched. Unknown outcomes remain conservatively quarantined by the generation port.

The native provider received streaming chat-completion requests without `max_tokens` or `max_completion_tokens`, despite fixture model metadata declaring `limit.output: 512`. The public plugin generation API does not expose an enforced output-token bound. `enforcedOutputLimit: false` remains the accurate capability declaration. Retained output and input evidence are bounded locally; those are not provider token limits.

The separate V1 forced-tool probe imports `createV1Generation` from the **installed archive's** `dist/hosts/v1-generation.js` and supplies the real public V1 SDK client. Both scoring and merging now set the public prompt option `tools: {"*": false}`. Actual host 1.18.23 persists that wildcard denial before execution and removes tools from the outgoing model request. A malicious local provider still emits a `write` call targeting only `project/forbidden-judge-write.txt`. The next request contains the actual terminal tool result: `Model tried to call unavailable tool 'invalid'. Available tools: .`. The final continuation returns the expected 0.8 JSON; the file remains absent and the single owned/released ID `ses_e7397f0c1ffez6GTF1PDI6CQi1` is absent from the subsequent public session listing. Two HTTP requests are expected here: forced tool response plus terminal continuation, with no diagnostic judge call. Automatic polling is set to one hour and uses only the explicitly enabled fixture provider.

The child follow-up uses the real public `session.create({parentID,...})` API. Source parent `ses_e73919ab8ffeCa7HVlt5lG4T1i` invokes historical scoring of child `ses_e73918204ffe2f6Onya58Sbcob` after the child completes a local work turn and public `location.reload()` clears the plugin registry. The score receipt remains correlated to the invoking parent; the durable score record belongs only to the child, with `source_session_id` equal to the child, `parent_session_id` equal to the parent, `agent_type: "subagent"`, `agent_name: "build"`, and score 0.8. This run follows the existing reset/quarantine/reload path, proving fresh generation after scope replacement. Seven HTTP requests are expected in the full run: the existing five plus one child work request and one child judge request. No private database writes or synthetic native-history import are used. Suppression of weak child proposals targeting project AGENTS.md is additionally checked by the core regression; this native fixture uses a normal 0.8 result and makes no instruction-file change.

This V1 fixture request includes `max_tokens: 512` from its host model metadata, unlike the measured V2 request. That observation does not add a universal per-call generation-port token-limit capability. The immutable V1 source trace and serialized public SDK contract are recorded in `V2-C10-V1-TOOL-ISOLATION.md`.

## Package and loader facts

The consumer was installed from the exact packed archive with `bun install --ignore-scripts`, outside repository `node_modules`. Production dependencies supply `@opencode/client@2.2.2`, `@opencode/schema@2.2.2`, and Effect 4.0.6. The final consumer has **no installed `@opencode/plugin` package**; its native host does not accidentally succeed because repository development SDK dependencies are available. Its legacy peer is `@opencode-ai/plugin@1.19.5`. Native entry modules use type-only plugin imports.

Both probes configure the installed package directory, which exercises its actual export metadata. V1 config uses a plain file URL in `plugin`; V2 uses `plugins: [{package: installedDirectory, options: ...}]`. They test packed installed bytes without using a working source wrapper. Registry publication and registry install were not performed.

An initial fixture containing separate root function and V2-only `./server` failed on V1: 1.18.23 resolves package metadata even for a JS file directly beside `package.json`, preferring `./server`. The actual dual `{id,server,effect}` fixture passed both hosts, supporting the production dual server default. A direct `dist/index.js` fixture without a `dist/package.json` also preserved legacy loading. The resolver reads the **direct containing directory's package metadata**, not an arbitrary ancestor search.

V1 TUI plugins use separate `tui.json` / `OPENCODE_TUI_CONFIG` configuration; inheriting its server plugin list was not sufficient. V2 CLI uses `--server URL --session ID DIRECTORY`; its old `attach URL` invocation is not supported.

Version-grounded references:

- [V1 resolver and classifiers](https://github.com/anomalyco/opencode/blob/v1.18.23/packages/opencode/src/plugin/shared.ts): export preference and `readV1Plugin()` accept the demonstrated dual server/TUI shapes.
- [V1 TUI configuration](https://github.com/anomalyco/opencode/blob/v1.18.23/packages/opencode/src/config/tui.ts): separate explicit TUI configuration and plugin origins.
- [Pinned V2 plugin source](https://github.com/anomalyco/opencode/tree/v2.2.2/packages/plugin): public Effect/plugin contracts.
- [Official migration guide, pinned](https://github.com/anomalyco/opencode/blob/92b2ca0dd727942e00aba3523ed141d53e78ea28/services/www/src/docs/content/build/plugins/migrate-v1.mdx): its documented mixed-plugin floor is 1.18.29. Actual installed 1.18.23 support here is a directly measured exception, not a claim for every older version.
- Installed declarations from `@opencode/plugin`, `@opencode/client`, `@opencode/schema` 2.2.2 are compiled by contract checks; Promise abort support is not inferred from Effect support.

## Reproduction and checks

Security remediation on 2026-10-30 additionally passed the full suite with
**715 passed, 27 skipped, 0 failed**, 1829 assertions across 47 files. Application
and SDK contract typechecks, the HTTP helper's strict typecheck, build and lint
passed. Lint retains two existing unused-suppression warnings. `bun audit --json`
returned `{}` with installed Zod 4.6.7 and TOML 5.0.1, including legacy SDK Zod
resolution. The private launcher regressions passed four tests.

Fresh packed consumers passed actual V1 1.18.23 production tool registration and
the V1 forced-tool generation guard, and actual V2 2.2.2 production commands,
scoring, reset/reload and child-session correlation. The V2 consumer now has
neither plugin SDK installed: the optional legacy peer and type-only native
imports prevent unnecessary runtime dependency installation. The V1 tool factory
uses the patched local Zod schema with the public identity-factory contract.
These checks use the local fixture provider and make no paid model requests.

Build first: `bun install --frozen-lockfile`, `bun run build`.

```
bun scripts/verify-native-sdk.ts <absolute-1.18.23-executable> v1 production
bun scripts/verify-native-sdk.ts <absolute-1.18.23-executable> v1 v1-generation
bun scripts/verify-native-sdk.ts <absolute-2.2.2-executable> v2 production tui
bun scripts/verify-native-sdk.ts <absolute-1.18.23-executable> v1 fixture tui
bun scripts/verify-native-sdk.ts <absolute-2.2.2-executable> v2 provider tui
```

The `tui` modes require a PTY. Child hosts use a whitelisted environment, isolated HOME/XDG/config/data/cache/temp directories, fixture Basic authentication, and hidden supervised processes. The provider listens only on loopback, accepts only explicit fixture credentials/models, never proxies, and records every request. Provider policy denies all non-fixture providers; no external or paid model request is authorized or dispatched. The harness retains artifacts and terminates only its own host children.

Full verification including the V1 tool guard, before the child follow-up: **704 passed, 27 skipped, 0 failed**, 1725 assertions across 45 files. Frozen install, production build, application typecheck, pinned SDK contract typecheck and strict independent harness/helper typechecks passed. The focused generation suite additionally passed 14 tests with 59 assertions. The subsequent child follow-up passed its actual native probe, strict harness SDK typecheck, application/contract typechecks and build, plus **83 focused history/evaluation tests with 234 assertions**. Lint passed with the two pre-existing unused-suppression warnings in e2e files. The opt-in external/model e2e suite remains skipped; native acceptance here uses the deterministic local provider.
