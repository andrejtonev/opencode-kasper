# Installing and migrating the dual-host checkout

Use [SUPPORT.md](SUPPORT.md) for verified host versions and limitations. These
steps describe local package preparation; no publication, registry tag change or
global host reconfiguration is performed by this guide's implementation work.

## Prepare an isolated package

```powershell
bun install --frozen-lockfile
bun run typecheck
bun run typecheck:contracts
bun run build
bun test
bun pm pack
```

Install the resulting archive in a clean consumer directory and register that
installed package in a temporary project configuration first. Do not use a
package `/v2` subpath. Both tested hosts choose `./server`; the final dual export supplies
V1's legacy `server()` function and native V2's Effect setup. Keeping only a root
function would not preserve package-name loading on V1 host 1.18.23.

For the qualified legacy V1 1.18.23 local profile, use singular `plugin` with an
installed package directory URL:

```json
{ "plugin": ["file:///C:/absolute/path/to/installed/package/"] }
```

For native 2.2.2, use plural `plugins` with the installed package directory:

```json
{
  "plugins": [
    { "package": "C:/absolute/path/to/installed/package", "options": {} }
  ]
}
```

These installed-directory profiles were exercised with the production packed
package in [native acceptance](V2-NATIVE-ACCEPTANCE.md). After a separately
verified registry publication, the ordinary package name can replace the local
directory identity. Local package acceptance does not verify registry delivery.

An explicit compiled V1 file URL is an alternative that bypasses package export
selection, for example
`file:///C:/absolute/path/to/node_modules/@atonev/opencode-kasper/dist/index.js`.
The ordinary package profile relies on the dual server entry, not on an assumed
legacy preference for the root export. Acceptance on 1.18.23 is explicit native
evidence despite the documentation's 1.18.29 mixed-object support floor; no
untested older-version range is inferred.

## Configuration

Keep Kasper settings in `kasper.jsonc` or `kasper.json`, with `kasper.jsonc`
preferred when both exist. Start with `auto_update: false` while reviewing source
targets and coverage. Native host connection/provenance options are separate
from these scoring settings and must match the actual production setup schema.

The native entrypoint first uses one existing standalone file, in this order:
`<directory>/.opencode/kasper.jsonc`, `.opencode/kasper.json`, `kasper.jsonc`,
`kasper.json`. Flat plugin options override that file; defaults fill missing
fields. Native setup does not read legacy nested host settings or global Kasper
config automatically. It reloads project settings/model, while `state_dir`
changes require restart; the default directory is `.opencode/kasper`.

Native connection and source options are:

| Option | Meaning |
| --- | --- |
| `server_url` | Explicit same-host server endpoint for complete archive/config APIs. HTTPS or loopback HTTP; no embedded credentials, query or fragment. |
| `archive_headers` | Explicit authentication headers for that endpoint. Not obtained from ambient credentials. |
| `trust_local_archive` | Explicit no-auth local-connection assertion; valid only for a loopback endpoint. |
| `instruction_discovery_verified` | Must be `true` before coverage is considered complete. Caller asserts that source/discovery settings match the actual host; this does not disable host instruction discovery. |
| `global_config_dir` | Actual host global config directory for AGENTS discovery when enabled. |
| `global_discovery`, `project_discovery` | Declared host discovery policy, both enabled by default. Match the host's real policy; changing a Kasper option does not change the host. |
| `editable_agents` | Agent-ID map of explicit `{path,jsonPath?}` source identities. Use absolute paths; native config pointers are `['agents', id, 'system']`. |
| `agent_overlays` | Agent-ID map of absolute owned overlay file paths within Kasper's state directory; appends to factory system. |

Without explicit archive/config access, verified discovery and complete known
agent system text, native setup remains usable for administration but does not
invoke the judge. Configured remote instruction URLs are currently unsupported
for complete native-entrypoint coverage because it does not expose the host's
cached remote text port. They are not silently fetched a second time.

V1 standalone configuration merges in this order:

1. Global candidates: `$XDG_CONFIG_HOME/opencode` when set, otherwise
   `~/.config/opencode`; Windows also checks `%APPDATA%/opencode`; then
   `~/.opencode`. Later candidates override earlier fields.
2. `OPENCODE_CONFIG_DIR` when explicitly set.
3. The nearest project `.opencode` directory found by walking upward, or the
   invoking directory's `.opencode` when none exists.
4. The invoking directory's legacy `opencode.json` or `opencode.jsonc` `kasper`
   object, applied last. `opencode.json` is preferred here when both exist.

Invalid JSONC fails visibly. Invalid individual settings fall back through
validation/defaults. The cache has a 30-second TTL; live reload behavior must be
verified for the chosen host. Do not leave conflicting legacy nested settings
when moving to native V2's stricter host schema; move those values to the
standalone Kasper file and verify the effective status/config.

V1 `prompt_paths` and `agents_md_paths` are directory arrays (at most 50 entries);
their resolver behavior does not establish native V2 origin. Native agent source
opt-ins use exact canonical source identity, while overlays must be owned by the
Kasper state directory. Default native project guidance targets local AGENTS.md.

## Preserve state and recoverable sources

Before migration, preserve the state directory and original guidance/config
bytes, including backup receipt sidecars and migration journals. Moving state
between host profiles should not reinterpret an arbitrary old cursor as a proven
completed boundary. Check saved-session history coverage in the new host before
allowing retroactive/batch scoring.

Use an isolated project to verify effective instructions, explicit editable
targets, a guarded apply and source-keyed rollback. Native plugin-only or
transformed sources remain read-only; configure an owned append overlay when
that is the intended policy. Do not extract or rewrite a global source into a
different project destination implicitly. A differing migration destination is
a conflict, with an explicit journal recovery path.

Expiry removes active improvement metadata, not injected guidance. A restart or
catalog reload request is not activation confirmation. Review pending refresh,
coverage and recovery status before enabling automatic writes.

## Release qualification

Run [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md). Native current-window scoring,
authenticated complete archive scoring, commands/tools, cancellation, reload and
packaged V1 loading have distinct evidence requirements. Keep actual external
provider termination/billing claims separate from deterministic local fixtures.
