import { rmSync, symlinkSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

const configDir = join(homedir(), ".config", "opencode")
const pluginsDir = join(configDir, "plugins")

const target = resolve("src/index.ts")
const linkPath = join(pluginsDir, "opencode-kasper.ts")

try {
  unlinkSync(linkPath)
} catch {
  // doesn't exist yet
}

try {
  rmSync(join(configDir, "dist"), { recursive: true, force: true })
} catch {
  // doesn't exist yet
}

symlinkSync(target, linkPath)

console.log(`Symlinked kasper plugin:`)
console.log(`  ${linkPath} -> ${target}`)
