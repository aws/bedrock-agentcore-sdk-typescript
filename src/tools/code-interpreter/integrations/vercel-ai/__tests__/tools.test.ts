import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CodeInterpreterTools } from '../tools.js'

// Mock CodeInterpreter
const mockCodeInterpreter = {
  startSession: vi.fn(),
  stopSession: vi.fn(),
  executeCode: vi.fn(),
  executeCommand: vi.fn(),
  readFiles: vi.fn(),
  writeFiles: vi.fn(),
  listFiles: vi.fn(),
  removeFiles: vi.fn(),
}

vi.mock('../../../client.js', () => ({
  CodeInterpreter: vi.fn(function (this: any) {
    return mockCodeInterpreter
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

describe('CodeInterpreterTools', () => {
  let codeInterpreterTools: CodeInterpreterTools

  beforeEach(() => {
    vi.clearAllMocks()
    codeInterpreterTools = new CodeInterpreterTools({ region: 'us-west-2' })
  })

  describe('constructor', () => {
    it('creates CodeInterpreterTools instance', () => {
      expect(codeInterpreterTools).toBeDefined()
    })

    it('initializes all tools', () => {
      expect(codeInterpreterTools.executeCode).toBeDefined()
      expect(codeInterpreterTools.executeCommand).toBeDefined()
      expect(codeInterpreterTools.fileOperations).toBeDefined()
    })

    it('provides tools object for spreading', () => {
      expect(codeInterpreterTools.tools).toBeDefined()
      expect(codeInterpreterTools.tools.executeCode).toBe(codeInterpreterTools.executeCode)
      expect(codeInterpreterTools.tools.executeCommand).toBe(codeInterpreterTools.executeCommand)
      expect(codeInterpreterTools.tools.fileOperations).toBe(codeInterpreterTools.fileOperations)
    })
  })

  describe('session management', () => {
    it('starts session', async () => {
      const mockSession = {
        sessionId: 'test-id',
        sessionName: 'test-session',
        createdAt: new Date(),
      }
      mockCodeInterpreter.startSession.mockResolvedValue(mockSession)

      const result = await codeInterpreterTools.startSession('test-session')

      expect(mockCodeInterpreter.startSession).toHaveBeenCalledWith({
        sessionName: 'test-session',
      })
      expect(result).toEqual(mockSession)
    })

    it('starts session without name', async () => {
      const mockSession = {
        sessionId: 'test-id',
        sessionName: 'default',
        createdAt: new Date(),
      }
      mockCodeInterpreter.startSession.mockResolvedValue(mockSession)

      await codeInterpreterTools.startSession()

      expect(mockCodeInterpreter.startSession).toHaveBeenCalledWith(undefined)
    })

    it('stops session', async () => {
      await codeInterpreterTools.stopSession()

      expect(mockCodeInterpreter.stopSession).toHaveBeenCalled()
    })
  })

  describe('getClient', () => {
    it('returns underlying CodeInterpreter client', () => {
      const client = codeInterpreterTools.getClient()
      expect(client).toBe(mockCodeInterpreter)
    })
  })

  describe('executeCode tool', () => {
    it('executes Python code successfully', async () => {
      mockCodeInterpreter.executeCode.mockResolvedValue('Hello World')

      const result = await codeInterpreterTools.executeCode.execute!(
        {
          language: 'python',
          code: 'print("Hello World")',
        },
        { toolCallId: 'test-call', messages: [] }
      )

      expect(result).toBe('Hello World')
      expect(mockCodeInterpreter.executeCode).toHaveBeenCalledWith({
        language: 'python',
        code: 'print("Hello World")',
      })
    })

    it('executes JavaScript code', async () => {
      mockCodeInterpreter.executeCode.mockResolvedValue('42')

      const result = await codeInterpreterTools.executeCode.execute!(
        {
          language: 'javascript',
          code: 'console.log(42)',
        },
        { toolCallId: 'test-call', messages: [] }
      )

      expect(result).toBe('42')
      expect(mockCodeInterpreter.executeCode).toHaveBeenCalledWith({
        language: 'javascript',
        code: 'console.log(42)',
      })
    })

    it('handles code execution errors', async () => {
      mockCodeInterpreter.executeCode.mockRejectedValue(new Error('Execution failed'))

      await expect(
        codeInterpreterTools.executeCode.execute!(
          {
            language: 'python',
            code: 'invalid syntax',
          },
          { toolCallId: 'test-call', messages: [] }
        )
      ).rejects.toThrow('Execution failed')
    })
  })

  describe('executeCommand tool', () => {
    it('executes shell command successfully', async () => {
      mockCodeInterpreter.executeCommand.mockResolvedValue('file.txt\n')

      const result = await codeInterpreterTools.executeCommand.execute!(
        {
          command: 'ls',
        },
        { toolCallId: 'test-call', messages: [] }
      )

      expect(result).toBe('file.txt\n')
      expect(mockCodeInterpreter.executeCommand).toHaveBeenCalledWith({
        command: 'ls',
      })
    })

    it('handles command errors', async () => {
      mockCodeInterpreter.executeCommand.mockRejectedValue(new Error('Command not found'))

      await expect(
        codeInterpreterTools.executeCommand.execute!(
          {
            command: 'invalid-command',
          },
          { toolCallId: 'test-call', messages: [] }
        )
      ).rejects.toThrow('Command not found')
    })
  })

  describe('fileOperations tool', () => {
    it('reads files successfully', async () => {
      mockCodeInterpreter.readFiles.mockResolvedValue('file contents')

      const result = await codeInterpreterTools.fileOperations.execute!(
        {
          operation: 'read',
          paths: ['test.txt'],
          path: '.',
        },
        { toolCallId: 'test-call', messages: [] }
      )

      expect(result).toBe('file contents')
      expect(mockCodeInterpreter.readFiles).toHaveBeenCalledWith({
        paths: ['test.txt'],
      })
    })

    it('writes files successfully', async () => {
      mockCodeInterpreter.writeFiles.mockResolvedValue('files written')

      const result = await codeInterpreterTools.fileOperations.execute!(
        {
          operation: 'write',
          files: [{ path: 'test.txt', content: 'Hello' }],
          path: '.',
        },
        { toolCallId: 'test-call', messages: [] }
      )

      expect(result).toBe('files written')
      expect(mockCodeInterpreter.writeFiles).toHaveBeenCalledWith({
        files: [{ path: 'test.txt', content: 'Hello' }],
      })
    })

    it('lists files successfully', async () => {
      mockCodeInterpreter.listFiles.mockResolvedValue('file list')

      const result = await codeInterpreterTools.fileOperations.execute!(
        {
          operation: 'list',
          path: '/',
        },
        { toolCallId: 'test-call', messages: [] }
      )

      expect(result).toBe('file list')
      expect(mockCodeInterpreter.listFiles).toHaveBeenCalledWith({
        path: '/',
      })
    })

    it('removes files successfully', async () => {
      mockCodeInterpreter.removeFiles.mockResolvedValue('files removed')

      const result = await codeInterpreterTools.fileOperations.execute!(
        {
          operation: 'remove',
          paths: ['test.txt'],
          path: '.',
        },
        { toolCallId: 'test-call', messages: [] }
      )

      expect(result).toBe('files removed')
      expect(mockCodeInterpreter.removeFiles).toHaveBeenCalledWith({
        paths: ['test.txt'],
      })
    })

    it('handles missing files parameter in write operation', async () => {
      const result = await codeInterpreterTools.fileOperations.execute!(
        {
          operation: 'write',
          files: [],
          path: '.',
        },
        { toolCallId: 'test-call', messages: [] }
      )

      expect(result).toContain('error')
    })

    it('handles file operation errors', async () => {
      mockCodeInterpreter.readFiles.mockRejectedValue(new Error('File not found'))

      await expect(
        codeInterpreterTools.fileOperations.execute!(
          {
            operation: 'read',
            paths: ['missing.txt'],
            path: '.',
          },
          { toolCallId: 'test-call', messages: [] }
        )
      ).rejects.toThrow('File not found')
    })
  })
})
