import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { CodeInterpreter } from '../src/tools/code-interpreter/client.js'

/**
 * Integration tests for CodeInterpreter.
 *
 * Prerequisites:
 * - AWS credentials configured (via environment variables or AWS config)
 * - Access to AWS Bedrock Code Interpreter service
 * - Permissions: bedrock:StartCodeInterpreterSession, bedrock:InvokeCodeInterpreter, bedrock:StopCodeInterpreterSession
 *
 * To run: npm run test:integ
 */

describe('CodeInterpreter Integration Tests', () => {
  let interpreter: CodeInterpreter
  const testRegion = process.env.AWS_REGION || 'us-east-1'

  beforeAll(() => {
    interpreter = new CodeInterpreter({ region: testRegion })
  })

  afterAll(async () => {
    // Cleanup the single session if it exists
    try {
      await interpreter.stopSession()
    } catch (error) {
      // Ignore errors during cleanup
      console.warn('Failed to stop session:', error)
    }
  })

  describe('Session Management', () => {
    it('starts session with all parameters', async () => {
      const testInterpreter = new CodeInterpreter({ region: testRegion })
      const session = await testInterpreter.startSession({
        sessionName: 'integ-test-session',
        description: 'Integration test session',
        timeout: 1800,
      })

      expect(session.sessionName).toBe('integ-test-session')
      expect(session.sessionId).toBeDefined()
      expect(session.sessionId.length).toBeGreaterThan(0)
      expect(session.description).toBe('Integration test session')
      expect(session.createdAt).toBeInstanceOf(Date)

      // Verify session ID was returned from AWS
      expect(session.sessionId.length).toBeGreaterThan(10)

      await testInterpreter.stopSession()
    }, 30000)

    it('starts session with default name when omitted', async () => {
      const testInterpreter = new CodeInterpreter({ region: testRegion })
      const session = await testInterpreter.startSession()

      expect(session.sessionName).toBe('default')
      expect(session.sessionId).toBeDefined()
      expect(session.createdAt).toBeInstanceOf(Date)

      await testInterpreter.stopSession()
    }, 30000)

    it('starts session with custom name', async () => {
      const testInterpreter = new CodeInterpreter({ region: testRegion })
      const session = await testInterpreter.startSession({
        sessionName: 'custom-session',
      })

      expect(session.sessionName).toBe('custom-session')
      expect(session.sessionId).toBeDefined()

      await testInterpreter.stopSession()
    }, 30000)

    it('stops session successfully', async () => {
      const testInterpreter = new CodeInterpreter({ region: testRegion })
      await testInterpreter.startSession({
        sessionName: 'stop-test',
      })

      // Should not throw
      await expect(testInterpreter.stopSession()).resolves.not.toThrow()
    }, 30000)

    it('gracefully handles stopping non-existent session', async () => {
      const testInterpreter = new CodeInterpreter({ region: testRegion })
      // Should not throw error when no session exists
      await expect(testInterpreter.stopSession()).resolves.not.toThrow()
    }, 30000)

    it('throws error when session already active', async () => {
      const testInterpreter = new CodeInterpreter({ region: testRegion })
      await testInterpreter.startSession({ sessionName: 'test-session' })

      await expect(testInterpreter.startSession({ sessionName: 'another-session' })).rejects.toThrow(
        /already active/
      )

      await testInterpreter.stopSession()
    }, 30000)
  })

  describe('Python Code Execution', () => {
    it('executes simple Python code', async () => {
      const testInterpreter = new CodeInterpreter({ region: testRegion })
      await testInterpreter.startSession({ sessionName: 'python-test' })

      const result = await testInterpreter.executeCode({
        code: 'print("Hello from Python!")',
        language: 'python',
      })

      expect(result).toBeDefined()
      expect(result).toContain('Hello from Python!')

      await testInterpreter.stopSession()
    }, 30000)

    it('maintains state across executions', async () => {
      const testInterpreter = new CodeInterpreter({ region: testRegion })
      await testInterpreter.startSession({ sessionName: 'stateful-test' })

      await testInterpreter.executeCode({
        code: 'x = 42',
      })

      const result = await testInterpreter.executeCode({
        code: 'print(x)',
      })

      expect(result).toBeDefined()
      expect(result).toContain('42')

      await testInterpreter.stopSession()
    }, 30000)

    it('handles Python errors gracefully', async () => {
      const testInterpreter = new CodeInterpreter({ region: testRegion })
      await testInterpreter.startSession({ sessionName: 'error-test' })

      const result = await testInterpreter.executeCode({
        code: '1 / 0',
      })

      expect(result).toBeDefined()
      expect(result).toContain('ZeroDivisionError')

      await testInterpreter.stopSession()
    }, 30000)

    it('executes code with imports', async () => {
      const testInterpreter = new CodeInterpreter({ region: testRegion })
      await testInterpreter.startSession({ sessionName: 'import-test' })

      const result = await testInterpreter.executeCode({
        code: `
import json
data = {"key": "value"}
print(json.dumps(data))
        `.trim(),
      })

      expect(result).toBeDefined()
      expect(result).toContain('{"key": "value"}')

      await testInterpreter.stopSession()
    }, 30000)
  })

  describe('JavaScript Code Execution', () => {
    it('executes JavaScript code', async () => {
      const testInterpreter = new CodeInterpreter({ region: testRegion })
      await testInterpreter.startSession({ sessionName: 'js-test' })

      const result = await testInterpreter.executeCode({
        code: 'console.log("Hello from JavaScript!")',
        language: 'javascript',
      })

      expect(result).toBeDefined()
      expect(result).toContain('Hello from JavaScript!')

      await testInterpreter.stopSession()
    }, 30000)
  })

  describe('TypeScript Code Execution', () => {
    it('executes TypeScript code', async () => {
      const testInterpreter = new CodeInterpreter({ region: testRegion })
      await testInterpreter.startSession({ sessionName: 'ts-test' })

      const result = await testInterpreter.executeCode({
        code: 'const x: number = 42; console.log(x);',
        language: 'typescript',
      })

      expect(result).toBeDefined()
      expect(result).toContain('42')

      await testInterpreter.stopSession()
    }, 30000)
  })

  describe('Command Execution', () => {
    it('executes shell commands', async () => {
      const testInterpreter = new CodeInterpreter({ region: testRegion })
      await testInterpreter.startSession({ sessionName: 'cmd-test' })

      const result = await testInterpreter.executeCommand({
        command: 'echo "Hello from shell"',
      })

      expect(result).toBeDefined()
      expect(result).toContain('Hello from shell')

      await testInterpreter.stopSession()
    }, 30000)

    it('lists directory contents', async () => {
      const testInterpreter = new CodeInterpreter({ region: testRegion })
      await testInterpreter.startSession({ sessionName: 'ls-test' })

      const result = await testInterpreter.executeCommand({
        command: 'ls -la',
      })

      expect(result).toBeDefined()
      expect(result.length).toBeGreaterThan(0)

      await testInterpreter.stopSession()
    }, 30000)
  })

  describe('File Operations', () => {
    it('writes, lists, reads, and removes files', async () => {
      const testInterpreter = new CodeInterpreter({ region: testRegion })
      await testInterpreter.startSession({ sessionName: 'file-test' })

      // Write files
      const writeResult = await testInterpreter.writeFiles({
        files: [
          { path: 'test.txt', content: 'Hello World' },
          { path: 'data.json', content: '{"test": true}' },
        ],
      })

      expect(writeResult).toBeDefined()
      expect(writeResult.length).toBeGreaterThan(0)

      // List files
      const listResult = await testInterpreter.listFiles({
        path: '.',
      })

      expect(listResult).toBeDefined()
      expect(listResult.length).toBeGreaterThan(0)

      // Read files
      const readResult = await testInterpreter.readFiles({
        paths: ['test.txt', 'data.json'],
      })

      expect(readResult).toBeDefined()
      expect(readResult.length).toBeGreaterThan(0)

      // Remove files
      const removeResult = await testInterpreter.removeFiles({
        paths: ['test.txt', 'data.json'],
      })

      expect(removeResult).toBeDefined()
      expect(removeResult.length).toBeGreaterThan(0)

      await testInterpreter.stopSession()
    }, 30000)

    it('reads file content after code execution creates it', async () => {
      const testInterpreter = new CodeInterpreter({ region: testRegion })
      await testInterpreter.startSession({ sessionName: 'code-file-test' })

      await testInterpreter.executeCode({
        code: `
with open('output.txt', 'w') as f:
    f.write('Generated by Python')
        `.trim(),
      })

      const readResult = await testInterpreter.readFiles({
        paths: ['output.txt'],
      })

      expect(readResult).toBeDefined()
      expect(readResult.length).toBeGreaterThan(0)

      await testInterpreter.stopSession()
    }, 30000)
  })

  describe('Auto-Session Mode', () => {
    it('auto-creates default session for executeCode', async () => {
      const testInterpreter = new CodeInterpreter({ region: testRegion })
      const result = await testInterpreter.executeCode({
        code: 'print("Auto session")',
      })

      expect(result).toBeDefined()
      expect(result).toContain('Auto session')

      await testInterpreter.stopSession()
    }, 30000)

    it('reuses session across operations', async () => {
      const testInterpreter = new CodeInterpreter({ region: testRegion })

      await testInterpreter.executeCode({ code: 'x = 100' })

      const result = await testInterpreter.executeCode({ code: 'print(x)' })

      expect(result).toBeDefined()
      expect(result).toContain('100')

      await testInterpreter.stopSession()
    }, 30000)
  })

  describe('Session Query Methods', () => {
    it('gets current session details', async () => {
      const testInterpreter = new CodeInterpreter({ region: testRegion })
      const startedSession = await testInterpreter.startSession({
        sessionName: 'query-test-session',
      })

      const session = await testInterpreter.getSession()

      expect(session).toBeDefined()
      expect(session.sessionId).toBe(startedSession.sessionId)
      expect(session.codeInterpreterIdentifier).toBe('aws.codeinterpreter.v1')
      expect(session.name).toBe('query-test-session')
      expect(session.status).toBe('READY')
      expect(session.createdAt).toBeInstanceOf(Date)
      expect(session.lastUpdatedAt).toBeInstanceOf(Date)
      expect(session.sessionTimeoutSeconds).toBeGreaterThan(0)

      await testInterpreter.stopSession()
    }, 30000)

    it('throws error when no session is active', async () => {
      const testInterpreter = new CodeInterpreter({ region: testRegion })

      await expect(testInterpreter.getSession()).rejects.toThrow(/must be provided/)
    }, 30000)

    it('lists sessions with default parameters', async () => {
      const testInterpreter = new CodeInterpreter({ region: testRegion })
      // Create a session to ensure at least one exists
      await testInterpreter.startSession({ sessionName: 'list-test-1' })

      const response = await testInterpreter.listSessions()

      expect(response).toBeDefined()
      expect(response.items).toBeInstanceOf(Array)
      expect(response.items.length).toBeGreaterThan(0)

      const session = response.items[0]!
      expect(session.sessionId).toBeDefined()
      // Name field may not always be present in list responses
      if (session.name) {
        expect(session.name).toBeDefined()
      }
      expect(session.status).toMatch(/READY|TERMINATED/)
      expect(session.createdAt).toBeInstanceOf(Date)
      expect(session.lastUpdatedAt).toBeInstanceOf(Date)

      await testInterpreter.stopSession()
    }, 30000)

    it('filters sessions by status', async () => {
      const testInterpreter = new CodeInterpreter({ region: testRegion })
      // Create an active session
      await testInterpreter.startSession({ sessionName: 'filter-test' })

      const response = await testInterpreter.listSessions({ status: 'READY' })

      expect(response).toBeDefined()
      expect(response.items).toBeInstanceOf(Array)
      // All returned sessions should have READY status
      expect(response.items.every((item: any) => item.status === 'READY')).toBe(true)

      await testInterpreter.stopSession()
    }, 30000)

    it('respects maxResults parameter', async () => {
      const testInterpreter = new CodeInterpreter({ region: testRegion })
      // Create a session to ensure at least one exists
      await testInterpreter.startSession({ sessionName: 'pagination-test' })

      const response = await testInterpreter.listSessions({ maxResults: 1 })

      expect(response).toBeDefined()
      expect(response.items.length).toBeLessThanOrEqual(1)

      await testInterpreter.stopSession()
    }, 30000)
  })

  describe('Real-World Workflows', () => {
    it('performs data analysis workflow', async () => {
      const testInterpreter = new CodeInterpreter({ region: testRegion })
      await testInterpreter.startSession({ sessionName: 'data-analysis' })

      // Write data file
      await testInterpreter.writeFiles({
        files: [
          {
            path: 'data.csv',
            content: 'name,age\nAlice,30\nBob,25',
          },
        ],
      })

      // Process with pandas
      const result = await testInterpreter.executeCode({
        code: `
import pandas as pd
df = pd.read_csv('data.csv')
print(df.describe().to_string())
        `.trim(),
      })

      expect(result).toBeDefined()
      expect(result.length).toBeGreaterThan(0)

      await testInterpreter.stopSession()
    }, 30000)

    it('performs multi-step computation', async () => {
      const testInterpreter = new CodeInterpreter({ region: testRegion })
      await testInterpreter.startSession({ sessionName: 'computation' })

      await testInterpreter.executeCode({
        code: 'numbers = [1, 2, 3, 4, 5]',
      })

      await testInterpreter.executeCode({
        code: 'squared = [x**2 for x in numbers]',
      })

      const result = await testInterpreter.executeCode({
        code: 'print(sum(squared))',
      })

      expect(result).toBeDefined()
      expect(result).toContain('55')

      await testInterpreter.stopSession()
    }, 30000)
  })
})
