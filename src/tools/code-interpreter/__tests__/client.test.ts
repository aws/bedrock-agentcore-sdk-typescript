import { describe, it, expect, beforeEach, vi } from 'vitest'
import { CodeInterpreter } from '../client.js'

// Mock AWS SDK
const mockSessionIds = new Map<string, string>()

vi.mock('@aws-sdk/client-bedrock-agentcore', () => {
  const mockSend = vi.fn((command: any) => {
    // Mock response for StartCodeInterpreterSessionCommand
    if (command._commandName === 'StartCodeInterpreterSessionCommand') {
      const sessionId = `session-${Date.now()}-${Math.random().toString(36).substring(7)}`
      mockSessionIds.set(command.input.name, sessionId)
      return Promise.resolve({
        codeInterpreterIdentifier: command.input.codeInterpreterIdentifier,
        sessionId,
        createdAt: new Date(),
      })
    }
    // Mock response for StopCodeInterpreterSessionCommand
    if (command._commandName === 'StopCodeInterpreterSessionCommand') {
      return Promise.resolve({
        codeInterpreterIdentifier: command.input.codeInterpreterIdentifier,
        sessionId: command.input.sessionId,
        lastUpdatedAt: new Date(),
      })
    }
    // Mock response for InvokeCodeInterpreterCommand
    if (command._commandName === 'InvokeCodeInterpreterCommand') {
      const args = command.input.arguments || {}

      // Mock different operations
      if (command.input.name === 'executeCode') {
        const hasError = args.code.includes('error') || args.code.includes('invalid')
        const output = hasError ? 'Error occurred' : `Output: ${args.code}`
        return Promise.resolve({
          result: { content: output },
          isError: hasError,
        })
      }

      if (command.input.name === 'executeCommand') {
        const hasError = args.command.includes('nonexistent')
        return Promise.resolve({
          result: { content: hasError ? 'Command not found' : `Command output: ${args.command}` },
          isError: hasError,
        })
      }

      if (command.input.name === 'writeFiles') {
        return Promise.resolve({
          result: { content: 'Files written successfully' },
          isError: false,
        })
      }

      if (command.input.name === 'readFiles') {
        const hasError = args.paths.some((p: string) => p.includes('non-existent'))
        if (hasError) {
          return Promise.resolve({
            result: { content: 'File not found' },
            isError: true,
          })
        }
        const files = args.paths.map((path: string) => ({
          path,
          text: `Content of ${path}`,
          size: 100,
        }))
        return Promise.resolve({
          result: { content: JSON.stringify(files) },
          isError: false,
        })
      }

      if (command.input.name === 'listFiles') {
        const files = [
          { path: 'file1.txt', type: 'file', size: 100 },
          { path: 'dir1', type: 'directory' },
        ]
        return Promise.resolve({
          result: { content: JSON.stringify(files) },
          isError: false,
        })
      }

      if (command.input.name === 'removeFiles') {
        return Promise.resolve({
          result: { content: 'Files removed successfully' },
          isError: false,
        })
      }
    }
    // Mock response for GetCodeInterpreterSessionCommand
    if (command._commandName === 'GetCodeInterpreterSessionCommand') {
      return Promise.resolve({
        sessionId: command.input.sessionId,
        codeInterpreterIdentifier: command.input.codeInterpreterIdentifier,
        name: 'test-session',
        status: 'READY',
        createdAt: new Date('2024-01-01T00:00:00Z'),
        lastUpdatedAt: new Date('2024-01-01T00:00:00Z'),
        sessionTimeoutSeconds: 900,
      })
    }
    // Mock response for ListCodeInterpreterSessionsCommand
    if (command._commandName === 'ListCodeInterpreterSessionsCommand') {
      const mockSessions = [
        {
          sessionId: 'session-1',
          name: 'session-1',
          status: 'READY',
          createdAt: new Date('2024-01-01T00:00:00Z'),
          lastUpdatedAt: new Date('2024-01-01T00:01:00Z'),
        },
        {
          sessionId: 'session-2',
          name: 'session-2',
          status: 'TERMINATED',
          createdAt: new Date('2024-01-01T00:00:00Z'),
          lastUpdatedAt: new Date('2024-01-01T00:02:00Z'),
        },
      ]

      let filtered = command.input.status ? mockSessions.filter((s: any) => s.status === command.input.status) : mockSessions
      const maxResults = command.input.maxResults || 10
      filtered = filtered.slice(0, maxResults)

      return Promise.resolve({
        items: filtered,
        nextToken: filtered.length >= maxResults ? 'next-token' : undefined,
      })
    }
    return Promise.resolve({})
  })

  return {
    BedrockAgentCoreClient: vi.fn(function (this: any) {
      this.send = mockSend
      return this
    }),
    StartCodeInterpreterSessionCommand: vi.fn(function (this: any, input: any) {
      this._commandName = 'StartCodeInterpreterSessionCommand'
      this.input = input
      return this
    }),
    StopCodeInterpreterSessionCommand: vi.fn(function (this: any, input: any) {
      this._commandName = 'StopCodeInterpreterSessionCommand'
      this.input = input
      return this
    }),
    GetCodeInterpreterSessionCommand: vi.fn(function (this: any, input: any) {
      this._commandName = 'GetCodeInterpreterSessionCommand'
      this.input = input
      return this
    }),
    ListCodeInterpreterSessionsCommand: vi.fn(function (this: any, input: any) {
      this._commandName = 'ListCodeInterpreterSessionsCommand'
      this.input = input
      return this
    }),
    InvokeCodeInterpreterCommand: vi.fn(function (this: any, input: any) {
      this._commandName = 'InvokeCodeInterpreterCommand'
      this.input = input
      return this
    }),
  }
})

describe('CodeInterpreter', () => {
  describe('constructor', () => {
    it('creates interpreter with required region', () => {
      const interpreter = new CodeInterpreter({ region: 'us-east-1' })
      expect(interpreter).toBeDefined()
      expect(interpreter.region).toBe('us-east-1')
    })

    it('uses default identifier when not provided', () => {
      const interpreter = new CodeInterpreter({ region: 'us-east-1' })
      expect(interpreter.identifier).toBe('aws.codeinterpreter.v1')
    })

    it('uses custom identifier when provided', () => {
      const interpreter = new CodeInterpreter({
        region: 'us-east-1',
        identifier: 'custom.interpreter.v2',
      })
      expect(interpreter.identifier).toBe('custom.interpreter.v2')
    })
  })

  describe('startSession', () => {
    let interpreter: CodeInterpreter

    beforeEach(() => {
      interpreter = new CodeInterpreter({ region: 'us-east-1' })
    })

    it('starts session with default name when sessionName omitted', async () => {
      const session = await interpreter.startSession()

      expect(session).toBeDefined()
      expect(session.sessionName).toBe('default')
      expect(session.sessionId).toBeDefined()
      expect(session.createdAt).toBeInstanceOf(Date)
    })

    it('starts session with provided name', async () => {
      const session = await interpreter.startSession({
        sessionName: 'test-session',
      })

      expect(session.sessionName).toBe('test-session')
      expect(session.sessionId).toBeDefined()
    })

    it('includes description when provided', async () => {
      const session = await interpreter.startSession({
        sessionName: 'test-session',
        description: 'Test description',
      })

      expect(session.description).toBe('Test description')
    })

    it('throws error when session already active', async () => {
      await interpreter.startSession()

      await expect(interpreter.startSession()).rejects.toThrow(/already active/)
    })
  })

  describe('stopSession', () => {
    let interpreter: CodeInterpreter

    beforeEach(() => {
      interpreter = new CodeInterpreter({ region: 'us-east-1' })
    })

    it('stops active session', async () => {
      await interpreter.startSession()
      await interpreter.stopSession()

      // Should allow starting a new session after stopping
      await expect(interpreter.startSession()).resolves.toBeDefined()
    })

    it('gracefully handles stopping non-existent session without throwing error', async () => {
      // Should not throw error when no session exists
      await expect(interpreter.stopSession()).resolves.not.toThrow()
    })
  })

  describe('executeCode', () => {
    let interpreter: CodeInterpreter

    beforeEach(() => {
      interpreter = new CodeInterpreter({ region: 'us-east-1' })
    })

    it('executes Python code in existing session', async () => {
      await interpreter.startSession()

      const result = await interpreter.executeCode({
        code: 'print("Hello")',
      })

      expect(result).toBeDefined()
      expect(result).toContain('Output')
    })

    it('auto-creates session when none exists', async () => {
      const result = await interpreter.executeCode({
        code: 'print("Hello")',
      })

      expect(result).toBeDefined()
      expect(result).toContain('Output')
    })

    it('defaults to Python language', async () => {
      const result = await interpreter.executeCode({
        code: 'print("Hello")',
      })

      expect(result).toBeDefined()
      expect(result).toContain('Output')
    })

    it('executes JavaScript code when specified', async () => {
      const result = await interpreter.executeCode({
        code: 'console.log("Hello")',
        language: 'javascript',
      })

      expect(result).toBeDefined()
      expect(result).toContain('Output')
    })

    it('executes TypeScript code when specified', async () => {
      const result = await interpreter.executeCode({
        code: 'const x: number = 1',
        language: 'typescript',
      })

      expect(result).toBeDefined()
      expect(result).toContain('Output')
    })

    it('returns error result on execution failure', async () => {
      const result = await interpreter.executeCode({
        code: 'invalid python syntax!',
      })

      expect(result).toBeDefined()
      expect(result).toContain('Error')
    })
  })

  describe('executeCommand', () => {
    let interpreter: CodeInterpreter

    beforeEach(() => {
      interpreter = new CodeInterpreter({ region: 'us-east-1' })
    })

    it('executes shell command in existing session', async () => {
      await interpreter.startSession()

      const result = await interpreter.executeCommand({
        command: 'echo "Hello"',
      })

      expect(result).toBeDefined()
      expect(result).toContain('Command output')
    })

    it('auto-creates session when none exists', async () => {
      const result = await interpreter.executeCommand({
        command: 'ls',
      })

      expect(result).toBeDefined()
      expect(result).toContain('Command output')
    })

    it('returns error result on command failure', async () => {
      const result = await interpreter.executeCommand({
        command: 'nonexistent-command',
      })

      expect(result).toBeDefined()
      expect(result).toContain('Command not found')
    })
  })

  describe('readFiles', () => {
    let interpreter: CodeInterpreter

    beforeEach(() => {
      interpreter = new CodeInterpreter({ region: 'us-east-1' })
    })

    it('reads files from session', async () => {
      await interpreter.startSession()

      const result = await interpreter.readFiles({
        paths: ['file1.txt', 'file2.txt'],
      })

      expect(result).toBeDefined()
      // Result is JSON string with file data
      const parsedData = JSON.parse(result)
      expect(Array.isArray(parsedData)).toBe(true)
    })

    it('auto-creates session when none exists', async () => {
      const result = await interpreter.readFiles({
        paths: ['file.txt'],
      })

      expect(result).toBeDefined()
      const parsedData = JSON.parse(result)
      expect(Array.isArray(parsedData)).toBe(true)
    })

    it('returns error for non-existent files', async () => {
      const result = await interpreter.readFiles({
        paths: ['non-existent.txt'],
      })

      expect(result).toBeDefined()
      expect(result).toContain('File not found')
    })
  })

  describe('writeFiles', () => {
    let interpreter: CodeInterpreter

    beforeEach(() => {
      interpreter = new CodeInterpreter({ region: 'us-east-1' })
    })

    it('writes files to session', async () => {
      await interpreter.startSession()

      const result = await interpreter.writeFiles({
        files: [
          { path: 'test.txt', content: 'Hello' },
          { path: 'data.json', content: '{}' },
        ],
      })

      expect(result).toBeDefined()
      expect(result).toContain('Files written successfully')
    })

    it('auto-creates session when none exists', async () => {
      const result = await interpreter.writeFiles({
        files: [{ path: 'test.txt', content: 'Hello' }],
      })

      expect(result).toBeDefined()
      expect(result).toContain('Files written successfully')
    })
  })

  describe('listFiles', () => {
    let interpreter: CodeInterpreter

    beforeEach(() => {
      interpreter = new CodeInterpreter({ region: 'us-east-1' })
    })

    it('lists files in session', async () => {
      await interpreter.startSession()

      const result = await interpreter.listFiles()

      expect(result).toBeDefined()
      // Result is JSON string with file list
      const parsedData = JSON.parse(result)
      expect(Array.isArray(parsedData)).toBe(true)
    })

    it('lists files in specified path', async () => {
      await interpreter.startSession()

      const result = await interpreter.listFiles({
        path: '/tmp',
      })

      expect(result).toBeDefined()
      const parsedData = JSON.parse(result)
      expect(Array.isArray(parsedData)).toBe(true)
    })

    it('auto-creates session when none exists', async () => {
      const result = await interpreter.listFiles()

      expect(result).toBeDefined()
      const parsedData = JSON.parse(result)
      expect(Array.isArray(parsedData)).toBe(true)
    })
  })

  describe('removeFiles', () => {
    let interpreter: CodeInterpreter

    beforeEach(() => {
      interpreter = new CodeInterpreter({ region: 'us-east-1' })
    })

    it('removes files from session', async () => {
      await interpreter.startSession()

      const result = await interpreter.removeFiles({
        paths: ['file1.txt', 'file2.txt'],
      })

      expect(result).toBeDefined()
      expect(result).toContain('Files removed successfully')
    })

    it('auto-creates session when none exists', async () => {
      const result = await interpreter.removeFiles({
        paths: ['test.txt'],
      })

      expect(result).toBeDefined()
      expect(result).toContain('Files removed successfully')
    })
  })

  describe('getSession', () => {
    let interpreter: CodeInterpreter

    beforeEach(() => {
      interpreter = new CodeInterpreter({ region: 'us-east-1' })
    })

    it('gets current session details', async () => {
      await interpreter.startSession({ sessionName: 'test-session' })

      const session = await interpreter.getSession()

      expect(session).toBeDefined()
      expect(session.sessionId).toBeDefined()
      expect(session.codeInterpreterIdentifier).toBe('aws.codeinterpreter.v1')
      expect(session.name).toBe('test-session')
      expect(session.status).toBe('READY')
      expect(session.createdAt).toBeInstanceOf(Date)
      expect(session.lastUpdatedAt).toBeInstanceOf(Date)
      expect(session.sessionTimeoutSeconds).toBe(900)
    })

    it('throws error when no session is active', async () => {
      await expect(interpreter.getSession()).rejects.toThrow(
        'Interpreter ID and Session ID must be provided or available from current session'
      )
    })

    it('gets specific session by ID', async () => {
      const session = await interpreter.getSession({
        interpreterId: 'aws.codeinterpreter.v1',
        sessionId: 'specific-session-id',
      })

      expect(session).toBeDefined()
      expect(session.sessionId).toBe('specific-session-id')
      expect(session.status).toBe('READY')
    })
  })

  describe('listSessions', () => {
    let interpreter: CodeInterpreter

    beforeEach(() => {
      interpreter = new CodeInterpreter({ region: 'us-east-1' })
    })

    it('lists all sessions', async () => {
      const response = await interpreter.listSessions()

      expect(response).toBeDefined()
      expect(response.items).toBeInstanceOf(Array)
      expect(response.items.length).toBeGreaterThan(0)
      expect(response.items[0].sessionId).toBeDefined()
      expect(response.items[0].name).toBeDefined()
      expect(response.items[0].status).toBeDefined()
    })

    it('filters sessions by status', async () => {
      const response = await interpreter.listSessions({ status: 'READY' })

      expect(response).toBeDefined()
      expect(response.items).toBeInstanceOf(Array)
      expect(response.items.every((item) => item.status === 'READY')).toBe(true)
    })

    it('respects maxResults parameter', async () => {
      const response = await interpreter.listSessions({ maxResults: 1 })

      expect(response).toBeDefined()
      expect(response.items.length).toBe(1)
      expect(response.nextToken).toBeDefined()
    })

    it('supports pagination', async () => {
      const firstPage = await interpreter.listSessions({ maxResults: 1 })
      expect(firstPage.nextToken).toBeDefined()

      const secondPage = await interpreter.listSessions({
        maxResults: 1,
        nextToken: firstPage.nextToken,
      })

      expect(secondPage).toBeDefined()
      expect(secondPage.items).toBeInstanceOf(Array)
    })

    it('can specify different interpreter ID', async () => {
      const response = await interpreter.listSessions({
        interpreterId: 'custom.interpreter.v1',
      })

      expect(response).toBeDefined()
      expect(response.items).toBeInstanceOf(Array)
    })
  })
})
