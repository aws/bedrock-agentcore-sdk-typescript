/**
 * Integration tests for BedrockAgentCoreApp HTTP server
 *
 * These tests validate the actual HTTP endpoints with a real server using supertest.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import WebSocket from 'ws'
import { BedrockAgentCoreApp } from '../src/runtime/app.js'
import type { Handler } from '../src/runtime/types.js'

describe('BedrockAgentCoreApp Integration', () => {
  let app: BedrockAgentCoreApp
  let fastify: any

  beforeAll(async () => {
    const handler: Handler = async (req, context) => {
      return {
        message: 'Hello from BedrockAgentCore!',
        receivedData: req,
        sessionId: context.sessionId,
      }
    }

    app = new BedrockAgentCoreApp({ handler })
    fastify = (app as any)._app
    await (app as any)._registerPlugins()
    ;(app as any)._setupRoutes()
    await fastify.ready()
  })

  describe('GET /ping', () => {
    it('returns JSON response with correct structure', async () => {
      await request(fastify.server)
        .get('/ping')
        .expect('Content-Type', /json/)
        .expect(200)
        .expect(function(res) {
          expect(res.body).toHaveProperty('status')
          expect(res.body).toHaveProperty('time_of_last_update')
        })
    })

    it('returns Healthy status', async () => {
      await request(fastify.server)
        .get('/ping')
        .expect(200)
        .expect(function(res) {
          expect(res.body.status).toBe('Healthy')
        })
    })

    it('returns valid ISO 8601 timestamp', async () => {
      await request(fastify.server)
        .get('/ping')
        .expect(200)
        .expect(function(res) {
          const timestamp = new Date(res.body.time_of_last_update)
          expect(timestamp.toISOString()).toBe(res.body.time_of_last_update)
        })
    })

    it('returns HealthyBusy with active tasks', async () => {
      // Create app with task tracking
      const handler: Handler = async (req, context) => {
        return { message: 'test' }
      }
      const testApp = new BedrockAgentCoreApp(handler)

      // Add a task
      testApp.addAsyncTask('test-task')

      // Setup routes
      await testApp._registerPlugins()
      testApp._setupRoutes()
      await testApp._app.ready()

      const response = await testApp._app.inject({
        method: 'GET',
        url: '/ping',
      })

      const body = JSON.parse(response.body)
      expect(body.status).toBe('HealthyBusy')
    })

    it('custom ping handler works', async () => {
      const handler: Handler = async (req, context) => {
        return { message: 'test' }
      }
      const testApp = new BedrockAgentCoreApp(handler)

      // Register custom handler
      testApp.ping(() => 'HealthyBusy')

      // Setup routes
      await testApp._registerPlugins()
      testApp._setupRoutes()
      await testApp._app.ready()

      const response = await testApp._app.inject({
        method: 'GET',
        url: '/ping',
      })

      const body = JSON.parse(response.body)
      expect(body.status).toBe('HealthyBusy')
    })
  })

  describe('POST /invocations', () => {
    it('invokes handler with request data', async () => {
      await request(fastify.server)
        .post('/invocations')
        .set('x-amzn-bedrock-agentcore-runtime-session-id', 'test-session')
        .send({ test: 'data', value: 42 })
        .expect('Content-Type', /json/)
        .expect(200)
        .expect(function(res) {
          expect(res.body).toEqual({
            message: 'Hello from BedrockAgentCore!',
            receivedData: { test: 'data', value: 42 },
            sessionId: 'test-session',
          })
        })
    })

    it('provides sessionId from header in context', async () => {
      await request(fastify.server)
        .post('/invocations')
        .set('x-amzn-bedrock-agentcore-runtime-session-id', 'my-session-id')
        .send({})
        .expect(200)
        .expect(function(res) {
          expect(res.body.sessionId).toBe('my-session-id')
        })
    })

    it('provides sessionId from body if header missing', async () => {
      await request(fastify.server)
        .post('/invocations')
        .send({ sessionId: 'body-session-id' })
        .expect(200)
        .expect(function(res) {
          expect(res.body.sessionId).toBe('body-session-id')
        })
    })

    it('returns 400 when sessionId missing', async () => {
      await request(fastify.server)
        .post('/invocations')
        .send({ test: 'data' })
        .expect(400)
    })

    describe('Error Handling', () => {
      let errorFastify: any

      beforeAll(async () => {
        const errorHandler: Handler = async (req, context) => {
          throw new Error('Handler failed')
        }

        const errorApp = new BedrockAgentCoreApp({ handler: errorHandler })
        errorFastify = (errorApp as any)._app
        await (errorApp as any)._registerPlugins()
        ;(errorApp as any)._setupRoutes()
        await errorFastify.ready()
      })

      it('returns 500 when handler throws error', async () => {
        await request(errorFastify.server)
          .post('/invocations')
          .set('x-amzn-bedrock-agentcore-runtime-session-id', 'test-session')
          .send({})
          .expect(500)
      })

      it('includes error message in response', async () => {
        await request(errorFastify.server)
          .post('/invocations')
          .set('x-amzn-bedrock-agentcore-runtime-session-id', 'test-session')
          .send({})
          .expect(500)
          .expect(function(res) {
            expect(res.body).toHaveProperty('error')
            expect(res.body.error).toBe('Handler failed')
          })
      })
    })

    describe('Streaming Responses', () => {
      let streamFastify: any

      beforeAll(async () => {
        const streamHandler: Handler = async function* (req, context) {
          yield { event: 'start', sessionId: context.sessionId }
          yield { event: 'data', content: 'streaming test' }
          yield { event: 'end' }
        }

        const streamApp = new BedrockAgentCoreApp({ handler: streamHandler })
        streamFastify = (streamApp as any)._app
        await (streamApp as any)._registerPlugins()
        ;(streamApp as any)._setupRoutes()
        await streamFastify.ready()
      })

      it('handles streaming responses with SSE', async () => {
        await request(streamFastify.server)
          .post('/invocations')
          .set('x-amzn-bedrock-agentcore-runtime-session-id', 'stream-session')
          .set('accept', 'text/event-stream')
          .send({ message: 'test' })
          .expect('Content-Type', 'text/event-stream')
          .expect(200)
          .expect(function(res) {
            expect(res.text).toContain('data: {"event":"start","sessionId":"stream-session"}')
            expect(res.text).toContain('data: {"event":"data","content":"streaming test"}')
            expect(res.text).toContain('data: {"event":"end"}')
          })
      })
    })
  })

  describe('WebSocket /ws', () => {
    let wsApp: BedrockAgentCoreApp
    let server: any

    beforeAll(async () => {
      const wsHandler: Handler = async (req, context) => {
        return { message: 'HTTP handler', sessionId: context.sessionId }
      }

      const websocketHandler = async (socket: any, context: any) => {
        socket.send(JSON.stringify({ 
          type: 'connected', 
          sessionId: context.sessionId 
        }))
        
        socket.on('message', (message: string) => {
          const data = JSON.parse(message)
          socket.send(JSON.stringify({ 
            type: 'echo', 
            received: data,
            sessionId: context.sessionId 
          }))
        })
      }

      wsApp = new BedrockAgentCoreApp({ 
        handler: wsHandler, 
        websocketHandler 
      })
      
      // Get the underlying Fastify server and start it manually
      const fastify = (wsApp as any)._app
      await (wsApp as any)._registerPlugins()
      ;(wsApp as any)._setupRoutes()
      await fastify.ready()
      await fastify.listen({ port: 0, host: '127.0.0.1' })
      server = fastify.server
    })

    afterAll(async () => {
      if (server) {
        await new Promise<void>((resolve) => {
          server.close(() => resolve())
        })
      }
    })

    it('establishes websocket connection', async () => {
      const port = server.address().port
      const ws = new WebSocket(`ws://localhost:${port}/ws`)
      
      await new Promise((resolve, reject) => {
        ws.on('open', resolve)
        ws.on('error', reject)
      })
      
      ws.close()
    })

    it('receives connected message with sessionId from header', async () => {
      const port = server.address().port
      const ws = new WebSocket(`ws://localhost:${port}/ws`, {
        headers: {
          'x-amzn-bedrock-agentcore-runtime-session-id': 'test-session-123'
        }
      })
      
      const message = await new Promise((resolve, reject) => {
        ws.on('message', (data) => {
          resolve(JSON.parse(data.toString()))
        })
        ws.on('error', reject)
      })
      
      expect(message).toEqual({
        type: 'connected',
        sessionId: 'test-session-123'
      })
      
      ws.close()
    })

    it('handles bidirectional messaging', async () => {
      const port = server.address().port
      const ws = new WebSocket(`ws://localhost:${port}/ws`, {
        headers: {
          'x-amzn-bedrock-agentcore-runtime-session-id': 'echo-session'
        }
      })
      
      // Wait for connection and skip connected message
      await new Promise((resolve, reject) => {
        ws.on('message', resolve)
        ws.on('error', reject)
      })
      
      // Send test message
      ws.send(JSON.stringify({ test: 'hello', value: 42 }))
      
      // Receive echo response
      const response = await new Promise((resolve, reject) => {
        ws.on('message', (data) => {
          resolve(JSON.parse(data.toString()))
        })
        ws.on('error', reject)
      })
      
      expect(response).toEqual({
        type: 'echo',
        received: { test: 'hello', value: 42 },
        sessionId: 'echo-session'
      })
      
      ws.close()
    })

    describe('Error Handling', () => {
      let errorServer: any

      beforeAll(async () => {
        const errorWebsocketHandler = async (socket: any, context: any) => {
          throw new Error('WebSocket handler failed')
        }

        const errorApp = new BedrockAgentCoreApp({ 
          handler: async () => ({}), 
          websocketHandler: errorWebsocketHandler 
        })
        
        const errorFastify = (errorApp as any)._app
        await (errorApp as any)._registerPlugins()
        ;(errorApp as any)._setupRoutes()
        await errorFastify.ready()
        await errorFastify.listen({ port: 0, host: '127.0.0.1' })
        errorServer = errorFastify.server
      })

      afterAll(async () => {
        if (errorServer) {
          await new Promise<void>((resolve) => {
            errorServer.close(() => resolve())
          })
        }
      })

      it('rejects non-websocket requests to /ws endpoint', async () => {
        await request(server)
          .get('/ws')
          .expect(404) // WebSocket route not found for HTTP requests
      })

      it('closes connection when handler throws error', async () => {
        const port = errorServer.address().port
        const ws = new WebSocket(`ws://localhost:${port}/ws`, {
          headers: {
            'x-amzn-bedrock-agentcore-runtime-session-id': 'error-session'
          }
        })
        
        const closeEvent = await new Promise((resolve, reject) => {
          ws.on('close', (code, reason) => {
            resolve({ code, reason: reason.toString() })
          })
          ws.on('error', reject)
        })
        
        expect(closeEvent.code).toBe(1011) // Internal server error
      })
    })
  })

  describe('Content Type Parsers', () => {
    let app: BedrockAgentCoreApp
    let fastify: any

    beforeAll(async () => {
      const handler: Handler = async (req, context) => {
        return {
          message: 'Content parsed successfully!',
          sessionId: context.sessionId,
          parsedData: req
        }
      }

      app = new BedrockAgentCoreApp({
        handler,
        config: {
          contentTypeParsers: [
            {
              // Async parser for XML content
              contentType: 'application/xml',
              parser: async (request, body) => {
                const content = body as string
                return {
                  type: 'xml',
                  content: content.trim(),
                  parsed: true,
                }
              },
              parseAs: 'string',
            },
            {
              // Async parser for JSON with validation
              contentType: 'application/custom-json',
              parser: async (request, body) => {
                const content = body as string

                // Simulate async validation (e.g., schema validation, external API call)
                await new Promise(resolve => setTimeout(resolve, 10))

                try {
                  const parsed = JSON.parse(content)
                  return {
                    type: 'custom-json',
                    data: parsed,
                    validated: true,
                  }
                } catch (error) {
                  throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : 'Unknown error'}`)
                }
              },
              parseAs: 'string',
            },
            {
              // Async parser for binary data
              contentType: 'application/octet-stream',
              parser: async (request, body) => {
                const buffer = body as Buffer
                return {
                  type: 'binary',
                  size: buffer.length,
                  checksum: buffer.toString('hex').slice(0, 8), // Simple checksum
                }
              },
              parseAs: 'buffer',
            },
            {
              // Parser that throws an error for testing error handling
              contentType: 'application/error-test',
              parser: async (request, body) => {
                throw new Error('Parser intentionally failed')
              },
              parseAs: 'string',
            },
            {
              // Callback-based parser for CSV content
              contentType: 'text/csv',
              parser: (request, body, done) => {
                try {
                  const content = (body as string).trim()
                  if (!content) {
                    done(null, { type: 'csv', headers: [], rows: [], rowCount: 0, parsed: true })
                    return
                  }
                  
                  const lines = content.split('\n')
                  const headers = lines[0]?.split(',') || []
                  const rows = lines.slice(1).map(line => line.split(','))
                  
                  done(null, { type: 'csv', headers, rows, rowCount: rows.length, parsed: true })
                } catch (error) {
                  done(error instanceof Error ? error : new Error('CSV parsing failed'))
                }
              },
              parseAs: 'string',
            },
            {
              // Callback-based parser that calls done with error
              contentType: 'application/callback-error-test',
              parser: (request, body, done) => {
                // Simulate some processing then call done with error
                done(new Error('Callback parser intentionally failed'))
              },
              parseAs: 'string',
            },
          ],
        },
      })

      fastify = (app as any)._app
      await (app as any)._registerPlugins()
      ;(app as any)._setupContentTypeParsers()
      ;(app as any)._setupRoutes()
      await fastify.ready()
    })

    afterAll(async () => {
      await fastify.close()
    })

    describe('XML Parser (Async)', () => {
      it('parses XML content correctly', async () => {
        const xmlContent = `<?xml version="1.0" encoding="UTF-8"?>
          <root>
            <message>Hello from XML parser!</message>
            <timestamp>2024-01-01T00:00:00Z</timestamp>
          </root>`

        await request(fastify.server)
          .post('/invocations')
          .set('Content-Type', 'application/xml')
          .set('x-amzn-bedrock-agentcore-runtime-session-id', 'test-session-xml')
          .send(xmlContent)
          .expect(200)
          .expect(function(res) {
            expect(res.body.message).toBe('Content parsed successfully!')
            expect(res.body.sessionId).toBe('test-session-xml')
            expect(res.body.parsedData).toEqual({
              type: 'xml',
              content: xmlContent.trim(),
              parsed: true,
            })
          })
      })

      it('handles empty XML content', async () => {
        await request(fastify.server)
          .post('/invocations')
          .set('Content-Type', 'application/xml')
          .set('x-amzn-bedrock-agentcore-runtime-session-id', 'test-session-xml-empty')
          .send('')
          .expect(200)
          .expect(function(res) {
            expect(res.body.parsedData).toEqual({
              type: 'xml',
              content: '',
              parsed: true,
            })
          })
      })
    })

    describe('Custom JSON Parser (Async)', () => {
      it('parses valid JSON with async validation', async () => {
        const jsonData = {
          name: 'John Doe',
          age: 30,
          city: 'New York',
          hobbies: ['reading', 'coding', 'hiking']
        }

        await request(fastify.server)
          .post('/invocations')
          .set('Content-Type', 'application/custom-json')
          .set('x-amzn-bedrock-agentcore-runtime-session-id', 'test-session-json')
          .send(JSON.stringify(jsonData))
          .expect(200)
          .expect(function(res) {
            expect(res.body.message).toBe('Content parsed successfully!')
            expect(res.body.sessionId).toBe('test-session-json')
            expect(res.body.parsedData).toEqual({
              type: 'custom-json',
              data: jsonData,
              validated: true,
            })
          })
      })

      it('handles invalid JSON with proper error message', async () => {
        const invalidJson = '{"invalid": json, "missing": quotes}'

        await request(fastify.server)
          .post('/invocations')
          .set('Content-Type', 'application/custom-json')
          .set('x-amzn-bedrock-agentcore-runtime-session-id', 'test-session-invalid-json')
          .send(invalidJson)
          .expect(500)
          .expect(function(res) {
            // Fastify wraps parser errors with generic "Internal Server Error"
            expect(res.body.error).toBeDefined()
            expect(typeof res.body.error).toBe('string')
          })
      })

      it('handles empty JSON content', async () => {
        await request(fastify.server)
          .post('/invocations')
          .set('Content-Type', 'application/custom-json')
          .set('x-amzn-bedrock-agentcore-runtime-session-id', 'test-session-json-empty')
          .send('{}')
          .expect(200)
          .expect(function(res) {
            expect(res.body.parsedData).toEqual({
              type: 'custom-json',
              data: {},
              validated: true,
            })
          })
      })
    })

    describe('Binary Parser (Buffer)', () => {
      it('parses binary data correctly', async () => {
        const binaryData = Buffer.from('Hello, this is binary data! 🚀', 'utf8')

        await request(fastify.server)
          .post('/invocations')
          .set('Content-Type', 'application/octet-stream')
          .set('x-amzn-bedrock-agentcore-runtime-session-id', 'test-session-binary')
          .send(binaryData)
          .expect(200)
          .expect(function(res) {
            expect(res.body.message).toBe('Content parsed successfully!')
            expect(res.body.sessionId).toBe('test-session-binary')
            expect(res.body.parsedData).toEqual({
              type: 'binary',
              size: binaryData.length,
              checksum: binaryData.toString('hex').slice(0, 8),
            })
          })
      })

      it('handles empty binary data', async () => {
        const emptyBuffer = Buffer.alloc(0)

        await request(fastify.server)
          .post('/invocations')
          .set('Content-Type', 'application/octet-stream')
          .set('x-amzn-bedrock-agentcore-runtime-session-id', 'test-session-binary-empty')
          .send(emptyBuffer)
          .expect(200)
          .expect(function(res) {
            expect(res.body.parsedData).toEqual({
              type: 'binary',
              size: 0,
              checksum: '',
            })
          })
      })

      it('handles large binary data', async () => {
        // Create a 1KB buffer with repeating pattern
        const largeBuffer = Buffer.alloc(1024, 'A')

        await request(fastify.server)
          .post('/invocations')
          .set('Content-Type', 'application/octet-stream')
          .set('x-amzn-bedrock-agentcore-runtime-session-id', 'test-session-binary-large')
          .send(largeBuffer)
          .expect(200)
          .expect(function(res) {
            expect(res.body.parsedData).toEqual({
              type: 'binary',
              size: 1024,
              checksum: largeBuffer.toString('hex').slice(0, 8),
            })
          })
      })
    })

    describe('Default Content Types', () => {
      it('uses default JSON parser for application/json', async () => {
        const jsonData = { message: 'This should use default JSON parser', test: true }

        await request(fastify.server)
          .post('/invocations')
          .set('Content-Type', 'application/json')
          .set('x-amzn-bedrock-agentcore-runtime-session-id', 'test-session-default-json')
          .send(jsonData)
          .expect(200)
          .expect(function(res) {
            expect(res.body.message).toBe('Content parsed successfully!')
            expect(res.body.parsedData).toEqual(jsonData)
          })
      })

      it('uses default text parser for text/plain', async () => {
        const textData = 'This is plain text content'

        await request(fastify.server)
          .post('/invocations')
          .set('Content-Type', 'text/plain')
          .set('x-amzn-bedrock-agentcore-runtime-session-id', 'test-session-text')
          .send(textData)
          .expect(200)
          .expect(function(res) {
            expect(res.body.message).toBe('Content parsed successfully!')
            expect(res.body.parsedData).toBe(textData)
          })
      })
    })

    describe('Error Handling', () => {
      it('handles parser that throws synchronous error', async () => {
        await request(fastify.server)
          .post('/invocations')
          .set('Content-Type', 'application/error-test')
          .set('x-amzn-bedrock-agentcore-runtime-session-id', 'test-session-error')
          .send('test content')
          .expect(500)
          .expect(function(res) {
            // Fastify wraps parser errors with generic "Internal Server Error"
            expect(res.body.error).toBeDefined()
            expect(typeof res.body.error).toBe('string')
          })
      })

      it('handles callback-based parser that calls done with error', async () => {
        await request(fastify.server)
          .post('/invocations')
          .set('Content-Type', 'application/callback-error-test')
          .set('x-amzn-bedrock-agentcore-runtime-session-id', 'test-session-callback-error')
          .send('test content')
          .expect(500)
          .expect(function(res) {
            // Fastify wraps parser errors with generic "Internal Server Error"
            expect(res.body.error).toBeDefined()
            expect(typeof res.body.error).toBe('string')
          })
    

      it('handles unsupported content type gracefully', async () => {
        await request(fastify.server)
          .post('/invocations')
          .set('Content-Type', 'application/unsupported-type')
          .set('x-amzn-bedrock-agentcore-runtime-session-id', 'test-session-unsupported')
          .send('some content')
          .expect(415) // Fastify returns 415 for unsupported media types
          .expect(function(res) {
            expect(res.body.error).toBeDefined()
            expect(res.body.message).toContain('Unsupported Media Type')
          })
      })
    })

    describe('Callback-Based Parsers', () => {
      it('parses CSV content using callback pattern', async () => {
        const csvContent = `name,age,city
John Doe,30,New York
Jane Smith,25,Los Angeles
Bob Johnson,35,Chicago`

        await request(fastify.server)
          .post('/invocations')
          .set('Content-Type', 'text/csv')
          .set('x-amzn-bedrock-agentcore-runtime-session-id', 'test-session-csv')
          .send(csvContent)
          .expect(200)
          .expect(function(res) {
            expect(res.body.message).toBe('Content parsed successfully!')
            expect(res.body.sessionId).toBe('test-session-csv')
            expect(res.body.parsedData).toEqual({
              type: 'csv',
              headers: ['name', 'age', 'city'],
              rows: [
                ['John Doe', '30', 'New York'],
                ['Jane Smith', '25', 'Los Angeles'],
                ['Bob Johnson', '35', 'Chicago']
              ],
              rowCount: 3,
              parsed: true,
            })
          })
      })

      it('handles empty CSV content with callback pattern', async () => {
        await request(fastify.server)
          .post('/invocations')
          .set('Content-Type', 'text/csv')
          .set('x-amzn-bedrock-agentcore-runtime-session-id', 'test-session-csv-empty')
          .send('')
          .expect(200)
          .expect(function(res) {
            expect(res.body.parsedData).toEqual({
              type: 'csv',
              headers: [],
              rows: [],
              rowCount: 0,
              parsed: true,
            })
          })
      })

      it('handles single header CSV with callback pattern', async () => {
        const csvContent = 'name,age,city'

        await request(fastify.server)
          .post('/invocations')
          .set('Content-Type', 'text/csv')
          .set('x-amzn-bedrock-agentcore-runtime-session-id', 'test-session-csv-header-only')
          .send(csvContent)
          .expect(200)
          .expect(function(res) {
            expect(res.body.parsedData).toEqual({
              type: 'csv',
              headers: ['name', 'age', 'city'],
              rows: [],
              rowCount: 0,
              parsed: true,
            })
          })
      })
    })
  })

  describe('Session Management Features', () => {
    let testApp: BedrockAgentCoreApp
    let testFastify: any
    let capturedContext: any

    beforeAll(async () => {
      const handler: Handler = async (req, context) => {
        capturedContext = context
        return { success: true, context }
      }

      testApp = new BedrockAgentCoreApp({ handler })
      testFastify = (testApp as any)._app
      await (testApp as any)._registerPlugins()
      ;(testApp as any)._setupRoutes()
      await testFastify.ready()
    })

    afterAll(async () => {
      await testFastify.close()
    })

    it('extracts requestId from header', async () => {
      await request(testFastify.server)
        .post('/invocations')
        .set('X-Amzn-Bedrock-AgentCore-Runtime-Session-Id', 'test-session')
        .set('X-Amzn-Bedrock-AgentCore-Runtime-Request-Id', 'test-request-123')
        .send({ test: 'data' })
        .expect(200)

      expect(capturedContext.requestId).toBe('test-request-123')
    })

    it('auto-generates requestId when header missing', async () => {
      await request(testFastify.server)
        .post('/invocations')
        .set('X-Amzn-Bedrock-AgentCore-Runtime-Session-Id', 'test-session')
        .send({ test: 'data' })
        .expect(200)

      expect(capturedContext.requestId).toBeDefined()
      expect(typeof capturedContext.requestId).toBe('string')
      expect(capturedContext.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    })

    it('extracts oauth2CallbackUrl from header', async () => {
      await request(testFastify.server)
        .post('/invocations')
        .set('X-Amzn-Bedrock-AgentCore-Runtime-Session-Id', 'test-session')
        .set('OAuth2CallbackUrl', 'https://example.com/callback')
        .send({ test: 'data' })
        .expect(200)

      expect(capturedContext.oauth2CallbackUrl).toBe('https://example.com/callback')
    })

    it('filters headers to include only Authorization and Custom-* headers', async () => {
      await request(testFastify.server)
        .post('/invocations')
        .set('X-Amzn-Bedrock-AgentCore-Runtime-Session-Id', 'test-session')
        .set('Authorization', 'Bearer token123')
        .set('X-Amzn-Bedrock-AgentCore-Runtime-Custom-Foo', 'bar')
        .set('User-Agent', 'test-agent')
        .set('Content-Type', 'application/json')
        .send({ test: 'data' })
        .expect(200)

      expect(capturedContext.headers['authorization']).toBe('Bearer token123')
      expect(capturedContext.headers['x-amzn-bedrock-agentcore-runtime-custom-foo']).toBe('bar')
      expect(capturedContext.headers['user-agent']).toBeUndefined()
      expect(capturedContext.headers['content-type']).toBeUndefined()
    })

    it('includes custom headers in filtered headers', async () => {
      await request(testFastify.server)
        .post('/invocations')
        .set('X-Amzn-Bedrock-AgentCore-Runtime-Session-Id', 'test-session')
        .set('X-Amzn-Bedrock-AgentCore-Runtime-Custom-Metadata', 'test-value')
        .send({ test: 'data' })
        .expect(200)

      expect(capturedContext.headers['x-amzn-bedrock-agentcore-runtime-custom-metadata']).toBe('test-value')
    })

    it('maintains backward compatibility', async () => {
      await request(testFastify.server)
        .post('/invocations')
        .set('X-Amzn-Bedrock-AgentCore-Runtime-Session-Id', 'test-session')
        .send({ test: 'data' })
        .expect(200)

      expect(capturedContext.sessionId).toBe('test-session')
      expect(capturedContext.requestId).toBeDefined()
      expect(capturedContext.headers).toBeDefined()
    })
  })
})
