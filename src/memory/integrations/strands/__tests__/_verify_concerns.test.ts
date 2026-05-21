import { describe, it, expect, vi, beforeEach } from 'vitest'
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
    constructor(d: { agent: any }) {
      this.agent = d.agent
    }
  }
  class MessageAddedEvent {
    readonly type = 'messageAddedEvent'
    readonly agent: any
    readonly message: any
    constructor(d: { agent: any; message: any }) {
      this.agent = d.agent
      this.message = d.message
    }
  }
  class AfterInvocationEvent {
    readonly type = 'afterInvocationEvent'
    readonly agent: any
    constructor(d: { agent: any }) {
      this.agent = d.agent
    }
  }
  return { BeforeInvocationEvent, MessageAddedEvent, AfterInvocationEvent, tool: vi.fn((c: any) => c) }
})

interface HookEntry {
  eventName: string
  callback: (event: any) => any
}
function createMockAgent() {
  const hooks: HookEntry[] = []
  return {
    systemPrompt: 'You are helpful.' as any,
    messages: [] as any[],
    addHook: vi.fn((eventType: any, callback: any) => {
      hooks.push({ eventName: eventType.name ?? 'unknown', callback })
      return () => {}
    }),
    async fireHooks(eventName: string, event: any) {
      for (const h of hooks.filter((h) => h.eventName === eventName)) await h.callback(event)
    },
  }
}
const msg = (role: any, text: string) => ({ role, content: [{ type: 'textBlock', text }] })
const BASE = { memoryId: 'mem', actorId: 'a1', sessionId: 's1' }

beforeEach(() => {
  mockRetrieveMemoryRecords.mockReset()
  mockCreateEvent.mockReset()
  mockRetrieveMemoryRecords.mockResolvedValue({ memoryRecordSummaries: [] })
  mockCreateEvent.mockResolvedValue({})
})

describe('CONCERN 1: retry uses SAME clientToken (idempotency)', () => {
  it('retry uses identical clientToken', async () => {
    const tokens: string[] = []
    let callNum = 0
    mockCreateEvent.mockImplementation((args: any) => {
      tokens.push(args.clientToken)
      callNum++
      if (callNum === 1) return Promise.reject(new Error('boom'))
      return Promise.resolve({})
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const plugin = new AgentCoreMemory({ ...BASE, extraction: true })
    const agent = createMockAgent()
    plugin.initAgent(agent as any)
    await agent.fireHooks('MessageAddedEvent', { agent, message: msg('user', 'hi') })
    await agent.fireHooks('AfterInvocationEvent', { agent })

    expect(tokens.length).toBe(2)
    expect(tokens[0]).toBe(tokens[1])
  })
})

describe('CONCERN 2: msg buffered DURING in-flight flush gets drained', () => {
  it('with batchSize:2, msg3 added during in-flight flush is drained by AfterInvocation', async () => {
    let resolveSlow!: () => void
    const slow = new Promise<void>((r) => {
      resolveSlow = r
    })
    let isFirstBatch = true
    mockCreateEvent.mockImplementation(() => {
      if (isFirstBatch) return slow.then(() => ({}))
      return Promise.resolve({})
    })

    const plugin = new AgentCoreMemory({ ...BASE, extraction: { batchSize: 2 } })
    const agent = createMockAgent()
    plugin.initAgent(agent as any)

    await agent.fireHooks('MessageAddedEvent', { agent, message: msg('user', 'msg1') })
    await agent.fireHooks('MessageAddedEvent', { agent, message: msg('user', 'msg2') })
    await agent.fireHooks('MessageAddedEvent', { agent, message: msg('assistant', 'msg3') })

    expect((plugin as any).batcher.size).toBe(1)

    isFirstBatch = false
    const afterPromise = agent.fireHooks('AfterInvocationEvent', { agent })
    resolveSlow()
    await afterPromise

    const calls = mockCreateEvent.mock.calls.length
    const remaining = (plugin as any).batcher.size
    console.log(`createEvent calls: ${calls}; buffer remaining: ${remaining}`)
    expect(calls).toBe(3)
    expect(remaining).toBe(0)
  })
})

describe('CONCERN 3: timer cleared when batchSize flush triggers', () => {
  it('timer is cleared, not left running to fire on empty buffer', async () => {
    vi.useFakeTimers()
    try {
      const plugin = new AgentCoreMemory({ ...BASE, extraction: { batchSize: 2, batchTimeoutMs: 5000 } })
      const agent = createMockAgent()
      plugin.initAgent(agent as any)

      await agent.fireHooks('MessageAddedEvent', { agent, message: msg('user', 'msg1') })
      expect((plugin as any).batcher.flushTimer).toBeDefined()

      await agent.fireHooks('MessageAddedEvent', { agent, message: msg('user', 'msg2') })
      await vi.advanceTimersByTimeAsync(0)

      expect((plugin as any).batcher.flushTimer).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('CONCERN 4: tool/reasoning/empty messages produce zero API calls', () => {
  it('empty content array → no createEvent', async () => {
    const plugin = new AgentCoreMemory({ ...BASE, extraction: true })
    const agent = createMockAgent()
    plugin.initAgent(agent as any)

    await agent.fireHooks('MessageAddedEvent', { agent, message: { role: 'assistant', content: [] } })
    await agent.fireHooks('AfterInvocationEvent', { agent })

    expect(mockCreateEvent).toHaveBeenCalledTimes(0)
  })

  it('tool_use + reasoning blocks → no createEvent', async () => {
    const plugin = new AgentCoreMemory({ ...BASE, extraction: true })
    const agent = createMockAgent()
    plugin.initAgent(agent as any)

    const toolMsg = {
      role: 'assistant',
      content: [
        { type: 'reasoningBlock', text: 'Let me think...' },
        { type: 'toolUseBlock', name: 'search', input: { query: 'x' } },
      ],
    }
    await agent.fireHooks('MessageAddedEvent', { agent, message: toolMsg })
    await agent.fireHooks('AfterInvocationEvent', { agent })

    expect(mockCreateEvent).toHaveBeenCalledTimes(0)
  })
})

describe('CONCERN 5: namespace template resolution', () => {
  it('{actorId} resolves at construct time', async () => {
    const plugin = new AgentCoreMemory({
      ...BASE,
      actorId: 'real-actor-123',
      injection: { namespaces: { '/users/{actorId}/facts': { topK: 5 } } },
    })
    const agent = createMockAgent()
    agent.messages = [msg('user', 'hello')]
    plugin.initAgent(agent as any)

    await agent.fireHooks('BeforeInvocationEvent', { agent })

    const ns = mockRetrieveMemoryRecords.mock.calls[0]?.[0]?.namespace
    expect(ns).toBe('/users/real-actor-123/facts')
  })

  it('withActor() forks re-resolve template', async () => {
    const base = new AgentCoreMemory({
      ...BASE,
      actorId: 'alice',
      injection: { namespaces: { '/users/{actorId}/facts': {} } },
    })
    const forked = base.withActor('bob')
    const agent = createMockAgent()
    agent.messages = [msg('user', 'hi')]
    forked.initAgent(agent as any)

    await agent.fireHooks('BeforeInvocationEvent', { agent })
    const ns = mockRetrieveMemoryRecords.mock.calls[0]?.[0]?.namespace
    expect(ns).toBe('/users/bob/facts')
  })
})

describe('CONCERN 6: validation throws on invalid config', () => {
  it.each([
    ['batchSize: 0', { batchSize: 0 }],
    ['batchSize: -1', { batchSize: -1 }],
    ['batchSize: NaN', { batchSize: NaN }],
    ['batchSize: Infinity', { batchSize: Infinity }],
    ['batchSize: 1.5 (non-integer)', { batchSize: 1.5 }],
    ['batchTimeoutMs: -100', { batchTimeoutMs: -100 }],
    ['flushTimeoutMs: 0', { flushTimeoutMs: 0 }],
    ['maxDrainIterations: 0', { maxDrainIterations: 0 }],
  ])('throws TypeError for %s', (_name, cfg: any) => {
    expect(() => new AgentCoreMemory({ ...BASE, extraction: cfg })).toThrow(TypeError)
  })
})

describe('CONCERN 7: lifecycle APIs exist and work', () => {
  it('flush() drains buffered messages', async () => {
    const plugin = new AgentCoreMemory({
      ...BASE,
      extraction: { batchSize: 100, batchTimeoutMs: 60000 },
    })
    const agent = createMockAgent()
    plugin.initAgent(agent as any)

    await agent.fireHooks('MessageAddedEvent', { agent, message: msg('user', 'hello') })
    expect(mockCreateEvent).toHaveBeenCalledTimes(0)

    await plugin.flush()
    expect(mockCreateEvent).toHaveBeenCalledTimes(1)
  })

  it('shutdown() makes plugin inert', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const plugin = new AgentCoreMemory({ ...BASE, extraction: true })
    const agent = createMockAgent()
    plugin.initAgent(agent as any)

    await plugin.shutdown()
    await agent.fireHooks('MessageAddedEvent', { agent, message: msg('user', 'after-shutdown') })
    await agent.fireHooks('AfterInvocationEvent', { agent })

    expect(mockCreateEvent).toHaveBeenCalledTimes(0)
  })
})
