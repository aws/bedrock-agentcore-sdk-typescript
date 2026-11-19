import { describe, it, expect } from 'vitest'
import type { BedrockAgentCore } from '@aws-sdk/client-bedrock-agentcore'
import type { BedrockAgentCoreControl } from '@aws-sdk/client-bedrock-agentcore-control'
import { MemoryClient } from '../client.js'
import { DATA_PLANE_METHODS, CONTROL_PLANE_METHODS } from '../types.js'

function fakeControlPlane(overrides: Record<string, (input: unknown) => unknown>): Record<string, unknown> {
  return new Proxy({} as Record<string, unknown>, {
    get: (_, method) => overrides[method as string] ?? (() => Promise.resolve({})),
  })
}

function fakeDataPlane(overrides: Record<string, (input: unknown) => unknown>): Record<string, unknown> {
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

  describe('memory() scoping', () => {
    const client = new MemoryClient({ region: 'us-west-2' })
    const mem = client.memory('mem-1')

    it('exposes scoped methods as functions', () => {
      expect(typeof mem.createEvent).toBe('function')
      expect(typeof mem.retrieveMemoryRecords).toBe('function')
      expect(typeof mem.listEvents).toBe('function')
      expect(typeof mem.listActors).toBe('function')
    })
  })

  describe('createOrGetMemory()', () => {
    it('returns existing memory when create throws already-exists', async () => {
      const client = new MemoryClient({
        controlPlaneClient: fakeControlPlane({
          createMemory: () => {
            throw Object.assign(new Error('already exists'), { name: 'ValidationException' })
          },
          getMemory: () => Promise.resolve({ memory: { id: 'mem-1' }, $metadata: {} }),
        }) as unknown as BedrockAgentCoreControl,
      })

      const result = await client.createOrGetMemory({ name: 'test', eventExpiryDuration: 30 })
      expect(result.memory).toMatchObject({ id: 'mem-1' })
    })

    it('propagates non-conflict errors', async () => {
      const client = new MemoryClient({
        controlPlaneClient: fakeControlPlane({
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
        controlPlaneClient: fakeControlPlane({
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
        dataPlaneClient: fakeDataPlane({
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

      const turns = await client.memory('mem-1').getLastKTurns({ actorId: 'a1', sessionId: 's1', k: 1 })
      expect(turns).toMatchObject([[{ role: 'USER' }, { role: 'ASSISTANT' }]])
    })

    it('returns all turns when k exceeds total', async () => {
      const client = new MemoryClient({
        dataPlaneClient: fakeDataPlane({
          listEvents: () =>
            Promise.resolve({
              events: [
                { eventId: 'e1', payload: [{ conversational: { role: 'USER', content: { text: 'hi' } } }] },
                { eventId: 'e2', payload: [{ conversational: { role: 'ASSISTANT', content: { text: 'hello' } } }] },
              ],
            }),
        }) as unknown as BedrockAgentCore,
      })

      const turns = await client.memory('mem-1').getLastKTurns({ actorId: 'a1', sessionId: 's1', k: 5 })
      expect(turns).toMatchObject([[{ role: 'USER' }, { role: 'ASSISTANT' }]])
    })

    it('returns empty array for empty session', async () => {
      const client = new MemoryClient({
        dataPlaneClient: fakeDataPlane({
          listEvents: () => Promise.resolve({ events: [] }),
        }) as unknown as BedrockAgentCore,
      })

      const turns = await client.memory('mem-1').getLastKTurns({ actorId: 'a1', sessionId: 's1', k: 5 })
      expect(turns).toEqual([])
    })
  })

  describe('listBranches()', () => {
    it('aggregates branch info from events', async () => {
      const client = new MemoryClient({
        dataPlaneClient: fakeDataPlane({
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

      const branches = await client.memory('mem-1').listBranches({ actorId: 'a1', sessionId: 's1' })
      expect(branches).toMatchObject([
        { name: 'main', eventCount: 2 },
        { name: 'alt', eventCount: 1, rootEventId: 'e1' },
      ])
    })
  })
})
