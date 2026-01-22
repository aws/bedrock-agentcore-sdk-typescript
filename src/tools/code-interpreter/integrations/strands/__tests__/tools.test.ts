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

// Mock Strands SDK
vi.mock('@strands-agents/sdk', () => ({
  tool: vi.fn((config) => ({
    name: config.name,
    description: config.description,
    inputSchema: config.inputSchema,
    callback: config.callback,
  })),
}))

describe('CodeInterpreterTools (Strands)', () => {
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

    it('provides tools array for spreading', () => {
      expect(codeInterpreterTools.tools).toBeDefined()
      expect(Array.isArray(codeInterpreterTools.tools)).toBe(true)
      expect(codeInterpreterTools.tools).toHaveLength(3)
      expect(codeInterpreterTools.tools).toContain(codeInterpreterTools.executeCode)
      expect(codeInterpreterTools.tools).toContain(codeInterpreterTools.executeCommand)
      expect(codeInterpreterTools.tools).toContain(codeInterpreterTools.fileOperations)
    })

    it('tools have required name property', () => {
      // Strands SDK requires name property on tools
      expect((codeInterpreterTools.executeCode as any).name).toBe('executeCode')
      expect((codeInterpreterTools.executeCommand as any).name).toBe('executeCommand')
      expect((codeInterpreterTools.fileOperations as any).name).toBe('fileOperations')
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

      const result = await (codeInterpreterTools.executeCode as any).callback({
        language: 'python',
        code: 'print("Hello World")',
      })

      expect(result).toBe('Hello World')
      expect(mockCodeInterpreter.executeCode).toHaveBeenCalledWith({
        language: 'python',
        code: 'print("Hello World")',
      })
    })

    it('executes JavaScript code', async () => {
      mockCodeInterpreter.executeCode.mockResolvedValue('42')

      const result = await (codeInterpreterTools.executeCode as any).callback({
        language: 'javascript',
        code: 'console.log(42)',
      })

      expect(result).toBe('42')
      expect(mockCodeInterpreter.executeCode).toHaveBeenCalledWith({
        language: 'javascript',
        code: 'console.log(42)',
      })
    })

    it('handles code execution errors', async () => {
      mockCodeInterpreter.executeCode.mockRejectedValue(new Error('Execution failed'))

      await expect(
        (codeInterpreterTools.executeCode as any).callback({
          language: 'python',
          code: 'invalid syntax',
        })
      ).rejects.toThrow('Execution failed')
    })
  })

  describe('executeCommand tool', () => {
    it('executes shell command successfully', async () => {
      mockCodeInterpreter.executeCommand.mockResolvedValue('file.txt\n')

      const result = await (codeInterpreterTools.executeCommand as any).callback({
        command: 'ls',
      })

      expect(result).toBe('file.txt\n')
      expect(mockCodeInterpreter.executeCommand).toHaveBeenCalledWith({
        command: 'ls',
      })
    })

    it('handles command errors', async () => {
      mockCodeInterpreter.executeCommand.mockRejectedValue(new Error('Command not found'))

      await expect(
        (codeInterpreterTools.executeCommand as any).callback({
          command: 'invalid-command',
        })
      ).rejects.toThrow('Command not found')
    })
  })

  describe('fileOperations tool', () => {
    it('reads files successfully', async () => {
      mockCodeInterpreter.readFiles.mockResolvedValue('file contents')

      const result = await (codeInterpreterTools.fileOperations as any).callback({
        operation: 'read',
        paths: ['test.txt'],
        path: '.',
      })

      expect(result).toBe('file contents')
      expect(mockCodeInterpreter.readFiles).toHaveBeenCalledWith({
        paths: ['test.txt'],
      })
    })

    it('writes files successfully', async () => {
      mockCodeInterpreter.writeFiles.mockResolvedValue('files written')

      const result = await (codeInterpreterTools.fileOperations as any).callback({
        operation: 'write',
        files: [{ path: 'test.txt', content: 'Hello' }],
        path: '.',
      })

      expect(result).toBe('files written')
      expect(mockCodeInterpreter.writeFiles).toHaveBeenCalledWith({
        files: [{ path: 'test.txt', content: 'Hello' }],
      })
    })

    it('lists files successfully', async () => {
      mockCodeInterpreter.listFiles.mockResolvedValue('file list')

      const result = await (codeInterpreterTools.fileOperations as any).callback({
        operation: 'list',
        path: '/',
      })

      expect(result).toBe('file list')
      expect(mockCodeInterpreter.listFiles).toHaveBeenCalledWith({
        path: '/',
      })
    })

    it('removes files successfully', async () => {
      mockCodeInterpreter.removeFiles.mockResolvedValue('files removed')

      const result = await (codeInterpreterTools.fileOperations as any).callback({
        operation: 'remove',
        paths: ['test.txt'],
        path: '.',
      })

      expect(result).toBe('files removed')
      expect(mockCodeInterpreter.removeFiles).toHaveBeenCalledWith({
        paths: ['test.txt'],
      })
    })

    it('handles missing files parameter in write operation', async () => {
      const result = await (codeInterpreterTools.fileOperations as any).callback({
        operation: 'write',
        files: [],
        path: '.',
      })

      expect(result).toContain('error')
    })

    it('handles file operation errors', async () => {
      mockCodeInterpreter.readFiles.mockRejectedValue(new Error('File not found'))

      await expect(
        (codeInterpreterTools.fileOperations as any).callback({
          operation: 'read',
          paths: ['missing.txt'],
          path: '.',
        })
      ).rejects.toThrow('File not found')
    })
  })
})
