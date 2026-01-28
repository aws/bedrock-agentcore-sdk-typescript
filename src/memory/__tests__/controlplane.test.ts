import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryControlPlaneClient } from '../controlplane.js'
import {
  CreateMemoryCommand,
  GetMemoryCommand,
  UpdateMemoryCommand,
} from '@aws-sdk/client-bedrock-agentcore-control'

// Mock AWS SDK
const mockSend = vi.fn()
vi.mock('@aws-sdk/client-bedrock-agentcore-control', () => {
  return {
    BedrockAgentCoreControlClient: class {
      send = mockSend
    },
    CreateMemoryCommand: class {
      constructor(public input: any) {}
    },
    GetMemoryCommand: class {
      constructor(public input: any) {}
    },
    ListMemoriesCommand: class {
      constructor(public input: any) {}
    },
    UpdateMemoryCommand: class {
      constructor(public input: any) {}
    },
    DeleteMemoryCommand: class {
      constructor(public input: any) {}
    },
  }
})

describe('MemoryControlPlaneClient', () => {
  let client: MemoryControlPlaneClient

  beforeEach(() => {
    vi.clearAllMocks()
    client = new MemoryControlPlaneClient({
      region: 'us-west-2',
    })
  })

  describe('constructor', () => {
    it('creates client with config', () => {
      expect(client).toBeDefined()
      expect(client.region).toBe('us-west-2')
    })
  })

  describe('createMemory', () => {
    it('creates memory resource', async () => {
      mockSend.mockResolvedValue({
        memory: {
          memoryId: 'mem-123',
          name: 'test-memory',
          status: 'ACTIVE',
        },
      })

      const result = await client.createMemory({
        name: 'test-memory',
      })

      expect(mockSend).toHaveBeenCalledTimes(1)
      const command = mockSend.mock.calls[0][0]
      expect(command).toBeInstanceOf(CreateMemoryCommand)
      expect(command.input).toMatchObject({
        name: 'test-memory',
      })
      expect(result.id).toBe('mem-123')
    })
  })

  describe('getMemory', () => {
    it('gets memory resource', async () => {
      mockSend.mockResolvedValue({
        memory: {
          memoryId: 'mem-123',
          name: 'test-memory',
          status: 'ACTIVE',
        },
      })

      const result = await client.getMemory('mem-123')

      expect(mockSend).toHaveBeenCalledTimes(1)
      const command = mockSend.mock.calls[0][0]
      expect(command).toBeInstanceOf(GetMemoryCommand)
      expect(command.input).toMatchObject({
        memoryId: 'mem-123',
        includeStrategies: true,
      })
      expect(result.id).toBe('mem-123')
    })
  })

  describe('addStrategy', () => {
    it('adds strategy to memory', async () => {
      mockSend.mockResolvedValue({
        memory: {
          memoryId: 'mem-123',
          strategies: [
            {
              strategyId: 'strat-1',
              type: 'semantic',
              status: 'ACTIVE',
            },
          ],
        },
      })

      const strategy = {
        semanticMemoryStrategy: {
          name: 'test-strat',
        },
      }

      const result = await client.addStrategy('mem-123', strategy, { maxWait: 0 })

      expect(mockSend).toHaveBeenCalledTimes(1)
      const command = mockSend.mock.calls[0][0]
      expect(command).toBeInstanceOf(UpdateMemoryCommand)
      expect(command.input).toMatchObject({
        memoryId: 'mem-123',
        addStrategies: [strategy],
      })
      expect(result.strategies).toHaveLength(1)
      expect(result.strategies![0].strategyId).toBe('strat-1')
    })
  })
})
