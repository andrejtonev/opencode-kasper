/** Host-independent ownership of timers, admission and asynchronous lifecycle revisions. */
export interface EvaluationRevision {
  global: number
  session: number
}
export class KasperRuntime {
  private readonly lifetime = new AbortController()
  private generation = 0
  private readonly revisions = new Map<string, number>()
  private readonly sessions = new Map<string, AbortController>()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private readonly jobs = new Map<string, Promise<unknown>>()
  private nextJob = 0
  readonly lifetimeSignal = this.lifetime.signal
  get active(): boolean {
    return !this.lifetimeSignal.aborted
  }
  capture(id: string): EvaluationRevision {
    return { global: this.generation, session: this.revisions.get(id) ?? 0 }
  }
  isCurrent(id: string, revision: EvaluationRevision): boolean {
    return (
      this.active &&
      revision.global === this.generation &&
      revision.session === (this.revisions.get(id) ?? 0)
    )
  }
  assertCurrent(id: string, revision: EvaluationRevision): void {
    if (!this.isCurrent(id, revision))
      throw new Error("Kasper operation cancelled by lifecycle change")
  }
  sessionSignal(id: string): AbortSignal {
    let controller = this.sessions.get(id)
    if (!controller) {
      controller = new AbortController()
      this.sessions.set(id, controller)
    }
    return AbortSignal.any([this.lifetimeSignal, controller.signal])
  }
  invalidateSession(id: string): void {
    this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1)
    this.sessions.get(id)?.abort()
    this.sessions.delete(id)
  }
  invalidateAll(): void {
    this.generation++
    for (const controller of this.sessions.values()) controller.abort()
    this.sessions.clear()
  }
  /** A deadline must never release a still-running job's admission slot. */
  async track<T>(work: () => Promise<T>): Promise<T> {
    if (!this.active) throw new Error("Kasper has unloaded.")
    const key = `action:${this.nextJob++}`
    const job = Promise.resolve().then(() => {
      if (!this.active) throw new Error("Kasper has unloaded.")
      return work()
    })
    this.jobs.set(key, job)
    try {
      return await job
    } finally {
      this.jobs.delete(key)
    }
  }
  async runOnce(key: string, work: () => Promise<unknown>): Promise<boolean> {
    if (!this.active || this.jobs.has(key)) return false
    const job = Promise.resolve().then(() => (this.active ? work() : undefined))
    this.jobs.set(key, job)
    try {
      await job
      return true
    } finally {
      if (this.jobs.get(key) === job) this.jobs.delete(key)
    }
  }
  every(
    key: string,
    interval: number,
    work: () => Promise<unknown>,
    onError: (error: unknown) => void,
  ): ReturnType<typeof setInterval> {
    const timer = setInterval(() => {
      void this.runOnce(key, work).catch(onError)
    }, interval)
    this.timers.add(timer)
    return timer
  }
  async dispose(drainMs = 1000): Promise<void> {
    if (!this.active) return
    this.lifetime.abort()
    this.invalidateAll()
    for (const timer of this.timers) clearInterval(timer)
    this.timers.clear()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.allSettled(this.jobs.values()),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, drainMs)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
