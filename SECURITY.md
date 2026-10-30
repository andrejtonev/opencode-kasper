# Security boundaries

Agent Markdown is treated as data. Kasper accepts YAML and JSON frontmatter and
rejects executable or unsupported languages before parsing, including for
read-only source attribution. Writes still require explicit editable provenance
and conflict checks.

The V1 tool adapter uses the package's patched Zod dependency; it does not load
the legacy SDK at runtime. Native SDK and Effect versions remain pinned. Run
`bun install --frozen-lockfile`, `bun audit`, and both SDK contract checks when
updating dependencies. Development overrides also patch transitive Zod and TOML;
consumer projects must audit their own installed dependency graph.

Diagnostic output redacts recognized credentials, authentication fields, email
addresses and home-directory identities. This is defense in depth, not a promise
that arbitrary sensitive text will be recognized. Stored observations and
instruction backups preserve their original content for correct operation and
rollback. Keep state directories private and review artifacts before sharing.

The local HTTP test helper sends authentication through a subprocess stdin pipe,
uses no shell, permits only loopback HTTP and omits provider credentials from its
child environment. Native acceptance uses an isolated local provider fixture.

Private launch scripts, runtime data and audit evidence are excluded from Git and
the package's dist-only allowlist. CI uses pinned action revisions and a
read-only repository token without persisted checkout credentials.

Generation cancellation and retained-output limits do not guarantee termination
at a provider or a billing limit. See the native acceptance report for measured
capabilities and release qualification.
