import { describe, expect, test } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import {
  candidateGlobalOpencodeDirs,
  dirExists,
  expandTilde,
  fileExists,
} from "../src/path-utils.js"

describe("expandTilde", () => {
  test("expands a bare '~' to the supplied home", () => {
    expect(expandTilde("~", "/custom/home")).toBe("/custom/home")
  })

  test("expands '~/...' against the supplied home", () => {
    // The implementation uses `path.join`, so the result uses the
    // platform's native separator. Use `homedir()` for the home
    // argument so the assertion is portable: both sides of the
    // comparison are produced by the same `path.join` call. (Earlier
    // revisions used `posix.join` here, but that only matches on POSIX
    // — on Windows `path.join("/home/x", "...")` returns
    // `\home\x\...`, not the forward-slash form.)
    expect(expandTilde("~/work/team.md", homedir())).toBe(
      join(homedir(), "work/team.md"),
    )
  })

  test("returns absolute paths unchanged", () => {
    expect(expandTilde("/etc/opencode/AGENTS.md", homedir())).toBe(
      "/etc/opencode/AGENTS.md",
    )
  })

  test("returns relative paths unchanged", () => {
    expect(expandTilde("./prompts", homedir())).toBe("./prompts")
  })

  test("defaults to os.homedir() when no home is supplied", () => {
    expect(expandTilde("~")).toBe(homedir())
    expect(expandTilde("~/x")).toBe(join(homedir(), "x"))
  })
})

describe("fileExists / dirExists", () => {
  test("fileExists returns true for a real file", async () => {
    const path = join(tmpdir(), `kasper-path-utils-${Date.now()}.md`)
    await Bun.write(path, "x")
    try {
      expect(await fileExists(path)).toBe(true)
    } finally {
      await Bun.$`rm -f ${path}`.quiet()
    }
  })

  test("fileExists returns false for a non-existent path", async () => {
    expect(
      await fileExists(
        join(tmpdir(), `kasper-path-utils-missing-${Date.now()}.md`),
      ),
    ).toBe(false)
  })

  test("fileExists returns false for a directory", async () => {
    const dir = join(tmpdir(), `kasper-path-utils-dir-${Date.now()}`)
    await Bun.$`mkdir -p ${dir}`.quiet()
    try {
      expect(await fileExists(dir)).toBe(false)
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet()
    }
  })

  test("dirExists returns true for a real directory", async () => {
    const dir = join(tmpdir(), `kasper-path-utils-dir-${Date.now()}`)
    await Bun.$`mkdir -p ${dir}`.quiet()
    try {
      expect(await dirExists(dir)).toBe(true)
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet()
    }
  })

  test("dirExists returns false for a regular file", async () => {
    const path = join(tmpdir(), `kasper-path-utils-file-${Date.now()}.md`)
    await Bun.write(path, "x")
    try {
      expect(await dirExists(path)).toBe(false)
    } finally {
      await Bun.$`rm -f ${path}`.quiet()
    }
  })

  test("dirExists returns false for a non-existent path", async () => {
    expect(
      await dirExists(
        join(tmpdir(), `kasper-path-utils-missing-dir-${Date.now()}`),
      ),
    ).toBe(false)
  })
})

describe("candidateGlobalOpencodeDirs", () => {
  test("starts with $XDG_CONFIG_HOME/opencode when set", () => {
    const saved = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = "/custom/xdg"
    try {
      const dirs = candidateGlobalOpencodeDirs()
      // The implementation does `join(process.env.XDG_CONFIG_HOME,
      // "opencode")`. Assert with the same `path.join` call so the
      // comparison uses the platform-native separator on Windows
      // (where `join("/custom/xdg", "opencode")` returns
      // `\custom\xdg\opencode`).
      expect(dirs[0]).toBe(join("/custom/xdg", "opencode"))
      // Always ends with ~/.opencode as the fallback.
      expect(dirs[dirs.length - 1]).toBe(join(homedir(), ".opencode"))
    } finally {
      if (saved === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = saved
    }
  })

  test("falls back to ~/.config/opencode when XDG_CONFIG_HOME is unset", () => {
    const saved = process.env.XDG_CONFIG_HOME
    delete process.env.XDG_CONFIG_HOME
    try {
      const dirs = candidateGlobalOpencodeDirs()
      expect(dirs).toContain(join(homedir(), ".config", "opencode"))
    } finally {
      if (saved !== undefined) process.env.XDG_CONFIG_HOME = saved
    }
  })

  test("does not include APPDATA path when APPDATA is unset", () => {
    const saved = process.env.APPDATA
    delete process.env.APPDATA
    try {
      const dirs = candidateGlobalOpencodeDirs()
      for (const d of dirs) {
        expect(d).not.toContain("AppData")
        expect(d).not.toContain("APPDATA")
      }
    } finally {
      if (saved !== undefined) process.env.APPDATA = saved
    }
  })

  test("always ends with ~/.opencode", () => {
    const dirs = candidateGlobalOpencodeDirs()
    expect(dirs[dirs.length - 1]).toBe(join(homedir(), ".opencode"))
  })

  test("deduplicates entries", () => {
    const dirs = candidateGlobalOpencodeDirs()
    expect(new Set(dirs).size).toBe(dirs.length)
  })
})
