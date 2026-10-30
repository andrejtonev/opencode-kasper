import type { HistoryMessage } from "./history.js"

export interface SessionDescriptor {
  id: string
  title?: string
  agent?: string
  parentID?: string
  projectID?: string
  location: { directory: string; workspaceID?: string }
  time: { created: number; updated: number; busy?: number; idle?: number }
  outcome?: "succeeded" | "failed" | "interrupted"
}
export interface HistorySnapshot {
  sessionID: string
  coverage: "archive" | "current-window"
  messages: HistoryMessage[]
  isIdle: boolean
}
export type HistoryReadResult =
  | { status: "ok"; snapshot: HistorySnapshot }
  | {
      status: "unsupported"
      reason: "archive_unavailable"
      detail: string
    }
export interface HistoryPort {
  read(
    sessionID: string,
    options: { purpose: "historical" | "current"; signal?: AbortSignal },
  ): Promise<HistoryReadResult>
}
export interface SessionDirectoryPort {
  get(
    sessionID: string,
    options?: { signal?: AbortSignal },
  ): Promise<SessionDescriptor>
  list(options?: {
    parentID?: string
    signal?: AbortSignal
  }): Promise<SessionDescriptor[]>
}
export type HistoryHost = HistoryPort & SessionDirectoryPort
