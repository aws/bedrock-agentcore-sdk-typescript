import { describe, it, expect, vi } from 'vitest'
import { BedrockAgentCoreApp } from '../app.js'
import { WARMUP_TYPE_HEADER } from '../constants.js'
import { parseWarmupType, warmupHookRoute } from '../warmup.js'
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

  it.each([undefined, '', 'cpu', 'memory, disk'])('returns 400 for header %j', async (header) => {
    const memory = vi.fn(async () => {})
    const reply = await call({ path: '/warmup', handlers: { memory } }, header)

    expect(reply.status).toHaveBeenCalledWith(400)
    expect(reply.send).toHaveBeenCalledWith({
      error: `${WARMUP_TYPE_HEADER} must be 'memory' or 'disk', got ${JSON.stringify(header ?? '')}`,
    })
    expect(memory).not.toHaveBeenCalled()
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

describe('parseWarmupType', () => {
  it('parses the warmup types and rejects anything else', () => {
    expect(parseWarmupType('memory')).toBe('memory')
    expect(parseWarmupType(' DISK ')).toBe('disk')
    expect(parseWarmupType(undefined)).toBeUndefined()
    expect(parseWarmupType(['memory', 'disk'])).toBeUndefined()
    expect(parseWarmupType('memoryx')).toBeUndefined()
  })
})
