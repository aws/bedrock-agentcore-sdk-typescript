import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BrowserTools } from '../tools.js'

// Mock PlaywrightBrowser
const mockPlaywrightBrowser = {
  startSession: vi.fn(),
  stopSession: vi.fn(),
  navigate: vi.fn(),
  click: vi.fn(),
  type: vi.fn(),
  getText: vi.fn(),
  getHtml: vi.fn(),
  screenshot: vi.fn(),
  evaluate: vi.fn(),
}

vi.mock('../../playwright/client.js', () => ({
  PlaywrightBrowser: vi.fn(function (this: any) {
    return mockPlaywrightBrowser
  }),
}))

// Mock Vercel AI SDK
vi.mock('ai', () => ({
  tool: vi.fn((config) => ({
    description: config.description,
    inputSchema: config.inputSchema,
    execute: config.execute,
  })),
}))

describe('BrowserTools', () => {
  let browserTools: BrowserTools

  beforeEach(() => {
    vi.clearAllMocks()
    browserTools = new BrowserTools({ region: 'us-west-2' })
  })

  describe('constructor', () => {
    it('creates BrowserTools instance', () => {
      expect(browserTools).toBeDefined()
    })

    it('initializes all tools', () => {
      expect(browserTools.navigate).toBeDefined()
      expect(browserTools.click).toBeDefined()
      expect(browserTools.type).toBeDefined()
      expect(browserTools.getText).toBeDefined()
      expect(browserTools.getHtml).toBeDefined()
      expect(browserTools.screenshot).toBeDefined()
      expect(browserTools.evaluate).toBeDefined()
    })

    it('provides tools object for spreading', () => {
      expect(browserTools.tools).toBeDefined()
      expect(browserTools.tools.navigate).toBe(browserTools.navigate)
      expect(browserTools.tools.click).toBe(browserTools.click)
      expect(browserTools.tools.type).toBe(browserTools.type)
      expect(browserTools.tools.getText).toBe(browserTools.getText)
      expect(browserTools.tools.getHtml).toBe(browserTools.getHtml)
      expect(browserTools.tools.screenshot).toBe(browserTools.screenshot)
      expect(browserTools.tools.evaluate).toBe(browserTools.evaluate)
    })
  })

  describe('session management', () => {
    it('starts session', async () => {
      const mockSession = {
        sessionId: 'test-id',
        sessionName: 'test-session',
        createdAt: new Date(),
      }
      mockPlaywrightBrowser.startSession.mockResolvedValue(mockSession)

      const result = await browserTools.startSession('test-session')

      expect(mockPlaywrightBrowser.startSession).toHaveBeenCalledWith({
        sessionName: 'test-session',
      })
      expect(result).toEqual(mockSession)
    })

    it('starts session without name', async () => {
      await browserTools.startSession()

      expect(mockPlaywrightBrowser.startSession).toHaveBeenCalledWith(undefined)
    })

    it('stops session', async () => {
      await browserTools.stopSession()

      expect(mockPlaywrightBrowser.stopSession).toHaveBeenCalled()
    })
  })

  describe('getClient', () => {
    it('returns underlying PlaywrightBrowser client', () => {
      const client = browserTools.getClient()
      expect(client).toBe(mockPlaywrightBrowser)
    })
  })

  describe('tool execution', () => {
    it('navigate tool executes successfully', async () => {
      mockPlaywrightBrowser.navigate.mockResolvedValue(undefined)

      const result = (await browserTools.navigate.execute!(
        {
          url: 'https://example.com',
        },
        { toolCallId: 'test-call', messages: [] }
      )) as { success: boolean; message: string }

      expect(result.success).toBe(true)
      expect(mockPlaywrightBrowser.navigate).toHaveBeenCalledWith({
        url: 'https://example.com',
      })
    })

    it('navigate tool handles errors', async () => {
      mockPlaywrightBrowser.navigate.mockRejectedValue(new Error('Navigation failed'))

      const result = (await browserTools.navigate.execute!(
        {
          url: 'https://example.com',
        },
        { toolCallId: 'test-call', messages: [] }
      )) as { success: boolean; error: string }

      expect(result.success).toBe(false)
      expect(result.error).toBe('Navigation failed')
    })

    it('click tool executes successfully', async () => {
      mockPlaywrightBrowser.click.mockResolvedValue(undefined)

      const result = (await browserTools.click.execute!(
        {
          selector: 'button',
        },
        { toolCallId: 'test-call', messages: [] }
      )) as { success: boolean; message: string }

      expect(result.success).toBe(true)
      expect(mockPlaywrightBrowser.click).toHaveBeenCalledWith({
        selector: 'button',
      })
    })

    it('type tool executes with all parameters', async () => {
      mockPlaywrightBrowser.type.mockResolvedValue(undefined)

      const result = (await browserTools.type.execute!(
        {
          selector: 'input',
          text: 'hello',
          delay: 100,
          timeout: 5000,
        },
        { toolCallId: 'test-call', messages: [] }
      )) as { success: boolean; message: string }

      expect(result.success).toBe(true)
      expect(mockPlaywrightBrowser.type).toHaveBeenCalledWith({
        selector: 'input',
        text: 'hello',
        delay: 100,
        timeout: 5000,
      })
    })

    it('getText tool executes successfully', async () => {
      mockPlaywrightBrowser.getText.mockResolvedValue('Hello World')

      const result = (await browserTools.getText.execute!(
        {
          selector: 'h1',
        },
        { toolCallId: 'test-call', messages: [] }
      )) as { success: boolean; text: string }

      expect(result.success).toBe(true)
      expect(result.text).toBe('Hello World')
    })

    it('getHtml tool executes successfully', async () => {
      mockPlaywrightBrowser.getHtml.mockResolvedValue('<div>content</div>')

      const result = (await browserTools.getHtml.execute!(
        {
          selector: '#main',
        },
        { toolCallId: 'test-call', messages: [] }
      )) as { success: boolean; html: string }

      expect(result.success).toBe(true)
      expect(result.html).toBe('<div>content</div>')
    })

    it('screenshot tool returns base64', async () => {
      mockPlaywrightBrowser.screenshot.mockResolvedValue('base64string')

      const result = (await browserTools.screenshot.execute!(
        {
          encoding: 'base64',
          type: 'png',
        },
        { toolCallId: 'test-call', messages: [] }
      )) as { success: boolean; screenshot: string }

      expect(result.success).toBe(true)
      expect(result.screenshot).toBe('base64string')
    })

    it('evaluate tool executes JavaScript', async () => {
      mockPlaywrightBrowser.evaluate.mockResolvedValue({ title: 'Test' })

      const result = (await browserTools.evaluate.execute!(
        {
          script: 'document.title',
        },
        { toolCallId: 'test-call', messages: [] }
      )) as { success: boolean; result: any }

      expect(result.success).toBe(true)
      expect(result.result).toEqual({ title: 'Test' })
    })
  })

  describe('tool parameter filtering', () => {
    it('filters undefined parameters in navigate', async () => {
      await browserTools.navigate.execute!(
        {
          url: 'https://example.com',
          waitUntil: undefined,
          timeout: undefined,
        },
        { toolCallId: 'test-call', messages: [] }
      )

      expect(mockPlaywrightBrowser.navigate).toHaveBeenCalledWith({
        url: 'https://example.com',
      })
    })

    it('includes defined optional parameters', async () => {
      await browserTools.navigate.execute!(
        {
          url: 'https://example.com',
          waitUntil: 'load',
          timeout: 30000,
        },
        { toolCallId: 'test-call', messages: [] }
      )

      expect(mockPlaywrightBrowser.navigate).toHaveBeenCalledWith({
        url: 'https://example.com',
        waitUntil: 'load',
        timeout: 30000,
      })
    })
  })
})
