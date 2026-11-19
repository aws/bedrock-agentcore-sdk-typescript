import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import request from 'supertest'
import { BedrockAgentCoreApp } from '../app.js'
import type { InvocationHandler } from '../types.js'

describe('Invocation errors with the real SSE plugin', () => {
  let server: FastifyInstance | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  const createServer = async (handler: InvocationHandler): Promise<FastifyInstance> => {
    const app = new BedrockAgentCoreApp({
      invocationHandler: { process: handler },
      config: { logging: { enabled: false } },
    })
    // run() neither returns the server nor exposes shutdown; use typed private access
    // for lifecycle setup while asserting only HTTP behavior with the real plugins.
    server = app['_app']
    await app['_registerPlugins']()
    app['_setupRoutes']()
    await server.ready()
    return server
  }

  it('returns the original JSON error when a non-streaming handler throws with SSE accepted', async () => {
    const app = await createServer(async () => {
      throw new Error('downstream dependency failed')
    })

    const response = await request(app.server)
      .post('/invocations')
      .set('Accept', 'text/event-stream')
      .set('x-amzn-bedrock-agentcore-runtime-session-id', 'test-session')
      .send({})
      .timeout(2000)

    expect(response.status).toBe(500)
    expect(response.headers['content-type']).toContain('application/json')
    expect(response.body).toEqual({ error: 'downstream dependency failed' })
  })

  it('still streams successful responses', async () => {
    const app = await createServer(async function* () {
      yield 'first'
      yield 'second'
    })

    const response = await request(app.server)
      .post('/invocations')
      .set('Accept', 'text/event-stream')
      .set('x-amzn-bedrock-agentcore-runtime-session-id', 'test-session')
      .send({})
      .timeout(2000)

    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toContain('text/event-stream')
    expect(response.text).toContain('data: first\n\n')
    expect(response.text).toContain('data: second\n\n')
  })

  it.each([0, 1])('preserves streaming errors after %i yielded chunks', async (chunks) => {
    const app = await createServer(async function* () {
      for (let i = 0; i < chunks; i++) {
        yield 'first'
      }
      throw new Error('stream failed')
    })

    const response = await request(app.server)
      .post('/invocations')
      .set('Accept', 'text/event-stream')
      .set('x-amzn-bedrock-agentcore-runtime-session-id', 'test-session')
      .send({})
      .timeout(2000)

    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toContain('text/event-stream')
    expect(response.text).toContain('event: error\n')
    expect(response.text).toContain('data: {"error":"stream failed"}\n\n')
    if (chunks > 0) {
      expect(response.text).toContain('data: first\n\n')
      expect(response.text.indexOf('data: first\n\n')).toBeLessThan(response.text.indexOf('event: error\n'))
    }
  })
})
