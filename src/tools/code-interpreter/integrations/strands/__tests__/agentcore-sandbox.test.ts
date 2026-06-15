import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ExecutionResult } from '@strands-agents/sdk/sandbox'
import { AgentCoreSandbox } from '../agentcore-sandbox.js'

const mockSend = vi.fn()
const mockClient = { send: mockSend } as any

vi.mock('@aws-sdk/client-bedrock-agentcore', () => ({
  BedrockAgentCoreClient: class {},
  InvokeCodeInterpreterCommand: class {
    [key: string]: unknown
    constructor(input: Record<string, unknown>) {
      Object.assign(this, input)
    }
  },
}))

function streamOf(...results: Array<{ content?: unknown[]; structuredContent?: unknown; isError?: boolean }>) {
  return {
    stream: (async function* () {
      for (const result of results) {
        yield { result }
      }
    })(),
  }
}

function errorStream(exceptionKey: string, message: string) {
  return {
    stream: (async function* () {
      yield { [exceptionKey]: { message } }
    })(),
  }
}

describe('AgentCoreSandbox', () => {
  let sandbox: AgentCoreSandbox

  beforeEach(() => {
    vi.clearAllMocks()
    sandbox = new AgentCoreSandbox({
      identifier: 'aws.codeinterpreter.v1',
      sessionId: 'sess-123',
      client: mockClient,
    })
  })

  describe('constructor', () => {
    it('stores identifier and sessionId', () => {
      expect(sandbox.identifier).toBe('aws.codeinterpreter.v1')
      expect(sandbox.sessionId).toBe('sess-123')
    })

    it('accepts a pre-configured client', () => {
      const client = { send: vi.fn() } as any
      const s = new AgentCoreSandbox({ identifier: 'id', sessionId: 'sid', client })
      expect(s.identifier).toBe('id')
    })
  })

  describe('executeStreaming', () => {
    it('sends executeCommand with the command string', async () => {
      mockSend.mockResolvedValueOnce(streamOf({ structuredContent: { stdout: 'hi\n', stderr: '', exitCode: 0 } }))

      const result = await sandbox.execute('echo hi')

      expect(mockSend).toHaveBeenCalledOnce()
      const cmd = mockSend.mock.calls[0]![0]
      expect(cmd.name).toBe('executeCommand')
      expect(cmd.arguments.command).toBe('echo hi')
      expect(cmd.codeInterpreterIdentifier).toBe('aws.codeinterpreter.v1')
      expect(cmd.sessionId).toBe('sess-123')
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('hi\n')
    })

    it('prepends env vars as shell export prefix', async () => {
      mockSend.mockResolvedValueOnce(streamOf({ structuredContent: { stdout: '', stderr: '', exitCode: 0 } }))

      await sandbox.execute('echo $FOO', { env: { FOO: 'bar' } })

      const cmd = mockSend.mock.calls[0]![0]
      expect(cmd.arguments.command).toBe("export FOO='bar' && echo $FOO")
    })

    it('prepends cd for cwd, before the env prefix', async () => {
      mockSend.mockResolvedValueOnce(streamOf({ structuredContent: { stdout: '', stderr: '', exitCode: 0 } }))

      await sandbox.execute('ls', { cwd: '/work space', env: { FOO: 'bar' } })

      const cmd = mockSend.mock.calls[0]![0]
      expect(cmd.arguments.command).toBe("cd '/work space' && export FOO='bar' && ls")
    })

    it('yields stream chunks for stdout and stderr', async () => {
      mockSend.mockResolvedValueOnce(
        streamOf({
          content: [{ type: 'text', text: 'out1' }],
          structuredContent: { stdout: 'out1', stderr: 'err1', exitCode: 1 },
        })
      )

      const chunks: unknown[] = []
      for await (const chunk of sandbox.executeStreaming('cmd')) {
        chunks.push(chunk)
      }

      expect(chunks).toContainEqual({ type: 'streamChunk', data: 'out1', streamType: 'stdout' })
      expect(chunks).toContainEqual({ type: 'streamChunk', data: 'err1', streamType: 'stderr' })
      const result = chunks.find((c: any) => c.type === 'executionResult') as ExecutionResult
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toBe('err1')
    })

    it('throws on missing stream', async () => {
      mockSend.mockResolvedValueOnce({})

      await expect(sandbox.execute('cmd')).rejects.toThrow('returned no result stream')
    })

    it('throws on service exceptions in stream', async () => {
      mockSend.mockResolvedValueOnce(errorStream('accessDeniedException', 'denied'))

      await expect(sandbox.execute('cmd')).rejects.toThrow('denied')
    })

    it('sets exitCode=1 when isError is true and no explicit exitCode', async () => {
      mockSend.mockResolvedValueOnce(streamOf({ content: [{ type: 'text', text: 'fail' }], isError: true }))

      const result = await sandbox.execute('cmd')
      expect(result.exitCode).toBe(1)
    })
  })

  describe('executeCodeStreaming', () => {
    it('sends executeCode with language mapped from alias', async () => {
      mockSend.mockResolvedValueOnce(streamOf({ structuredContent: { stdout: '3', stderr: '', exitCode: 0 } }))

      await sandbox.executeCode('print(1+2)', 'python3')

      const cmd = mockSend.mock.calls[0]![0]
      expect(cmd.name).toBe('executeCode')
      expect(cmd.arguments.code).toBe('print(1+2)')
      expect(cmd.arguments.language).toBe('python')
    })

    it('maps node to javascript', async () => {
      mockSend.mockResolvedValueOnce(streamOf({ structuredContent: { stdout: '', stderr: '', exitCode: 0 } }))

      await sandbox.executeCode('console.log(1)', 'node')

      const cmd = mockSend.mock.calls[0]![0]
      expect(cmd.arguments.language).toBe('javascript')
    })

    it('maps ts to typescript', async () => {
      mockSend.mockResolvedValueOnce(streamOf({ structuredContent: { stdout: '', stderr: '', exitCode: 0 } }))

      await sandbox.executeCode('const x: number = 1', 'ts')

      const cmd = mockSend.mock.calls[0]![0]
      expect(cmd.arguments.language).toBe('typescript')
    })

    it('throws on unsupported language', async () => {
      await expect(sandbox.executeCode('code', 'ruby')).rejects.toThrow('does not support language "ruby"')
    })

    it('collects output files from image and resource content blocks', async () => {
      const imageData = new Uint8Array([1, 2, 3])
      const resourceData = new Uint8Array([4, 5, 6])
      mockSend.mockResolvedValueOnce(
        streamOf({
          content: [
            { type: 'image', data: imageData, name: 'chart.png', mimeType: 'image/png' },
            {
              type: 'resource',
              name: 'data.bin',
              resource: { blob: resourceData, mimeType: 'application/octet-stream' },
            },
          ],
          structuredContent: { exitCode: 0 },
        })
      )

      const result = await sandbox.executeCode('plot()', 'python')

      expect(result.outputFiles).toHaveLength(2)
      expect(result.outputFiles[0]).toEqual({
        name: 'chart.png',
        content: imageData,
        mimeType: 'image/png',
      })
      expect(result.outputFiles[1]).toEqual({
        name: 'data.bin',
        content: resourceData,
        mimeType: 'application/octet-stream',
      })
    })
  })

  describe('readFile', () => {
    it('returns blob content as Uint8Array', async () => {
      const data = new Uint8Array([10, 20, 30])
      mockSend.mockResolvedValueOnce(
        streamOf({ content: [{ type: 'resource', resource: { blob: data, uri: 'file:///tmp/a.bin' } }] })
      )

      const result = await sandbox.readFile('/tmp/a.bin')
      expect(result).toEqual(data)
    })

    it('returns text content encoded as UTF-8', async () => {
      mockSend.mockResolvedValueOnce(
        streamOf({ content: [{ type: 'resource', resource: { text: 'hello', uri: 'file:///f.txt' } }] })
      )

      const result = await sandbox.readFile('/f.txt')
      expect(new TextDecoder().decode(result)).toBe('hello')
    })

    it('throws on error response', async () => {
      mockSend.mockResolvedValueOnce(streamOf({ content: [{ type: 'text', text: 'not found' }], isError: true }))

      await expect(sandbox.readFile('/missing')).rejects.toThrow('not found')
    })

    it('returns empty bytes for a 0-byte file with no content blocks', async () => {
      mockSend.mockResolvedValueOnce(streamOf({ content: [] }))

      const result = await sandbox.readFile('/empty.txt')
      expect(result).toEqual(new Uint8Array(0))
    })

    it('sends readFiles with paths array', async () => {
      mockSend.mockResolvedValueOnce(streamOf({ content: [{ type: 'resource', resource: { text: 'x' } }] }))

      await sandbox.readFile('/a.txt')

      const cmd = mockSend.mock.calls[0]![0]
      expect(cmd.name).toBe('readFiles')
      expect(cmd.arguments.paths).toEqual(['/a.txt'])
    })
  })

  describe('writeFile', () => {
    it('sends writeFiles with blob content', async () => {
      mockSend.mockResolvedValueOnce(streamOf({ content: [] }))

      const data = new Uint8Array([1, 2, 3])
      await sandbox.writeFile('/out.bin', data)

      const cmd = mockSend.mock.calls[0]![0]
      expect(cmd.name).toBe('writeFiles')
      expect(cmd.arguments.content).toEqual([{ path: '/out.bin', blob: data }])
    })

    it('throws on error response', async () => {
      mockSend.mockResolvedValueOnce(streamOf({ content: [{ type: 'text', text: 'disk full' }], isError: true }))

      await expect(sandbox.writeFile('/f', new Uint8Array())).rejects.toThrow('disk full')
    })
  })

  describe('removeFile', () => {
    it('sends removeFiles with paths array', async () => {
      mockSend.mockResolvedValueOnce(streamOf({ content: [] }))

      await sandbox.removeFile('/tmp/junk')

      const cmd = mockSend.mock.calls[0]![0]
      expect(cmd.name).toBe('removeFiles')
      expect(cmd.arguments.paths).toEqual(['/tmp/junk'])
    })

    it('throws on error response', async () => {
      mockSend.mockResolvedValueOnce(
        streamOf({ content: [{ type: 'text', text: 'permission denied' }], isError: true })
      )

      await expect(sandbox.removeFile('/root/x')).rejects.toThrow('permission denied')
    })
  })

  describe('listFiles', () => {
    it('sends listFiles with directoryPath', async () => {
      mockSend.mockResolvedValueOnce(streamOf({ content: [] }))

      await sandbox.listFiles('/home')

      const cmd = mockSend.mock.calls[0]![0]
      expect(cmd.name).toBe('listFiles')
      expect(cmd.arguments.directoryPath).toBe('/home')
    })

    it('parses resource_link blocks into FileInfo entries', async () => {
      mockSend.mockResolvedValueOnce(
        streamOf({
          content: [
            { type: 'resource_link', name: 'foo.txt', size: 42 },
            { type: 'resource_link', name: 'bar/', size: undefined },
          ],
        })
      )

      const entries = await sandbox.listFiles('/dir')

      expect(entries).toEqual([
        { name: 'foo.txt', size: 42, isDir: false },
        { name: 'bar', isDir: true },
      ])
    })

    it('parses text block as newline-separated file names', async () => {
      mockSend.mockResolvedValueOnce(streamOf({ content: [{ type: 'text', text: 'a.txt\nb.txt\n' }] }))

      const entries = await sandbox.listFiles('.')

      expect(entries).toEqual([
        { name: 'a.txt', isDir: false },
        { name: 'b.txt', isDir: false },
      ])
    })

    it('throws on error response', async () => {
      mockSend.mockResolvedValueOnce(streamOf({ content: [{ type: 'text', text: 'no such dir' }], isError: true }))

      await expect(sandbox.listFiles('/nope')).rejects.toThrow('no such dir')
    })
  })
})
