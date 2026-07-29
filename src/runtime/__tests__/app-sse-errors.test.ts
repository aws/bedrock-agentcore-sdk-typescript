import { describe, it, expect } from 'vitest'
import request from 'supertest'
import type { InvocationHandler } from '../types.js'
import { BedrockAgentCoreApp } from '../app.js'

// This suite deliberately does NOT mock @fastify/sse: it exercises the real
// plugin, because the behaviour under test is the plugin's own Content-Type
// timing. app.test.ts mocks the plugin and therefore cannot cover it.
const buildApp = async (handler: InvocationHandler) => {
  const app = new BedrockAgentCoreApp({ invocationHandler: { process: handler } })
  const fastify = (app as any)._app
  await (app as any)._registerPlugins()
  ;(app as any)._setupRoutes()
  await fastify.ready()
  return fastify
}

describe('BedrockAgentCoreApp invocation errors with the real @fastify/sse plugin', () => {
  it('returns HTTP 500 with a JSON body when a handler throws before streaming and the client sent Accept: text/event-stream', async () => {
    const fastify = await buildApp(async () => {
      throw new Error('Sync handler blew up')
    })

    const res = await request(fastify.server)
      .post('/invocations')
      .set('x-amzn-bedrock-agentcore-runtime-session-id', 'throw-session-sse-accept')
      .set('Accept', 'text/event-stream')
      .send({})
      .expect(500)

    expect(res.body).toEqual({ error: 'Sync handler blew up' })
  })

  it('still streams SSE when the handler yields', async () => {
    const fastify = await buildApp(async function* () {
      yield 'first'
      yield 'second'
    })

    await request(fastify.server)
      .post('/invocations')
      .set('x-amzn-bedrock-agentcore-runtime-session-id', 'stream-session')
      .set('Accept', 'text/event-stream')
      .send({})
      .expect('Content-Type', 'text/event-stream')
      .expect(200)
      .expect((res) => {
        expect(res.text).toContain('data: first')
        expect(res.text).toContain('data: second')
      })
  })
})
