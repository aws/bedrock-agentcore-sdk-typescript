/**
 * Integration tests for BedrockAgentCoreApp HTTP server
 *
 * These tests validate the actual HTTP endpoints with a real Express server.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { BedrockAgentCoreApp } from '../src/runtime/app.js'
import type { Handler } from '../src/runtime/types.js'

describe('BedrockAgentCoreApp Integration', () => {
  let app: BedrockAgentCoreApp
  let expressApp: Express

  beforeAll(() => {
    // Set up a test handler
    const handler: Handler = async (req, context) => {
      return {
        message: 'Hello from BedrockAgentCore!',
        receivedData: req,
        sessionId: context.sessionId,
      }
    }

    app = new BedrockAgentCoreApp(handler)

    // Get the Express app instance for testing
    expressApp = (app as any)._app
  })

  describe('GET /ping', () => {
    it('returns 200 status code', async () => {
      const response = await request(expressApp).get('/ping')
      expect(response.status).toBe(200)
    })

    it('returns JSON response', async () => {
      const response = await request(expressApp).get('/ping')
      expect(response.type).toBe('application/json')
    })

    it('returns correct health check format', async () => {
      const response = await request(expressApp).get('/ping')
      expect(response.body).toEqual({
        status: expect.stringMatching(/^(Healthy|HealthyBusy)$/),
        time_of_last_update: expect.any(String),
      })
    })

    it('returns Healthy status', async () => {
      const response = await request(expressApp).get('/ping')
      expect(response.body.status).toBe('Healthy')
    })

    it('returns valid ISO 8601 timestamp', async () => {
      const response = await request(expressApp).get('/ping')
      const timestamp = new Date(response.body.time_of_last_update)
      expect(timestamp.toISOString()).toBe(response.body.time_of_last_update)
    })
  })

  describe('POST /invocations', () => {
    it('returns 200 status code for valid request', async () => {
      const response = await request(expressApp)
        .post('/invocations')
        .set('x-amzn-bedrock-agentcore-runtime-session-id', 'test-session')
        .send({ test: 'data' })

      expect(response.status).toBe(200)
    })

    it('returns JSON response', async () => {
      const response = await request(expressApp)
        .post('/invocations')
        .set('x-amzn-bedrock-agentcore-runtime-session-id', 'test-session')
        .send({ test: 'data' })

      expect(response.type).toBe('application/json')
    })

    it('invokes handler with request data', async () => {
      const response = await request(expressApp)
        .post('/invocations')
        .set('x-amzn-bedrock-agentcore-runtime-session-id', 'test-session')
        .send({ test: 'data', value: 42 })

      expect(response.body).toEqual({
        message: 'Hello from BedrockAgentCore!',
        receivedData: { test: 'data', value: 42 },
        sessionId: 'test-session',
      })
    })

    it('provides sessionId from header in context', async () => {
      const response = await request(expressApp)
        .post('/invocations')
        .set('x-amzn-bedrock-agentcore-runtime-session-id', 'my-session-id')
        .send({})

      expect(response.body.sessionId).toBe('my-session-id')
    })

    it('provides sessionId from body if header missing', async () => {
      const response = await request(expressApp).post('/invocations').send({ sessionId: 'body-session-id' })

      expect(response.body.sessionId).toBe('body-session-id')
    })

    it('returns 400 when sessionId missing', async () => {
      const response = await request(expressApp).post('/invocations').send({ test: 'data' })

      expect(response.status).toBe(400)
      expect(response.body).toHaveProperty('error')
      expect(response.body.error).toContain('sessionId')
    })
  })

  describe('Error Handling', () => {
    let errorApp: BedrockAgentCoreApp
    let errorExpressApp: Express

    beforeAll(() => {
      const errorHandler: Handler = async (req, context) => {
        throw new Error('Handler failed')
      }

      errorApp = new BedrockAgentCoreApp(errorHandler)
      errorExpressApp = (errorApp as any)._app
    })

    it('returns 500 when handler throws error', async () => {
      const response = await request(errorExpressApp)
        .post('/invocations')
        .set('x-amzn-bedrock-agentcore-runtime-session-id', 'test-session')
        .send({})

      expect(response.status).toBe(500)
    })

    it('includes error message in response', async () => {
      const response = await request(errorExpressApp)
        .post('/invocations')
        .set('x-amzn-bedrock-agentcore-runtime-session-id', 'test-session')
        .send({})

      expect(response.body).toHaveProperty('error')
      expect(response.body.error).toBe('Handler failed')
    })
  })

  describe('Streaming Responses', () => {
    let streamApp: BedrockAgentCoreApp
    let streamExpressApp: Express

    beforeAll(() => {
      // Set up streaming handler
      const streamHandler: Handler = async function* (req, context) {
        yield { event: 'start', sessionId: context.sessionId }
        yield { event: 'data', content: (req as any).message || 'streaming' }
        yield { event: 'end' }
      }

      streamApp = new BedrockAgentCoreApp(streamHandler)
      streamExpressApp = (streamApp as any)._app
    })

    it('returns SSE content type for streaming', async () => {
      const response = await request(streamExpressApp)
        .post('/invocations')
        .set('x-amzn-bedrock-agentcore-runtime-session-id', 'stream-session')
        .send({ message: 'test' })

      expect(response.headers['content-type']).toContain('text/event-stream')
    })

    it('streams multiple chunks', async () => {
      const response = await request(streamExpressApp)
        .post('/invocations')
        .set('x-amzn-bedrock-agentcore-runtime-session-id', 'stream-session')
        .send({ message: 'test' })

      const body = response.text

      // Verify chunks are in SSE format
      expect(body).toContain('data: {"event":"start","sessionId":"stream-session"}')
      expect(body).toContain('data: {"event":"data","content":"test"}')
      expect(body).toContain('data: {"event":"end"}')
      expect(body).toContain('event: done')
    })

    it('handles streaming errors', async () => {
      const errorHandler: Handler = async function* () {
        yield { event: 'start' }
        throw new Error('Stream error occurred')
      }

      const errorApp = new BedrockAgentCoreApp(errorHandler)
      const errorExpressApp = (errorApp as any)._app

      const response = await request(errorExpressApp)
        .post('/invocations')
        .set('x-amzn-bedrock-agentcore-runtime-session-id', 'error-session')
        .send({})

      const body = response.text
      expect(body).toContain('event: error')
      expect(body).toContain('Stream error occurred')
    })
  })
})
