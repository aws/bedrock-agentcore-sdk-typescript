/**
 * Integration tests for BedrockAgentCoreApp HTTP server
 *
 * These tests validate the actual HTTP endpoints with a real Fastify server.
 */

import { createRequire } from 'module'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { BedrockAgentCoreApp } from '../src/runtime/app.js'
import type { Handler } from '../src/runtime/types.js'

const require = createRequire(import.meta.url)

describe('BedrockAgentCoreApp Integration', () => {
  let app: BedrockAgentCoreApp
  let fastifyApp: any

  beforeAll(async () => {
    // Set up a test handler
    const handler: Handler = async (req, context) => {
      return {
        message: 'Hello from BedrockAgentCore!',
        receivedData: req,
        sessionId: context.sessionId,
      }
    }

    app = new BedrockAgentCoreApp(handler)

    // Get the Fastify app instance for testing
    fastifyApp = app._app

    // Register plugins and setup routes (same as run() method but without listening)
    await app._registerPlugins()
    app._setupRoutes()
    await fastifyApp.ready()
  })

  describe('GET /ping', () => {
    it('returns 200 status code', async () => {
      const response = await fastifyApp.inject({
        method: 'GET',
        url: '/ping',
      })
      expect(response.statusCode).toBe(200)
    })

    it('returns JSON response', async () => {
      const response = await fastifyApp.inject({
        method: 'GET',
        url: '/ping',
      })
      expect(response.headers['content-type']).toContain('application/json')
    })

    it('returns correct health check format', async () => {
      const response = await fastifyApp.inject({
        method: 'GET',
        url: '/ping',
      })
      const body = JSON.parse(response.body)
      expect(body).toEqual({
        status: expect.stringMatching(/^(Healthy|HealthyBusy)$/),
        time_of_last_update: expect.any(String),
      })
    })

    it('returns Healthy status', async () => {
      const response = await fastifyApp.inject({
        method: 'GET',
        url: '/ping',
      })
      const body = JSON.parse(response.body)
      expect(body.status).toBe('Healthy')
    })

    it('returns valid ISO 8601 timestamp', async () => {
      const response = await fastifyApp.inject({
        method: 'GET',
        url: '/ping',
      })
      const body = JSON.parse(response.body)
      const timestamp = new Date(body.time_of_last_update)
      expect(timestamp.toISOString()).toBe(body.time_of_last_update)
    })
  })

  describe('POST /invocations', () => {
    it('returns 200 status code for valid request', async () => {
      const response = await fastifyApp.inject({
        method: 'POST',
        url: '/invocations',
        headers: {
          'x-amzn-bedrock-agentcore-runtime-session-id': 'test-session',
          'content-type': 'application/json',
        },
        payload: { test: 'data' },
      })

      expect(response.statusCode).toBe(200)
    })

    it('returns JSON response', async () => {
      const response = await fastifyApp.inject({
        method: 'POST',
        url: '/invocations',
        headers: {
          'x-amzn-bedrock-agentcore-runtime-session-id': 'test-session',
          'content-type': 'application/json',
        },
        payload: { test: 'data' },
      })

      expect(response.headers['content-type']).toContain('application/json')
    })

    it('invokes handler with request data', async () => {
      const response = await fastifyApp.inject({
        method: 'POST',
        url: '/invocations',
        headers: {
          'x-amzn-bedrock-agentcore-runtime-session-id': 'test-session',
          'content-type': 'application/json',
        },
        payload: { test: 'data', value: 42 },
      })

      const body = JSON.parse(response.body)
      expect(body).toEqual({
        message: 'Hello from BedrockAgentCore!',
        receivedData: { test: 'data', value: 42 },
        sessionId: 'test-session',
      })
    })

    it('provides sessionId from header in context', async () => {
      const response = await fastifyApp.inject({
        method: 'POST',
        url: '/invocations',
        headers: {
          'x-amzn-bedrock-agentcore-runtime-session-id': 'my-session-id',
          'content-type': 'application/json',
        },
        payload: {},
      })

      const body = JSON.parse(response.body)
      expect(body.sessionId).toBe('my-session-id')
    })

    it('provides sessionId from body if header missing', async () => {
      const response = await fastifyApp.inject({
        method: 'POST',
        url: '/invocations',
        headers: {
          'content-type': 'application/json',
        },
        payload: { sessionId: 'body-session-id' },
      })

      const body = JSON.parse(response.body)
      expect(body.sessionId).toBe('body-session-id')
    })

    it('returns 400 when sessionId missing', async () => {
      const response = await fastifyApp.inject({
        method: 'POST',
        url: '/invocations',
        headers: {
          'content-type': 'application/json',
        },
        payload: { test: 'data' },
      })

      expect(response.statusCode).toBe(400)
      const body = JSON.parse(response.body)
      expect(body).toHaveProperty('error')
      expect(body.error).toContain('sessionId')
    })
  })

  describe('Error Handling', () => {
    let errorApp: BedrockAgentCoreApp
    let errorFastifyApp: any

    beforeAll(async () => {
      const errorHandler: Handler = async (req, context) => {
        throw new Error('Handler failed')
      }

      errorApp = new BedrockAgentCoreApp(errorHandler)
      errorFastifyApp = errorApp._app

      // Register plugins and setup routes for error handling tests
      await errorApp._registerPlugins()
      errorApp._setupRoutes()
      await errorFastifyApp.ready()
    })

    it('returns 500 when handler throws error', async () => {
      const response = await errorFastifyApp.inject({
        method: 'POST',
        url: '/invocations',
        headers: {
          'x-amzn-bedrock-agentcore-runtime-session-id': 'test-session',
          'content-type': 'application/json',
        },
        payload: {},
      })

      expect(response.statusCode).toBe(500)
    })

    it('includes error message in response', async () => {
      const response = await errorFastifyApp.inject({
        method: 'POST',
        url: '/invocations',
        headers: {
          'x-amzn-bedrock-agentcore-runtime-session-id': 'test-session',
          'content-type': 'application/json',
        },
        payload: {},
      })

      const body = JSON.parse(response.body)
      expect(body).toHaveProperty('error')
      expect(body.error).toBe('Handler failed')
    })
  })

  describe('Streaming Responses', () => {
    it('detects async generator responses correctly', async () => {
      // Test that the server can identify streaming responses
      const streamHandler: Handler = async function* (req, context) {
        yield { event: 'start', sessionId: context.sessionId }
        yield { event: 'data', content: 'test' }
        yield { event: 'end' }
      }

      const streamApp = new BedrockAgentCoreApp(streamHandler)

      // Test the _isAsyncGenerator method directly
      const isAsyncGen = streamApp._isAsyncGenerator(streamHandler({}, { sessionId: 'test', headers: {} }))
      expect(isAsyncGen).toBe(true)

      // Test with non-generator
      const nonStreamHandler: Handler = async () => ({ result: 'not streaming' })
      const isNotAsyncGen = streamApp._isAsyncGenerator(nonStreamHandler({}, { sessionId: 'test', headers: {} }))
      expect(isNotAsyncGen).toBe(false)
    })

    it('handles streaming responses with proper SSE plugin registration', async () => {
      const streamHandler: Handler = async function* (req, context) {
        yield { event: 'start', sessionId: context.sessionId }
        yield { event: 'data', content: 'streaming test' }
        yield { event: 'end' }
      }

      const streamApp = new BedrockAgentCoreApp(streamHandler)
      const streamFastifyApp = streamApp._app

      // Register plugins and setup routes
      await streamApp._registerPlugins()
      streamApp._setupRoutes()
      await streamFastifyApp.ready()

      // Make request with SSE accept header
      const response = await streamFastifyApp.inject({
        method: 'POST',
        url: '/invocations',
        headers: {
          'x-amzn-bedrock-agentcore-runtime-session-id': 'stream-session',
          'content-type': 'application/json',
          'accept': 'text/event-stream',
        },
        payload: { message: 'test' },
      })

      expect(response.statusCode).toBe(200)
      // Verify SSE content type and streaming data
      expect(response.headers['content-type']).toBe('text/event-stream')

      // Verify the SSE stream contains expected events
      const sseBody = response.body
      expect(sseBody).toContain('data: {"event":"start","sessionId":"stream-session"}')
      expect(sseBody).toContain('data: {"event":"data","content":"streaming test"}')
      expect(sseBody).toContain('data: {"event":"end"}')
      expect(sseBody).toContain('event: done')
    })

    it('handles streaming errors properly', async () => {
      const errorHandler: Handler = async function* () {
        yield { event: 'start' }
        throw new Error('Stream error occurred')
      }

      const errorApp = new BedrockAgentCoreApp(errorHandler)
      const errorFastifyApp = errorApp._app

      // Register plugins and setup routes
      await errorApp._registerPlugins()
      errorApp._setupRoutes()
      await errorFastifyApp.ready()

      const response = await errorFastifyApp.inject({
        method: 'POST',
        url: '/invocations',
        headers: {
          'x-amzn-bedrock-agentcore-runtime-session-id': 'error-session',
          'content-type': 'application/json',
          'accept': 'text/event-stream',
        },
        payload: {},
      })

      // With SSE streaming, errors are handled within the stream
      // The response status should still be 200 as the stream starts successfully
      expect(response.statusCode).toBe(200)

      // Verify SSE content type
      expect(response.headers['content-type']).toBe('text/event-stream')

      // Verify the SSE stream contains the start event and error event
      const sseBody = response.body
      expect(sseBody).toContain('data: {"event":"start"}')
      expect(sseBody).toContain('event: error')
      expect(sseBody).toContain('data: {"error":"Stream error occurred"}')
    })
  })
})
