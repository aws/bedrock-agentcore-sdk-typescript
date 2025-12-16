import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RequestHandler } from 'express'
import type { Handler } from '../types.js'

// Mock express module
vi.mock('express', () => {
  const expressFn = vi.fn(() => {
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
  expressFn.json = vi.fn(() => vi.fn())
  return { default: expressFn }
})

describe('BedrockAgentCoreApp', () => {
  let BedrockAgentCoreApp: any
  let express: any

  beforeEach(async () => {
    vi.resetModules()
    express = (await import('express')).default
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

    it('creates instance with handler and middleware config', () => {
      const handler: Handler = async (request, context) => 'test response'
      const middleware: RequestHandler = (req, res, next) => next()
      const app = new BedrockAgentCoreApp(handler, { middleware: [middleware] })
      expect(app).toBeDefined()
    })

    it('initializes Express app', () => {
      const handler: Handler = async (request, context) => 'test response'
      new BedrockAgentCoreApp(handler)
      expect(express).toHaveBeenCalled()
    })
  })

  describe('routes setup', () => {
    it('registers GET /ping route', () => {
      const handler: Handler = async (request, context) => 'test response'
      const app = new BedrockAgentCoreApp(handler)
      const mockApp = (app as any)._app
      expect(mockApp.get).toHaveBeenCalledWith('/ping', expect.any(Function))
    })

    it('registers POST /invocations route', () => {
      const handler: Handler = async (request, context) => 'test response'
      const app = new BedrockAgentCoreApp(handler)
      const mockApp = (app as any)._app
      expect(mockApp.post).toHaveBeenCalledWith('/invocations', expect.any(Function))
    })

    it('applies custom middleware if provided', () => {
      const handler: Handler = async (request, context) => 'test response'
      const middleware: RequestHandler = (req, res, next) => next()
      const app = new BedrockAgentCoreApp(handler, { middleware: [middleware] })
      const mockApp = (app as any)._app
      expect(mockApp.use).toHaveBeenCalled()
    })
  })

  describe('health check handler', () => {
    it('returns correct response format', async () => {
      const handler: Handler = async (request, context) => 'test response'
      const app = new BedrockAgentCoreApp(handler)
      const mockApp = (app as any)._app
      const getCall = (mockApp.get as any).mock.calls.find((call: any[]) => call[0] === '/ping')
      const pingHandler = getCall[1]
      const mockReq = {}
      const mockRes = { json: vi.fn() }
      await pingHandler(mockReq, mockRes)
      expect(mockRes.json).toHaveBeenCalledWith({
        status: expect.stringMatching(/^(Healthy|HealthyBusy)$/),
        time_of_last_update: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/),
      })
    })
  })

  describe('invocations handler', () => {
    it('invokes handler with request and context', async () => {
      const mockHandler = vi.fn(async (request, context) => ({ result: 'success' }))
      const app = new BedrockAgentCoreApp(mockHandler)
      const mockApp = (app as any)._app
      const postCall = (mockApp.post as any).mock.calls.find((call: any[]) => call[0] === '/invocations')
      const invocationHandler = postCall[1]
      const mockReq = {
        body: { test: 'data' },
        headers: {
          'x-amzn-bedrock-agentcore-runtime-session-id': 'session-123',
          'content-type': 'application/json',
        },
      }
      const mockRes = { json: vi.fn(), status: vi.fn().mockReturnThis() }
      await invocationHandler(mockReq, mockRes)
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
      const mockApp = (app as any)._app
      const postCall = (mockApp.post as any).mock.calls.find((call: any[]) => call[0] === '/invocations')
      const invocationHandler = postCall[1]
      const mockReq = {
        body: {},
        headers: { 'x-amzn-bedrock-agentcore-runtime-session-id': 'session-123' },
      }
      const mockRes = { json: vi.fn(), status: vi.fn().mockReturnThis() }
      await invocationHandler(mockReq, mockRes)
      expect(mockRes.json).toHaveBeenCalledWith({ result: 'success' })
    })

    it('handles streaming response', async () => {
      const mockHandler = vi.fn(async function* () {
        yield { chunk: 1 }
        yield { chunk: 2 }
      })
      const app = new BedrockAgentCoreApp(mockHandler)
      const mockApp = (app as any)._app
      const postCall = (mockApp.post as any).mock.calls.find((call: any[]) => call[0] === '/invocations')
      const invocationHandler = postCall[1]
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
      }
      await invocationHandler(mockReq, mockRes)
      expect(mockRes.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream')
      expect(writes.length).toBeGreaterThan(0)
    })
  })

  describe('run', () => {
    it('starts server on port 8080', () => {
      const handler: Handler = async (request, context) => 'test response'
      const app = new BedrockAgentCoreApp(handler)
      const mockApp = (app as any)._app
      app.run()
      expect(mockApp.listen).toHaveBeenCalledWith(8080, expect.any(Function))
    })
  })
})
