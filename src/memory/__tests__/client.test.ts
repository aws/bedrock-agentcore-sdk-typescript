import { describe, it, expect } from 'vitest'
import type { BedrockAgentCore } from '@aws-sdk/client-bedrock-agentcore'
import type { BedrockAgentCoreControl } from '@aws-sdk/client-bedrock-agentcore-control'
import { MemoryClient } from '../client.js'
import { DATA_PLANE_METHODS, CONTROL_PLANE_METHODS } from '../types.js'

function fakeClient(overrides: Record<string, (input: unknown) => unknown>): Record<string, unknown> {
  return new Proxy({} as Record<string, unknown>, {
    get: (_, method) => overrides[method as string] ?? (() => Promise.resolve({})),
  })
}

describe('MemoryClient', () => {
  describe('passthrough', () => {
    const client = new MemoryClient({ region: 'us-west-2' })

    it('exposes every data plane method as a function', () => {
      for (const method of DATA_PLANE_METHODS) {
        expect(typeof client[method]).toBe('function')
      }
    })

    it('exposes every control plane method as a function', () => {
      for (const method of CONTROL_PLANE_METHODS) {
        expect(typeof client[method]).toBe('function')
      }
    })

    it('does not expose arbitrary properties', () => {
      expect((client as unknown as Record<string, unknown>)['nonExistentMethod']).toBeUndefined()
    })

    it('constructs without config using defaults', () => {
      expect(new MemoryClient()).toBeDefined()
    })
  })

  describe('createOrGetMemory()', () => {
    it('returns existing memory when create throws already-exists', async () => {
      const client = new MemoryClient({
        controlPlaneClient: fakeClient({
          createMemory: () => {
            throw Object.assign(new Error('already exists'), { name: 'ValidationException' })
          },
          listMemories: () => Promise.resolve({ memories: [{ id: 'test-abc123' }] }),
          getMemory: () => Promise.resolve({ memory: { id: 'test-abc123' }, $metadata: {} }),
        }) as unknown as BedrockAgentCoreControl,
      })

      const result = await client.createOrGetMemory({ name: 'test', eventExpiryDuration: 30 })
      expect(result.memory).toMatchObject({ id: 'test-abc123' })
    })

    it('does not match memories with similar name prefixes', async () => {
      const client = new MemoryClient({
        controlPlaneClient: fakeClient({
          createMemory: () => {
            throw Object.assign(new Error('already exists'), { name: 'ValidationException' })
          },
          listMemories: () => Promise.resolve({ memories: [{ id: 'prod-east-abc123' }, { id: 'prod-abc123' }] }),
          getMemory: (input: { memoryId: string }) =>
            Promise.resolve({ memory: { id: input.memoryId }, $metadata: {} }),
        }) as unknown as BedrockAgentCoreControl,
      })

      const result = await client.createOrGetMemory({ name: 'prod', eventExpiryDuration: 30 })
      expect(result.memory).toMatchObject({ id: 'prod-abc123' })
    })

    it('propagates non-conflict errors', async () => {
      const client = new MemoryClient({
        controlPlaneClient: fakeClient({
          createMemory: () => {
            throw Object.assign(new Error('throttled'), { name: 'ThrottlingException' })
          },
        }) as unknown as BedrockAgentCoreControl,
      })

      await expect(client.createOrGetMemory({ name: 'test', eventExpiryDuration: 30 })).rejects.toThrow('throttled')
    })
  })

  describe('deleteMemoryAndWait()', () => {
    it('resolves when resource is not found after delete', async () => {
      const client = new MemoryClient({
        controlPlaneClient: fakeClient({
          deleteMemory: () => Promise.resolve({}),
          getMemory: () => {
            throw Object.assign(new Error(), { name: 'ResourceNotFoundException' })
          },
        }) as unknown as BedrockAgentCoreControl,
      })

      await expect(
        client.deleteMemoryAndWait('mem-1', { maxWaitSeconds: 1, pollIntervalMs: 10 })
      ).resolves.toBeUndefined()
    })
  })

  describe('getLastKTurns()', () => {
    it('groups messages into turns at USER boundaries', async () => {
      const client = new MemoryClient({
        dataPlaneClient: fakeClient({
          listEvents: () =>
            Promise.resolve({
              events: [
                { eventId: 'e1', payload: [{ conversational: { role: 'USER', content: { text: 'hi' } } }] },
                { eventId: 'e2', payload: [{ conversational: { role: 'ASSISTANT', content: { text: 'hello' } } }] },
                { eventId: 'e3', payload: [{ conversational: { role: 'USER', content: { text: 'bye' } } }] },
                { eventId: 'e4', payload: [{ conversational: { role: 'ASSISTANT', content: { text: 'goodbye' } } }] },
              ],
            }),
        }) as unknown as BedrockAgentCore,
      })

      const turns = await client.getLastKTurns({ memoryId: 'mem-1', actorId: 'a1', sessionId: 's1', k: 1 })
      expect(turns).toMatchObject([[{ role: 'USER' }, { role: 'ASSISTANT' }]])
    })

    it('returns the last K turns, not the first K', async () => {
      const events = Array.from({ length: 10 }, (_, i) => [
        { eventId: `e${i * 2}`, payload: [{ conversational: { role: 'USER', content: { text: `q${i + 1}` } } }] },
        {
          eventId: `e${i * 2 + 1}`,
          payload: [{ conversational: { role: 'ASSISTANT', content: { text: `a${i + 1}` } } }],
        },
      ]).flat()

      const client = new MemoryClient({
        dataPlaneClient: fakeClient({
          listEvents: () => Promise.resolve({ events }),
        }) as unknown as BedrockAgentCore,
      })

      const turns = await client.getLastKTurns({ memoryId: 'mem-1', actorId: 'a1', sessionId: 's1', k: 3 })
      expect(turns).toHaveLength(3)
      expect(turns[0]![0]).toMatchObject({ role: 'USER', content: { text: 'q8' } })
      expect(turns[1]![0]).toMatchObject({ role: 'USER', content: { text: 'q9' } })
      expect(turns[2]![0]).toMatchObject({ role: 'USER', content: { text: 'q10' } })
    })

    it('returns all turns when k exceeds total', async () => {
      const client = new MemoryClient({
        dataPlaneClient: fakeClient({
          listEvents: () =>
            Promise.resolve({
              events: [
                { eventId: 'e1', payload: [{ conversational: { role: 'USER', content: { text: 'hi' } } }] },
                { eventId: 'e2', payload: [{ conversational: { role: 'ASSISTANT', content: { text: 'hello' } } }] },
              ],
            }),
        }) as unknown as BedrockAgentCore,
      })

      const turns = await client.getLastKTurns({ memoryId: 'mem-1', actorId: 'a1', sessionId: 's1', k: 5 })
      expect(turns).toMatchObject([[{ role: 'USER' }, { role: 'ASSISTANT' }]])
    })

    it('returns empty array for empty session', async () => {
      const client = new MemoryClient({
        dataPlaneClient: fakeClient({
          listEvents: () => Promise.resolve({ events: [] }),
        }) as unknown as BedrockAgentCore,
      })

      const turns = await client.getLastKTurns({ memoryId: 'mem-1', actorId: 'a1', sessionId: 's1', k: 5 })
      expect(turns).toEqual([])
    })
  })

  describe('listBranches()', () => {
    it('aggregates branch info from events', async () => {
      const client = new MemoryClient({
        dataPlaneClient: fakeClient({
          listEvents: () =>
            Promise.resolve({
              events: [
                { eventId: 'e1' },
                { eventId: 'e2' },
                { eventId: 'e3', branch: { name: 'alt', rootEventId: 'e1' } },
              ],
            }),
        }) as unknown as BedrockAgentCore,
      })

      const branches = await client.listBranches({ memoryId: 'mem-1', actorId: 'a1', sessionId: 's1' })
      expect(branches).toMatchObject([
        { name: 'main', eventCount: 2 },
        { name: 'alt', eventCount: 1, rootEventId: 'e1' },
      ])
    })
  })
})
