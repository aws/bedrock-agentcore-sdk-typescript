import { describe, it, expect, vi } from 'vitest'
import { BedrockAgentCoreApp } from '../app.js'
import { WARMUP_TYPE_HEADER } from '../constants.js'
import { isWarmupType, normalizeWarmupTypeHeader, warmupHookRoute } from '../warmup.js'
import type { WarmupHandler } from '../types.js'
import type { WarmupHookConfig } from '../types.js'

function createReply(): { status: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> } {
  const reply = { status: vi.fn(), send: vi.fn(async () => reply) }
  reply.status.mockReturnValue(reply)
  return reply
}

function createRequest(header?: string | string[]): unknown {
  return {
    headers: header === undefined ? {} : { [WARMUP_TYPE_HEADER]: header },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }
}

async function call(config: WarmupHookConfig, header?: string): Promise<ReturnType<typeof createReply>> {
  const reply = createReply()
  await warmupHookRoute(config).handler(createRequest(header) as any, reply as any)
  return reply
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('warmupHookRoute', () => {
  it('describes a POST route at the configured path and port', () => {
    const route = warmupHookRoute({ path: '/warmup', port: 9000, handlers: {} })
    expect(route).toMatchObject({ name: 'warmupHook', method: 'POST', path: '/warmup', port: 9000 })
    expect(warmupHookRoute({ path: '/warmup', handlers: {} })).not.toHaveProperty('port')
  })

  it('returns completed after the handler resolves', async () => {
    const order: string[] = []
    const memory = vi.fn(async () => {
      await sleep(5)
      order.push('handler done')
    })
    const reply = createReply()
    reply.send.mockImplementation(async () => {
      order.push('reply sent')
      return reply
    })

    await warmupHookRoute({ path: '/warmup', handlers: { memory } }).handler(
      createRequest('memory') as any,
      reply as any
    )

    expect(memory).toHaveBeenCalledOnce()
    expect(reply.status).not.toHaveBeenCalled()
    expect(reply.send).toHaveBeenCalledWith({ status: 'ok', type: 'memory', result: 'completed' })
    expect(order).toEqual(['handler done', 'reply sent'])
  })

  it('runs the handler for each type', async () => {
    const memory = vi.fn(async () => {})
    const disk = vi.fn(async () => {})
    const config = { path: '/warmup', handlers: { memory, disk } }

    expect((await call(config, 'disk')).send).toHaveBeenCalledWith({ status: 'ok', type: 'disk', result: 'completed' })
    expect(disk).toHaveBeenCalledOnce()
    expect(memory).not.toHaveBeenCalled()
  })

  it('returns skipped for a type without a handler', async () => {
    const memory = vi.fn(async () => {})
    const reply = await call({ path: '/warmup', handlers: { memory } }, 'disk')

    expect(reply.status).not.toHaveBeenCalled()
    expect(reply.send).toHaveBeenCalledWith({ status: 'ok', type: 'disk', result: 'skipped' })
    expect(memory).not.toHaveBeenCalled()
  })

  it('matches the header ignoring case and surrounding whitespace', async () => {
    const memory = vi.fn(async () => {})
    const reply = await call({ path: '/warmup', handlers: { memory } }, '  MeMoRy \t')

    expect(reply.send).toHaveBeenCalledWith({ status: 'ok', type: 'memory', result: 'completed' })
  })

  it.each([undefined, '', '   '])('returns 400 for header %j', async (header) => {
    const memory = vi.fn(async () => {})
    const reply = await call({ path: '/warmup', handlers: { memory } }, header)

    expect(reply.status).toHaveBeenCalledWith(400)
    expect(reply.send).toHaveBeenCalledWith({ error: `${WARMUP_TYPE_HEADER} header is missing or empty` })
    expect(memory).not.toHaveBeenCalled()
  })

  it.each([
    ['cpu', 'cpu'],
    ['memory,disk', 'memory,disk'],
    [' GPU ', 'gpu'],
  ])('skips unknown type %j as %j', async (header, type) => {
    const memory = vi.fn(async () => {})
    const disk = vi.fn(async () => {})
    const request = createRequest(header) as any
    const reply = createReply()

    await warmupHookRoute({ path: '/warmup', handlers: { memory, disk } }).handler(request, reply as any)

    expect(reply.status).not.toHaveBeenCalled()
    expect(reply.send).toHaveBeenCalledWith({ status: 'ok', type, result: 'skipped' })
    expect(request.log.info).toHaveBeenCalledWith(`Warmup (${type}): unknown type, nothing to do`)
    expect(memory).not.toHaveBeenCalled()
    expect(disk).not.toHaveBeenCalled()
  })

  describe('handlers validation', () => {
    const build = (handlers: unknown): unknown =>
      warmupHookRoute({ path: '/warmup', handlers: handlers as WarmupHookConfig['handlers'] })

    it('rejects an unknown key', () => {
      expect(() => build({ memroy: async () => {} })).toThrow(
        'warmupHook.handlers has an unknown key "memroy"; expected memory or disk'
      )
    })

    it('rejects a value that is not a function', () => {
      expect(() => build({ memory: 'load' })).toThrow('warmupHook.handlers.memory must be a function')
      expect(() => build({ disk: undefined })).toThrow('warmupHook.handlers.disk must be a function')
    })

    it.each([undefined, null, 'memory', ['memory']])('rejects handlers %j that are not an object', (handlers) => {
      expect(() => build(handlers)).toThrow('warmupHook.handlers must be an object')
    })

    it('checks keys before the generator check', () => {
      expect(() =>
        build({
          disk: function* () {
            yield
          },
          memroy: async () => {},
        })
      ).toThrow('warmupHook.handlers has an unknown key "memroy"')
    })

    it('allows an empty object, which skips every type', async () => {
      for (const type of ['memory', 'disk']) {
        const reply = await call({ path: '/warmup', handlers: {} }, type)
        expect(reply.send).toHaveBeenCalledWith({ status: 'ok', type, result: 'skipped' })
      }
    })
  })

  it.each([
    [
      'function*',
      function* () {
        yield
      },
    ],
    [
      'async function*',
      async function* () {
        yield
      },
    ],
  ])('throws at construction for a %s handler', (_kind, generator) => {
    for (const type of ['memory', 'disk'] as const) {
      expect(() =>
        warmupHookRoute({ path: '/warmup', handlers: { [type]: generator as unknown as WarmupHandler } })
      ).toThrow(`warmupHook.handlers.${type} is a generator function: its body would never run; remove the yield`)
    }
  })

  it.each(['sync', 'async'])('returns 500 for a handler that returns a %s generator', async (kind) => {
    let bodyRan = false
    function* gen(): Generator<void> {
      bodyRan = true
      yield
    }
    async function* asyncGen(): AsyncGenerator<void> {
      bodyRan = true
      yield
    }
    const memory = (kind === 'sync' ? () => gen() : () => asyncGen()) as unknown as WarmupHandler
    const request = createRequest('memory') as any
    const reply = createReply()

    await warmupHookRoute({ path: '/warmup', handlers: { memory } }).handler(request, reply as any)

    expect(reply.status).toHaveBeenCalledWith(500)
    expect(reply.send).toHaveBeenCalledWith({
      error: 'warmup handler returned an iterator; its body would never run',
      type: 'memory',
    })
    expect(request.log.error).toHaveBeenCalledOnce()
    expect(bodyRan).toBe(false)
  })

  it('completes for a handler that resolves to a non-iterator value', async () => {
    const memory = (async () => 'done') as unknown as WarmupHandler
    const reply = await call({ path: '/warmup', handlers: { memory } }, 'memory')

    expect(reply.send).toHaveBeenCalledWith({ status: 'ok', type: 'memory', result: 'completed' })
  })

  it('returns 500 when the handler rejects with an Error', async () => {
    const reply = await call(
      {
        path: '/warmup',
        handlers: {
          memory: async () => {
            throw new Error('model failed to load')
          },
        },
      },
      'memory'
    )

    expect(reply.status).toHaveBeenCalledWith(500)
    expect(reply.send).toHaveBeenCalledWith({ error: 'model failed to load', type: 'memory' })
  })

  it('returns 500 when the handler rejects with a non-Error', async () => {
    const reply = await call(
      {
        path: '/warmup',
        handlers: {
          disk: async () => {
            throw 'disk unavailable'
          },
        },
      },
      'disk'
    )

    expect(reply.status).toHaveBeenCalledWith(500)
    expect(reply.send).toHaveBeenCalledWith({ error: 'disk unavailable', type: 'disk' })
  })

  it('never runs overlapping calls on one hook together', async () => {
    let active = 0
    let maxActive = 0
    const work = async (): Promise<void> => {
      active++
      maxActive = Math.max(maxActive, active)
      await sleep(20)
      active--
    }
    const route = warmupHookRoute({ path: '/warmup', handlers: { memory: work, disk: work } })

    await Promise.all(
      ['memory', 'disk', 'memory'].map((type) => route.handler(createRequest(type) as any, createReply() as any))
    )

    expect(maxActive).toBe(1)
  })

  it('runs two hooks in parallel', async () => {
    let active = 0
    let maxActive = 0
    const work = async (): Promise<void> => {
      active++
      maxActive = Math.max(maxActive, active)
      await sleep(20)
      active--
    }
    const first = warmupHookRoute({ path: '/a', handlers: { memory: work } })
    const second = warmupHookRoute({ path: '/b', handlers: { memory: work } })

    await Promise.all([
      first.handler(createRequest('memory') as any, createReply() as any),
      second.handler(createRequest('memory') as any, createReply() as any),
    ])

    expect(maxActive).toBe(2)
  })
})

describe('warmup route on a real Fastify server', () => {
  it('returns completed for a POST with no body and no Content-Type', async () => {
    const memory = vi.fn(async () => {})
    const app = new BedrockAgentCoreApp({
      invocationHandler: { process: async () => 'ok' },
      warmupHook: { path: '/warmup', handlers: { memory } },
      config: { logging: { enabled: false } },
    })
    await app['_registerPlugins']()
    app['_setupMainRoutes'](8080)
    await app['_app'].ready()

    try {
      const response = await app['_app'].inject({
        method: 'POST',
        url: '/warmup',
        headers: { [WARMUP_TYPE_HEADER]: 'memory' },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ status: 'ok', type: 'memory', result: 'completed' })
      expect(memory).toHaveBeenCalledOnce()
    } finally {
      await app['_app'].close()
    }
  })
})

describe('normalizeWarmupTypeHeader and isWarmupType', () => {
  it('trims and lower-cases the header and recognizes the warmup types', () => {
    expect(normalizeWarmupTypeHeader(' DISK ')).toBe('disk')
    expect(normalizeWarmupTypeHeader(undefined)).toBe('')
    expect(normalizeWarmupTypeHeader(['Memory', 'disk'])).toBe('memory, disk')
    expect(isWarmupType('memory')).toBe(true)
    expect(isWarmupType('disk')).toBe(true)
    expect(isWarmupType('memoryx')).toBe(false)
  })
})
