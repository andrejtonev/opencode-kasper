/**
 * Shared filesystem and path-expansion helpers used by both the agent-prompt
 * resolver and the AGENTS.md resolver. Centralised so the two resolvers stay
 * in sync on:
 *
 *   - `expandTilde`: a leading `~` or `~/...` is expanded against the
 *     supplied home directory. Pure function, easy to test.
 *   - `fileExists` / `dirExists`: `stat`-backed existence checks. Both
 *     silently swallow ENOENT and any other error and return `false`.
 *   - `candidateGlobalOpencodeDirs`: ordered list of directories where
 *     opencode stores its global config — `$XDG_CONFIG_HOME/opencode`,
 *     `%APPDATA%/opencode` on win32, `~/.opencode` as the last-resort
 *     fallback. The first existing one wins in callers.
 *
 * No kasper-specific knowledge lives here — these are pure path and
 * filesystem primitives.
 */

import { stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Expand a leading `~` or `~/...` against `home`. Anything else is
 * returned unchanged.
 */
export function expandTilde(p: string, home: string = homedir()): string {
  if (p === "~") return home
  if (p.startsWith("~/")) return join(home, p.slice(2))
  return p
}

/**
 * True if `p` exists and is a regular file. Swallows all errors.
 */
export async function fileExists(p: string): Promise<boolean> {
  try {
    const info = await stat(p)
    return info.isFile()
  } catch {
    return false
  }
}

/**
 * True if `p` exists and is a directory. Swallows all errors.
 */
export async function dirExists(p: string): Promise<boolean> {
  try {
    const info = await stat(p)
    return info.isDirectory()
  } catch {
    return false
  }
}

/**
 * Ordered list of directories where opencode stores its global config.
 * Callers try each in order and stop at the first one that contains an
 * `opencode.json`/`opencode.jsonc` or a `*.json[c]` plugin config.
 *
 *   - `$XDG_CONFIG_HOME/opencode` (or `~/.config/opencode` when unset)
 *   - `%APPDATA%/opencode` on win32
 *   - `~/.opencode` as a final fallback
 *
 * Duplicates are removed (preserving first-seen order).
 */
export function candidateGlobalOpencodeDirs(): string[] {
  const dirs: string[] = []
  if (process.env.XDG_CONFIG_HOME) {
    dirs.push(join(process.env.XDG_CONFIG_HOME, "opencode"))
  } else {
    dirs.push(join(homedir(), ".config", "opencode"))
  }
  if (process.platform === "win32" && process.env.APPDATA) {
    dirs.push(join(process.env.APPDATA, "opencode"))
  }
  dirs.push(join(homedir(), ".opencode"))
  return [...new Set(dirs)]
}
