import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Express, RequestHandler } from 'express'
import type { Handler, AppConfig } from '../types.js'

// Mock express module
vi.mock('express', () => {
  const expressFn = vi.fn(() => {
    // Create a fresh mock app for each call
    return {
      get: vi.fn(),
      post: vi.fn(),
      use: vi.fn(),
      listen: vi.fn((port: number, callback?: () => void) => {
        if (callback) callback()
        return { close: vi.fn() }
      }),
    }
  })
  // Add json() method to express function
  expressFn.json = vi.fn(() => vi.fn())

  return {
    default: expressFn,
  }
})

describe('BedrockAgentCoreApp', () => {
  let BedrockAgentCoreApp: any
  let express: any

  beforeEach(async () => {
    // Reset mocks
    vi.resetModules()

    // Re-import to get fresh mocks
    express = (await import('express')).default
    const module = await import('../app.js')
    BedrockAgentCoreApp = module.BedrockAgentCoreApp
  })

  describe('constructor', () => {
    it('creates instance with no config', () => {
      const app = new BedrockAgentCoreApp()
      expect(app).toBeDefined()
    })

    it('creates instance with timeout config', () => {
      const app = new BedrockAgentCoreApp({ timeout: 5000 })
      expect(app).toBeDefined()
    })

    it('creates instance with logging config', () => {
      const app = new BedrockAgentCoreApp({
        logging: { enabled: true, level: 'debug' },
      })
      expect(app).toBeDefined()
    })

    it('creates instance with middleware config', () => {
      const middleware: RequestHandler = (req, res, next) => next()
      const app = new BedrockAgentCoreApp({ middleware: [middleware] })
      expect(app).toBeDefined()
    })

    it('initializes Express app', () => {
      new BedrockAgentCoreApp()
      expect(express).toHaveBeenCalled()
    })
  })

  describe('setEntrypoint', () => {
    it('sets handler function', () => {
      const app = new BedrockAgentCoreApp()
      const handler: Handler = async (request, context) => 'test response'

      expect(() => app.setEntrypoint(handler)).not.toThrow()
    })

    it('stores handler for later invocation', () => {
      const app = new BedrockAgentCoreApp()
      const handler: Handler = async (request, context) => 'test response'

      app.setEntrypoint(handler)

      // Handler should be stored (tested indirectly through invocation)
      expect(app._handler).toBe(handler)
    })
  })

  describe('routes setup', () => {
    it('registers GET /ping route', () => {
      const app = new BedrockAgentCoreApp()
      const mockApp = (app as any)._app

      expect(mockApp.get).toHaveBeenCalledWith('/ping', expect.any(Function))
    })

    it('registers POST /invocations route', () => {
      const app = new BedrockAgentCoreApp()
      const mockApp = (app as any)._app

      expect(mockApp.post).toHaveBeenCalledWith('/invocations', expect.any(Function))
    })

    it('applies custom middleware if provided', () => {
      const middleware: RequestHandler = (req, res, next) => next()
      const app = new BedrockAgentCoreApp({ middleware: [middleware] })
      const mockApp = (app as any)._app

      expect(mockApp.use).toHaveBeenCalled()
    })
  })

  describe('health check handler', () => {
    it('returns correct response format', async () => {
      const app = new BedrockAgentCoreApp()
      const mockApp = (app as any)._app

      // Get the health check handler
      const getCall = (mockApp.get as any).mock.calls.find((call: any[]) => call[0] === '/ping')
      expect(getCall).toBeDefined()

      const handler = getCall[1]

      // Mock Express req/res
      const mockReq = {}
      const mockRes = {
        json: vi.fn(),
      }

      await handler(mockReq, mockRes)

      expect(mockRes.json).toHaveBeenCalledWith({
        status: expect.stringMatching(/^(Healthy|HealthyBusy)$/),
        time_of_last_update: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/),
      })
    })

    it('returns Healthy status by default', async () => {
      const app = new BedrockAgentCoreApp()
      const mockApp = (app as any)._app

      const getCall = (mockApp.get as any).mock.calls.find((call: any[]) => call[0] === '/ping')
      const handler = getCall[1]

      const mockRes = { json: vi.fn() }
      await handler({}, mockRes)

      const response = (mockRes.json as any).mock.calls[0][0]
      expect(response.status).toBe('Healthy')
    })

    it('returns valid ISO 8601 timestamp', async () => {
      const app = new BedrockAgentCoreApp()
      const mockApp = (app as any)._app

      const getCall = (mockApp.get as any).mock.calls.find((call: any[]) => call[0] === '/ping')
      const handler = getCall[1]

      const mockRes = { json: vi.fn() }
      await handler({}, mockRes)

      const response = (mockRes.json as any).mock.calls[0][0]
      const timestamp = new Date(response.time_of_last_update)
      expect(timestamp.toISOString()).toBe(response.time_of_last_update)
    })
  })

  describe('invocations handler', () => {
    it('invokes handler with request and context', async () => {
      const app = new BedrockAgentCoreApp()
      const mockApp = (app as any)._app

      const mockHandler = vi.fn(async (request, context) => ({ result: 'success' }))
      app.setEntrypoint(mockHandler)

      // Get the invocations handler
      const postCall = (mockApp.post as any).mock.calls.find((call: any[]) => call[0] === '/invocations')
      const handler = postCall[1]

      const mockReq = {
        body: { test: 'data' },
        headers: {
          'x-amzn-bedrock-agentcore-runtime-session-id': 'session-123',
          'content-type': 'application/json',
        },
      }
      const mockRes = { json: vi.fn(), status: vi.fn().mockReturnThis() }

      await handler(mockReq, mockRes)

      expect(mockHandler).toHaveBeenCalledWith(
        { test: 'data' },
        {
          sessionId: 'session-123',
          headers: expect.objectContaining({
            'x-amzn-bedrock-agentcore-runtime-session-id': 'session-123',
            'content-type': 'application/json',
          }),
        }
      )
    })

    it('extracts sessionId from x-amzn-bedrock-agentcore-runtime-session-id header', async () => {
      const app = new BedrockAgentCoreApp()
      const mockApp = (app as any)._app

      const mockHandler = vi.fn(async (request, context) => ({ result: 'success' }))
      app.setEntrypoint(mockHandler)

      const postCall = (mockApp.post as any).mock.calls.find((call: any[]) => call[0] === '/invocations')
      const handler = postCall[1]

      const mockReq = {
        body: {},
        headers: { 'x-amzn-bedrock-agentcore-runtime-session-id': 'session-from-header' },
      }
      const mockRes = { json: vi.fn(), status: vi.fn().mockReturnThis() }

      await handler(mockReq, mockRes)

      const context = (mockHandler as any).mock.calls[0][1]
      expect(context.sessionId).toBe('session-from-header')
    })

    it('extracts sessionId from request body if header missing', async () => {
      const app = new BedrockAgentCoreApp()
      const mockApp = (app as any)._app

      const mockHandler = vi.fn(async (request, context) => ({ result: 'success' }))
      app.setEntrypoint(mockHandler)

      const postCall = (mockApp.post as any).mock.calls.find((call: any[]) => call[0] === '/invocations')
      const handler = postCall[1]

      const mockReq = {
        body: { sessionId: 'session-from-body' },
        headers: {},
      }
      const mockRes = { json: vi.fn(), status: vi.fn().mockReturnThis() }

      await handler(mockReq, mockRes)

      const context = (mockHandler as any).mock.calls[0][1]
      expect(context.sessionId).toBe('session-from-body')
    })

    it('returns JSON response from handler', async () => {
      const app = new BedrockAgentCoreApp()
      const mockApp = (app as any)._app

      const mockHandler = vi.fn(async () => ({ result: 'success', data: { value: 42 } }))
      app.setEntrypoint(mockHandler)

      const postCall = (mockApp.post as any).mock.calls.find((call: any[]) => call[0] === '/invocations')
      const handler = postCall[1]

      const mockReq = {
        body: {},
        headers: { 'x-amzn-bedrock-agentcore-runtime-session-id': 'session-123' },
      }
      const mockRes = { json: vi.fn(), status: vi.fn().mockReturnThis() }

      await handler(mockReq, mockRes)

      expect(mockRes.json).toHaveBeenCalledWith({ result: 'success', data: { value: 42 } })
    })

    it('returns 500 for internal errors', async () => {
      const app = new BedrockAgentCoreApp()
      const mockApp = (app as any)._app

      const mockHandler = vi.fn(async () => {
        throw new Error('Internal server error')
      })
      app.setEntrypoint(mockHandler)

      const postCall = (mockApp.post as any).mock.calls.find((call: any[]) => call[0] === '/invocations')
      const handler = postCall[1]

      const mockReq = {
        body: {},
        headers: { 'x-amzn-bedrock-agentcore-runtime-session-id': 'session-123' },
      }
      const mockRes = { json: vi.fn(), status: vi.fn().mockReturnThis() }

      await handler(mockReq, mockRes)

      expect(mockRes.status).toHaveBeenCalledWith(500)
      expect(mockRes.json).toHaveBeenCalledWith({
        error: 'Internal server error',
      })
    })

    it('returns 500 when handler not set', async () => {
      const app = new BedrockAgentCoreApp()
      const mockApp = (app as any)._app

      const postCall = (mockApp.post as any).mock.calls.find((call: any[]) => call[0] === '/invocations')
      const handler = postCall[1]

      const mockReq = {
        body: {},
        headers: { 'x-amzn-bedrock-agentcore-runtime-session-id': 'session-123' },
      }
      const mockRes = { json: vi.fn(), status: vi.fn().mockReturnThis() }

      await handler(mockReq, mockRes)

      expect(mockRes.status).toHaveBeenCalledWith(500)
      expect(mockRes.json).toHaveBeenCalledWith({
        error: expect.stringContaining('handler'),
      })
    })

    it('returns 400 when sessionId missing', async () => {
      const app = new BedrockAgentCoreApp()
      const mockApp = (app as any)._app

      const mockHandler = vi.fn(async () => ({ result: 'success' }))
      app.setEntrypoint(mockHandler)

      const postCall = (mockApp.post as any).mock.calls.find((call: any[]) => call[0] === '/invocations')
      const handler = postCall[1]

      const mockReq = {
        body: {},
        headers: {},
      }
      const mockRes = { json: vi.fn(), status: vi.fn().mockReturnThis() }

      await handler(mockReq, mockRes)

      expect(mockRes.status).toHaveBeenCalledWith(400)
      expect(mockRes.json).toHaveBeenCalledWith({
        error: expect.stringContaining('sessionId'),
      })
    })

    it('handles streaming response with async generator', async () => {
      const app = new BedrockAgentCoreApp()
      const mockApp = (app as any)._app

      // Create async generator handler
      const mockHandler = vi.fn(async function* () {
        yield { chunk: 1, data: 'first' }
        yield { chunk: 2, data: 'second' }
        yield { chunk: 3, data: 'third' }
      })
      app.setEntrypoint(mockHandler)

      const postCall = (mockApp.post as any).mock.calls.find((call: any[]) => call[0] === '/invocations')
      const handler = postCall[1]

      const mockReq = {
        body: { test: 'stream' },
        headers: { 'x-amzn-bedrock-agentcore-runtime-session-id': 'session-123' },
      }
      const writes: string[] = []
      const mockRes = {
        setHeader: vi.fn(),
        write: vi.fn((data: string) => writes.push(data)),
        end: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
        writableEnded: false,
        json: vi.fn(),
        status: vi.fn().mockReturnThis(),
      }

      await handler(mockReq, mockRes)

      // Verify SSE headers were set
      expect(mockRes.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream')
      expect(mockRes.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache')
      expect(mockRes.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive')

      // Verify data chunks were written
      expect(writes).toContain('data: {"chunk":1,"data":"first"}\n\n')
      expect(writes).toContain('data: {"chunk":2,"data":"second"}\n\n')
      expect(writes).toContain('data: {"chunk":3,"data":"third"}\n\n')
      expect(writes).toContain('event: done\ndata: {}\n\n')

      // Verify response was ended
      expect(mockRes.end).toHaveBeenCalled()
    })

    it('handles streaming errors gracefully', async () => {
      const app = new BedrockAgentCoreApp()
      const mockApp = (app as any)._app

      // Create async generator that throws
      const mockHandler = vi.fn(async function* () {
        yield { chunk: 1 }
        throw new Error('Streaming error')
      })
      app.setEntrypoint(mockHandler)

      const postCall = (mockApp.post as any).mock.calls.find((call: any[]) => call[0] === '/invocations')
      const handler = postCall[1]

      const mockReq = {
        body: {},
        headers: { 'x-amzn-bedrock-agentcore-runtime-session-id': 'session-123' },
      }
      const writes: string[] = []
      const mockRes = {
        setHeader: vi.fn(),
        write: vi.fn((data: string) => writes.push(data)),
        end: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
        writableEnded: false,
        json: vi.fn(),
        status: vi.fn().mockReturnThis(),
      }

      await handler(mockReq, mockRes)

      // Verify error event was sent
      const errorWrite = writes.find((w) => w.includes('event: error'))
      expect(errorWrite).toBeDefined()
      expect(errorWrite).toContain('Streaming error')
    })

    it('stops streaming when client disconnects', async () => {
      const app = new BedrockAgentCoreApp()
      const mockApp = (app as any)._app

      let chunkCount = 0
      // Create async generator that yields many chunks
      const mockHandler = vi.fn(async function* () {
        for (let i = 0; i < 100; i++) {
          chunkCount++
          yield { chunk: i }
        }
      })
      app.setEntrypoint(mockHandler)

      const postCall = (mockApp.post as any).mock.calls.find((call: any[]) => call[0] === '/invocations')
      const handler = postCall[1]

      const mockReq = {
        body: {},
        headers: { 'x-amzn-bedrock-agentcore-runtime-session-id': 'session-123' },
      }

      const writes: string[] = []
      let closeCallback: (() => void) | null = null
      const mockRes = {
        setHeader: vi.fn(),
        write: vi.fn((data: string) => {
          writes.push(data)
          // Simulate client disconnect after 3 chunks
          if (writes.length === 3 && closeCallback) {
            closeCallback()
          }
          return true
        }),
        end: vi.fn(),
        on: vi.fn((event: string, callback: () => void) => {
          if (event === 'close') {
            closeCallback = callback
          }
        }),
        off: vi.fn(),
        writableEnded: false,
        json: vi.fn(),
        status: vi.fn().mockReturnThis(),
      }

      await handler(mockReq, mockRes)

      // Verify streaming stopped early (should be much less than 100 chunks)
      expect(chunkCount).toBeLessThan(10)
      // Verify close listener was registered and cleaned up
      expect(mockRes.on).toHaveBeenCalledWith('close', expect.any(Function))
      expect(mockRes.off).toHaveBeenCalledWith('close', expect.any(Function))
    })
  })

  describe('run', () => {
    it('starts server on port 8080', () => {
      const app = new BedrockAgentCoreApp()
      const mockApp = (app as any)._app

      app.run()

      expect(mockApp.listen).toHaveBeenCalledWith(8080, expect.any(Function))
    })

    it('logs server startup message', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const app = new BedrockAgentCoreApp()

      app.run()

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('8080'))
      consoleSpy.mockRestore()
    })
  })
})
