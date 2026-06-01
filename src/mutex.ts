export class AsyncMutex {
  private locked = false
  private queue: Array<() => void> = []

  isLocked(): boolean {
    return this.locked
  }

  tryAcquire(): boolean {
    if (!this.locked) {
      this.locked = true
      return true
    }
    return false
  }

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true
      return
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve)
    })
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()
      if (next) next()
    } else {
      this.locked = false
    }
  }

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }
}
