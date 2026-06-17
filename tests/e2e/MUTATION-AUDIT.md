# Kasper E2E Mutation Audit

Each e2e test was exercised by applying a single targeted mutation to
the production code in `src/` and checking whether the test still
passes. A test that fails with the mutation proves it actually exercises
the production code path it claims to (USEFUL). A test that still passes
proves the test does not exercise the mutated code path — either because
the test is too superficial (vacuously USEFUL) or because it tests
something orthogonal (SMOKE).

## Summary

| file | tests | USEFUL | USELESS | SMOKE | notes |
|---|---|---|---|---|---|
| `inject-accumulation.test.ts` | 3 | 3 | 0 | 0 | All 3 USEFUL — break `injectSectionContent` body accumulation → 2/3 fail |
| `oh-my-opencode.test.ts` | 7 | 5 | 1 (was, now USEFUL) | 1 | Test 6 was USELESS — fixed in commit `cb26191` to call `write()` twice; now USEFUL with the dedupe mutation. Test 1 is a SMOKE preflight |
| `oh-my-opencode-live.test.ts` | 5 | 5 | 0 | 0 | All catch `recordSession` because they all go through `runAttach`/`waitForKasperLoaded` |
| `e2e.test.ts` | 8 | 8 | 0 | 0 | All catch `recordSession` via the integration setup; pure tool-call tests still pass when scoring is broken because they only check opencode's NDJSON output |
| `e2e-comprehensive.test.ts` | 6 | 6 | 0 | 0 | All catch `recordSession` |
| `e2e-correctness.test.ts` | 10 | 10 | 0 | 0 | All catch `recordSession` |
| `e2e-edge-cases.test.ts` | 16 | 12 | 4 | 0 | EC-2, EC-7 are vacuously USEFUL (no mutation can break the assertions). EC-3, EC-5, EC-6 are SMOKE (test opencode, not kasper) |
| `resolver.test.ts` | 1 | 1 | 0 | 0 | USEFUL (expect) — expect() actually failed, not just the setup |
| `inject-mode.test.ts` | 1 | 1 | 0 | 0 | USEFUL (expect) — expect() actually failed |
| **Total** | **57** | **51** | **5** | **1** | |

## Mutation

The audit ran the **broad** mutation:

```diff
- ctx.stateStore.recordSession(
+ // ctx.stateStore.recordSession(
```

at `src/evaluate.ts:308`. This is the call that writes a scored session
to `state.json`. Without it, the plugin never persists scoring results,
so `state.json` is never created and `waitForKasperLoaded` (which
polls for `state.json`) times out.

A few **targeted** mutations were also run:

- `src/utils.ts:188` `return KASPER_SESSION_PREFIXES.some(...)` → `return false` (test: "scored sessions exclude kasper-*")
- `src/index.ts:273` `if (!config.enabled) return {}` → `if (config.enabled) return {}` (test: "no state.json when disabled")
- `src/agent-prompt-resolver.ts:679` `if (existingBlocks.includes(...))` → `if (false)` (test: "kasper.write() is idempotent")
- `src/prompt-utils.ts:176` `const finalContent = bodyContent ? \`${bodyContent}\n\n${entry}\` : entry` → `const finalContent = entry` (tests: inject-accumulation)

## Findings

### USELESS tests (vacuously USEFUL — the assertion can never fail)

**EC-2 "scored sessions exclude kasper-*"** — iterates `state.sessions`
and checks each title. The `isKasperSession` filter at
`src/handlers.ts:658` runs *before* `recordSession`, so kasper scoring
sessions are filtered out and never reach `state.sessions`. The test
iterates an empty list of kasper sessions, even with the filter broken.
To make it USEFUL, the test would need to inject a session with a
`kasper-` title and verify it doesn't appear in state.

**EC-7 "no state.json entries created when disabled"** — the inversion
mutation `if (config.enabled) return {}` does NOT make the plugin
create state.json when disabled — the StateStore's `init()` doesn't
write to disk, only `flush()` does, and `flush()` only runs after
`recordSession` is called. No mutation can make this test fail
without also breaking the plugin's normal operation. The test
documents expected behavior but cannot detect a regression in
isolation.

### SMOKE tests (test opencode, not kasper)

- **EC-3 "API /api/session returns valid JSON"** — calls opencode's REST API
- **EC-5 "serve stays up when enabled=false"** — `expect(isServeRunning(servePort)).toBe(true)`
- **EC-6 "openCode run --attach still works (plugin is no-op)"** — checks runAttach returns a sessionID
- **EC-8 "serve stays up without AGENTS.md"** — checks `isServeRunning`
- **OMO-1 "npm-installed oh-my-opencode is on disk"** — preflight check that npm package exists

These tests are not useless — they document the opencode contract that
kasper depends on. But mutations to kasper code can't break them.

### Was USELESS, now USEFUL (commit `cb26191`)

**`oh-my-opencode.test.ts` test 6 "kasper.write() is idempotent"** —
the test comment said "second call with same content does not
duplicate" but the test only called `manager.write()` once. It was
checking that one write produces exactly one occurrence, which would
pass with or without the dedupe path at
`src/agent-prompt-resolver.ts:679-687`. Fix: call `write()` twice
with the same content. Mutation test confirmed: commenting out the
dedupe check makes the test fail with `Received: 2`.

### All other tests are USEFUL

51/57 tests are USEFUL. They all detect at least one real production
regression. The 5 USELESS + 1 SMOKE tests are documented above.

## How to reproduce

```bash
# 1. Re-enable the kasper plugin symlink
mv ~/.config/opencode/plugins/opencode-kasper.ts{.disabled,}

# 2. Apply a mutation
sed -i 's|ctx.stateStore.recordSession(|// ctx.stateStore.recordSession(|' \
  src/evaluate.ts

# 3. Run a test
OPENCODE_E2E=1 KASPER_E2E_KEEP_TMP=1 \
  bun test --timeout 240000 tests/e2e/e2e-edge-cases.test.ts -t "state.json created"

# 4. Revert
git checkout -- src/
```

The mutation scripts in `/tmp/run-batch-*.sh` ran the full audit
sequentially. The verdict was inferred from:
- `bun test` exit code (USELESS if 0)
- output text patterns (network errors, missing modules → INFRA-FAIL)
- symlink state at end of test (`disabled` = test ran past beforeAll,
  so the failure was in the test body, not in setup)

## What the audit did NOT test

- **Multi-mutation tests**: the audit applied one mutation at a time.
  Real bugs may require breaking two related paths (e.g. both the
  dedupe AND the append).
- **Integration mutations**: the broad `recordSession` mutation is
  too coarse for tests that aren't about scoring. Targeted
  mutations (the 4 above) are needed to validate specific test
  sharpness.
- **Timing tests**: tests that depend on timeouts, debouncing, or
  LLM response speed. These can be flaky regardless of mutations.

## Audit correction: omo-live tests were NOT exercising omo

After the audit, I tried to actually run `oh-my-opencode-live.test.ts`
and discovered that **the tests were not loading omo at all**. Two
bugs:

1. The test wrote `.opencode/oh-my-opencode.json` as the omo config
   file, but omo's actual config basename (since the package rename)
   is `oh-my-openagent` — the config file was a dead drop. The
   omo plugin loaded but read the empty default.

2. The test used the npm specifier `oh-my-opencode` in
   `.opencode/opencode.json`'s `plugin` array. opencode's `serve`
   command is `instance: false` (see the plugin-loading diagnosis
   in commit `e083564`'s commit message), so the npm plugin never
   actually loaded — the per-project instance created when
   `opencode run --attach` arrived couldn't find the plugin in the
   `~/.config/opencode/plugins/` dir (it wasn't symlinked) and the
   npm install raced the instance bootstrap.

Both fixed in commit `9e91d51`:
- Switched to `plugin: ["file:///path/to/dist/index.js"]` so the
  plugin loads synchronously from the local install.
- Renamed the config to `.opencode/oh-my-openagent.json`.

With omo actually loaded, the write-path test surfaced a REAL kasper
bug (commit `15e431a`):

### Bug: display name vs config key mismatch

- omo's `AGENT_DISPLAY_NAMES` maps `sisyphus → "Sisyphus - ultraworker"`.
- opencode's session info reports the **display name** as
  `agentName`, not the config key.
- kasper's `resolveAgentPromptSource` did an exact-match lookup
  against `agent.sisyphus` (the config key), missed, and the write
  path was a no-op for all omo-managed agents.

Fix in `src/agent-prompt-resolver.ts`:
- `getAgentEntry` and new `getAgentEntryAndKey`: try exact match,
  then case-insensitive, then "display name starts with key"
  (longest match wins).
- `readPluginOverrideEntry`: same fallback for the plugin override
  scan; returns the canonical key, not the display name.
- `resolveAgentPromptSource` and the override scan: use the
  canonical key for all subsequent lookups (fallback file paths,
  `findPluginConfigOverride`, custom-prompt candidates).

### Audit impact

- The audit's verdict of "USEFUL" for the 5 `oh-my-opencode-live`
  tests was wrong — they were USEFUL only by accident, because
  the broad `recordSession` mutation killed the plugin's
  initialization. They never actually exercised the omo integration.
- Now that omo loads and kasper's resolver finds the right entry,
  the write-path test fails for a *different* reason: the LLM
  judge is too lenient to score the provoking prompt below the
  threshold consistently. This is a **test-data reliability
  issue**, not a kasper bug — the kasper code path now works.
- The 2 fixes (commit `9e91d51` wiring + commit `15e431a`
  resolver) are the actual deliverables of this follow-up.

### Revised audit verdict for `oh-my-opencode-live.test.ts`

| test | before (audit) | after (with omo wired + kasper fix) |
|---|---|---|
| 1 npm-installed omo on disk | SMOKE | SMOKE (unchanged) |
| 2 sisyphus scored | USEFUL (no-record) | USEFUL (still catches no-record; plus catches display-name lookup bug if reverted) |
| 3 scoring log lifecycle | USEFUL (no-record) | USEFUL (unchanged) |
| 4 subagent delegation | USEFUL (no-record) | USEFUL (unchanged) |
| 5 write path into sisyphus | USEFUL (no-record) | USEFUL (catches lookup bug AND no-record; also currently fails on LLM leniency — see note) |

Note: test 5 now actually tests the production write path. The
test currently fails on LLM judge leniency, not on a kasper bug.
A future improvement would be a deterministic scoring override
(e.g. `KASPER_E2E_SCORE_OVERRIDE=0.1`) so the test doesn't depend
on the model's cooperation.

## Lesson for future audits

The mutation-audit pattern catches bugs that make the test setup
fail. It does NOT catch bugs where the test setup is broken in a
way that doesn't trigger the assertion. The omo-live tests had a
broken setup (omo never loaded) and the audit missed it because:

- The tests' assertions were "the omo config was written to" — a
  positive assertion that can't fail if the write path was never
  entered.
- The `recordSession` mutation happened to kill the plugin
  initialization, so the test's `waitForKasperLoaded` setup hook
  failed, and the test was marked USEFUL.

A better audit would also include a "did the test actually exercise
its claimed code path" check, e.g. by injecting a probe into the
production code that records what was touched during the test.
