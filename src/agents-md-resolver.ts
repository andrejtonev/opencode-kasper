/**
 * Resolve which file on disk is the project's rules file that kasper
 * should read and write to. This mirrors opencode's documented rules
 * selection logic (https://opencode.ai/docs/rules) so that when kasper
 * injects an improvement, it lands in the same file the LLM is reading.
 *
 * Resolution order (first existing file wins):
 *
 *   1. Per configured `agentsMdPaths` (kasper-native). For each path in
 *      order, check `<path>/AGENTS.md` then `<path>/CLAUDE.md`. First hit
 *      becomes the primary. If no entry has an existing file but
 *      `agentsMdPaths` is non-empty, the first entry's `AGENTS.md` is the
 *      write target (kasper creates it on first write).
 *
 *   2. Local walk-up from `projectRoot`. For each ancestor directory
 *      starting at `projectRoot` and walking up, check
 *      `<dir>/AGENTS.md` then `<dir>/CLAUDE.md`. First hit wins. SKIPPED
 *      when step 1 found a primary — explicit user config always wins
 *      over ambient discovery.
 *
 *   3. Global opencode dir: `<globalOpencodeDir>/AGENTS.md` then
 *      `CLAUDE.md`. First hit wins. Consulted when no earlier step
 *      produced a primary.
 *
 *   4. Claude Code global: `~/.claude/CLAUDE.md`. Skipped when
 *      `OPENCODE_DISABLE_CLAUDE_CODE=1` or
 *      `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT=1` is set.
 *
 *   5. Custom config dir: when `OPENCODE_CONFIG_DIR` is set, treat the
 *      same as a configured entry — `<dir>/AGENTS.md` then
 *      `<dir>/CLAUDE.md`.
 *
 *   6. Final fallback (write target when nothing exists): the first
 *      entry's `AGENTS.md` if `agentsMdPaths` is non-empty, else
 *      `<projectRoot>/AGENTS.md` (the historical default).
 *
 * Other files discovered during resolution are NOT consulted by kasper
 * for read or write. Per the user's design decision, kasper edits the
 * primary file only — the other files are user/system-managed and
 * reading them into kasper's view would just confuse the picture.
 */

import { homedir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import {
  candidateGlobalOpencodeDirs,
  expandTilde,
  fileExists,
} from "./path-utils.js"

const MAX_WALKUP_DEPTH = 32

export interface AgentsMdSource {
  /**
   * The file kasper will read from and write to. Always an absolute
   * path. May point at a file that does not yet exist — that is fine,
   * kasper creates it on first write.
   */
  primary: string
  /**
   * Every other file the resolver considered (in priority order). Useful
   * for diagnostics; kasper does not read or write to any of these.
   */
  candidates: string[]
  /**
   * Why this file won. Useful for `/kasper diagnose` and tests.
   */
  reason:
    | "configured-explicit"
    | "configured-default"
    | "local-walkup"
    | "global-opencode"
    | "global-claude"
    | "opencode-config-dir"
    | "fallback-project-root"
}

export interface ResolveAgentsMdOptions {
  /**
   * Kasper-native field. Each entry is a directory; kasper looks for
   * `<dir>/AGENTS.md` and `<dir>/CLAUDE.md` inside it. Paths may be
   * absolute, project-relative, or start with `~/`. Empty / undefined
   * skips step 1 of the algorithm.
   */
  agentsMdPaths?: string[]
  /**
   * Override the global opencode dir used in step 3. Defaults to the
   * standard candidates (`$XDG_CONFIG_HOME/opencode`, win32 APPDATA,
   * `~/.opencode`). If the user passes a value, that value is tried
   * first.
   */
  globalOpencodeDir?: string
  /**
   * Override the home directory used in step 4 (`~/.claude/CLAUDE.md`).
   * Defaults to `os.homedir()`. Tests use this to point the resolver at
   * a sandbox.
   */
  homeDir?: string
  /**
   * Maximum number of parent directories to walk in step 2. Defaults to
   * 32 (more than enough for any reasonable directory tree, but
   * prevents runaway walks in pathological inputs like a symlink loop).
   */
  maxWalkupDepth?: number
}

function expandAgentsMdPath(
  raw: string,
  projectRoot: string,
  home: string,
): string {
  const expanded = expandTilde(raw.trim(), home)
  return isAbsolute(expanded) ? expanded : join(projectRoot, expanded)
}

async function firstExisting(
  ...candidates: string[]
): Promise<string | undefined> {
  for (const c of candidates) {
    if (await fileExists(c)) return c
  }
  return undefined
}

/**
 * Read a list of env var names, returning true if any is set to a truthy
 * value (anything other than "0", "false", or "").
 */
function envIsTruthy(...names: string[]): boolean {
  for (const n of names) {
    const v = process.env[n]
    if (v !== undefined && v !== "" && v !== "0" && v !== "false") {
      return true
    }
  }
  return false
}

/**
 * Walk up from `startDir` collecting every ancestor directory up to
 * `maxDepth` levels. The first element is `startDir` itself, the last
 * is the filesystem root. Stops early if `dirname(current) === current`
 * (i.e. we've reached the root).
 */
function ancestors(startDir: string, maxDepth: number): string[] {
  const out: string[] = []
  let current = startDir
  for (let i = 0; i < maxDepth; i++) {
    out.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return out
}

/**
 * Resolve the project's rules file. See the file-level JSDoc for the
 * full algorithm.
 */
export async function resolveAgentsMdSource(
  projectRoot: string,
  options: ResolveAgentsMdOptions = {},
): Promise<AgentsMdSource> {
  const home = options.homeDir ?? homedir()
  const maxDepth = options.maxWalkupDepth ?? MAX_WALKUP_DEPTH
  const configured = options.agentsMdPaths ?? []
  const candidates: string[] = []

  // Step 1: explicit kasper-native `agentsMdPaths`. First entry whose
  // AGENTS.md OR CLAUDE.md exists becomes the primary. If none exists
  // but the list is non-empty, the first entry's AGENTS.md is the
  // write target.
  if (configured.length > 0) {
    let firstMissingDir: string | undefined
    for (const raw of configured) {
      const dir = expandAgentsMdPath(raw, projectRoot, home)
      const agents = join(dir, "AGENTS.md")
      const claude = join(dir, "CLAUDE.md")
      candidates.push(agents, claude)
      const hit = await firstExisting(agents, claude)
      if (hit) {
        return { primary: hit, candidates, reason: "configured-explicit" }
      }
      if (firstMissingDir === undefined) firstMissingDir = dir
    }
    if (firstMissingDir !== undefined) {
      return {
        primary: join(firstMissingDir, "AGENTS.md"),
        candidates,
        reason: "configured-default",
      }
    }
  }

  // Step 2: local walk-up from projectRoot. AGENTS.md wins over
  // CLAUDE.md at each level (per opencode's documented rules
  // precedence).
  for (const dir of ancestors(projectRoot, maxDepth)) {
    const agents = join(dir, "AGENTS.md")
    const claude = join(dir, "CLAUDE.md")
    candidates.push(agents, claude)
    const hit = await firstExisting(agents, claude)
    if (hit) {
      return { primary: hit, candidates, reason: "local-walkup" }
    }
  }

  // Step 3: global opencode dir. Try the caller-provided one first,
  // then the standard candidates (XDG_CONFIG_HOME/opencode, APPDATA
  // on win32, ~/.opencode).
  const globalDirs = options.globalOpencodeDir
    ? [
        options.globalOpencodeDir,
        ...candidateGlobalOpencodeDirs().filter(
          (d) => d !== options.globalOpencodeDir,
        ),
      ]
    : candidateGlobalOpencodeDirs()
  for (const dir of globalDirs) {
    const agents = join(dir, "AGENTS.md")
    const claude = join(dir, "CLAUDE.md")
    candidates.push(agents, claude)
    const hit = await firstExisting(agents, claude)
    if (hit) {
      return { primary: hit, candidates, reason: "global-opencode" }
    }
  }

  // Step 4: Claude Code global. Skipped when Claude Code is disabled
  // (either at the umbrella level or for prompts only).
  if (
    !envIsTruthy(
      "OPENCODE_DISABLE_CLAUDE_CODE",
      "OPENCODE_DISABLE_CLAUDE_CODE_PROMPT",
    )
  ) {
    const claudeGlobal = join(home, ".claude", "CLAUDE.md")
    candidates.push(claudeGlobal)
    if (await fileExists(claudeGlobal)) {
      return {
        primary: claudeGlobal,
        candidates,
        reason: "global-claude",
      }
    }
  }

  // Step 5: custom config dir from `OPENCODE_CONFIG_DIR`. Treated as a
  // configured entry — AGENTS.md wins over CLAUDE.md.
  const opencodeConfigDir = process.env.OPENCODE_CONFIG_DIR
  if (opencodeConfigDir) {
    const agents = join(opencodeConfigDir, "AGENTS.md")
    const claude = join(opencodeConfigDir, "CLAUDE.md")
    candidates.push(agents, claude)
    const hit = await firstExisting(agents, claude)
    if (hit) {
      return { primary: hit, candidates, reason: "opencode-config-dir" }
    }
    // If the dir is set but has no rules file, fall through to the
    // final fallback. We do NOT create files in the custom config dir
    // because that's user-managed.
  }

  // Step 6: final fallback. If the user configured explicit paths, use
  // the first entry's AGENTS.md; otherwise the canonical project root.
  const fallback =
    configured.length > 0
      ? join(expandAgentsMdPath(configured[0], projectRoot, home), "AGENTS.md")
      : join(projectRoot, "AGENTS.md")
  candidates.push(fallback)
  return {
    primary: fallback,
    candidates,
    reason: "fallback-project-root",
  }
}

/**
 * Derive a stable directory name for the backup folder of a resolved
 * AGENTS.md path. Replaces path separators with `--` so the result is a
 * single path component, and trims leading separators.
 *
 * Example: `/home/me/work/rules/AGENTS.md` →
 *   `AGENTS.md--home-me-work-rules`
 *
 * The prefix keeps the directory recognisable in `listBackups` output;
 * the suffix uniquely identifies the file's location.
 */
export function backupDirNameFor(resolvedPath: string): string {
  // Use the filename as a stable, recognisable prefix and append a
  // sanitised representation of the directory.
  const parts = resolvedPath.split(/[\\/]/).filter(Boolean)
  const filename = parts[parts.length - 1] ?? "AGENTS.md"
  // Everything except the last segment.
  const dirSegments = parts.slice(0, -1)
  // Sanitise: replace path separators (already split, but defensive),
  // collapse runs of dashes, and strip leading/trailing dashes.
  const sanitised = dirSegments
    .map((s) => s.replace(/[^a-zA-Z0-9._-]+/g, "-"))
    .join("--")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
  return sanitised ? `${filename}--${sanitised}` : filename
}
