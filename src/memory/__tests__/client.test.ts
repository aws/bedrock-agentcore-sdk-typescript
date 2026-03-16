import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryClient } from '../client.js'

// Mock AWS SDK
vi.mock('@aws-sdk/client-bedrock-agentcore', () => {
  const CreateEventCommand = class {
    input: any
    constructor(input: any) {
      this.input = input
    }
  }
  const GetEventCommand = class {
    input: any
    constructor(input: any) {
      this.input = input
    }
  }
  const ListEventsCommand = class {
    input: any
    constructor(input: any) {
      this.input = input
    }
  }
  const DeleteEventCommand = class {
    input: any
    constructor(input: any) {
      this.input = input
    }
  }
  const RetrieveMemoryRecordsCommand = class {
    input: any
    constructor(input: any) {
      this.input = input
    }
  }
  const ListMemoryRecordsCommand = class {
    input: any
    constructor(input: any) {
      this.input = input
    }
  }
  const GetMemoryRecordCommand = class {
    input: any
    constructor(input: any) {
      this.input = input
    }
  }
  const DeleteMemoryRecordCommand = class {
    input: any
    constructor(input: any) {
      this.input = input
    }
  }

  return {
    BedrockAgentCoreClient: vi.fn(),
    CreateEventCommand,
    GetEventCommand,
    ListEventsCommand,
    DeleteEventCommand,
    RetrieveMemoryRecordsCommand,
    ListMemoryRecordsCommand,
    GetMemoryRecordCommand,
    DeleteMemoryRecordCommand,
  }
})

vi.mock('@aws-sdk/client-bedrock-agentcore-control', () => {
  const CreateMemoryCommand = class {
    input: any
    constructor(input: any) {
      this.input = input
    }
  }
  const GetMemoryCommand = class {
    input: any
    constructor(input: any) {
      this.input = input
    }
  }
  const ListMemoriesCommand = class {
    input: any
    constructor(input: any) {
      this.input = input
    }
  }
  const UpdateMemoryCommand = class {
    input: any
    constructor(input: any) {
      this.input = input
    }
  }
  const DeleteMemoryCommand = class {
    input: any
    constructor(input: any) {
      this.input = input
    }
  }

  return {
    BedrockAgentCoreControlClient: vi.fn(),
    CreateMemoryCommand,
    GetMemoryCommand,
    ListMemoriesCommand,
    UpdateMemoryCommand,
    DeleteMemoryCommand,
  }
})

import {
  BedrockAgentCoreClient,
  CreateEventCommand,
  RetrieveMemoryRecordsCommand,
} from '@aws-sdk/client-bedrock-agentcore'
import {
  BedrockAgentCoreControlClient,
  CreateMemoryCommand,
  GetMemoryCommand,
} from '@aws-sdk/client-bedrock-agentcore-control'
import { StrategyType, MessageRole, DEFAULT_NAMESPACES } from '../constants.js'

describe('MemoryClient', () => {
  describe('constructor', () => {
    it('creates client with default region', () => {
      const client = new MemoryClient()
      expect(client.region).toBeDefined()
    })
    it('creates client with custom region', () => {
      const client = new MemoryClient({ region: 'us-east-1' })
      expect(client.region).toBe('us-east-1')
    })
    it('creates client with credentials provider', () => {
      const client = new MemoryClient({
        credentialsProvider: {
          accessKeyId: 'test',
          secretAccessKey: 'test',
        } as any,
      })
      expect(client).toBeDefined()
    })
  })

  describe('createMemory', () => {
    let client: MemoryClient
    let mockControlSend: any

    beforeEach(() => {
      client = new MemoryClient()
      mockControlSend = vi.fn().mockResolvedValue({ memory: { id: 'mem-123' } })
      ;(client as any)._controlPlaneClient.send = mockControlSend
    })

    it('creates memory with minimal params', async () => {
      await client.createMemory({ name: 'test-memory' })
      expect(mockControlSend).toHaveBeenCalledWith(expect.any(CreateMemoryCommand))
      const callArgs = mockControlSend.mock.calls[0][0].input
      expect(callArgs).toEqual(expect.objectContaining({
        name: 'test-memory',
        eventExpiryDuration: 90,
      }))
    })

    it('creates memory with strategies', async () => {
      await client.createMemory({
        name: 'test-memory',
        strategies: [{ [StrategyType.SEMANTIC]: { name: 'semantic' } }],
      })
      const callArgs = mockControlSend.mock.calls[0][0].input
      expect(callArgs.memoryStrategies).toHaveLength(1)
      expect(callArgs.memoryStrategies[0][StrategyType.SEMANTIC]).toBeDefined()
    })

    it('adds default namespaces when not provided', async () => {
      await client.createMemory({
        name: 'test-memory',
        strategies: [{ [StrategyType.SEMANTIC]: { name: 'semantic' } }],
      })
      const callArgs = mockControlSend.mock.calls[0][0].input
      const strategy = callArgs.memoryStrategies[0][StrategyType.SEMANTIC]
      expect(strategy.namespaces).toEqual(DEFAULT_NAMESPACES[StrategyType.SEMANTIC])
    })

    it('includes description when provided', async () => {
      await client.createMemory({ name: 'test-memory', description: 'desc' })
      const callArgs = mockControlSend.mock.calls[0][0].input
      expect(callArgs.description).toBe('desc')
    })
  })

  describe('createMemoryAndWait', () => {
    let client: MemoryClient
    let mockControlSend: any

    beforeEach(() => {
      client = new MemoryClient()
      mockControlSend = vi.fn()
      ;(client as any)._controlPlaneClient.send = mockControlSend
    })

    it('waits for memory to become ACTIVE', async () => {
      mockControlSend
        .mockResolvedValueOnce({ memory: { id: 'mem-123' } }) // create
        .mockResolvedValueOnce({ memory: { status: 'CREATING' } }) // get status
        .mockResolvedValueOnce({ memory: { status: 'ACTIVE', id: 'mem-123' } }) // get status
        .mockResolvedValueOnce({ memory: { status: 'ACTIVE', id: 'mem-123' } }) // final get

      const memory = await client.createMemoryAndWait({ name: 'test' }, { pollInterval: 0.1 })
      expect(memory.status).toBe('ACTIVE')
    })

    it('throws TimeoutError on timeout', async () => {
      mockControlSend
        .mockResolvedValueOnce({ memory: { id: 'mem-123' } })
        .mockResolvedValue({ memory: { status: 'CREATING' } })

      await expect(
        client.createMemoryAndWait({ name: 'test' }, { maxWait: 0.1, pollInterval: 0.1 })
      ).rejects.toThrow('did not become ACTIVE')
    })

    it('throws RuntimeError when memory fails', async () => {
      mockControlSend
        .mockResolvedValueOnce({ memory: { id: 'mem-123' } })
        .mockResolvedValue({ memory: { status: 'FAILED', failureReason: 'Error' } })

      await expect(
        client.createMemoryAndWait({ name: 'test' }, { pollInterval: 0.1 })
      ).rejects.toThrow('failed: Error')
    })
  })

  describe('createEvent', () => {
    let client: MemoryClient
    let mockDataSend: any

    beforeEach(() => {
      client = new MemoryClient()
      mockDataSend = vi.fn().mockResolvedValue({ event: {} })
      ;(client as any)._dataPlaneClient.send = mockDataSend
    })

    it('creates event with messages', async () => {
      await client.createEvent({
        memoryId: 'mem-1',
        actorId: 'actor-1',
        sessionId: 'sess-1',
        messages: [['hello', 'USER']],
      })
      expect(mockDataSend).toHaveBeenCalledWith(expect.any(CreateEventCommand))
      const callArgs = mockDataSend.mock.calls[0][0].input
      expect(callArgs.payload).toHaveLength(1)
      expect(callArgs.payload[0].conversational.role).toBe('USER')
    })

    it('validates message roles', async () => {
      await expect(
        client.createEvent({
          memoryId: 'mem-1',
          actorId: 'actor-1',
          sessionId: 'sess-1',
          messages: [['hello', 'INVALID' as any]],
        })
      ).rejects.toThrow('Invalid role')
    })

    it('throws on empty messages', async () => {
      await expect(
        client.createEvent({
          memoryId: 'mem-1',
          actorId: 'actor-1',
          sessionId: 'sess-1',
          messages: [],
        })
      ).rejects.toThrow('At least one message is required')
    })

    it('supports branch info', async () => {
      await client.createEvent({
        memoryId: 'mem-1',
        actorId: 'actor-1',
        sessionId: 'sess-1',
        messages: [['hello', 'USER']],
        branch: { name: 'dev', rootEventId: 'evt-1' },
      })
      const callArgs = mockDataSend.mock.calls[0][0].input
      expect(callArgs.branch).toEqual({ name: 'dev', rootEventId: 'evt-1' })
    })
  })

  describe('retrieveMemories', () => {
    let client: MemoryClient
    let mockDataSend: any

    beforeEach(() => {
      client = new MemoryClient()
      mockDataSend = vi.fn().mockResolvedValue({ memoryRecordSummaries: [] })
      ;(client as any)._dataPlaneClient.send = mockDataSend
    })

    it('retrieves memories by query', async () => {
      await client.retrieveMemories({
        memoryId: 'mem-1',
        namespace: 'ns',
        query: 'test',
      })
      expect(mockDataSend).toHaveBeenCalledWith(expect.any(RetrieveMemoryRecordsCommand))
      const callArgs = mockDataSend.mock.calls[0][0].input
      expect(callArgs.searchCriteria.searchQuery).toBe('test')
    })

    it('rejects wildcards in namespace', async () => {
      const result = await client.retrieveMemories({
        memoryId: 'mem-1',
        namespace: 'ns/*',
        query: 'test',
      })
      expect(result).toEqual([])
      expect(mockDataSend).not.toHaveBeenCalled()
    })

    it('handles ResourceNotFoundException gracefully', async () => {
      mockDataSend.mockRejectedValue({ name: 'ResourceNotFoundException' })
      const result = await client.retrieveMemories({
        memoryId: 'mem-1',
        namespace: 'ns',
        query: 'test',
      })
      expect(result).toEqual([])
    })
  })

  describe('_normalizeMemoryResponse', () => {
    let client: MemoryClient

    beforeEach(() => {
      client = new MemoryClient()
    })

    it('adds memoryId from id', () => {
      const normalized = (client as any)._normalizeMemoryResponse({ id: '123' })
      expect(normalized.memoryId).toBe('123')
    })

    it('adds id from memoryId', () => {
      const normalized = (client as any)._normalizeMemoryResponse({ memoryId: '123' })
      expect(normalized.id).toBe('123')
    })

    it('normalizes strategies array', () => {
      const normalized = (client as any)._normalizeMemoryResponse({
        strategies: [{ strategyId: 's-1', type: 'SEMANTIC' }],
      })
      expect(normalized.strategies[0].memoryStrategyId).toBe('s-1')
      expect(normalized.strategies[0].memoryStrategyType).toBe('SEMANTIC')
    })
  })

  describe('_addDefaultNamespaces', () => {
    let client: MemoryClient

    beforeEach(() => {
      client = new MemoryClient()
    })

    it('adds defaults for semantic strategy', () => {
      const strategies = [{ [StrategyType.SEMANTIC]: { name: 'test' } }]
      const result = (client as any)._addDefaultNamespaces(strategies)
      expect(result[0][StrategyType.SEMANTIC].namespaces).toEqual(
        DEFAULT_NAMESPACES[StrategyType.SEMANTIC]
      )
    })

    it('preserves user-provided namespaces', () => {
      const strategies = [
        { [StrategyType.SEMANTIC]: { name: 'test', namespaces: ['custom'] } },
      ]
      const result = (client as any)._addDefaultNamespaces(strategies)
      expect(result[0][StrategyType.SEMANTIC].namespaces).toEqual(['custom'])
    })
  })
})
