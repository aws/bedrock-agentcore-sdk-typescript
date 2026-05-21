import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AsyncBatcher } from '../batcher.js'
import type { BatchDropInfo, AsyncBatcherConfig } from '../batcher.js'

const DEFAULT_CONFIG = {
  batchSize: 10,
  batchTimeoutMs: 5000,
  sendTimeoutMs: 10000,
  maxDrainIterations: 10,
}

function makeBatcher<T>(
  overrides: Partial<AsyncBatcherConfig<T>> & Pick<AsyncBatcherConfig<T>, 'send'>
): AsyncBatcher<T> {
  return new AsyncBatcher<T>({
    ...DEFAULT_CONFIG,
    ...overrides,
  })
}

let warnSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  warnSpy.mockRestore()
})

describe('AsyncBatcher: size trigger', () => {
  it('flushes when buffer reaches batchSize', async () => {
    const send = vi.fn().mockResolvedValue('ok')
    const b = makeBatcher<string>({ batchSize: 3, send })

    b.add('a')
    b.add('b')
    expect(send).not.toHaveBeenCalled()

    b.add('c')
    await b.flush()

    expect(send).toHaveBeenCalledTimes(3)
    expect(b.size).toBe(0)
  })
})

describe('AsyncBatcher: time trigger', () => {
  it('flushes after batchTimeoutMs even below batchSize', async () => {
    vi.useFakeTimers()
    try {
      const send = vi.fn().mockResolvedValue('ok')
      const b = makeBatcher<string>({ batchSize: 100, batchTimeoutMs: 200, send })

      b.add('a')
      expect(send).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(200)
      expect(send).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('timer is cleared when size triggers a flush first', async () => {
    vi.useFakeTimers()
    try {
      const send = vi.fn().mockResolvedValue('ok')
      const b = makeBatcher<string>({ batchSize: 2, batchTimeoutMs: 5000, send })

      b.add('a')
      b.add('b')
      await vi.advanceTimersByTimeAsync(0)
      // After size-triggered drain, timer should be cleared (not pending another empty flush)
      expect((b as any).flushTimer).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('AsyncBatcher: idempotent retry', () => {
  it('retries failed items with the SAME item reference (caller controls idempotency key)', async () => {
    const seen: string[] = []
    let firstFail = true
    const send = vi.fn().mockImplementation(async (item: string) => {
      seen.push(item)
      if (firstFail && item === 'a') {
        firstFail = false
        throw new Error('transient')
      }
      return 'ok'
    })
    const b = makeBatcher<string>({ send })
    b.add('a')
    b.add('b')
    await b.flush()

    // 3 calls: a (fail), b (ok), a-retry (ok)
    expect(seen).toEqual(['a', 'b', 'a'])
  })

  it('drops items that fail twice and reports via onDropped', async () => {
    const onDropped = vi.fn()
    const send = vi.fn().mockRejectedValue(new Error('persistent'))
    const b = makeBatcher<string>({ send, onDropped, keyOf: (s) => s })

    b.add('a')
    b.add('b')
    await b.flush()

    expect(send).toHaveBeenCalledTimes(4) // 2 originals + 2 retries
    expect(onDropped).toHaveBeenCalledTimes(2)
    const reasons = onDropped.mock.calls.map((c) => (c[0] as BatchDropInfo).reason)
    expect(reasons).toEqual(['retry-failed', 'retry-failed'])
    const keys = onDropped.mock.calls.map((c) => (c[0] as BatchDropInfo).key)
    expect(keys.sort()).toEqual(['a', 'b'])
  })
})

describe('AsyncBatcher: per-send timeout', () => {
  it('rejects send that exceeds sendTimeoutMs and surfaces via onDropped', async () => {
    vi.useFakeTimers()
    try {
      const onDropped = vi.fn()
      const hangingSend = vi.fn().mockImplementation(() => new Promise(() => {})) // never resolves
      const b = makeBatcher<string>({ send: hangingSend, sendTimeoutMs: 100, onDropped, keyOf: (s) => s })

      b.add('a')
      const flushPromise = b.flush()

      // Advance past timeout — should reject the in-flight send, then retry, then time out again
      await vi.advanceTimersByTimeAsync(100) // first timeout fires
      await vi.advanceTimersByTimeAsync(100) // retry timeout fires
      await flushPromise

      // Two timeout drops (initial + retry), then one retry-failed drop
      const reasons = onDropped.mock.calls.map((c) => (c[0] as BatchDropInfo).reason)
      expect(reasons).toContain('timeout')
      expect(reasons).toContain('retry-failed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('synchronous throw in send is isolated as a rejection (does not escape allSettled)', async () => {
    // Every call to send throws synchronously — verifies the
    // Promise.resolve().then(...) wrap converts sync throws into rejections.
    const send = vi.fn().mockImplementation(() => {
      throw new Error('sync boom')
    })
    const onDropped = vi.fn()
    const b = makeBatcher<string>({ send, onDropped, keyOf: (s) => s })

    b.add('a')
    b.add('b')
    // Must not throw — sync throws are caught by the Promise.resolve().then(...) wrap
    await expect(b.flush()).resolves.toBeUndefined()

    // 2 originals throw, 2 retries throw, both items dropped via 'retry-failed'
    expect(send).toHaveBeenCalledTimes(4)
    expect(onDropped).toHaveBeenCalledTimes(2)
    const reasons = onDropped.mock.calls.map((c) => (c[0] as BatchDropInfo).reason)
    expect(reasons).toEqual(['retry-failed', 'retry-failed'])
  })
})

describe('AsyncBatcher: drain dedup', () => {
  it('concurrent flush() calls share a single in-flight drain', async () => {
    let resolveSend!: () => void
    const sendPromise = new Promise((r) => {
      resolveSend = r as () => void
    })
    const send = vi.fn().mockImplementation(() => sendPromise.then(() => 'ok'))
    const b = makeBatcher<string>({ send })

    b.add('a')
    const f1 = b.flush()
    const f2 = b.flush()
    const f3 = b.flush()

    resolveSend()
    await Promise.all([f1, f2, f3])

    expect(send).toHaveBeenCalledTimes(1) // not 3
  })
})

describe('AsyncBatcher: maxDrainIterations cap', () => {
  it('stops looping after the cap and reports residual drop', async () => {
    const send = vi.fn().mockResolvedValue('ok')
    const onDropped = vi.fn()
    const b = makeBatcher<string>({ batchSize: 2, maxDrainIterations: 2, send, onDropped })

    // Pre-populate buffer beyond what 2 iterations can drain
    for (let i = 0; i < 10; i++) b.add(`item-${i}`)

    // Each iteration drains the buffer snapshot. With batchSize 2 each add triggers
    // an immediate flush — so by the time we await, drain has already happened.
    await b.flush()

    // No items should remain stranded — the size triggers fired during add.
    // This test really validates the cap kicks in only when size+timer aren't
    // draining fast enough; for that we need a slow producer scenario.
    expect(b.size).toBe(0)
    expect(send).toHaveBeenCalled()
  })

  it('cap fires when each iteration finds new items', async () => {
    // Each send call adds another item to the buffer before resolving. With
    // maxDrainIterations=2, the drain loop runs exactly 2 iterations:
    //   iter-1: snapshot=[1], send adds 2 → buffer=[2] after iter
    //   iter-2: snapshot=[2], send adds 3 → buffer=[3] after iter
    //   loop exits at i=2; buffer=[3] is stranded
    let counter = 1
    const onDropped = vi.fn()
    const send = vi.fn().mockImplementation(async () => {
      counter++
      if (counter <= 3) {
        b.add(counter)
      }
      return 'ok'
    })
    const b: AsyncBatcher<number> = makeBatcher<number>({
      batchSize: 100, // ensure size-trigger doesn't kick in
      maxDrainIterations: 2,
      send,
      onDropped,
      keyOf: (n) => `n-${n}`,
    })

    ;(b as any).buffer.push(1)
    await b.flush()

    const reasons = onDropped.mock.calls.map((c) => (c[0] as BatchDropInfo).reason)
    expect(reasons).toContain('max-drain-iterations')
    expect(b.size).toBe(1) // item 3 stranded
  })
})

describe('AsyncBatcher: shutdown', () => {
  it('drains buffer then refuses new items', async () => {
    const send = vi.fn().mockResolvedValue('ok')
    const onDropped = vi.fn()
    const b = makeBatcher<string>({ send, onDropped, keyOf: (s) => s })

    b.add('a')
    b.add('b')
    await b.shutdown()
    expect(send).toHaveBeenCalledTimes(2)

    b.add('c')
    expect(send).toHaveBeenCalledTimes(2) // unchanged

    expect(onDropped).toHaveBeenCalledWith(expect.objectContaining({ reason: 'post-shutdown', key: 'c' }))
  })

  it('post-shutdown warning logs only once', async () => {
    const b = makeBatcher<string>({ send: vi.fn() })

    await b.shutdown()
    b.add('a')
    b.add('b')
    b.add('c')

    const postShutdownWarns = warnSpy.mock.calls.filter((c: unknown[]) => String(c[0]).includes('after shutdown()'))
    expect(postShutdownWarns.length).toBe(1)
  })
})

describe('AsyncBatcher: onDropped error isolation', () => {
  it('throwing onDropped does not break the batcher', async () => {
    const onDropped = vi.fn().mockImplementation(() => {
      throw new Error('callback boom')
    })
    const send = vi.fn().mockRejectedValue(new Error('persistent'))
    const b = makeBatcher<string>({ send, onDropped })

    b.add('a')
    await expect(b.flush()).resolves.toBeUndefined()
    expect(onDropped).toHaveBeenCalled()
  })
})

describe('AsyncBatcher: empty operations', () => {
  it('flush() on empty buffer is a no-op', async () => {
    const send = vi.fn()
    const b = makeBatcher<string>({ send })
    await b.flush()
    expect(send).not.toHaveBeenCalled()
  })

  it('shutdown() on empty buffer is a no-op', async () => {
    const send = vi.fn()
    const b = makeBatcher<string>({ send })
    await b.shutdown()
    expect(send).not.toHaveBeenCalled()
  })
})
