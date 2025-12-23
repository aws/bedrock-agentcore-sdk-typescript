import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { FastifyPluginAsync } from 'fastify'
import type { Handler, WebSocketHandler } from '../types.js'

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
        info: vi.fn(),
      },
    }
  })
  return { default: mockFastify }
})

// Mock @fastify/sse
vi.mock('@fastify/sse', () => {
  return vi.fn()
})

// Mock @fastify/websocket
vi.mock('@fastify/websocket', () => {
  return vi.fn()
})

describe('BedrockAgentCoreApp', () => {
  let BedrockAgentCoreApp: any
  let Fastify: any

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    Fastify = (await import('fastify')).default
    const module = await import('../app.js')
    BedrockAgentCoreApp = module.BedrockAgentCoreApp
  })

  describe('constructor', () => {
    it('creates instance with handler', () => {
      const handler: Handler = async (request, context) => 'test response'
      const app = new BedrockAgentCoreApp({ handler })
      expect(app).toBeDefined()
    })

    it('creates instance with websocket handler', () => {
      const handler: Handler = async (request, context) => 'test response'
      const websocketHandler: WebSocketHandler = async (socket, context) => {}
      const app = new BedrockAgentCoreApp({ handler, websocketHandler })
      expect(app).toBeDefined()
    })

    it('creates instance with handler and logging config', () => {
      const handler: Handler = async (request, context) => 'test response'
      const app = new BedrockAgentCoreApp({
        handler,
        config: {
          logging: { enabled: true, level: 'debug' },
        },
      })
      expect(app).toBeDefined()
    })

    it('initializes Fastify app', () => {
      const handler: Handler = async (request, context) => 'test response'
      new BedrockAgentCoreApp({ handler })
      expect(Fastify).toHaveBeenCalled()
    })

    it('configures logger with default settings when no config provided', () => {
      const handler: Handler = async (request, context) => 'test response'
      new BedrockAgentCoreApp({ handler })
      expect(Fastify).toHaveBeenCalledWith({ logger: true })
    })

    it('configures logger with custom level', () => {
      const handler: Handler = async (request, context) => 'test response'
      new BedrockAgentCoreApp({
        handler,
        config: {
          logging: { enabled: true, level: 'debug' },
        },
      })
      expect(Fastify).toHaveBeenCalledWith({ logger: { level: 'debug' } })
    })

    it('disables logger when logging is disabled', () => {
      const handler: Handler = async (request, context) => 'test response'
      new BedrockAgentCoreApp({
        handler,
        config: {
          logging: { enabled: false },
        },
      })
      expect(Fastify).toHaveBeenCalledWith({ logger: false })
    })

    it('uses info level as default when level not specified', () => {
      const handler: Handler = async (request, context) => 'test response'
      new BedrockAgentCoreApp({
        handler,
        config: {
          logging: { enabled: true },
        },
      })
      expect(Fastify).toHaveBeenCalledWith({ logger: { level: 'info' } })
    })
  })

  describe('routes setup', () => {
    it('registers GET /ping route', () => {
      const handler: Handler = async (request, context) => 'test response'
      const app = new BedrockAgentCoreApp({ handler })
      const mockApp = app._app

      // Call _setupRoutes to register the routes
      app._setupRoutes()

      expect(mockApp.get).toHaveBeenCalledWith('/ping', expect.any(Function))
    })

    it('registers POST /invocations route', () => {
      const handler: Handler = async (request, context) => 'test response'
      const app = new BedrockAgentCoreApp({ handler })
      const mockApp = app._app

      // Call _setupRoutes to register the routes
      app._setupRoutes()

      expect(mockApp.post).toHaveBeenCalledWith('/invocations', { sse: true }, expect.any(Function))
    })

    it('registers GET /ws route when websocket handler provided', () => {
      const handler: Handler = async (request, context) => 'test response'
      const websocketHandler: WebSocketHandler = async (socket, context) => {}
      const app = new BedrockAgentCoreApp({ handler, websocketHandler })
      const mockApp = app._app

      app._setupRoutes()

      expect(mockApp.get).toHaveBeenCalledWith('/ws', { websocket: true }, expect.any(Function))
    })

    it('does not register GET /ws route when no websocket handler', () => {
      const handler: Handler = async (request, context) => 'test response'
      const app = new BedrockAgentCoreApp({ handler })
      const mockApp = app._app

      app._setupRoutes()

      const wsCall = mockApp.get.mock.calls.find((call: any[]) => call[0] === '/ws')
      expect(wsCall).toBeUndefined()
    })
  })

  describe('health check handler', () => {
    it('returns correct response format', async () => {
      const handler: Handler = async (request, context) => 'test response'
      const app = new BedrockAgentCoreApp({ handler })
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
      const app = new BedrockAgentCoreApp({ handler: mockHandler })
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
          workloadAccessToken: undefined,
        }
      )
    })

    it('returns JSON response from handler', async () => {
      const mockHandler = vi.fn(async () => ({ result: 'success' }))
      const app = new BedrockAgentCoreApp({ handler: mockHandler })
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

    it('extracts workloadAccessToken from header when present', async () => {
      const mockHandler = vi.fn(async (request, context) => ({ token: context.workloadAccessToken }))
      const app = new BedrockAgentCoreApp({ handler: mockHandler })
      const mockApp = app._app

      app._setupRoutes()

      const postCall = mockApp.post.mock.calls.find((call: any[]) => call[0] === '/invocations')
      const invocationHandler = postCall[2] // Third argument (after path and options)
      const mockReq = {
        body: {},
        headers: {
          'x-amzn-bedrock-agentcore-runtime-session-id': 'session-123',
          workloadaccesstoken: 'workload-token-abc123',
        },
      }
      const mockReply = { send: vi.fn(), status: vi.fn().mockReturnThis() }
      await invocationHandler(mockReq, mockReply)
      expect(mockHandler).toHaveBeenCalledWith(
        {},
        expect.objectContaining({
          workloadAccessToken: 'workload-token-abc123',
        })
      )
    })

    it('sets workloadAccessToken to undefined when header not present', async () => {
      const mockHandler = vi.fn(async (request, context) => ({ hasToken: !!context.workloadAccessToken }))
      const app = new BedrockAgentCoreApp({ handler: mockHandler })
      const mockApp = app._app

      app._setupRoutes()

      const postCall = mockApp.post.mock.calls.find((call: any[]) => call[0] === '/invocations')
      const invocationHandler = postCall[2] // Third argument (after path and options)
      const mockReq = {
        body: {},
        headers: { 'x-amzn-bedrock-agentcore-runtime-session-id': 'session-123' },
      }
      const mockReply = { send: vi.fn(), status: vi.fn().mockReturnThis() }
      await invocationHandler(mockReq, mockReply)
      expect(mockHandler).toHaveBeenCalledWith(
        {},
        expect.objectContaining({
          workloadAccessToken: undefined,
        })
      )
    })

    it('handles streaming response', async () => {
      const mockHandler = vi.fn(async function* () {
        yield { chunk: 1 }
        yield { chunk: 2 }
      })
      const app = new BedrockAgentCoreApp({ handler: mockHandler })
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
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
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

      const app = new BedrockAgentCoreApp({ handler: mockHandler })
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
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
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

  describe('websocket handler', () => {
    it('handles websocket connection with valid handler', async () => {
      const handler: Handler = async (request, context) => 'test response'
      const websocketHandler = vi.fn(async (socket, context) => {})
      const app = new BedrockAgentCoreApp({ handler, websocketHandler })
      const mockApp = app._app

      app._setupRoutes()

      const wsCall = mockApp.get.mock.calls.find((call: any[]) => call[0] === '/ws')
      const wsHandler = wsCall[2]

      const mockSocket = { socket: { close: vi.fn() } }
      const mockReq = {
        headers: { 'x-amzn-bedrock-agentcore-runtime-session-id': 'ws-session-123' },
      }

      await wsHandler(mockSocket, mockReq)

      expect(websocketHandler).toHaveBeenCalledWith(mockSocket, {
        sessionId: 'ws-session-123',
        headers: expect.objectContaining({
          'x-amzn-bedrock-agentcore-runtime-session-id': 'ws-session-123',
        }),
        workloadAccessToken: undefined,
      })
    })

    it('handles websocket errors and closes connection', async () => {
      const handler: Handler = async (request, context) => 'test response'
      const websocketHandler = vi.fn(async () => {
        throw new Error('WebSocket handler error')
      })
      const app = new BedrockAgentCoreApp({ handler, websocketHandler })
      const mockApp = app._app

      const mockSocket = { close: vi.fn() }
      const mockReq = {
        headers: { 'x-amzn-bedrock-agentcore-runtime-session-id': 'ws-session-123' },
      }

      await app._handleWebSocket(mockSocket, mockReq)

      expect(mockSocket.close).toHaveBeenCalledWith(1011, 'Internal server error')
    })
  })

  describe('plugin registration', () => {
    it('registers SSE plugin unconditionally', async () => {
      const handler: Handler = async (request, context) => 'test response'
      const app = new BedrockAgentCoreApp({ handler })
      const mockApp = app._app

      await app._registerPlugins()

      // SSE plugin should always be registered
      expect(mockApp.register).toHaveBeenCalled()
    })

    it('registers WebSocket plugin only when websocketHandler is provided', async () => {
      const handler: Handler = async (request, context) => 'test response'
      const websocketHandler: WebSocketHandler = async (socket, context) => {}
      const app = new BedrockAgentCoreApp({ handler, websocketHandler })
      const mockApp = app._app

      await app._registerPlugins()

      // Both SSE and WebSocket plugins should be registered
      expect(mockApp.register).toHaveBeenCalledTimes(2)
    })

    it('does not register WebSocket plugin when no websocketHandler provided', async () => {
      const handler: Handler = async (request, context) => 'test response'
      const app = new BedrockAgentCoreApp({ handler })
      const mockApp = app._app

      await app._registerPlugins()

      // Only SSE plugin should be registered
      expect(mockApp.register).toHaveBeenCalledTimes(1)
    })
  })

  describe('run', () => {
    it('starts server on port 8080', async () => {
      const handler: Handler = async (request, context) => 'test response'
      const app = new BedrockAgentCoreApp({ handler })
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

  describe('task tracking', () => {
    it('adds and completes tasks', () => {
      const handler: Handler = async (request, context) => 'test'
      const app = new BedrockAgentCoreApp(handler)

      const taskId = app.addAsyncTask('test-task')
      expect(app.getAsyncTaskInfo().activeCount).toBe(1)

      app.completeAsyncTask(taskId)
      expect(app.getAsyncTaskInfo().activeCount).toBe(0)
    })

    it('returns HealthyBusy with active tasks', () => {
      const handler: Handler = async (request, context) => 'test'
      const app = new BedrockAgentCoreApp(handler)

      expect(app.getCurrentPingStatus()).toBe('Healthy')

      app.addAsyncTask('test-task')
      expect(app.getCurrentPingStatus()).toBe('HealthyBusy')
    })

    it('tracks multiple tasks', () => {
      const handler: Handler = async (request, context) => 'test'
      const app = new BedrockAgentCoreApp(handler)

      const id1 = app.addAsyncTask('task1')
      const id2 = app.addAsyncTask('task2')

      const info = app.getAsyncTaskInfo()
      expect(info.activeCount).toBe(2)
      expect(info.runningJobs).toHaveLength(2)

      app.completeAsyncTask(id1)
      expect(app.getAsyncTaskInfo().activeCount).toBe(1)
    })
  })

  describe('status priority', () => {
    it('custom handler used when provided', () => {
      const handler: Handler = async (request, context) => 'test'
      const app = new BedrockAgentCoreApp(handler)

      app.ping(() => 'HealthyBusy')
      expect(app.getCurrentPingStatus()).toBe('HealthyBusy')
    })

    it('automatic status when no handler', () => {
      const handler: Handler = async (request, context) => 'test'
      const app = new BedrockAgentCoreApp(handler)

      expect(app.getCurrentPingStatus()).toBe('Healthy')

      app.addAsyncTask('test')
      expect(app.getCurrentPingStatus()).toBe('HealthyBusy')
    })

    it('custom handler overrides automatic status', () => {
      const handler: Handler = async (request, context) => 'test'
      const app = new BedrockAgentCoreApp(handler)

      app.addAsyncTask('test-task')
      app.ping(() => 'Healthy')

      expect(app.getCurrentPingStatus()).toBe('Healthy')
    })
  })

  describe('asyncTask decorator', () => {
    it('tracks task during execution', async () => {
      const handler: Handler = async (request, context) => 'test'
      const app = new BedrockAgentCoreApp(handler)

      let statusDuringExecution: string | undefined

      const fn = app.asyncTask(async () => {
        statusDuringExecution = app.getCurrentPingStatus()
        return 'done'
      })

      await fn()

      expect(statusDuringExecution).toBe('HealthyBusy')
      expect(app.getCurrentPingStatus()).toBe('Healthy')
    })

    it('removes task even on error', async () => {
      const handler: Handler = async (request, context) => 'test'
      const app = new BedrockAgentCoreApp(handler)

      const fn = app.asyncTask(async () => {
        throw new Error('test error')
      })

      await expect(fn()).rejects.toThrow('test error')
      expect(app.getCurrentPingStatus()).toBe('Healthy')
    })

    it('preserves function name', () => {
      const handler: Handler = async (request, context) => 'test'
      const app = new BedrockAgentCoreApp(handler)

      async function myFunction() {
        return 'result'
      }

      const wrapped = app.asyncTask(myFunction)
      expect(wrapped.name).toBe('myFunction')
    })

    it('throws error for non-async functions', () => {
      const handler: Handler = async (request, context) => 'test'
      const app = new BedrockAgentCoreApp(handler)

      const syncFunction = () => {
        return 'result'
      }

      expect(() => app.asyncTask(syncFunction as any)).toThrow('asyncTask can only be applied to async functions')
    })
  })
})
