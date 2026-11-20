import { describe, it, expect } from 'vitest'
import { Mutex, assertNoRouteConflict, isCanonicalPath, validateHookConfig } from '../hooks.js'
import type { HookConfig } from '../types.js'

describe('validateHookConfig', () => {
  const validate = (config: Partial<HookConfig> | Record<string, unknown>): void =>
    validateHookConfig(config as HookConfig, 'warmupHook')

  describe('path', () => {
    it.each(['/', '/warmup', '/a/b-c_d.e~f', '/' + 'a'.repeat(31), '/a.b', '/..a'])('accepts %s', (path) => {
      expect(() => validate({ path })).not.toThrow()
    })

    it('rejects a non-string path', () => {
      expect(() => validate({ path: 42 })).toThrow('warmupHook.path must be a string, got 42')
      expect(() => validate({})).toThrow('warmupHook.path must be a string, got undefined')
    })

    it.each(['', '/' + 'a'.repeat(32)])('rejects %j by length', (path) => {
      expect(() => validate({ path })).toThrow(
        `warmupHook.path must be between 1 and 32 characters, got ${JSON.stringify(path)}`
      )
    })

    it.each(['warmup', '/bad path', '/a?b'])('rejects %j by characters', (path) => {
      expect(() => validate({ path })).toThrow(
        `warmupHook.path must start with '/' and contain only letters, numbers, '.', '_', '~', '/' and '-', got ${JSON.stringify(path)}`
      )
    })

    it.each(['/warmup/', '//warmup', '/a//b', '/./warmup', '/a/../b', '/a/.', '/a/..'])(
      'rejects %j as not canonical',
      (path) => {
        expect(() => validate({ path })).toThrow(
          "warmupHook.path must be canonical: no trailing '/' (except '/' itself), no '//', " +
            `and no '.' or '..' segments, got ${JSON.stringify(path)}`
        )
      }
    )
  })

  describe('port', () => {
    it.each([8000, 12000])('accepts %d', (port) => {
      expect(() => validate({ path: '/warmup', port })).not.toThrow()
    })

    it.each([7999, 12001])('rejects %d by range', (port) => {
      expect(() => validate({ path: '/warmup', port })).toThrow(
        `warmupHook.port must be between 8000 and 12000, got ${port}`
      )
    })

    it.each([
      [8080.5, '8080.5'],
      ['8080', '"8080"'],
    ])('rejects %j as not an integer', (port, shown) => {
      expect(() => validate({ path: '/warmup', port })).toThrow(`warmupHook.port must be an integer, got ${shown}`)
    })
  })
})

describe('isCanonicalPath', () => {
  it('accepts / and rejects empty segments', () => {
    expect(isCanonicalPath('/')).toBe(true)
    expect(isCanonicalPath('/a/b')).toBe(true)
    expect(isCanonicalPath('/a/')).toBe(false)
  })
})

describe('assertNoRouteConflict', () => {
  const served = [
    { method: 'GET', path: '/ping' },
    { method: 'POST', path: '/invocations' },
  ] as const

  it('throws for the same method and path', () => {
    expect(() => assertNoRouteConflict(served, { method: 'POST', path: '/invocations' }, 'warmupHook')).toThrow(
      'warmupHook POST /invocations conflicts with a route already served on its port; pick another path'
    )
  })

  it('allows the same path with another method', () => {
    expect(() => assertNoRouteConflict(served, { method: 'POST', path: '/ping' }, 'warmupHook')).not.toThrow()
  })
})

describe('Mutex', () => {
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))

  it('runs calls one at a time, in call order', async () => {
    const mutex = new Mutex()
    const events: string[] = []
    let active = 0
    let maxActive = 0
    const task = (name: string) => async (): Promise<string> => {
      active++
      maxActive = Math.max(maxActive, active)
      events.push(`start ${name}`)
      await tick()
      events.push(`end ${name}`)
      active--
      return name
    }

    const results = await Promise.all([mutex.run(task('a')), mutex.run(task('b')), mutex.run(task('c'))])

    expect(results).toEqual(['a', 'b', 'c'])
    expect(maxActive).toBe(1)
    expect(events).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c'])
  })

  it('releases the lock after a call throws', async () => {
    const mutex = new Mutex()
    await expect(
      mutex.run(async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    await expect(mutex.run(async () => 'next')).resolves.toBe('next')
  })
})
