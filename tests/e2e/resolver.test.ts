/**
 * End-to-end regression test for the {file:...} directive fix.
 *
 * Setup: a project opencode.json declares `pr-reviewer` with
 * `prompt: "{file:/tmp/.../real-prompt.md}"`. Kasper is configured with
 * auto_update and a low scoring_threshold so the session evaluation
 * generates and applies an improvement.
 *
 * Assertion: the Kasper Inferred Instructions section ends up in the
 * REAL prompt file (the one referenced by {file:...}), not in a new
 * .opencode/agents/pr-reviewer.md stub at the project root. This is
 * the bug fix scenario from the original report.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { execSync } from "node:child_process"
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { disableKasperPlugin, enableKasperPlugin } from "./harness.js"

const ENABLED =
  process.env.OPENCODE_E2E === "1" &&
  (() => {
    try {
      execSync("opencode --version", { stdio: "pipe" })
      return true
    } catch {
      return false
    }
  })()

describe.skipIf(!ENABLED)(
  "e2e: agent prompt resolver honours {file:...} directive",
  () => {
    let projectDir: string
    let targetPath: string
    let pluginEnabled = false
    const realPromptOriginal = [
      "# Real Reviewer",
      "",
      "Follow the delegation protocol strictly.",
      "",
    ].join("\n")

    beforeAll(() => {
      // Enable the kasper plugin symlink so `opencode run` below
      // actually loads it. Without this, the plugin is .disabled
      // and the test passes vacuously (no scoring, no write).
      enableKasperPlugin()
      pluginEnabled = true

      projectDir = mkdtempSync(join(tmpdir(), "kasper-e2e-resolver-"))
      targetPath = join(projectDir, "real-prompt.md")
      writeFileSync(targetPath, realPromptOriginal, "utf-8")

      writeFileSync(
        join(projectDir, "opencode.json"),
        JSON.stringify(
          {
            $schema: "https://opencode.ai/config.json",
            agent: {
              "pr-reviewer": { prompt: `{file:${targetPath}}` },
            },
            kasper: {
              enabled: true,
              auto_update: true,
              scoring_threshold: 0.0,
              min_session_messages: 1,
              min_observations_for_update: 1,
              evaluation_poll_interval_ms: 2000,
              state_dir: ".opencode/kasper",
            },
          },
          null,
          2,
        ),
        "utf-8",
      )
      writeFileSync(join(projectDir, "AGENTS.md"), "# Test project\n", "utf-8")
    })

    afterAll(() => {
      if (projectDir) rmSync(projectDir, { recursive: true, force: true })
      if (pluginEnabled) {
        disableKasperPlugin()
        pluginEnabled = false
      }
    })

    test(
      "writes Kasper Inferred Instructions to the real {file:...} target, not a new project stub",
      async () => {
        // Trigger a session with the pr-reviewer agent. The plugin's
        // background loop evaluates it and (with threshold 0.0) will
        // generate an improvement and inject it.
        const userMessage =
          "Please review: pretend there is a 5-line PR to review."
        const cmd = [
          "opencode",
          "run",
          "--agent",
          "pr-reviewer",
          "--message",
          JSON.stringify(userMessage),
        ].join(" ")
        try {
          execSync(cmd, {
            cwd: projectDir,
            stdio: "pipe",
            timeout: 90_000,
          })
        } catch {
          // opencode run may exit non-zero on its own; we don't care, we
          // only need it to have loaded the plugin and tracked a session.
        }

        // Wait long enough for: session idle → eval poll (2s) → score →
        // improvement queue → inject. The eval is LLM-driven and may take
        // 10–30s on slow models.
        const deadline = Date.now() + 90_000
        let injectedToReal = false
        let stubExists = false
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 3_000))
          const real = readFileSync(targetPath, "utf-8")
          if (real.includes("Kasper Inferred Instructions")) {
            injectedToReal = true
            break
          }
          const stubPath = join(
            projectDir,
            ".opencode",
            "agents",
            "pr-reviewer.md",
          )
          stubExists = existsSync(stubPath)
          if (stubExists) break
        }

        // The REAL prompt file must contain the injected section.
        // If scoring never produced an improvement, we can't strictly
        // assert it — but if a stub file appeared, that would be the
        // regression we're guarding against.
        const real = readFileSync(targetPath, "utf-8")
        expect(real).toContain(realPromptOriginal.split("\n")[0])

        const stubPath = join(
          projectDir,
          ".opencode",
          "agents",
          "pr-reviewer.md",
        )
        if (existsSync(stubPath)) {
          const stub = readFileSync(stubPath, "utf-8")
          // If a stub exists, it must NOT be a brand-new empty file with
          // only frontmatter. The old bug would create exactly that.
          const stripped = stub
            .replace(/^---[\s\S]*?---\n*/, "")
            .replace(/<!-- kasper:[^>]+-->\n*/g, "")
            .trim()
          expect(stubbed_isMeaningful(stripped)).toBe(true)
        }

        // HARD assertion: with scoring_threshold=0.0,
        // min_observations_for_update=1, and a clearly-shoddy
        // (zero-context) user message, kasper MUST produce a card and
        // inject into the {file:...} target. The previous version
        // logged "No injection observed" and passed, which masked
        // the disabled-plugin bug.
        expect(injectedToReal).toBe(true)
        console.log("✓ Kasper injected into the {file:...} target")
      },
      { timeout: 180_000 },
    )
  },
)

function stubbed_isMeaningful(content: string): boolean {
  // A meaningful stub has at least the original prompt body, not just
  // frontmatter + an injected section.
  return content.length > 50
}
