import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AgentCoreMemory } from '../plugin.js'

const mockRetrieveMemoryRecords = vi.fn()
const mockCreateEvent = vi.fn()

vi.mock('../../../client.js', () => ({
  MemoryClient: vi.fn(function (this: any) {
    this.retrieveMemoryRecords = mockRetrieveMemoryRecords
    this.createEvent = mockCreateEvent
    return this
  }),
}))

vi.mock('@strands-agents/sdk', () => {
  class BeforeInvocationEvent {
    readonly type = 'beforeInvocationEvent'
    readonly agent: any
    constructor(data: { agent: any }) {
      this.agent = data.agent
    }
  }
  class MessageAddedEvent {
    readonly type = 'messageAddedEvent'
    readonly agent: any
    readonly message: any
    constructor(data: { agent: any; message: any }) {
      this.agent = data.agent
      this.message = data.message
    }
  }
  class AfterInvocationEvent {
    readonly type = 'afterInvocationEvent'
    readonly agent: any
    constructor(data: { agent: any }) {
      this.agent = data.agent
    }
  }
  return {
    BeforeInvocationEvent,
    MessageAddedEvent,
    AfterInvocationEvent,
    tool: vi.fn((config: any) => ({
      name: config.name,
      description: config.description,
      inputSchema: config.inputSchema,
      callback: config.callback,
    })),
  }
})

interface HookEntry {
  eventName: string
  callback: (event: any) => any
}

function createMockAgent() {
  const hooks: HookEntry[] = []
  return {
    systemPrompt: 'You are a helpful assistant.' as any,
    messages: [] as any[],
    addHook: vi.fn((eventType: any, callback: any) => {
      hooks.push({ eventName: eventType.name ?? eventType.prototype?.constructor?.name ?? 'unknown', callback })
      return () => {}
    }),
    _hooks: hooks,
    async fireHooks(eventName: string, event: any) {
      for (const h of hooks.filter((h) => h.eventName === eventName)) {
        await h.callback(event)
      }
    },
  }
}

function createMessage(role: 'user' | 'assistant', text: string): any {
  return {
    role,
    content: [{ type: 'textBlock', text }],
  }
}

const BASE_CONFIG = {
  memoryId: 'mem-1',
  actorId: 'user-1',
  sessionId: 'session-1',
}

describe('AgentCoreMemory', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mockRetrieveMemoryRecords.mockResolvedValue({ memoryRecordSummaries: [] })
    mockCreateEvent.mockResolvedValue({})
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('constructor', () => {
    it('creates instance with extraction and injection', () => {
      const plugin = new AgentCoreMemory({
        ...BASE_CONFIG,
        extraction: true,
        injection: { namespaces: { '/facts/{actorId}/': {} } },
      })
      expect(plugin.name).toBe('agentcore-memory')
    })

    it('extraction: true resolves to defaults', () => {
      const plugin = new AgentCoreMemory({ ...BASE_CONFIG, extraction: true })
      expect((plugin as any).extractionConfig).toEqual({
        batchSize: 10,
        batchTimeoutMs: 5000,
        messageFilter: expect.any(Function),
        fireAndForget: false,
      })
    })

    it('extraction: {} resolves to defaults', () => {
      const plugin = new AgentCoreMemory({ ...BASE_CONFIG, extraction: {} })
      expect((plugin as any).extractionConfig).toEqual({
        batchSize: 10,
        batchTimeoutMs: 5000,
        messageFilter: expect.any(Function),
        fireAndForget: false,
      })
    })

    it('extraction: false resolves to null', () => {
      const plugin = new AgentCoreMemory({ ...BASE_CONFIG, extraction: false })
      expect((plugin as any).extractionConfig).toBeNull()
    })

    it('extraction with custom config merges with defaults', () => {
      const plugin = new AgentCoreMemory({ ...BASE_CONFIG, extraction: { batchSize: 20 } })
      expect((plugin as any).extractionConfig.batchSize).toBe(20)
      expect((plugin as any).extractionConfig.batchTimeoutMs).toBe(5000)
    })

    it('warns on degenerate injection config', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      new AgentCoreMemory({
        ...BASE_CONFIG,
        injection: { namespaces: { '/facts/{actorId}/': {} }, automatic: false, searchTool: false },
      })
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('injection will do nothing'))
      warnSpy.mockRestore()
    })
  })

  describe('initAgent', () => {
    it('registers injection hook when automatic: true (default)', () => {
      const plugin = new AgentCoreMemory({
        ...BASE_CONFIG,
        injection: { namespaces: { '/facts/{actorId}/': {} } },
      })
      const agent = createMockAgent()
      plugin.initAgent(agent as any)
      expect(agent.addHook).toHaveBeenCalledTimes(1)
      expect(agent._hooks[0]!.eventName).toBe('BeforeInvocationEvent')
    })

    it('does not register injection hook when automatic: false', () => {
      const plugin = new AgentCoreMemory({
        ...BASE_CONFIG,
        injection: { namespaces: { '/facts/{actorId}/': {} }, automatic: false, searchTool: true },
      })
      const agent = createMockAgent()
      plugin.initAgent(agent as any)
      expect(agent.addHook).not.toHaveBeenCalled()
    })

    it('registers extraction hooks when extraction configured', () => {
      const plugin = new AgentCoreMemory({ ...BASE_CONFIG, extraction: true })
      const agent = createMockAgent()
      plugin.initAgent(agent as any)
      expect(agent.addHook).toHaveBeenCalledTimes(2)
      expect(agent._hooks[0]!.eventName).toBe('MessageAddedEvent')
      expect(agent._hooks[1]!.eventName).toBe('AfterInvocationEvent')
    })

    it('registers both injection and extraction hooks', () => {
      const plugin = new AgentCoreMemory({
        ...BASE_CONFIG,
        extraction: true,
        injection: { namespaces: { '/facts/{actorId}/': {} } },
      })
      const agent = createMockAgent()
      plugin.initAgent(agent as any)
      expect(agent.addHook).toHaveBeenCalledTimes(3)
    })

    it('throws on double registration', () => {
      const plugin = new AgentCoreMemory({ ...BASE_CONFIG, extraction: true })
      const agent = createMockAgent()
      plugin.initAgent(agent as any)
      expect(() => plugin.initAgent(agent as any)).toThrow('AgentCoreMemory plugin already initialized')
    })
  })

  describe('getTools', () => {
    it('returns empty array when searchTool not configured', () => {
      const plugin = new AgentCoreMemory({
        ...BASE_CONFIG,
        injection: { namespaces: { '/facts/{actorId}/': {} } },
      })
      expect(plugin.getTools()).toEqual([])
    })

    it('returns search_memory tool when searchTool: true', () => {
      const plugin = new AgentCoreMemory({
        ...BASE_CONFIG,
        injection: { namespaces: { '/facts/{actorId}/': {} }, searchTool: true },
      })
      const tools = plugin.getTools()
      expect(tools).toHaveLength(1)
      expect((tools[0] as any).name).toBe('search_memory')
    })
  })

  describe('injection pipeline', () => {
    it('retrieves and injects memory into system prompt', async () => {
      mockRetrieveMemoryRecords.mockResolvedValue({
        memoryRecordSummaries: [
          { content: { text: 'User likes dark mode' }, score: 0.9 },
          { content: { text: 'User timezone is US/Pacific' }, score: 0.8 },
        ],
      })

      const plugin = new AgentCoreMemory({
        ...BASE_CONFIG,
        injection: { namespaces: { '/facts/{actorId}/': { topK: 5 } } },
      })
      const agent = createMockAgent()
      agent.messages = [createMessage('user', 'hello')]
      plugin.initAgent(agent as any)

      await agent.fireHooks('BeforeInvocationEvent', { agent })

      expect(mockRetrieveMemoryRecords).toHaveBeenCalledWith({
        memoryId: 'mem-1',
        namespace: '/facts/{actorId}/',
        searchCriteria: { searchQuery: 'hello', topK: 5 },
      })
      expect(agent.systemPrompt).toContain('<agentcore_memory>')
      expect(agent.systemPrompt).toContain('User likes dark mode')
    })

    it('strips stale memory block before re-injecting', async () => {
      mockRetrieveMemoryRecords.mockResolvedValue({
        memoryRecordSummaries: [{ content: { text: 'New fact' }, score: 0.9 }],
      })

      const plugin = new AgentCoreMemory({
        ...BASE_CONFIG,
        injection: { namespaces: { '/facts/{actorId}/': {} } },
      })
      const agent = createMockAgent()
      agent.systemPrompt = 'Base prompt\n\n<agentcore_memory>\nOld data\n</agentcore_memory>'
      agent.messages = [createMessage('user', 'hello')]
      plugin.initAgent(agent as any)

      await agent.fireHooks('BeforeInvocationEvent', { agent })

      expect(agent.systemPrompt).not.toContain('Old data')
      expect(agent.systemPrompt).toContain('New fact')
      expect(agent.systemPrompt).toContain('Base prompt')
    })

    it('skips injection when zero records returned', async () => {
      const plugin = new AgentCoreMemory({
        ...BASE_CONFIG,
        injection: { namespaces: { '/facts/{actorId}/': {} } },
      })
      const agent = createMockAgent()
      agent.messages = [createMessage('user', 'hello')]
      plugin.initAgent(agent as any)

      await agent.fireHooks('BeforeInvocationEvent', { agent })

      expect(agent.systemPrompt).toBe('You are a helpful assistant.')
    })

    it('uses generic query on fresh session with no messages', async () => {
      const plugin = new AgentCoreMemory({
        ...BASE_CONFIG,
        injection: { namespaces: { '/facts/{actorId}/': {}, '/preferences/{actorId}/': {} } },
      })
      const agent = createMockAgent()
      agent.messages = []
      plugin.initAgent(agent as any)

      await agent.fireHooks('BeforeInvocationEvent', { agent })

      expect(mockRetrieveMemoryRecords).toHaveBeenCalledWith(
        expect.objectContaining({
          searchCriteria: expect.objectContaining({
            searchQuery: expect.stringContaining('facts'),
          }),
        })
      )
    })

    it('continues without injection on retrieval error', async () => {
      mockRetrieveMemoryRecords.mockRejectedValue(new Error('API error'))
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const plugin = new AgentCoreMemory({
        ...BASE_CONFIG,
        injection: { namespaces: { '/facts/{actorId}/': {} } },
      })
      const agent = createMockAgent()
      agent.systemPrompt = 'Base prompt\n\n<agentcore_memory>\nStale\n</agentcore_memory>'
      agent.messages = [createMessage('user', 'hello')]
      plugin.initAgent(agent as any)

      await agent.fireHooks('BeforeInvocationEvent', { agent })

      expect(agent.systemPrompt).not.toContain('agentcore_memory')
      expect(agent.systemPrompt).toContain('Base prompt')
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Injection failed'), expect.any(Error))
      warnSpy.mockRestore()
    })

    it('applies relevanceScore post-filter', async () => {
      mockRetrieveMemoryRecords.mockResolvedValue({
        memoryRecordSummaries: [
          { content: { text: 'High relevance' }, score: 0.9 },
          { content: { text: 'Low relevance' }, score: 0.2 },
        ],
      })

      const plugin = new AgentCoreMemory({
        ...BASE_CONFIG,
        injection: { namespaces: { '/facts/{actorId}/': { relevanceScore: 0.5 } } },
      })
      const agent = createMockAgent()
      agent.messages = [createMessage('user', 'hello')]
      plugin.initAgent(agent as any)

      await agent.fireHooks('BeforeInvocationEvent', { agent })

      expect(agent.systemPrompt).toContain('High relevance')
      expect(agent.systemPrompt).not.toContain('Low relevance')
    })

    it('uses custom contextTag', async () => {
      mockRetrieveMemoryRecords.mockResolvedValue({
        memoryRecordSummaries: [{ content: { text: 'Fact' }, score: 0.9 }],
      })

      const plugin = new AgentCoreMemory({
        ...BASE_CONFIG,
        injection: { namespaces: { '/facts/{actorId}/': {} }, contextTag: 'custom_memory' },
      })
      const agent = createMockAgent()
      agent.messages = [createMessage('user', 'hello')]
      plugin.initAgent(agent as any)

      await agent.fireHooks('BeforeInvocationEvent', { agent })

      expect(agent.systemPrompt).toContain('<custom_memory>')
      expect(agent.systemPrompt).toContain('</custom_memory>')
    })

    it('uses custom formatMemories override', async () => {
      mockRetrieveMemoryRecords.mockResolvedValue({
        memoryRecordSummaries: [{ content: { text: 'Fact' }, score: 0.9 }],
      })

      const plugin = new AgentCoreMemory({
        ...BASE_CONFIG,
        injection: {
          namespaces: { '/facts/{actorId}/': {} },
          formatMemories: () => '<custom>Custom format</custom>',
        },
      })
      const agent = createMockAgent()
      agent.messages = [createMessage('user', 'hello')]
      plugin.initAgent(agent as any)

      await agent.fireHooks('BeforeInvocationEvent', { agent })

      expect(agent.systemPrompt).toContain('<custom>Custom format</custom>')
    })

    it('handles undefined systemPrompt', async () => {
      mockRetrieveMemoryRecords.mockResolvedValue({
        memoryRecordSummaries: [{ content: { text: 'Fact' }, score: 0.9 }],
      })

      const plugin = new AgentCoreMemory({
        ...BASE_CONFIG,
        injection: { namespaces: { '/facts/{actorId}/': {} } },
      })
      const agent = createMockAgent()
      agent.systemPrompt = undefined
      agent.messages = [createMessage('user', 'hello')]
      plugin.initAgent(agent as any)

      await agent.fireHooks('BeforeInvocationEvent', { agent })

      expect(typeof agent.systemPrompt).toBe('string')
      expect(agent.systemPrompt).toContain('<agentcore_memory>')
    })

    it('handles SystemContentBlock[] systemPrompt', async () => {
      mockRetrieveMemoryRecords.mockResolvedValue({
        memoryRecordSummaries: [{ content: { text: 'Fact from array' }, score: 0.9 }],
      })

      const plugin = new AgentCoreMemory({
        ...BASE_CONFIG,
        injection: { namespaces: { '/facts/{actorId}/': {} } },
      })
      const agent = createMockAgent()
      agent.systemPrompt = [{ type: 'textBlock', text: 'Base instructions' }, { type: 'cachePointBlock' }] as any
      agent.messages = [createMessage('user', 'hello')]
      plugin.initAgent(agent as any)

      await agent.fireHooks('BeforeInvocationEvent', { agent })

      expect(Array.isArray(agent.systemPrompt)).toBe(true)
      const blocks = agent.systemPrompt as any[]
      expect(blocks[0].text).toBe('Base instructions')
      expect(blocks[1].type).toBe('cachePointBlock')
      const memoryBlock = blocks.find((b: any) => b.text?.includes('agentcore_memory'))
      expect(memoryBlock).toBeDefined()
      expect(memoryBlock.text).toContain('Fact from array')
    })
  })

  describe('extraction pipeline', () => {
    it('buffers messages from MessageAddedEvent', async () => {
      const plugin = new AgentCoreMemory({ ...BASE_CONFIG, extraction: true })
      const agent = createMockAgent()
      plugin.initAgent(agent as any)

      const msg = createMessage('assistant', 'Hello!')
      await agent.fireHooks('MessageAddedEvent', { agent, message: msg })

      expect((plugin as any).buffer).toHaveLength(1)
    })

    it('flushes buffer on AfterInvocationEvent', async () => {
      const plugin = new AgentCoreMemory({ ...BASE_CONFIG, extraction: true })
      const agent = createMockAgent()
      plugin.initAgent(agent as any)

      await agent.fireHooks('MessageAddedEvent', { agent, message: createMessage('user', 'Hi') })
      await agent.fireHooks('MessageAddedEvent', { agent, message: createMessage('assistant', 'Hello!') })
      await agent.fireHooks('AfterInvocationEvent', { agent })

      expect(mockCreateEvent).toHaveBeenCalledTimes(2)
      expect((plugin as any).buffer).toHaveLength(0)
    })

    it('applies messageFilter before buffering', async () => {
      const plugin = new AgentCoreMemory({
        ...BASE_CONFIG,
        extraction: { messageFilter: (msg: any) => msg.role !== 'user' },
      })
      const agent = createMockAgent()
      plugin.initAgent(agent as any)

      await agent.fireHooks('MessageAddedEvent', { agent, message: createMessage('user', 'Hi') })
      await agent.fireHooks('MessageAddedEvent', { agent, message: createMessage('assistant', 'Hello!') })

      expect((plugin as any).buffer).toHaveLength(1)
    })

    it('sends correct payload to createEvent', async () => {
      const plugin = new AgentCoreMemory({ ...BASE_CONFIG, extraction: true })
      const agent = createMockAgent()
      plugin.initAgent(agent as any)

      await agent.fireHooks('MessageAddedEvent', { agent, message: createMessage('assistant', 'Hello!') })
      await agent.fireHooks('AfterInvocationEvent', { agent })

      expect(mockCreateEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          memoryId: 'mem-1',
          actorId: 'user-1',
          sessionId: 'session-1',
          payload: [{ conversational: { role: 'ASSISTANT', content: { text: 'Hello!' } } }],
          clientToken: expect.any(String),
        })
      )
    })

    it('includes metadata from metadataProvider', async () => {
      const plugin = new AgentCoreMemory({
        ...BASE_CONFIG,
        extraction: true,
        metadataProvider: () => ({ source: { stringValue: 'test' } }),
      })
      const agent = createMockAgent()
      plugin.initAgent(agent as any)

      await agent.fireHooks('MessageAddedEvent', { agent, message: createMessage('assistant', 'Hello!') })
      await agent.fireHooks('AfterInvocationEvent', { agent })

      expect(mockCreateEvent).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: { source: { stringValue: 'test' } } })
      )
    })

    it('retries failed events once then drops', async () => {
      let callCount = 0
      mockCreateEvent.mockImplementation(() => {
        callCount++
        if (callCount <= 2) return Promise.reject(new Error('throttled'))
        return Promise.resolve({})
      })
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const plugin = new AgentCoreMemory({ ...BASE_CONFIG, extraction: true })
      const agent = createMockAgent()
      plugin.initAgent(agent as any)

      await agent.fireHooks('MessageAddedEvent', { agent, message: createMessage('assistant', 'msg1') })
      await agent.fireHooks('AfterInvocationEvent', { agent })

      expect(mockCreateEvent).toHaveBeenCalledTimes(2)
      warnSpy.mockRestore()
    })

    it('does not throw from hooks on extraction error', async () => {
      mockCreateEvent.mockRejectedValue(new Error('API error'))
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const plugin = new AgentCoreMemory({ ...BASE_CONFIG, extraction: true })
      const agent = createMockAgent()
      plugin.initAgent(agent as any)

      await agent.fireHooks('MessageAddedEvent', { agent, message: createMessage('assistant', 'msg') })
      await expect(agent.fireHooks('AfterInvocationEvent', { agent })).resolves.toBeUndefined()

      warnSpy.mockRestore()
    })

    it('flushes early when batchSize reached', async () => {
      const plugin = new AgentCoreMemory({ ...BASE_CONFIG, extraction: { batchSize: 2 } })
      const agent = createMockAgent()
      plugin.initAgent(agent as any)

      await agent.fireHooks('MessageAddedEvent', { agent, message: createMessage('assistant', 'msg1') })
      await agent.fireHooks('MessageAddedEvent', { agent, message: createMessage('assistant', 'msg2') })

      await vi.advanceTimersByTimeAsync(10)
      expect(mockCreateEvent).toHaveBeenCalledTimes(2)
    })

    it('guards against concurrent flushes', async () => {
      let resolveFirst!: () => void
      const firstCallPromise = new Promise<void>((resolve) => {
        resolveFirst = resolve
      })
      mockCreateEvent.mockImplementationOnce(() => firstCallPromise.then(() => ({})))
      mockCreateEvent.mockResolvedValue({})

      const plugin = new AgentCoreMemory({ ...BASE_CONFIG, extraction: true })
      const agent = createMockAgent()
      plugin.initAgent(agent as any)
      ;(plugin as any).buffer = [createMessage('assistant', 'msg1')]

      const flush1 = (plugin as any).flushBuffer()
      ;(plugin as any).buffer = [createMessage('assistant', 'msg2')]
      const flush2 = (plugin as any).flushBuffer()

      resolveFirst()
      await flush1
      await flush2

      expect(mockCreateEvent).toHaveBeenCalledTimes(1)
    })
  })

  describe('withActor', () => {
    it('returns new uninitialized instance with overridden actorId', () => {
      const plugin = new AgentCoreMemory({ ...BASE_CONFIG, extraction: true })
      const cloned = plugin.withActor('actor-2')
      expect((cloned as any).originalConfig.actorId).toBe('actor-2')
      expect((cloned as any).initialized).toBe(false)
    })

    it('shares MemoryClient instance', () => {
      const plugin = new AgentCoreMemory({ ...BASE_CONFIG, extraction: true })
      const cloned = plugin.withActor('actor-2')
      expect((cloned as any).client).toBe((plugin as any).client)
    })

    it('has independent buffer', () => {
      const plugin = new AgentCoreMemory({ ...BASE_CONFIG, extraction: true })
      const cloned = plugin.withActor('actor-2')
      expect((cloned as any).buffer).not.toBe((plugin as any).buffer)
    })
  })

  describe('withMetadataProvider', () => {
    it('returns new instance with overridden metadataProvider', () => {
      const plugin = new AgentCoreMemory({ ...BASE_CONFIG, extraction: true })
      const fn = () => ({ key: { stringValue: 'val' } })
      const cloned = plugin.withMetadataProvider(fn)
      expect((cloned as any).originalConfig.metadataProvider).toBe(fn)
      expect((cloned as any).initialized).toBe(false)
    })
  })
})
