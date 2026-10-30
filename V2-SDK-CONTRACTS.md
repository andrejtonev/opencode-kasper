# Pinned V2 SDK contracts and native loading evidence

C05, reviewed 2026-10-30. The SDK, client and schema are pinned to **2.2.2**, and Effect to **4.0.6**. These optional peers are installed for development; the production default remains the existing V1 function. No production V2 setup or dummy compatibility entrypoint is exported by this chunk.

## Verified package layout

The public `@opencode/plugin/host` resolver prefers a package's `./server` export, then `.`. It honors a local directory's named `package.json` and exports as well. See [pinned host resolver](https://github.com/anomalyco/opencode/blob/v2.2.2/packages/plugin/src/host.ts) and [native module loader](https://github.com/anomalyco/opencode/blob/v2.2.2/packages/core/src/plugin/module.ts#L114).

The packaged fixture demonstrates this layout:

```json
{
  "exports": {
    ".": "./index.js",
    "./server": "./server.js"
  }
}
```

Its root is a legacy plugin function with no V2 import; `./server` is an Effect definition. **Native OpenCode 2.2.2 selected `./server` from the installed fixture package and ran its effect.** Thus C10 can preserve Kasper's root V1 export and add a real `./server` V2 adapter without configuring an invented npm `/v2` subpath or adopting a mixed root object. This chunk deliberately leaves Kasper's exports unchanged until that adapter exists.

Supported native V2 configuration exercised here:

```json
{
  "plugins": [
    { "package": "C:/absolute/path/to/installed/package", "options": {} }
  ]
}
```

The native fixture first uses `bun pm pack` and installs the archive into a clean consumer. This verifies installed package bytes and exports, rather than only a workspace-linked source. Registry-name configuration should use the package's normal name, with the host resolving its server export. `opencode plugin add --help` in 2.2.2 declares an npm/Git package argument and global configuration installation, with **no `--global` flag**. The harness does not change user global configuration or invoke that installation command; registry installation syntax itself still belongs to final packaged acceptance.

The public [migration documentation](https://github.com/anomalyco/opencode/blob/v2.2.2/services/www/src/docs/content/build/plugins/migrate-v1.mdx) puts the mixed `{server,effect/setup}` V1 object support floor at 1.18.29. Separate root/server exports avoid depending on that mixed object contract. V1 1.18.23 isolated native probing has not yet produced the fixture marker; this is **unverified V1 acceptance**, not proof that the retained function export is rejected. Keep the existing V1 contract and finish packaged V1 acceptance in C11.

## Generation and cancellation

Native stateless generation is `context.experimental.generate.text({prompt, model?})`. It creates no session and supplies no user-session history/tools. `context.generate.text` is a deprecated alias. Both Promise and Effect contexts expose it.

The 2.2.2 input has **only `prompt` and optional `model`**. There is no per-request `maxTokens`, temperature or options object. Source: [text protocol](https://github.com/anomalyco/opencode/blob/v2.2.2/packages/protocol/src/groups/generate.ts#L25), [native generation](https://github.com/anomalyco/opencode/blob/v2.2.2/packages/core/src/generate.ts#L92), and installed `@opencode/client/dist/effect/api/api.d.ts:1834-1841`. A prompt asking for short output is not an enforced output-token limit. C06/C08 must expose this limitation honestly, bound retained output separately, and qualify any dedicated model configuration before claiming an enforced provider output ceiling. Native generation also has a host retry policy; one logical plugin request is not necessarily one physical provider attempt.

The inspected [Promise adapter](https://github.com/anomalyco/opencode/blob/v2.2.2/packages/core/src/plugin/promise.ts) invokes API effects with the input and `Effect.runPromiseWith` without forwarding a second request-options signal. Adding a cast and `{signal}` to those plugin domain methods does not establish cancellation. RPC and subscriptions have their own explicit cancellation paths; they cannot prove unrelated Promise generation methods respect a signal.

**Use the Effect entrypoint for the native bridge.** Its bound API methods return public Effects, and `Effect.runPromise(operation, {signal})` propagates caller interruption. The native fixture registered a delayed public RPC effect, invoked it through its real plugin context, and interrupted the running call through this bridge. The resulting marker was:

```json
{
  "entrypoint": "server-v2",
  "loaded": true,
  "version": "2.2.2",
  "sessionPage": {"size": 0, "cursor": {}},
  "cancellation": {"started": true, "interrupted": true, "completed": false}
}
```

This proves interruption/finalization through the **actual native Effect plugin/API boundary**, without a provider request. Provider network abort, late paid completions and billed retry behavior remain C11 acceptance requirements. Effect 4.0.6 uses `Effect.callback`, not the older `Effect.async` name.

Minimal extension design for C06/C10: keep the shared core Promise-based; construct its host port from the real Effect setup context. Run bound native API effects with combined caller and plugin-lifetime signals. Hooks/transforms stay registered inside the setup scope; use scoped finalizers for lifetime cancellation and bounded core disposal. Preserve one generation slot until the underlying call settles. Do not fake a V1 client, import private Core services, patch the SDK, or substitute a timeout race for physical cancellation.

## Archive and pagination

The declared plugin session domain now includes `list` and `remove`. Native `session.list({limit:1,order:'asc',directory:context.location.directory})` returned the documented page envelope in the fixture.

- `session.list` returns `{data,cursor:{previous?,next?}}`; use `cursor.next`, not a bare cursor or `result.data.data`. Installed client effect API lines 160-178.
- Plugin `session.context` accepts **only `{sessionID}`**. It exposes neither `mode:'full'` nor pagination. Installed lines 311-315. It is current model context and cannot substantiate original pre-compaction tools.
- Plugin context has no top-level `message` archive domain. Full public `@opencode/client` has `message.list({sessionID,order,limit,cursor})`, returning `{data,cursor:{previous?,next?}}`, installed lines 1791-1805. Archive pagination is compile-verified here; populated native archive behavior belongs to C08/C11.
- `context.app` has name/version/channel only, with no same-server URL. Do not guess localhost or import private host bootstrap state to construct an archive client.

C08 may accept a trusted explicitly configured same-server archive URL/auth connection through plugin options. Verify location/session provenance against native session data, use public client pagination, and fail closed when archive coverage is unavailable. Default current-context reads must report incomplete historical coverage rather than silently claim batch/history parity. TUI's public client can support UI-side reads, but it is not silently available in the server Effect context.

## Commands, tools and UI

Actual SDK compile contracts exercise:

- Effect `command.transform` with an invocation containing sessionID/prompt/delivery and **void** execution result.
- Effect `tool.transform` returning structured `{content}` and binding to invoking session identity.
- Dedicated compaction hook appending a `SystemPart`.
- Typed public RPC registration and response schema.

A native command definition can execute administrative work directly without submitting a chat prompt. Returning a string is not terminal output: the command contract returns void. Use the public TUI/RPC result channel with explicit session/location/request correlation. Rendering, retrying delivery or refreshing status cannot rerun a mutation or submit a judge. Native terminal rendering remains C10/C11 acceptance.

## Checks and reproducible harness

Commands:

```powershell
bun install --frozen-lockfile
bun run typecheck:contracts
bun test tests/sdk-contracts.test.ts
bun scripts/verify-native-sdk.ts <absolute-2.2.2-executable> v2
```

The native Windows package is **`@opencode/cli@2.2.2`**, with binaries named `opencode`/`opencode2`; it is not an `opencode-ai@2.2.2` package. The temporary tool install used its platform package `@opencode/cli-windows-x64/bin/opencode.exe`; Bun blocked its optional launcher-copy postinstall, so the probe ran the verified platform binary directly.

Final successful native artifact: `%TEMP%/kasper-sdk-native-NfeR7O/result.json`. Frozen install, SDK contract compilation, repository typecheck/build and the full test suite pass (**580 passed, 27 opt-in tests skipped**). Lint has the two pre-existing unused-suppression warnings.

The harness retains isolated archives, config and logs for review. It redirects home, XDG directories, ProgramData, temporary directories and explicit host config; disables project ancestor discovery, Claude discovery, default plugins, model-catalog fetch and file watchers; whitelists child environment without provider credentials; binds localhost with a fixture-only password; and queries an explicit temporary location. It makes no session prompt, generation, provider, user-config or sibling-repository call.

Initial native attempts exposed fixture-auth and request-route mistakes, then an obsolete `Effect.async` API name; these were corrected before the successful native V2 result. A standalone Bun invocation of the installed resolver reports missing optional exports differently from the host's resolver; the offline resolver test uses Node's standard resolver, and native loading is verified independently. No Kasper V2 feature parity is claimed by these contract tests.
