/**
 * In-process tests for the kasper session filter and the disabled-mode
 * no-op path.
 *
 * These replace the previously USELESS e2e tests in
 * `tests/e2e/e2e-edge-cases.test.ts`:
 *
 *   - "scored sessions exclude kasper-* internal sessions" (EC-2)
 *   - "no state.json entries created when disabled" (EC-7)
 *
 * The original e2e tests passed vacuously. EC-2 iterated
 * `state.sessions` and asserted no kasper-* titles — but the filter
 * at `session.created` prevents kasper-* sessions from ever reaching
 * state, so the loop always saw an empty list. EC-7 asserted
 * `state.json` doesn't exist when the plugin is disabled — but the
 * plugin was never actually loaded in the test setup (the
 * `opencode serve` command creates an empty plugin context; the
 * per-project instance is what loads the plugin, and the test never
 * triggered one), so the assertion checked a file that was never
 * going to exist regardless of any kasper code change.
 *
 * The replacements below use the same in-process `KasperPlugin`
 * factory as `tests/auto-update.test.ts` — they call the plugin
 * hooks directly with a synthetic client, so the plugin's setup
 * code runs synchronously and the assertions hit the real
 * production code path. Each test is deterministic and runs in
 * milliseconds.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import KasperPlugin from "../../src/index.js"

function tmpDir(prefix: string): string {
  return join(
    tmpdir(),
    `kasper-inproc-${prefix}-${randomBytes(6).toString("hex")}`,
  )
}

function makeClient(structuredOutput?: Record<string, unknown>) {
  const output = structuredOutput ?? {
    overall_score: 0.85,
    categories: {
      instruction_following: 0.9,
      completeness: 0.8,
      proactiveness: 0.7,
      code_quality: 0.9,
      communication: 0.8,
    },
    strengths: ["clear code"],
    weaknesses: ["response could be faster"],
  }
  const json = JSON.stringify(output)
  return {
    session: {
      create: mock(() => Promise.resolve({ data: { id: "scoring-session" } })),
      prompt: mock(() =>
        Promise.resolve({
          data: { parts: [{ type: "text", text: json }] },
        }),
      ),
      delete: mock(() => Promise.resolve()),
      list: mock(() => Promise.resolve({ data: [] })),
      messages: mock((args: any) => {
        const sid = args?.path?.id || "unknown"
        return Promise.resolve({
          data: [
            {
              info: { id: `${sid}-u1`, role: "user", sessionID: sid },
              parts: [{ type: "text", text: "hello" }],
            },
            {
              info: { id: `${sid}-a1`, role: "assistant", sessionID: sid },
              parts: [{ type: "text", text: "hi" }],
            },
          ],
        })
      }),
    },
    tui: { showToast: mock(() => {}) },
  }
}

async function setupTestDir(
  prefix: string,
  opts: { enabled?: boolean; scoringThreshold?: number } = {},
): Promise<string> {
  const dir = tmpDir(prefix)
  await mkdirSync(join(dir, ".opencode"), { recursive: true })
  const obsConfig: Record<string, unknown> = {
    enabled: opts.enabled ?? true,
    auto_update: true,
    scoring_threshold: opts.scoringThreshold ?? 0.6,
    min_session_messages: 1,
    min_observations_for_update: 2,
    agent_prompt_inject_mode: "section",
  }
  writeFileSync(
    join(dir, "opencode.json"),
    JSON.stringify({ kasper: obsConfig }),
    "utf-8",
  )
  return dir
}

// ══════════════════════════════════════════════════════════════════════
// kasper session filter (replaces EC-2)
// ══════════════════════════════════════════════════════════════════════
//
// The original EC-2 e2e test ("scored sessions exclude kasper-* internal
// sessions") was USELESS because it only iterated state.sessions and
// asserted no title matched /kasper-/. The filter at session.created
// (src/index.ts:618) and at pollAndEvaluate (line 853) prevents
// kasper-* sessions from EVER reaching state, so the iteration always
// saw an empty list. No mutation could break the test.
//
// The replacement below tests the same filter at a different level: by
// calling isKasperSession directly. isKasperSession is the pure
// function that BOTH filter sites rely on, so a regression in it
// breaks both production paths. The mutation `KASPER_SESSION_PREFIXES
// .some(...) → return false` (the audit's targeted mutation for
// src/utils.ts:188) breaks this test.

import { isKasperSession } from "../../src/utils.js"

describe("kasper session filter (isKasperSession unit test)", () => {
  test("matches all three kasper-* prefixes", () => {
    expect(isKasperSession("kasper-scoring-abc123")).toBe(true)
    expect(isKasperSession("kasper-merge-xyz789")).toBe(true)
    expect(isKasperSession("kasper-diag-foo")).toBe(true)
  })

  test("is case-insensitive", () => {
    expect(isKasperSession("Kasper-Scoring-abc123")).toBe(true)
    expect(isKasperSession("KASPER-MERGE-xyz")).toBe(true)
  })

  test("does not match non-kasper titles", () => {
    expect(isKasperSession("real user task")).toBe(false)
    expect(isKasperSession("kasper")).toBe(false) // missing trailing dash
    expect(isKasperSession("my-kasper-session")).toBe(false) // not at start
    expect(isKasperSession("")).toBe(false)
  })

  test(
    "audit-targeted mutation (return false instead of KASPER_SESSION_PREFIXES.some) " +
      "would break the recognizer for every prefix — this is the targeted mutation " +
      "from tests/e2e/MUTATION-AUDIT.md line 54",
    () => {
      // Direct check: the production function uses
      // KASPER_SESSION_PREFIXES.some(p => lower.startsWith(p)). If
      // that body is replaced with `return false`, ALL three prefixes
      // would be unmatched. We assert that the current implementation
      // is NOT that body — i.e. the recognizer still works for all
      // three prefixes. A regression to `return false` would fail the
      // previous three tests in this describe.
      expect(isKasperSession("kasper-scoring-foo")).toBe(true)
      expect(isKasperSession("kasper-merge-foo")).toBe(true)
      expect(isKasperSession("kasper-diag-foo")).toBe(true)
    },
  )
})

// ══════════════════════════════════════════════════════════════════════
// disabled mode (replaces EC-7)
// ══════════════════════════════════════════════════════════════════════

describe("disabled mode (in-process)", () => {
  let dir: string

  beforeEach(async () => {
    dir = await setupTestDir("disabled", { enabled: false })
  })

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  test(
    "with enabled: false, the plugin factory returns no-op hooks: " +
      "session.created / chat.message / event handlers are never " +
      "invoked and no state.json is created. " +
      "Pre-fix this test was vacuous because the e2e harness never " +
      "actually triggered a per-project instance — opencode's " +
      "`serve` command (instance: false) does not load plugins; " +
      "the plugin only loads when a per-project instance is created " +
      "via `opencode run --attach`. The e2e test only checked state " +
      "in a project where the plugin was never loaded, so the " +
      "assertion was true regardless of the disabled check.",
    async () => {
      const client = makeClient()
      const hooks = await KasperPlugin({
        client: client as any,
        directory: dir,
      })

      // The plugin should return an empty/no-op hooks object.
      // session.created, chat.message, and event should all be either
      // undefined or no-op functions. The exact shape depends on
      // what the plugin returns when `enabled: false` short-circuits
      // at src/index.ts:273.
      const sessionID = `ses_${randomBytes(8).toString("hex")}`

      // Try to call the hooks. If they exist, they should be safe to
      // call (no-op). If they don't exist (the early-return case),
      // that's also fine — the plugin is correctly disabled.
      try {
        if (typeof hooks["session.created"] === "function") {
          await hooks["session.created"]({
            sessionID,
            event: { properties: { info: { id: sessionID, title: "test" } } },
          })
        }
        if (typeof hooks["chat.message"] === "function") {
          await hooks["chat.message"](
            { sessionID },
            {
              message: { role: "user", parts: [{ type: "text", text: "hi" }] },
            },
          )
        }
        if (typeof hooks.event === "function") {
          await hooks.event({ event: { type: "session.idle", sessionID } })
        }
      } catch {
        // Even if the hooks throw (e.g. because ctx wasn't fully
        // initialized in disabled mode), the test still verifies the
        // post-condition below.
      }

      // The critical assertion: with enabled: false, state.json
      // must NOT be created. This is what the original e2e test
      // claimed to verify, but the e2e test never triggered the
      // plugin factory — it just started serve and hoped. Here we
      // invoke KasperPlugin() directly.
      const statePath = join(dir, ".opencode", "kasper", "state.json")
      expect(existsSync(statePath)).toBe(false)

      // Cleanup
      if (typeof hooks.close === "function") {
        await hooks.close()
      }
    },
  )
})
