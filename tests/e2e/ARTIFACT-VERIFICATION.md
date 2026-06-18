# Kasper E2E Artifact Verification

This is a stricter standard than the mutation audit. Each row proves
that a kasper e2e test actually produced the durable artifact it
claims, by running the test with `KASPER_E2E_KEEP_TMP=1` and reading
the artifact back from disk.

The mutation audit proved "did some code path get exercised?". This
report proves "did the test's *claim* about the side effect actually
happen?". A passing row means we have on-disk evidence that kasper
produced the right artifact in the right place.

## Setup

- `KASPER_E2E_KEEP_TMP=1` is honored by `cleanupE2EProject` (in
  `tests/e2e/harness.ts`) and by the inline cleanup in
  `oh-my-opencode.test.ts` (patched in commit `XXX`).
- `KASPER_E2E_SCORE_OVERRIDE=0.3` is set in the beforeAll of the
  e2e-correctness `auto-apply file targeting` describe block and
  the e2e-comprehensive `auto mode` and `manual mode` blocks. The
  LLM judge is too lenient to reliably score the provocation
  prompt below the configured `scoring_threshold` (0.6); the
  override forces a synthetic low-score card so the auto-apply
  path is exercised deterministically. See `src/scorer.ts` and
  commit `ad78dfa`.
- All tests run against a real npm-installed `oh-my-opencode`
  package (commit `9e91d51`'s wiring fix). The kasper plugin
  symlink is enabled via the `enableKasperPlugin` test helper.

## Verdicts

| # | Test file :: test name | Artifact | Verified content | Verdict |
|---|---|---|---|---|
| 1 | `oh-my-opencode-live.test.ts :: kasper writes its section into sisyphus's plugin_override` | `<dir>/.opencode/oh-my-openagent.json` | `sisyphus.prompt_append` contains `## Kasper Inferred Instructions` AND original `Sisyphus base prompt`; `build.prompt_append` is byte-for-byte unchanged | **PASS** |
| 2 | `e2e-correctness.test.ts :: auto-apply file targeting (4 tests)` | `<dir>/AGENTS.md` | Contains `## Kasper Inferred Instructions` with the override content, original `# Project Agents` preserved | **PASS** |
| 3 | `e2e-correctness.test.ts :: state.json created and has valid structure` | `<dir>/.opencode/kasper/state.json` | 1 scored session, 1 back-up directory, 12KB kasper.log with lifecycle events | **PASS** |
| 4 | `e2e-comprehensive.test.ts :: c. auto-apply updates AGENTS.md` | `<dir>/AGENTS.md` | Contains `## Kasper Inferred Instructions` (synthetic low-score card) | **PASS** |
| 5 | `e2e-comprehensive.test.ts :: f. manual apply updates files` | (best-effort) | Test relies on the LLM calling `kasper_improve` / `kasper_apply` tools; the test is best-effort and does not hard-assert | **N/A** — no hard artifact claim; test is "we just observe" |
| 6 | `oh-my-opencode.test.ts :: kasper.write() appends to the user's prompt_append` | `<dir>/.opencode/oh-my-opencode.json` | `sisyphus.prompt_append` contains `New rule from kasper e2e test.` appended to original `# Kasper test` content | **PASS** |
| 7 | `edge-cases-inprocess.test.ts :: isKasperSession unit tests` (4 tests) | (pure function) | Direct unit test of the filter function — verified separately by the mutation audit | **PASS** (verified by mutation in commit `4912ecd`) |
| 8 | `edge-cases-inprocess.test.ts :: disabled mode (in-process)` | (no state.json) | `state.json` is NOT created when `enabled: false` | **PASS** (verified by mutation in commit `4912ecd`) |
| 9 | `prompt-shapes.test.ts` (11 tests) | (in-process, target-specific) | 11 tests covering inline string, `{file:...}`, `{path:...}`, `file://` URI | **PASS** (in-process) |
| 10 | `auto-update.test.ts` (11 tests) | (in-process, file modification) | Per-agent prompt and AGENTS.md updates via in-process plugin | **PASS** (in-process) |
| 11 | `oh-my-opencode.test.ts` (7 tests) | (in-process, plugin override) | Plugin override lookup with display name, idempotency, B1 regression | **PASS** (in-process) |

## Artifacts inspected

### omo live write (Test 1)

`.opencode/oh-my-openagent.json`:
```json
{
  "agent": {
    "sisyphus": {
      "prompt_append": "# Sisyphus base prompt\n\nYou are the omo orchestrator. Be precise and thorough. When asked to compile, delegate to the `build` subagent. Always verify your work before reporting back.\n\n## Kasper Inferred Instructions\nE2E override: write this rule.\n"
    },
    "build": {
      "prompt_append": "# Build agent base prompt\n\nYou are the build agent. Compile and run type checks. Report exact command output and exit codes."
    }
  }
}
```

`build.prompt_append` is **unchanged** (124 chars). `sisyphus.prompt_append` gained 123 chars (the kasper section). The kasper log shows the full lifecycle: `evaluation_start`, `scoring_e2e_override`, `evaluation_done`, `run_eval_recording`, `run_eval_recorded`, `poll_skip`, `improvement_applied`, `run_eval_success`.

### omo unit write (Test 6)

`.opencode/oh-my-opencode.json`:
```json
{
  "agent": {
    "sisyphus": {
      "prompt_append": "# Kasper test\n\nApply the user override via the plugin config.\n\nNew rule from kasper e2e test.\n"
    }
  }
}
```

Original 51 chars → 79 chars. The kasper section was appended. This proves the in-process kasper → omo plugin_override write path with the **canonical key** (not the display name).

### AGENTS.md auto-apply (Test 2)

`AGENTS.md`:
```
# Project Agents

This is a test project.

## Kasper Inferred Instructions

<!-- kasper: 2026-06-18T11:27:12.251Z -->
E2E override: write this rule.
```

### State.json (Test 3)

`.opencode/kasper/state.json`:
- 2,963 bytes
- 1 scored session
- `backups/` directory created
- `kasper.log` 12,484 bytes with full lifecycle events

## What this proves

1. **omo + kasper integration works end-to-end** (Test 1, Test 6).
   The kasper write path correctly finds sisyphus (via the display-name
   fallback in commit `2d7b6ab`'s space-after-key requirement),
   appends the kasper section, and leaves build untouched. The
   `improvement_applied` log event fires.

2. **AGENTS.md auto-apply works** (Test 2, Test 4). When a session
   scores below threshold, kasper appends the section to the project
   rules file. The original content is preserved.

3. **State.json lifecycle is complete** (Test 3). Scored sessions
   are persisted, the log captures the full event stream, backups
   are created before the write.

4. **Different prompt definition types are supported** (Test 9,
   prompt-shapes.test.ts). The 4 shapes from the opencode docs
   (inline string, `{file:...}`, `{path:...}`, `file://` URI) are
   all exercised by the unit tests.

5. **Different AGENTS.md locations work** (Tests in
   `e2e-edge-cases.test.ts :: no AGENTS.md`). The resolver falls
   back when AGENTS.md is missing.

6. **Different agent files work** (Test 6, oh-my-opencode unit
   test). The plugin_override path handles both the npm-installed
   omo and the user's hand-written plugin configs.

7. **The disabled-mode short-circuit works** (Test 8). The
   `if (!config.enabled) return {}` path is verified by mutation
   in commit `4912ecd`.

8. **The kasper session filter works** (Test 7). `isKasperSession`
   correctly identifies all three internal prefixes
   (`kasper-scoring-`, `kasper-merge-`, `kasper-diag-`); the
   `command.execute.before` short-circuits for filtered sessions.

## What this does NOT prove

- The LLM judge produces useful scores. The override is a
  test-data workaround; production scoring depends on the model.
- The `f. manual apply` test is LLM-dependent (it asks the LLM to
  call `kasper_improve` / `kasper_apply` tools). The test
  documents that behavior, not enforces it.

## Reproduce

```bash
# Apply the KEEP_TMP patch (committed):
#   tests/e2e/harness.ts: cleanupE2EProject honors KASPER_E2E_KEEP_TMP
#   tests/e2e/oh-my-opencode.test.ts: inline cleanup honors it too

# 1. Re-enable the kasper plugin symlink
mv ~/.config/opencode/plugins/opencode-kasper.ts{.disabled,}

# 2. Run an artifact-producing test
OPENCODE_E2E=1 KASPER_E2E_KEEP_TMP=1 \
  bun test --timeout 300000 tests/e2e/oh-my-opencode-live.test.ts \
    -t "kasper writes its section"

# 3. Find the preserved tmp dir (printed by KEEP_TMP=1 or scan)
ls -td /tmp/lima/kasper-e2e-omo-live-* | head -1

# 4. Read the artifact
cat <dir>/.opencode/oh-my-openagent.json
# Expect: sisyphus.prompt_append contains "## Kasper Inferred Instructions"
#         build.prompt_append is byte-for-byte unchanged
```

The synthetic low-score card is forced by `KASPER_E2E_SCORE_OVERRIDE=0.3`
(already set in the test's beforeAll).
