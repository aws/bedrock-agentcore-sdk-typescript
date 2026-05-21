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
        flushTimeoutMs: 10000,
        maxDrainIterations: 10,
      })
    })

    it('extraction: {} resolves to defaults', () => {
      const plugin = new AgentCoreMemory({ ...BASE_CONFIG, extraction: {} })
      expect((plugin as any).extractionConfig).toEqual({
        batchSize: 10,
        batchTimeoutMs: 5000,
        messageFilter: expect.any(Function),
        fireAndForget: false,
        flushTimeoutMs: 10000,
        maxDrainIterations: 10,
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

    it('M6: throws when a second plugin tries to register on the same agent', () => {
      const first = new AgentCoreMemory({ ...BASE_CONFIG, actorId: 'A', extraction: true })
      const second = new AgentCoreMemory({ ...BASE_CONFIG, actorId: 'B', extraction: true })
      const agent = createMockAgent()
      first.initAgent(agent as any)
      expect(() => second.initAgent(agent as any)).toThrow('another AgentCoreMemory plugin is already registered')
    })

    it('M6: different agents can each have their own plugin', () => {
      const a = new AgentCoreMemory({ ...BASE_CONFIG, actorId: 'A', extraction: true })
      const b = new AgentCoreMemory({ ...BASE_CONFIG, actorId: 'B', extraction: true })
      const agent1 = createMockAgent()
      const agent2 = createMockAgent()
      a.initAgent(agent1 as any)
      expect(() => b.initAgent(agent2 as any)).not.toThrow()
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
        namespace: '/facts/user-1/',
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

      expect((plugin as any).batcher.size).toBe(1)
    })

    it('flushes buffer on AfterInvocationEvent', async () => {
      const plugin = new AgentCoreMemory({ ...BASE_CONFIG, extraction: true })
      const agent = createMockAgent()
      plugin.initAgent(agent as any)

      await agent.fireHooks('MessageAddedEvent', { agent, message: createMessage('user', 'Hi') })
      await agent.fireHooks('MessageAddedEvent', { agent, message: createMessage('assistant', 'Hello!') })
      await agent.fireHooks('AfterInvocationEvent', { agent })

      expect(mockCreateEvent).toHaveBeenCalledTimes(2)
      expect((plugin as any).batcher.size).toBe(0)
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

      expect((plugin as any).batcher.size).toBe(1)
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

    it('concurrent flush() calls are deduplicated (no double-send of in-flight batch)', async () => {
      let resolveFirst!: () => void
      const firstCallPromise = new Promise<void>((resolve) => {
        resolveFirst = resolve
      })
      mockCreateEvent.mockImplementationOnce(() => firstCallPromise.then(() => ({})))
      mockCreateEvent.mockResolvedValue({})

      const plugin = new AgentCoreMemory({ ...BASE_CONFIG, extraction: true })
      const agent = createMockAgent()
      plugin.initAgent(agent as any)

      await agent.fireHooks('MessageAddedEvent', { agent, message: createMessage('assistant', 'msg1') })

      const flush1 = plugin.flush()
      const flush2 = plugin.flush()

      resolveFirst()
      await flush1
      await flush2

      expect(mockCreateEvent).toHaveBeenCalledTimes(1)
    })

    it('messages buffered during in-flight flush are drained on the next pass (B1 regression)', async () => {
      let resolveFirst!: () => void
      const firstCallPromise = new Promise<void>((resolve) => {
        resolveFirst = resolve
      })
      mockCreateEvent.mockImplementationOnce(() => firstCallPromise.then(() => ({})))
      mockCreateEvent.mockResolvedValue({})

      const plugin = new AgentCoreMemory({ ...BASE_CONFIG, extraction: { batchSize: 2 } })
      const agent = createMockAgent()
      plugin.initAgent(agent as any)

      await agent.fireHooks('MessageAddedEvent', { agent, message: createMessage('assistant', 'a') })
      await agent.fireHooks('MessageAddedEvent', { agent, message: createMessage('assistant', 'b') })
      await agent.fireHooks('MessageAddedEvent', { agent, message: createMessage('assistant', 'c') })
      await agent.fireHooks('MessageAddedEvent', { agent, message: createMessage('assistant', 'd') })
      const after = agent.fireHooks('AfterInvocationEvent', { agent })

      resolveFirst()
      await after

      expect(mockCreateEvent).toHaveBeenCalledTimes(4)
      expect((plugin as any).batcher.size).toBe(0)
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

    it('has independent batcher', () => {
      const plugin = new AgentCoreMemory({ ...BASE_CONFIG, extraction: true })
      const cloned = plugin.withActor('actor-2')
      expect((cloned as any).batcher).not.toBe((plugin as any).batcher)
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

  describe('bug bash regressions', () => {
    it('H1: clientToken is stable across retry', async () => {
      let firstCall = true
      const tokensSeen: string[] = []
      mockCreateEvent.mockImplementation(async (req: any) => {
        tokensSeen.push(req.clientToken)
        if (firstCall) {
          firstCall = false
          throw new Error('simulated transient failure')
        }
        return {}
      })

      const plugin = new AgentCoreMemory({ ...BASE_CONFIG, extraction: true })
      const agent = createMockAgent()
      plugin.initAgent(agent as any)
      await agent.fireHooks('MessageAddedEvent', { agent, message: createMessage('user', 'hi') })
      await agent.fireHooks('AfterInvocationEvent', { agent })

      expect(tokensSeen).toHaveLength(2)
      expect(tokensSeen[0]).toBe(tokensSeen[1])
    })

    it('H2: metadataProvider sync throw does not drop sibling messages', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const plugin = new AgentCoreMemory({
        ...BASE_CONFIG,
        extraction: true,
        metadataProvider: (m) => {
          const text = m.content[0]?.type === 'textBlock' ? m.content[0].text : ''
          if (text === 'throw') throw new Error('boom')
          return { ok: { stringValue: 'yes' } }
        },
      })
      const agent = createMockAgent()
      plugin.initAgent(agent as any)

      await agent.fireHooks('MessageAddedEvent', { agent, message: createMessage('user', 'a') })
      await agent.fireHooks('MessageAddedEvent', { agent, message: createMessage('user', 'throw') })
      await agent.fireHooks('MessageAddedEvent', { agent, message: createMessage('user', 'c') })
      await agent.fireHooks('MessageAddedEvent', { agent, message: createMessage('user', 'd') })
      await agent.fireHooks('AfterInvocationEvent', { agent })

      // 4 messages attempted; 'throw' rejects both initial + retry; siblings succeed.
      expect(mockCreateEvent).toHaveBeenCalled()
      const successTexts = mockCreateEvent.mock.calls
        .filter((c: any[]) => {
          // Every call passes. Filter out the throw-message attempts by checking if the promise succeeds.
          return c[0].payload[0].conversational.content.text !== 'throw'
        })
        .map((c: any[]) => c[0].payload[0].conversational.content.text)
      // Three unique non-throw messages landed: a, c, d
      expect(new Set(successTexts)).toEqual(new Set(['a', 'c', 'd']))
      warnSpy.mockRestore()
    })

    it('H3: {actorId} and {sessionId} templates resolved at construct time', async () => {
      const plugin = new AgentCoreMemory({
        ...BASE_CONFIG,
        actorId: 'aidan',
        sessionId: 'sess-12345',
        injection: {
          namespaces: {
            '/users/{actorId}/facts': { topK: 3 },
            '/sessions/{sessionId}/summary': { topK: 2 },
          },
        },
      })
      const agent = createMockAgent()
      agent.messages = [createMessage('user', 'hi')]
      plugin.initAgent(agent as any)
      await agent.fireHooks('BeforeInvocationEvent', { agent })

      const calls = mockRetrieveMemoryRecords.mock.calls.map((c: any[]) => c[0].namespace)
      expect(calls).toContain('/users/aidan/facts')
      expect(calls).toContain('/sessions/sess-12345/summary')
      expect(calls).not.toContain('/users/{actorId}/facts')
    })

    it('H3: withActor re-resolves {actorId} templates for fork', async () => {
      const base = new AgentCoreMemory({
        ...BASE_CONFIG,
        actorId: 'user-1',
        injection: { namespaces: { '/users/{actorId}/facts': {} } },
      })
      const fork = base.withActor('user-2')
      const agent = createMockAgent()
      fork.initAgent(agent as any)
      await agent.fireHooks('BeforeInvocationEvent', { agent })
      const calls = mockRetrieveMemoryRecords.mock.calls.map((c: any[]) => c[0].namespace)
      expect(calls).toContain('/users/user-2/facts')
      expect(calls).not.toContain('/users/user-1/facts')
    })

    it('B2: flushTimeoutMs rejects hung createEvent instead of stalling', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      mockCreateEvent.mockImplementation(() => new Promise(() => {}))

      const plugin = new AgentCoreMemory({
        ...BASE_CONFIG,
        extraction: { flushTimeoutMs: 50 },
      })
      const agent = createMockAgent()
      plugin.initAgent(agent as any)
      await agent.fireHooks('MessageAddedEvent', { agent, message: createMessage('user', 'hi') })

      const afterInvoke = agent.fireHooks('AfterInvocationEvent', { agent })
      await vi.advanceTimersByTimeAsync(200)
      await afterInvoke

      expect(warnSpy).toHaveBeenCalled()
      warnSpy.mockRestore()
    })

    it('public flush() drains buffer synchronously', async () => {
      const plugin = new AgentCoreMemory({ ...BASE_CONFIG, extraction: { batchTimeoutMs: 60000 } })
      const agent = createMockAgent()
      plugin.initAgent(agent as any)
      await agent.fireHooks('MessageAddedEvent', { agent, message: createMessage('user', 'hi') })
      expect(mockCreateEvent).not.toHaveBeenCalled()
      await plugin.flush()
      expect(mockCreateEvent).toHaveBeenCalledTimes(1)
    })

    it('shutdown() stops accepting new messages', async () => {
      const plugin = new AgentCoreMemory({ ...BASE_CONFIG, extraction: true })
      const agent = createMockAgent()
      plugin.initAgent(agent as any)
      await plugin.shutdown()
      await agent.fireHooks('MessageAddedEvent', { agent, message: createMessage('user', 'hi') })
      expect(mockCreateEvent).not.toHaveBeenCalled()
    })

    it('extraction batchSize: 0 throws at construct time (M3)', () => {
      expect(() => new AgentCoreMemory({ ...BASE_CONFIG, extraction: { batchSize: 0 } })).toThrow(
        /batchSize must be a positive integer/
      )
    })

    it('silently coerces system/tool roles away (M1) — not buffered', async () => {
      const plugin = new AgentCoreMemory({ ...BASE_CONFIG, extraction: true })
      const agent = createMockAgent()
      plugin.initAgent(agent as any)
      const sysMsg = { role: 'system', content: [{ type: 'textBlock', text: 'sys' }] }
      await agent.fireHooks('MessageAddedEvent', { agent, message: sysMsg })
      await agent.fireHooks('AfterInvocationEvent', { agent })
      expect(mockCreateEvent).not.toHaveBeenCalled()
    })
  })

  describe('observability', () => {
    it('onDroppedEvents fires with retry-failed when both initial + retry fail', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const dropped: any[] = []
      mockCreateEvent.mockRejectedValue(new Error('boom'))

      const plugin = new AgentCoreMemory({
        ...BASE_CONFIG,
        extraction: { onDroppedEvents: (info) => dropped.push(info) },
      })
      const agent = createMockAgent()
      plugin.initAgent(agent as any)
      await agent.fireHooks('MessageAddedEvent', { agent, message: createMessage('user', 'hi') })
      await agent.fireHooks('AfterInvocationEvent', { agent })

      expect(
        dropped.some((d) => d.reason === 'retry-failed' && d.count === 1 && typeof d.clientToken === 'string')
      ).toBe(true)
      warnSpy.mockRestore()
    })

    it('onDroppedEvents fires with timeout when flushTimeoutMs trips', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const dropped: any[] = []
      // first call hangs, second (retry) resolves so final state is not drop
      let calls = 0
      mockCreateEvent.mockImplementation(() => {
        calls++
        if (calls === 1) return new Promise(() => {}) // hang
        return Promise.resolve({})
      })

      const plugin = new AgentCoreMemory({
        ...BASE_CONFIG,
        extraction: { flushTimeoutMs: 50, onDroppedEvents: (info) => dropped.push(info) },
      })
      const agent = createMockAgent()
      plugin.initAgent(agent as any)
      await agent.fireHooks('MessageAddedEvent', { agent, message: createMessage('user', 'hi') })

      const afterInvoke = agent.fireHooks('AfterInvocationEvent', { agent })
      await vi.advanceTimersByTimeAsync(200)
      await afterInvoke

      expect(dropped.some((d) => d.reason === 'timeout')).toBe(true)
      warnSpy.mockRestore()
    })

    it('post-shutdown MessageAddedEvent warns once and notifies via onDroppedEvents', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const dropped: any[] = []

      const plugin = new AgentCoreMemory({
        ...BASE_CONFIG,
        extraction: { onDroppedEvents: (info) => dropped.push(info) },
      })
      const agent = createMockAgent()
      plugin.initAgent(agent as any)
      await plugin.shutdown()

      await agent.fireHooks('MessageAddedEvent', { agent, message: createMessage('user', 'late-1') })
      await agent.fireHooks('MessageAddedEvent', { agent, message: createMessage('user', 'late-2') })

      const postShutdownDrops = dropped.filter((d) => d.reason === 'post-shutdown')
      expect(postShutdownDrops).toHaveLength(2)
      // warn is one-shot — only the first drop produces a console.warn
      const dropWarns = warnSpy.mock.calls.filter((c) => String(c[0]).includes('after shutdown()'))
      expect(dropWarns).toHaveLength(1)
      warnSpy.mockRestore()
    })

    it('shutdown() no-ops when extraction is disabled (R2-A1 + R2-A3 regression)', async () => {
      const plugin = new AgentCoreMemory({
        ...BASE_CONFIG,
        injection: { namespaces: { '/x': {} } },
      })
      const agent = createMockAgent()
      plugin.initAgent(agent as any)
      await expect(plugin.shutdown()).resolves.toBeUndefined()
    })

    it('tool-use-only messages are skipped from extraction (jariy17 finding 2)', async () => {
      const plugin = new AgentCoreMemory({ ...BASE_CONFIG, extraction: true })
      const agent = createMockAgent()
      plugin.initAgent(agent as any)

      const toolUseOnly = {
        role: 'assistant',
        content: [{ type: 'toolUseBlock', name: 'search', toolUseId: 't1', input: { q: 'test' } }],
      }
      await agent.fireHooks('MessageAddedEvent', { agent, message: toolUseOnly })
      await agent.fireHooks('AfterInvocationEvent', { agent })

      expect(mockCreateEvent).not.toHaveBeenCalled()
    })

    it('reasoning-only messages are skipped from extraction (jariy17 finding 2)', async () => {
      const plugin = new AgentCoreMemory({ ...BASE_CONFIG, extraction: true })
      const agent = createMockAgent()
      plugin.initAgent(agent as any)

      const reasoningOnly = {
        role: 'assistant',
        content: [{ type: 'reasoningBlock', text: 'Let me think about this carefully...' }],
      }
      await agent.fireHooks('MessageAddedEvent', { agent, message: reasoningOnly })
      await agent.fireHooks('AfterInvocationEvent', { agent })

      expect(mockCreateEvent).not.toHaveBeenCalled()
    })

    it('mixed message lands with only the text content (jariy17 finding 2)', async () => {
      const plugin = new AgentCoreMemory({ ...BASE_CONFIG, extraction: true })
      const agent = createMockAgent()
      plugin.initAgent(agent as any)

      const mixed = {
        role: 'assistant',
        content: [
          { type: 'textBlock', text: 'here is my answer' },
          { type: 'toolUseBlock', name: 'search', toolUseId: 't1', input: { q: 'test' } },
          { type: 'reasoningBlock', text: 'internal chain of thought' },
        ],
      }
      await agent.fireHooks('MessageAddedEvent', { agent, message: mixed })
      await agent.fireHooks('AfterInvocationEvent', { agent })

      expect(mockCreateEvent).toHaveBeenCalledTimes(1)
      const sentText = mockCreateEvent.mock.calls[0]![0].payload[0].conversational.content.text
      expect(sentText).toBe('here is my answer')
      expect(sentText).not.toContain('tool_use')
      expect(sentText).not.toContain('chain of thought')
    })

    it('empty-content messages are skipped (jariy17 finding 3)', async () => {
      const plugin = new AgentCoreMemory({ ...BASE_CONFIG, extraction: true })
      const agent = createMockAgent()
      plugin.initAgent(agent as any)

      const empty = { role: 'user', content: [] }
      const imageOnly = { role: 'user', content: [{ type: 'imageBlock' }] }

      await agent.fireHooks('MessageAddedEvent', { agent, message: empty })
      await agent.fireHooks('MessageAddedEvent', { agent, message: imageOnly })
      await agent.fireHooks('AfterInvocationEvent', { agent })

      expect(mockCreateEvent).not.toHaveBeenCalled()
    })
  })
})
