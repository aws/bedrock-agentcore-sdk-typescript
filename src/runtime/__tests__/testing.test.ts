import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { BedrockAgentCoreApp } from '../app.js'
import { createTestClient } from '../testing.js'
import type { BedrockAgentCoreAppParams } from '../types.js'

function createApp<TSchema extends z.ZodSchema>(
  invocationHandler: BedrockAgentCoreAppParams<TSchema>['invocationHandler'],
  pingHandler?: BedrockAgentCoreAppParams<TSchema>['pingHandler']
): BedrockAgentCoreApp<TSchema> {
  return new BedrockAgentCoreApp({
    invocationHandler,
    ...(pingHandler && { pingHandler }),
    config: { logging: { enabled: false } },
  })
}

describe('createTestClient', () => {
  describe('invoke', () => {
    it('returns the JSON response of the handler', async () => {
      const client = createTestClient(
        createApp({ process: async (request: unknown) => ({ echo: (request as { prompt: string }).prompt }) })
      )

      const result = await client.invoke({ prompt: 'hi' })

      expect(result.status).toBe(200)
      expect(result.body).toEqual({ echo: 'hi' })
      expect(result.events).toEqual([])
    })

    it('passes session ID, request ID and custom headers into the request context', async () => {
      const client = createTestClient(
        createApp({
          process: async (_request, context) => ({
            sessionId: context.sessionId,
            requestId: context.requestId,
            headers: context.headers,
          }),
        })
      )

      const result = await client.invoke(
        {},
        {
          sessionId: 'session-1',
          requestId: 'request-1',
          headers: { 'x-amzn-bedrock-agentcore-runtime-custom-tenant': 'acme' },
        }
      )

      expect(result.body).toEqual({
        sessionId: 'session-1',
        requestId: 'request-1',
        headers: { 'x-amzn-bedrock-agentcore-runtime-custom-tenant': 'acme' },
      })
    })

    it('generates a session ID when none is given', async () => {
      const client = createTestClient(createApp({ process: async (_request, context) => context.sessionId }))

      const first = await client.invoke({})
      const second = await client.invoke({})

      expect(first.body).toMatch(/^[0-9a-f-]{36}$/)
      expect(second.body).not.toBe(first.body)
    })

    it('falls back to the body session ID, and returns a 400 without one', async () => {
      const client = createTestClient(createApp({ process: async (_request, context) => context.sessionId }))

      const fromBody = await client.invoke({ sessionId: 'body-session' }, { sessionId: '' })
      const missing = await client.invoke({}, { sessionId: '' })

      expect(fromBody.body).toBe('body-session')
      expect(missing.status).toBe(400)
      expect(missing.body).toEqual({ error: expect.stringContaining('Missing sessionId') })
    })

    it('parses streamed chunks into events', async () => {
      const client = createTestClient(
        createApp({
          process: async function* () {
            yield 'plain'
            yield 'two\nlines'
            yield { text: 'wrapped' }
            yield { event: 'delta', id: '7', data: { text: 'named' } }
          },
        })
      )

      const result = await client.invoke({})

      expect(result.status).toBe(200)
      expect(result.headers['content-type']).toBe('text/event-stream')
      expect(result.events).toEqual([
        { event: 'message', data: 'plain' },
        { event: 'message', data: 'two\nlines' },
        { event: 'message', data: { text: 'wrapped' } },
        { event: 'delta', id: '7', data: { text: 'named' } },
      ])
    })

    it('returns an error event when the stream throws', async () => {
      const client = createTestClient(
        createApp({
          process: async function* () {
            yield { text: 'partial' }
            throw new Error('stream failed')
          },
        })
      )

      const result = await client.invoke({})

      expect(result.events).toEqual([
        { event: 'message', data: { text: 'partial' } },
        { event: 'error', data: { error: 'stream failed' } },
      ])
    })

    it('returns a 500 when the handler throws', async () => {
      const client = createTestClient(
        createApp({
          process: async () => {
            throw new Error('handler failed')
          },
        })
      )

      const result = await client.invoke({})

      expect(result.status).toBe(500)
      expect(result.body).toEqual({ error: 'handler failed' })
    })

    it('returns a 400 when the body fails the request schema', async () => {
      const client = createTestClient(
        createApp({
          requestSchema: z.object({ prompt: z.string() }),
          process: async (request) => `you said ${request.prompt}`,
        })
      )

      const valid = await client.invoke({ prompt: 'hi' })
      const invalid = await client.invoke({ wrong: true })

      expect(valid.body).toBe('you said hi')
      expect(invalid.status).toBe(400)
      expect(invalid.body).toMatchObject({
        error: 'Invalid request body format',
        details: [expect.objectContaining({ path: ['prompt'] })],
      })
    })

    it('sends a string body as text', async () => {
      const client = createTestClient(createApp({ process: async (request) => ({ received: request }) }))

      const result = await client.invoke('raw text')

      expect(result.body).toEqual({ received: 'raw text' })
    })

    it('decodes text and binary responses by content type', async () => {
      const textClient = createTestClient(createApp({ process: async () => 'hello' }))
      const binaryClient = createTestClient(createApp({ process: async () => Buffer.from('bytes') }))

      const text = await textClient.invoke({}, { headers: { accept: 'text/event-stream, text/plain' } })
      const binary = await binaryClient.invoke(
        {},
        { headers: { accept: 'text/event-stream, application/octet-stream' } }
      )

      expect(text.body).toBe('hello')
      expect(binary.body).toEqual(Buffer.from('bytes'))
    })
  })

  describe('ping', () => {
    it('returns the health check response', async () => {
      const client = createTestClient(createApp({ process: async () => 'ok' }))

      const ping = await client.ping()

      expect(ping).toEqual({ status: 'Healthy', time_of_last_update: expect.any(Number) })
    })

    it('reflects a custom ping handler', async () => {
      const client = createTestClient(createApp({ process: async () => 'ok' }, () => 'HealthyBusy'))

      const ping = await client.ping()

      expect(ping.status).toBe('HealthyBusy')
    })
  })
})
