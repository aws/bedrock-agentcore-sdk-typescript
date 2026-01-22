import { describe, it, expect } from 'vitest'
import { getContext, runWithContext } from '../context.js'
import type { RequestContext } from '../types.js'

describe('Context Storage', () => {
  const mockContext: RequestContext = {
    sessionId: 'test-session-123',
    workloadAccessToken: 'test-token-456',
    oauth2CallbackUrl: 'https://example.com/callback',
    requestId: 'test-request-789',
    headers: {
      authorization: 'Bearer test',
      'x-custom-header': 'value',
    },
  }

  describe('getContext', () => {
    it('returns undefined when called outside context', () => {
      const context = getContext()
      expect(context).toBeUndefined()
    })

    it('returns context when called inside runWithContext', () => {
      runWithContext(mockContext, () => {
        const context = getContext()
        expect(context).toBeDefined()
        expect(context?.sessionId).toBe('test-session-123')
        expect(context?.workloadAccessToken).toBe('test-token-456')
        expect(context?.oauth2CallbackUrl).toBe('https://example.com/callback')
        expect(context?.requestId).toBe('test-request-789')
      })
    })

    it('returns the same object reference as passed to runWithContext', () => {
      runWithContext(mockContext, () => {
        const context = getContext()
        expect(context).toBe(mockContext)
      })
    })

    it('returns undefined after runWithContext completes', () => {
      runWithContext(mockContext, () => {
        // Inside context
        expect(getContext()).toBeDefined()
      })
      // Outside context
      expect(getContext()).toBeUndefined()
    })
  })

  describe('runWithContext', () => {
    it('makes context available throughout async operations', async () => {
      await runWithContext(mockContext, async () => {
        const context1 = getContext()
        expect(context1?.sessionId).toBe('test-session-123')

        await Promise.resolve()

        const context2 = getContext()
        expect(context2?.sessionId).toBe('test-session-123')
      })
    })

    it('preserves context across nested async calls', async () => {
      await runWithContext(mockContext, async () => {
        const level1 = async () => {
          const ctx = getContext()
          expect(ctx?.sessionId).toBe('test-session-123')

          const level2 = async () => {
            const ctx2 = getContext()
            expect(ctx2?.sessionId).toBe('test-session-123')
          }

          await level2()
        }

        await level1()
      })
    })

    it('returns the result of the callback function', () => {
      const result = runWithContext(mockContext, () => {
        return 42
      })
      expect(result).toBe(42)
    })

    it('returns the result of async callback function', async () => {
      const result = await runWithContext(mockContext, async () => {
        await Promise.resolve()
        return 'test-result'
      })
      expect(result).toBe('test-result')
    })

    it('propagates errors from callback', () => {
      expect(() => {
        runWithContext(mockContext, () => {
          throw new Error('Test error')
        })
      }).toThrow('Test error')
    })

    it('propagates errors from async callback', async () => {
      await expect(
        runWithContext(mockContext, async () => {
          await Promise.resolve()
          throw new Error('Async test error')
        })
      ).rejects.toThrow('Async test error')
    })

    it('cleans up context after error', () => {
      try {
        runWithContext(mockContext, () => {
          throw new Error('Test error')
        })
      } catch {
        // Error caught
      }

      // Context should be cleaned up
      expect(getContext()).toBeUndefined()
    })
  })

  describe('nested contexts', () => {
    it('inner context shadows outer context', () => {
      const outerContext: RequestContext = {
        sessionId: 'outer-session',
        headers: {},
      }

      const innerContext: RequestContext = {
        sessionId: 'inner-session',
        headers: {},
      }

      runWithContext(outerContext, () => {
        expect(getContext()?.sessionId).toBe('outer-session')

        runWithContext(innerContext, () => {
          expect(getContext()?.sessionId).toBe('inner-session')
        })

        expect(getContext()?.sessionId).toBe('outer-session')
      })
    })

    it('restores outer context after inner completes', () => {
      const outerContext: RequestContext = {
        sessionId: 'outer',
        workloadAccessToken: 'outer-token',
        headers: {},
      }

      const innerContext: RequestContext = {
        sessionId: 'inner',
        workloadAccessToken: 'inner-token',
        headers: {},
      }

      runWithContext(outerContext, () => {
        const ctx1 = getContext()
        expect(ctx1?.workloadAccessToken).toBe('outer-token')

        runWithContext(innerContext, () => {
          const ctx2 = getContext()
          expect(ctx2?.workloadAccessToken).toBe('inner-token')
        })

        const ctx3 = getContext()
        expect(ctx3?.workloadAccessToken).toBe('outer-token')
      })
    })
  })

  describe('concurrent requests', () => {
    it('maintains separate contexts for concurrent operations', async () => {
      const context1: RequestContext = {
        sessionId: 'session-1',
        workloadAccessToken: 'token-1',
        headers: {},
      }

      const context2: RequestContext = {
        sessionId: 'session-2',
        workloadAccessToken: 'token-2',
        headers: {},
      }

      const promise1 = runWithContext(context1, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        const ctx = getContext()
        expect(ctx?.sessionId).toBe('session-1')
        expect(ctx?.workloadAccessToken).toBe('token-1')
        return 'result-1'
      })

      const promise2 = runWithContext(context2, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        const ctx = getContext()
        expect(ctx?.sessionId).toBe('session-2')
        expect(ctx?.workloadAccessToken).toBe('token-2')
        return 'result-2'
      })

      const [result1, result2] = await Promise.all([promise1, promise2])
      expect(result1).toBe('result-1')
      expect(result2).toBe('result-2')
    })

    it('isolates contexts in Promise.all', async () => {
      const contexts = [
        { sessionId: 'req-1', headers: {} },
        { sessionId: 'req-2', headers: {} },
        { sessionId: 'req-3', headers: {} },
      ] as RequestContext[]

      const results = await Promise.all(
        contexts.map((ctx, index) =>
          runWithContext(ctx, async () => {
            await new Promise((resolve) => setTimeout(resolve, Math.random() * 10))
            const current = getContext()
            expect(current?.sessionId).toBe(`req-${index + 1}`)
            return current?.sessionId
          })
        )
      )

      expect(results).toEqual(['req-1', 'req-2', 'req-3'])
    })
  })

  describe('context with optional fields', () => {
    it('handles context with minimal fields', () => {
      const minimalContext: RequestContext = {
        sessionId: 'minimal-session',
        headers: {},
      }

      runWithContext(minimalContext, () => {
        const ctx = getContext()
        expect(ctx?.sessionId).toBe('minimal-session')
        expect(ctx?.workloadAccessToken).toBeUndefined()
        expect(ctx?.oauth2CallbackUrl).toBeUndefined()
        expect(ctx?.requestId).toBeUndefined()
        expect(ctx?.headers).toEqual({})
      })
    })

    it('handles context with all fields populated', () => {
      const fullContext: RequestContext = {
        sessionId: 'full-session',
        workloadAccessToken: 'full-token',
        oauth2CallbackUrl: 'https://callback.com',
        requestId: 'full-request-id',
        headers: {
          authorization: 'Bearer token',
          'x-custom': 'value',
        },
      }

      runWithContext(fullContext, () => {
        const ctx = getContext()
        expect(ctx).toEqual(fullContext)
      })
    })
  })

  describe('context mutation', () => {
    it('allows modifying context within scope', () => {
      const context: RequestContext = {
        sessionId: 'mutable-session',
        headers: {},
      }

      runWithContext(context, () => {
        const ctx = getContext()
        if (ctx) {
          ctx.workloadAccessToken = 'new-token'
        }

        const updatedCtx = getContext()
        expect(updatedCtx?.workloadAccessToken).toBe('new-token')
      })

      // Original object is mutated
      expect(context.workloadAccessToken).toBe('new-token')
    })

    it('modifications persist across async boundaries', async () => {
      const context: RequestContext = {
        sessionId: 'async-mutable',
        headers: {},
      }

      await runWithContext(context, async () => {
        const ctx1 = getContext()
        if (ctx1) {
          ctx1.requestId = 'modified-id'
        }

        await Promise.resolve()

        const ctx2 = getContext()
        expect(ctx2?.requestId).toBe('modified-id')
      })
    })
  })
})
