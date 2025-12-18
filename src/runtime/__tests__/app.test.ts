import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { FastifyPluginAsync } from 'fastify'
import type { Handler } from '../types.js'

// Mock fastify module
vi.mock('fastify', () => {
  const mockFastify = vi.fn(() => {
    return {
      get: vi.fn(),
      post: vi.fn(),
      register: vi.fn(async () => {}), // Make register async
      ready: vi.fn(async () => {}), // Add ready method
      listen: vi.fn(async () => {}),
      log: {
        error: vi.fn(),
      },
    }
  })
  return { default: mockFastify }
})

// Mock @fastify/sse
vi.mock('@fastify/sse', () => {
  return vi.fn()
})

describe('BedrockAgentCoreApp', () => {
  let BedrockAgentCoreApp: any
  let Fastify: any

  beforeEach(async () => {
    vi.resetModules()
    Fastify = (await import('fastify')).default
    const module = await import('../app.js')
    BedrockAgentCoreApp = module.BedrockAgentCoreApp
  })

  describe('constructor', () => {
    it('creates instance with handler', () => {
      const handler: Handler = async (request, context) => 'test response'
      const app = new BedrockAgentCoreApp(handler)
      expect(app).toBeDefined()
    })

    it('creates instance with handler and logging config', () => {
      const handler: Handler = async (request, context) => 'test response'
      const app = new BedrockAgentCoreApp(handler, {
        logging: { enabled: true, level: 'debug' },
      })
      expect(app).toBeDefined()
    })

    it('initializes Fastify app', () => {
      const handler: Handler = async (request, context) => 'test response'
      new BedrockAgentCoreApp(handler)
      expect(Fastify).toHaveBeenCalled()
    })

    it('configures logger with default settings when no config provided', () => {
      const handler: Handler = async (request, context) => 'test response'
      new BedrockAgentCoreApp(handler)
      expect(Fastify).toHaveBeenCalledWith({ logger: true })
    })

    it('configures logger with custom level', () => {
      const handler: Handler = async (request, context) => 'test response'
      new BedrockAgentCoreApp(handler, {
        logging: { enabled: true, level: 'debug' },
      })
      expect(Fastify).toHaveBeenCalledWith({ logger: { level: 'debug' } })
    })

    it('disables logger when logging is disabled', () => {
      const handler: Handler = async (request, context) => 'test response'
      new BedrockAgentCoreApp(handler, {
        logging: { enabled: false },
      })
      expect(Fastify).toHaveBeenCalledWith({ logger: false })
    })

    it('uses info level as default when level not specified', () => {
      const handler: Handler = async (request, context) => 'test response'
      new BedrockAgentCoreApp(handler, {
        logging: { enabled: true },
      })
      expect(Fastify).toHaveBeenCalledWith({ logger: { level: 'info' } })
    })
  })

  describe('routes setup', () => {
    it('registers GET /ping route', () => {
      const handler: Handler = async (request, context) => 'test response'
      const app = new BedrockAgentCoreApp(handler)
      const mockApp = app._app

      // Call _setupRoutes to register the routes
      app._setupRoutes()

      expect(mockApp.get).toHaveBeenCalledWith('/ping', expect.any(Function))
    })

    it('registers POST /invocations route', () => {
      const handler: Handler = async (request, context) => 'test response'
      const app = new BedrockAgentCoreApp(handler)
      const mockApp = app._app

      // Call _setupRoutes to register the routes
      app._setupRoutes()

      expect(mockApp.post).toHaveBeenCalledWith('/invocations', { sse: true }, expect.any(Function))
    })
  })

  describe('health check handler', () => {
    it('returns correct response format', async () => {
      const handler: Handler = async (request, context) => 'test response'
      const app = new BedrockAgentCoreApp(handler)
      const mockApp = app._app

      // Call _setupRoutes to register the routes
      app._setupRoutes()

      const getCall = mockApp.get.mock.calls.find((call: any[]) => call[0] === '/ping')
      const pingHandler = getCall[1]
      const mockReq = {}
      const mockReply = { send: vi.fn() }
      await pingHandler(mockReq, mockReply)
      expect(mockReply.send).toHaveBeenCalledWith({
        status: expect.stringMatching(/^(Healthy|HealthyBusy)$/),
        time_of_last_update: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/),
      })
    })
  })

  describe('invocations handler', () => {
    it('invokes handler with request and context', async () => {
      const mockHandler = vi.fn(async (request, context) => ({ result: 'success' }))
      const app = new BedrockAgentCoreApp(mockHandler)
      const mockApp = app._app

      // Call _setupRoutes to register the routes
      app._setupRoutes()

      const postCall = mockApp.post.mock.calls.find((call: any[]) => call[0] === '/invocations')
      const invocationHandler = postCall[2] // Third argument since we have { sse: true } as second
      const mockReq = {
        body: { test: 'data' },
        headers: {
          'x-amzn-bedrock-agentcore-runtime-session-id': 'session-123',
          'content-type': 'application/json',
        },
      }
      const mockReply = { send: vi.fn(), status: vi.fn().mockReturnThis() }
      await invocationHandler(mockReq, mockReply)
      expect(mockHandler).toHaveBeenCalledWith(
        { test: 'data' },
        {
          sessionId: 'session-123',
          headers: expect.objectContaining({
            'x-amzn-bedrock-agentcore-runtime-session-id': 'session-123',
          }),
        }
      )
    })

    it('returns JSON response from handler', async () => {
      const mockHandler = vi.fn(async () => ({ result: 'success' }))
      const app = new BedrockAgentCoreApp(mockHandler)
      const mockApp = app._app

      // Call _setupRoutes to register the routes
      app._setupRoutes()

      const postCall = mockApp.post.mock.calls.find((call: any[]) => call[0] === '/invocations')
      const invocationHandler = postCall[2] // Third argument since we have { sse: true } as second
      const mockReq = {
        body: {},
        headers: { 'x-amzn-bedrock-agentcore-runtime-session-id': 'session-123' },
      }
      const mockReply = { send: vi.fn(), status: vi.fn().mockReturnThis() }
      await invocationHandler(mockReq, mockReply)
      expect(mockReply.send).toHaveBeenCalledWith({ result: 'success' })
    })

    it('handles streaming response', async () => {
      const mockHandler = vi.fn(async function* () {
        yield { chunk: 1 }
        yield { chunk: 2 }
      })
      const app = new BedrockAgentCoreApp(mockHandler)
      const mockApp = app._app

      // Call _setupRoutes to register the routes
      app._setupRoutes()

      const postCall = mockApp.post.mock.calls.find((call: any[]) => call[0] === '/invocations')
      const invocationHandler = postCall[2] // Third argument since we have { sse: true } as second
      const mockReq = {
        body: {},
        headers: { 'x-amzn-bedrock-agentcore-runtime-session-id': 'session-123' },
      }
      const mockSSE = {
        keepAlive: vi.fn(),
        onClose: vi.fn(),
        isConnected: true,
        send: vi.fn(),
        close: vi.fn(),
      }
      const mockReply = {
        sse: mockSSE,
      }
      await invocationHandler(mockReq, mockReply)
      expect(mockSSE.keepAlive).toHaveBeenCalled()
      expect(mockSSE.send).toHaveBeenCalled()
    })

    it('sends correct SSE events for streaming response', async () => {
      const mockHandler = vi.fn(async function* (req, context) {
        yield { event: 'start', sessionId: context.sessionId }
        yield { event: 'data', content: 'streaming test' }
        yield { event: 'end' }
      })

      const app = new BedrockAgentCoreApp(mockHandler)
      const mockApp = app._app

      // Call _setupRoutes to register the routes
      app._setupRoutes()

      const postCall = mockApp.post.mock.calls.find((call: any[]) => call[0] === '/invocations')
      const invocationHandler = postCall[2] // Third argument since we have { sse: true } as second

      const mockReq = {
        body: { message: 'test' },
        headers: { 'x-amzn-bedrock-agentcore-runtime-session-id': 'stream-session' },
      }

      // Track all SSE events sent
      const sentEvents: any[] = []
      const mockSSE = {
        keepAlive: vi.fn(),
        onClose: vi.fn(),
        isConnected: true,
        send: vi.fn((event) => {
          sentEvents.push(event)
          return Promise.resolve()
        }),
        close: vi.fn(),
      }

      const mockReply = {
        sse: mockSSE,
      }

      await invocationHandler(mockReq, mockReply)

      // Verify SSE setup
      expect(mockSSE.keepAlive).toHaveBeenCalled()

      // Verify correct number of SSE events (3 data + 1 done)
      expect(mockSSE.send).toHaveBeenCalledTimes(4)

      // Verify the actual SSE event data
      expect(sentEvents).toEqual([
        { data: { event: 'start', sessionId: 'stream-session' } },
        { data: { event: 'data', content: 'streaming test' } },
        { data: { event: 'end' } },
        { event: 'done', data: {} }, // Final done event
      ])

      // Verify connection was closed
      expect(mockSSE.close).toHaveBeenCalled()
    })
  })

  describe('run', () => {
    it('starts server on port 8080', async () => {
      const handler: Handler = async (request, context) => 'test response'
      const app = new BedrockAgentCoreApp(handler)
      const mockApp = app._app

      // Mock the register method to return a resolved promise
      mockApp.register.mockResolvedValue(undefined)
      mockApp.listen.mockResolvedValue(undefined)

      // Mock console.log to avoid output during tests
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      app.run()

      // Wait a bit for the async operations to complete
      await new Promise((resolve) => setTimeout(resolve, 10))

      // Verify that register was called (for SSE plugin)
      expect(mockApp.register).toHaveBeenCalled()

      // Verify that listen was called with correct parameters
      expect(mockApp.listen).toHaveBeenCalledWith({ port: 8080, host: '0.0.0.0' })

      consoleSpy.mockRestore()
    })
  })
})
