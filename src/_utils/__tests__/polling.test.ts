import { describe, it, expect } from 'vitest'
import { pollUntil } from '../../_utils/polling.js'

describe('pollUntil', () => {
  it('should return true immediately when condition is met', async () => {
    const result = await pollUntil(() => Promise.resolve(true), { maxWaitSeconds: 5, pollIntervalMs: 10 })
    expect(result).toBe(true)
  })

  it('should poll until condition becomes true', async () => {
    let calls = 0
    const result = await pollUntil(() => Promise.resolve(++calls >= 3), { maxWaitSeconds: 5, pollIntervalMs: 10 })
    expect(result).toBe(true)
    expect(calls).toBe(3)
  })

  it('should return false on timeout when no timeoutErrorMessage', async () => {
    const result = await pollUntil(() => Promise.resolve(false), { maxWaitSeconds: 0.05, pollIntervalMs: 10 })
    expect(result).toBe(false)
  })

  it('should throw on timeout when timeoutErrorMessage is set', async () => {
    await expect(
      pollUntil(() => Promise.resolve(false), {
        maxWaitSeconds: 0.05,
        pollIntervalMs: 10,
        timeoutErrorMessage: 'timed out',
      })
    ).rejects.toThrow('timed out')
  })

  it('should swallow errors matching shouldSwallowError predicate', async () => {
    let calls = 0
    const result = await pollUntil(
      () => {
        calls++
        if (calls < 2) throw new Error('transient')
        return Promise.resolve(true)
      },
      { maxWaitSeconds: 5, pollIntervalMs: 10, shouldSwallowError: () => true }
    )
    expect(result).toBe(true)
    expect(calls).toBe(2)
  })

  it('should propagate errors not matched by shouldSwallowError', async () => {
    await expect(
      pollUntil(
        () => {
          throw new Error('fatal')
        },
        { maxWaitSeconds: 5, pollIntervalMs: 10, shouldSwallowError: (err) => (err as Error).message !== 'fatal' }
      )
    ).rejects.toThrow('fatal')
  })

  it('should propagate all errors when shouldSwallowError is not provided', async () => {
    await expect(
      pollUntil(
        () => {
          throw new Error('fatal')
        },
        { maxWaitSeconds: 5, pollIntervalMs: 10 }
      )
    ).rejects.toThrow('fatal')
  })

  it('should run condition at least once even with maxWaitSeconds=0', async () => {
    let called = false
    const result = await pollUntil(
      () => {
        called = true
        return Promise.resolve(false)
      },
      { maxWaitSeconds: 0, pollIntervalMs: 10 }
    )
    expect(called).toBe(true)
    expect(result).toBe(false)
  })

  it('should return true on first attempt with maxWaitSeconds=0 when condition is met', async () => {
    const result = await pollUntil(() => Promise.resolve(true), { maxWaitSeconds: 0, pollIntervalMs: 10 })
    expect(result).toBe(true)
  })

  it('should not sleep past the deadline', async () => {
    const start = Date.now()
    await pollUntil(() => Promise.resolve(false), { maxWaitSeconds: 0.05, pollIntervalMs: 5000 })
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(1000)
  })
})
