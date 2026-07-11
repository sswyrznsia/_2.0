import type { QueuedImport } from './importTypes'

export class ImportQueue {
  private readonly pending: QueuedImport[] = []
  private active = 0

  constructor(
    private readonly worker: (item: QueuedImport) => Promise<void>,
    private readonly concurrency = 1,
  ) {}

  add(item: QueuedImport) {
    this.pending.push(item)
    this.drain()
  }

  remove(jobId: string): QueuedImport | undefined {
    const index = this.pending.findIndex((item) => item.job.jobId === jobId)
    if (index < 0) return undefined
    return this.pending.splice(index, 1)[0]
  }

  private drain() {
    while (this.active < this.concurrency && this.pending.length) {
      const item = this.pending.shift()
      if (!item) return
      this.active += 1
      void this.worker(item).finally(() => {
        this.active -= 1
        this.drain()
      })
    }
  }
}
