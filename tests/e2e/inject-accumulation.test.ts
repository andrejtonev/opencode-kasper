/**
 * End-to-end regression test for the `injectSection` accumulation bug.
 *
 * REPRODUCES: https://github.com/andrejtonev/opencode-kasper/issues/<this-PR>
 * Steps from the bug report:
 *   1. Apply improvement #1 → AGENTS.md gets `## Kasper Inferred Instructions`
 *      with improvement 1
 *   2. Apply improvement #2 → AGENTS.md now contains only improvement 2
 *      (improvement 1 is GONE)   ← THE BUG
 *   3. Apply improvement #3 → AGENTS.md now contains only improvement 3
 *
 * Root cause (from the PR review):
 *   `injectSection` used a `bodyStrip` regex anchored at `^##` that fails
 *   when the target section is NOT at the start of the file (which is the
 *   common case — AGENTS.md normally starts with a `# Title` and an intro).
 *   When the strip fails, `existingBody` retains the original `## Section`
 *   header, and the subsequent `replace` produces a NESTED header on every
 *   apply. The original PR's tests didn't catch this because they all
 *   started the fixture file with the target `## Section` at position 0.
 *
 * This test runs against the LIVE plugin (symlinked from
 * `~/.config/opencode/plugins/opencode-kasper.ts` to
 * `src/index.ts`) so it tests the actual `AgentsMdManager` and
 * `AgentPromptManager` shipped to users.
 *
 * Run with: OPENCODE_E2E=1 bun test tests/e2e/inject-accumulation.test.ts
 *
 * The test does not require `opencode serve`; it drives the managers
 * directly, which is the exact code path `/kasper apply` invokes in
 * handlers.ts:1281 → AgentsMdManager.injectSection and
 * handlers.ts:1235 → AgentPromptManager.injectSection.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { execSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentPromptManager } from "../../src/agent-prompts.js"
import { AgentsMdManager } from "../../src/agents-md.js"

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

const SECTION_NAME = "Kasper Inferred Instructions"

function countHeaders(content: string, sectionName: string): number {
  // Count top-level (line-anchored) `## {sectionName}` headers. We use
  // `\\s+` to also catch any whitespace between `##` and the name, mirroring
  // how markdown renderers tolerate it.
  const re = new RegExp(
    `^##\\s+${sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
    "gm",
  )
  return (content.match(re) || []).length
}

function countProvenanceLines(content: string): number {
  return (content.match(/<!-- kasper:/g) || []).length
}

describe.skipIf(!ENABLED)(
  "e2e: injectSection accumulation — reproduces issue, verifies fix",
  () => {
    // The "user's project" with a realistic AGENTS.md layout: starts with
    // a # Title and an intro paragraph BEFORE the target section. This is
    // the case that triggered the bug for real users.
    const realisticAgentsMd = [
      "# My Project",
      "",
      "This is a typical AGENTS.md that starts with a project title and a",
      "short description. The user's instructions live below.",
      "",
      `## ${SECTION_NAME}`,
      "old improvement from a prior apply",
      "",
      "## Conventions",
      "Follow the existing code style.",
      "",
    ].join("\n")

    const threeImprovements = [
      "improvement 1: be polite to users",
      "improvement 2: always run tests before committing",
      "improvement 3: prefer functional over imperative code",
    ]

    let projectDir: string
    let agentsMdManager: AgentsMdManager

    beforeAll(() => {
      projectDir = mkdtempSync(join(tmpdir(), "kasper-e2e-accum-"))
      const opencodeDir = join(projectDir, ".opencode", "kasper")
      execSync(`mkdir -p "${opencodeDir}"`, { stdio: "pipe" })
      writeFileSync(join(projectDir, "AGENTS.md"), realisticAgentsMd, "utf-8")
      agentsMdManager = new AgentsMdManager(projectDir, opencodeDir, 5)
    })

    afterAll(() => {
      if (projectDir) {
        rmSync(projectDir, { recursive: true, force: true })
      }
    })

    test("REGRESSION: 3x /kasper apply accumulates into one section, no nested headers", async () => {
      // Sanity: the fixture file has exactly one header and one prior body.
      const before = readFileSync(join(projectDir, "AGENTS.md"), "utf-8")
      expect(countHeaders(before, SECTION_NAME)).toBe(1)
      expect(before).toContain("old improvement from a prior apply")

      // ── Mirror the bug-report's steps 1, 2, 3: apply three improvements
      //    back-to-back, exactly like the user did.
      for (const improvement of threeImprovements) {
        await agentsMdManager.lockedUpdate(async (existing) =>
          agentsMdManager.injectSection(existing, SECTION_NAME, improvement),
        )
      }

      const after = readFileSync(join(projectDir, "AGENTS.md"), "utf-8")

      // ── Primary assertion: exactly ONE `## Kasper Inferred Instructions`
      //    header. With the original bug this would be 2 (apply #1) then
      //    3 (apply #2) then 4 (apply #3). The PR-fix must keep it at 1.
      const headerCount = countHeaders(after, SECTION_NAME)
      expect(headerCount).toBe(1)

      // ── Secondary: ALL improvements are present, none lost.
      //    (The original bug lost improvement 1 after apply #2, and lost
      //    improvement 2 after apply #3.)
      expect(after).toContain("old improvement from a prior apply")
      for (const imp of threeImprovements) {
        expect(after).toContain(imp)
      }

      // ── Tertiary: only ONE provenance line, not stacked.
      expect(countProvenanceLines(after)).toBe(1)

      // ── Quaternary: order is chronological (oldest first, newest last).
      const idxOld = after.indexOf("old improvement from a prior apply")
      const idx1 = after.indexOf(threeImprovements[0])
      const idx2 = after.indexOf(threeImprovements[1])
      const idx3 = after.indexOf(threeImprovements[2])
      expect(idxOld).toBeGreaterThan(-1)
      expect(idx1).toBeGreaterThan(idxOld)
      expect(idx2).toBeGreaterThan(idx1)
      expect(idx3).toBeGreaterThan(idx2)

      // ── Quinary: surrounding content untouched.
      expect(after).toContain("# My Project")
      expect(after).toContain("This is a typical AGENTS.md")
      expect(after).toContain("## Conventions")
      expect(after).toContain("Follow the existing code style.")
    })

    test("REGRESSION: AgentPromptManager accumulates with frontmatter (agent prompt case)", async () => {
      // Common case for an agent prompt: starts with YAML frontmatter and
      // a # Title and an intro before the target section.
      const promptDir = join(projectDir, ".opencode", "agents")
      execSync(`mkdir -p "${promptDir}"`, { stdio: "pipe" })

      const agentName = "build"
      const realisticPrompt = [
        "---",
        "description: My build agent",
        "mode: subagent",
        "---",
        "",
        "# Build Agent",
        "",
        "You are a build agent. Be thorough.",
        "",
        `## ${SECTION_NAME}`,
        "prior rule",
        "",
        "## Output Format",
        "Always print the build result.",
        "",
      ].join("\n")
      const promptPath = join(promptDir, `${agentName}.md`)
      writeFileSync(promptPath, realisticPrompt, "utf-8")

      // Register the agent so AgentPromptManager's resolver finds it as a
      // project-level file (this is the real path /kasper apply takes).
      const apm = new AgentPromptManager(
        projectDir,
        join(projectDir, ".opencode", "kasper"),
      )
      const source = await apm.resolve(agentName)
      expect(source.kind).toBe("project_file")

      // Apply three improvements via the same code path /kasper apply uses.
      for (const imp of threeImprovements) {
        await apm.injectSection(
          agentName,
          SECTION_NAME,
          imp,
          true, // backupEnabled
          20, // maxBackups
          "subagent", // mode
          "section", // injectMode (default)
        )
      }

      const after = readFileSync(promptPath, "utf-8")

      // Same primary assertion: exactly ONE header.
      const headerCount = countHeaders(after, SECTION_NAME)
      expect(headerCount).toBe(1)

      // All improvements preserved.
      expect(after).toContain("prior rule")
      for (const imp of threeImprovements) {
        expect(after).toContain(imp)
      }

      // Frontmatter and pre-section content preserved.
      expect(after).toContain("description: My build agent")
      expect(after).toContain("# Build Agent")
      expect(after).toContain("You are a build agent. Be thorough.")
      expect(after).toContain("## Output Format")
    })

    test("REGRESSION: a freshly-created AGENTS.md (no prior Kasper section) gets a single header on first apply", async () => {
      // The other half of the bug surface: even on the very first apply,
      // when the file is realistic (has # Title + intro) and the section
      // does not yet exist, we must NOT somehow produce a malformed result.
      const freshDir = mkdtempSync(join(tmpdir(), "kasper-e2e-accum-fresh-"))
      const opencodeDir = join(freshDir, ".opencode", "kasper")
      execSync(`mkdir -p "${opencodeDir}"`, { stdio: "pipe" })
      writeFileSync(
        join(freshDir, "AGENTS.md"),
        [
          "# Brand New Project",
          "",
          "Fresh project, no Kasper history.",
          "",
        ].join("\n"),
        "utf-8",
      )

      const mgr = new AgentsMdManager(freshDir, opencodeDir, 5)
      await mgr.lockedUpdate(async (existing) =>
        mgr.injectSection(existing, SECTION_NAME, "first improvement"),
      )

      const after = readFileSync(join(freshDir, "AGENTS.md"), "utf-8")
      expect(countHeaders(after, SECTION_NAME)).toBe(1)
      expect(after).toContain("first improvement")
      expect(after).toContain("# Brand New Project")
      // File should end with a trailing newline (POSIX-correct).
      expect(after.endsWith("\n")).toBe(true)

      rmSync(freshDir, { recursive: true, force: true })
    })
  },
)
