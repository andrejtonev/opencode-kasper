import { appendFile, mkdir, open, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

export interface LogEntry {
  ts: string
  event: string
  [key: string]: unknown
}

export class KasperLogger {
  private logDir: string
  private maxLines: number

  constructor(logDir: string, maxLines = 300) {
    this.logDir = logDir
    this.maxLines = maxLines
  }

  private get logPath(): string {
    return join(this.logDir, "kasper.log")
  }

  async init(): Promise<void> {
    await mkdir(this.logDir, { recursive: true })
  }

  async log(event: string, data: Record<string, unknown> = {}): Promise<void> {
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      event,
      ...data,
    }
    const line = `${JSON.stringify(entry)}\n`
    try {
      await appendFile(this.logPath, line, "utf-8")
    } catch {
      /* log failure is non-fatal */
    }
  }

  async tail(lines = 80): Promise<string> {
    if (lines <= 0) return ""
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(this.logPath, "r")
      const info = await handle.stat()
      if (info.size <= 0) return ""
      const chunkSize = 8192
      let offset = info.size
      let text = ""
      let newlineCount = 0
      while (offset > 0 && newlineCount <= lines) {
        const readSize = Math.min(chunkSize, offset)
        offset -= readSize
        const buffer = Buffer.alloc(readSize)
        await handle.read(buffer, 0, readSize, offset)
        text = buffer.toString("utf8") + text
        newlineCount = (text.match(/\n/g) || []).length
      }
      return text.split(/\r?\n/).filter(Boolean).slice(-lines).join("\n")
    } catch {
      return ""
    } finally {
      if (handle) await handle.close().catch(() => {})
    }
  }

  async trim(): Promise<void> {
    try {
      const text = await readFile(this.logPath, "utf-8")
      const allLines = text.split(/\r?\n/).filter(Boolean)
      if (allLines.length <= this.maxLines) return
      const trimmed = `${allLines.slice(-this.maxLines).join("\n")}\n`
      await writeFile(this.logPath, trimmed, "utf-8")
    } catch {
      /* trim failure is non-fatal */
    }
  }
}
