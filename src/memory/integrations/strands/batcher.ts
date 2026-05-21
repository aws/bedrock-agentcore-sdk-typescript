/// <reference types="node" />

/**
 * Generic async batcher with size + time triggers, idempotent single-retry,
 * per-send timeout, bounded drain loop, and graceful shutdown.
 *
 * Internal to the memory plugin today. If a second consumer needs this pattern
 * (telemetry, OTEL, identity events), promote to a public export — the API is
 * intentionally generic so that promotion is a one-line index.ts change.
 */

export type BatchDropReason = 'retry-failed' | 'max-drain-iterations' | 'post-shutdown' | 'timeout'

export interface BatchDropInfo {
  reason: BatchDropReason
  count: number
  /** Caller-defined identifier for the dropped item. Useful for log correlation. */
  key?: string
  cause?: unknown
}

export interface AsyncBatcherConfig<T> {
  /** Buffered item count that triggers an immediate flush. Must be a positive integer. */
  batchSize: number
  /** Maximum time (ms) an item sits in the buffer before being flushed. Must be non-negative. */
  batchTimeoutMs: number
  /** Per-send timeout (ms). Items exceeding this are rejected; one retry is attempted. */
  sendTimeoutMs: number
  /** Upper bound on flush passes per drain. Guards against pathological producers. */
  maxDrainIterations: number
  /**
   * Sends one item. Wrapped in `Promise.resolve().then(...)` internally, so a
   * synchronous throw becomes a rejected promise rather than escaping the
   * batcher's `Promise.allSettled` isolation.
   */
  send: (item: T) => Promise<unknown>
  /** Optional structured drop callback. Errors thrown inside are caught and logged. */
  onDropped?: (info: BatchDropInfo) => void
  /**
   * Returns a stable identifier for an item, used for drop logging. If omitted,
   * dropped events log without a key.
   */
  keyOf?: (item: T) => string
  /** Prefix for `console.warn` messages. Defaults to `[batcher]`. */
  logPrefix?: string
}

export class AsyncBatcher<T> {
  private readonly config: AsyncBatcherConfig<T>
  private readonly logPrefix: string
  private buffer: T[] = []
  private flushTimer?: ReturnType<typeof globalThis.setTimeout> | undefined
  private pendingFlush: Promise<void> | null = null
  private shuttingDown = false
  private postShutdownDropWarned = false

  constructor(config: AsyncBatcherConfig<T>) {
    this.config = config
    this.logPrefix = config.logPrefix ?? '[batcher]'
  }

  get size(): number {
    return this.buffer.length
  }

  add(item: T): void {
    if (this.shuttingDown) {
      if (!this.postShutdownDropWarned) {
        this.postShutdownDropWarned = true
        console.warn(`${this.logPrefix} Dropping item received after shutdown()`)
      }
      this.notifyDropped({ reason: 'post-shutdown', count: 1, ...this.keyFor(item) })
      return
    }

    this.buffer.push(item)

    if (this.buffer.length >= this.config.batchSize) {
      void this.drainUntilEmpty()
      return
    }

    if (!this.flushTimer && this.buffer.length === 1) {
      this.flushTimer = globalThis.setTimeout(() => {
        void this.drainUntilEmpty()
      }, this.config.batchTimeoutMs)
    }
  }

  /**
   * Force an immediate flush of the buffer and wait for completion. Loops
   * until the buffer is empty or {@link AsyncBatcherConfig.maxDrainIterations}
   * is reached.
   */
  async flush(): Promise<void> {
    this.clearFlushTimer()
    await this.drainUntilEmpty()
  }

  /**
   * Stop accepting new items, cancel pending timers, and await the final
   * flush. After shutdown the batcher is inert — subsequent `add` calls are
   * dropped via {@link BatchDropInfo} with reason `'post-shutdown'`.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true
    this.clearFlushTimer()
    await this.drainUntilEmpty()
  }

  /**
   * Drain the buffer across multiple flush passes. Each pass takes a snapshot
   * of the current buffer; any items that arrive during the pass (from
   * concurrent `add()` calls) are picked up on the next iteration. Bounded by
   * `maxDrainIterations` to guard against pathological producers.
   */
  private async drainUntilEmpty(): Promise<void> {
    if (this.pendingFlush) {
      await this.pendingFlush
      return
    }

    const run = async (): Promise<void> => {
      const maxIter = this.config.maxDrainIterations
      for (let i = 0; i < maxIter && this.buffer.length > 0; i++) {
        await this.flushOnce()
      }
      if (this.buffer.length > 0) {
        const stranded = this.buffer.length
        console.warn(
          `${this.logPrefix} flush reached maxDrainIterations=${maxIter} with ${stranded} item(s) still buffered`
        )
        this.notifyDropped({ reason: 'max-drain-iterations', count: stranded })
      }
    }

    this.pendingFlush = run().finally(() => {
      this.pendingFlush = null
    })
    await this.pendingFlush
  }

  private async flushOnce(): Promise<void> {
    if (this.buffer.length === 0) return

    const toFlush = [...this.buffer]
    this.buffer = []
    this.clearFlushTimer()

    const results = await Promise.allSettled(toFlush.map((item) => this.sendWithTimeout(item)))

    const failed: number[] = []
    for (let i = 0; i < results.length; i++) {
      if (results[i]!.status === 'rejected') failed.push(i)
    }
    if (failed.length === 0) return

    const retryResults = await Promise.allSettled(failed.map((i) => this.sendWithTimeout(toFlush[i]!)))
    const failedDetails: Array<{ key?: string; reason: unknown }> = []
    for (let j = 0; j < retryResults.length; j++) {
      const r = retryResults[j]!
      if (r.status === 'rejected') {
        const item = toFlush[failed[j]!]!
        failedDetails.push({ ...this.keyFor(item), reason: r.reason })
      }
    }
    if (failedDetails.length === 0) return

    for (const detail of failedDetails) {
      const keyPart = detail.key !== undefined ? ` (key=${detail.key})` : ''
      console.warn(`${this.logPrefix} Dropping item after retry${keyPart}:`, detail.reason)
      this.notifyDropped({
        reason: 'retry-failed',
        count: 1,
        ...(detail.key !== undefined ? { key: detail.key } : {}),
        cause: detail.reason,
      })
    }
    console.warn(`${this.logPrefix} Dropped ${failedDetails.length} item(s) after retry`)
  }

  /**
   * Wraps the user-supplied `send` in `Promise.resolve().then(...)` so a
   * synchronous throw becomes a rejected promise (preserves `Promise.allSettled`
   * isolation), and races it against `sendTimeoutMs`.
   */
  private sendWithTimeout(item: T): Promise<unknown> {
    const timeoutMs = this.config.sendTimeoutMs
    const call = Promise.resolve().then(() => this.config.send(item))

    let timer: ReturnType<typeof globalThis.setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = globalThis.setTimeout(() => {
        const keyInfo = this.keyFor(item)
        const keyPart = keyInfo.key !== undefined ? ` (key=${keyInfo.key})` : ''
        const msg = `${this.logPrefix} send timed out after ${timeoutMs}ms${keyPart}`
        console.warn(msg)
        this.notifyDropped({
          reason: 'timeout',
          count: 1,
          ...(keyInfo.key !== undefined ? { key: keyInfo.key } : {}),
          cause: new Error(msg),
        })
        reject(new Error(msg))
      }, timeoutMs)
    })

    return Promise.race([call, timeout]).finally(() => {
      if (timer) globalThis.clearTimeout(timer)
    })
  }

  private notifyDropped(info: BatchDropInfo): void {
    const cb = this.config.onDropped
    if (!cb) return
    try {
      cb(info)
    } catch (err) {
      console.warn(`${this.logPrefix} onDropped callback threw:`, err)
    }
  }

  private keyFor(item: T): { key?: string } {
    if (!this.config.keyOf) return {}
    const key = this.config.keyOf(item)
    return key !== undefined ? { key } : {}
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) {
      globalThis.clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
  }
}
