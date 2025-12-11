import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemorySessionManager } from '../session.js'
import { MessageRole } from '../constants.js'
import {
  CreateEventCommand,
  ListEventsCommand,
  RetrieveMemoryRecordsCommand,
} from '@aws-sdk/client-bedrock-agentcore'

// Mock AWS SDK
const mockSend = vi.fn()
vi.mock('@aws-sdk/client-bedrock-agentcore', () => {
  return {
    BedrockAgentCoreClient: class {
      send = mockSend
    },
    CreateEventCommand: class {
      constructor(public input: any) {}
    },
    ListEventsCommand: class {
      constructor(public input: any) {}
    },
    GetEventCommand: class {
      constructor(public input: any) {}
    },
    DeleteEventCommand: class {
      constructor(public input: any) {}
    },
    RetrieveMemoryRecordsCommand: class {
      constructor(public input: any) {}
    },
    ListMemoryRecordsCommand: class {
      constructor(public input: any) {}
    },
    GetMemoryRecordCommand: class {
      constructor(public input: any) {}
    },
    DeleteMemoryRecordCommand: class {
      constructor(public input: any) {}
    },
  }
})

describe('MemorySessionManager', () => {
  let manager: MemorySessionManager
  const memoryId = 'test-memory'
  const actorId = 'test-actor'
  const sessionId = 'test-session'

  beforeEach(() => {
    vi.clearAllMocks()
    manager = new MemorySessionManager({
      memoryId,
      region: 'us-west-2',
    })
  })

  describe('constructor', () => {
    it('creates manager with config', () => {
      expect(manager).toBeDefined()
      expect(manager.region).toBe('us-west-2')
    })
  })

  describe('addTurns', () => {
    it('creates event with conversational messages', async () => {
      mockSend.mockResolvedValue({
        event: {
          eventId: 'event-123',
          eventTimestamp: new Date(),
        },
      })

      const messages = [
        { role: MessageRole.USER, text: 'Hello' },
        { role: MessageRole.ASSISTANT, text: 'Hi there' },
      ]

      await manager.addTurns({
        actorId,
        sessionId,
        messages,
      })

      expect(mockSend).toHaveBeenCalledTimes(1)
      const command = mockSend.mock.calls[0][0]
      expect(command).toBeInstanceOf(CreateEventCommand)
      expect(command.input).toMatchObject({
        memoryId,
        actorId,
        sessionId,
        payload: [
          { conversational: { role: 'USER', content: { text: 'Hello' } } },
          { conversational: { role: 'ASSISTANT', content: { text: 'Hi there' } } },
        ],
      })
    })

    it('throws error if no messages provided', async () => {
      await expect(
        manager.addTurns({
          actorId,
          sessionId,
          messages: [],
        })
      ).rejects.toThrow('At least one message is required')
    })
  })

  describe('listEvents', () => {
    it('lists events and returns them', async () => {
      const mockEvents = [
        {
          eventId: 'event-1',
          eventTimestamp: '2023-01-01T10:00:00Z',
          payload: [],
        },
        {
          eventId: 'event-2',
          eventTimestamp: '2023-01-01T10:01:00Z',
          payload: [],
        },
      ]

      mockSend.mockResolvedValue({
        events: mockEvents,
      })

      const result = await manager.listEvents({
        actorId,
        sessionId,
      })

      expect(result).toHaveLength(2)
      expect(result[0].eventId).toBe('event-1')
      expect(result[1].eventId).toBe('event-2')
      expect(mockSend).toHaveBeenCalledTimes(1)
      const command = mockSend.mock.calls[0][0]
      expect(command).toBeInstanceOf(ListEventsCommand)
    })
  })

  describe('searchLongTermMemories', () => {
    it('searches memories with query', async () => {
      mockSend.mockResolvedValue({
        memoryRecordSummaries: [
          { memoryRecordId: 'rec-1', content: 'test content' },
        ],
      })

      await manager.searchLongTermMemories({
        query: 'test query',
        namespacePrefix: 'test/namespace',
      })

      expect(mockSend).toHaveBeenCalledTimes(1)
      const command = mockSend.mock.calls[0][0]
      expect(command).toBeInstanceOf(RetrieveMemoryRecordsCommand)
      expect(command.input).toMatchObject({
        memoryId,
        searchCriteria: {
          searchQuery: 'test query',
          namespace: 'test/namespace',
        },
      })
    })
  })

  describe('processTurnWithLlm', () => {
    it('processes turn with llm callback', async () => {
      // Mock retrieval
      mockSend.mockImplementation((command) => {
        if (command instanceof RetrieveMemoryRecordsCommand) {
          return Promise.resolve({
            memoryRecordSummaries: [
              { memoryRecordId: 'rec-1', content: 'context' },
            ],
          })
        }
        if (command instanceof CreateEventCommand) {
          return Promise.resolve({
            event: { eventId: 'evt-1' },
          })
        }
        return Promise.resolve({})
      })

      const llmCallback = vi.fn().mockReturnValue('AI Response')

      const result = await manager.processTurnWithLlm({
        actorId,
        sessionId,
        userInput: 'User Input',
        llmCallback,
        retrievalConfig: {
          'ns/{actorId}': { topK: 2 },
        },
      })

      expect(llmCallback).toHaveBeenCalledWith(
        'User Input',
        expect.arrayContaining([expect.objectContaining({ content: 'context' })])
      )
      expect(result.response).toBe('AI Response')
      expect(mockSend).toHaveBeenCalledTimes(2) // Retrieve + CreateEvent
    })
  })
})
