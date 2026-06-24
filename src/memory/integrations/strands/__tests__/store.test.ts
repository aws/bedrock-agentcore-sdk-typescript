import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore'
import { AgentCoreMemoryStore } from '../store.js'
import { logger } from '../logger.js'
import { RESERVED_METADATA_PREFIX, type AgentCoreMemoryConfig, type AgentCoreMemoryStoreConfig } from '../types.js'
import type { MessageData } from '@strands-agents/sdk'

interface CapturedCommand {
  constructor: { name: string }
  input: Record<string, unknown>
}

/** A `send` spy: a vitest mock or a plain async fn. Loosely typed so vi.fn() assigns cleanly. */
type SendFn = ((command: CapturedCommand) => Promise<unknown>) | ReturnType<typeof vi.fn>

function fakeClient(send: SendFn): BedrockAgentCoreClient {
  return { send } as unknown as BedrockAgentCoreClient
}

function record(id: string, text: string, score?: number, namespaces: string[] = ['/ns/a']) {
  return { memoryRecordId: id, content: { text }, score, namespaces, memoryStrategyId: 'strat', createdAt: new Date() }
}

const userMsg = (text: string): MessageData => ({ role: 'user', content: [{ text }] })

/**
 * Override shape for tests: every store-config field optional, plus the read target expressed as either
 * `namespace` (exact) or `namespacePath` (subtree). `baseConfig` defaults to the exact arm.
 */
type ConfigOverrides = Partial<Omit<AgentCoreMemoryStoreConfig, 'namespace' | 'namespacePath'>> & {
  namespace?: string
  namespacePath?: string
}

const baseConfig = (send: SendFn, overrides: ConfigOverrides = {}): AgentCoreMemoryStoreConfig => {
  const { namespace, namespacePath, ...rest } = overrides
  const readTarget =
    namespacePath !== undefined
      ? { namespacePath }
      : { namespace: namespace ?? '/strategy/s/actor/{actorId}/preferences' }
  return {
    memoryId: 'mem-1',
    actorId: 'actor-1',
    sessionId: 'sess-1',
    client: fakeClient(send),
    name: 'prefs',
    writable: false,
    ...readTarget,
    ...rest,
  } as AgentCoreMemoryStoreConfig
}

describe('AgentCoreMemoryStore.search', () => {
  let lastInput: Record<string, unknown>
  let send: ReturnType<typeof vi.fn>

  const sendReturning = (summaries: unknown[]) =>
    vi.fn(async (command: CapturedCommand) => {
      lastInput = command.input
      return { memoryRecordSummaries: summaries }
    })

  beforeEach(() => {
    lastInput = {}
  })

  it('resolves {actorId} in the namespace and queries via `namespace` for exact (per-namespace) mode', async () => {
    send = sendReturning([record('1', 'a')])
    const store = new AgentCoreMemoryStore(baseConfig(send))
    await store.search('q')
    expect(lastInput.namespace).toBe('/strategy/s/actor/actor-1/preferences')
    expect(lastInput.namespacePath).toBeUndefined()
  })

  it('queries via `namespacePath` for subtree mode', async () => {
    send = sendReturning([record('1', 'a')])
    const store = new AgentCoreMemoryStore(baseConfig(send, { namespacePath: '/strategy/s/actor/{actorId}' }))
    await store.search('q')
    expect(lastInput.namespacePath).toBe('/strategy/s/actor/actor-1')
    expect(lastInput.namespace).toBeUndefined()
  })

  it('maps MemoryRecordSummary -> MemoryEntry (content.text, underscored id/score/namespaces/createdAt)', async () => {
    const createdAt = new Date('2026-01-02T03:04:05.000Z')
    send = sendReturning([
      { memoryRecordId: 'rec-9', content: { text: 'dark mode' }, score: 0.8, namespaces: ['/ns/x'], createdAt },
    ])
    const store = new AgentCoreMemoryStore(baseConfig(send))
    const results = await store.search('q')
    expect(results).toEqual([
      {
        content: 'dark mode',
        metadata: {
          _id: 'rec-9',
          _score: 0.8,
          _namespaces: ['/ns/x'],
          _createdAt: '2026-01-02T03:04:05.000Z',
        },
      },
    ])
    // Every store-provided key carries the documented reserved prefix (collision-avoidance contract).
    expect(Object.keys(results[0]!.metadata!).every((k) => k.startsWith(RESERVED_METADATA_PREFIX))).toBe(true)
  })

  it('passes topK = want when no minScore floor', async () => {
    send = sendReturning([])
    const store = new AgentCoreMemoryStore(baseConfig(send, { maxSearchResults: 3 }))
    await store.search('q')
    expect((lastInput.searchCriteria as { topK: number }).topK).toBe(3)
  })

  it('over-fetches topK when a minScore floor is set, and trims to want after filtering', async () => {
    // 5 records, 3 below floor; want=2; over-fetch grabs more, filter keeps >=0.5, trim to 2.
    const recs = [
      record('1', 'a', 0.9),
      record('2', 'b', 0.1),
      record('3', 'c', 0.7),
      record('4', 'd', 0.2),
      record('5', 'e', 0.6),
    ]
    send = sendReturning(recs)
    const store = new AgentCoreMemoryStore(baseConfig(send, { maxSearchResults: 2, minScore: 0.5 }))
    const results = await store.search('q')
    expect((lastInput.searchCriteria as { topK: number }).topK).toBeGreaterThan(2) // over-fetched
    expect(results.map((r) => r.content)).toEqual(['a', 'c']) // top-2 above floor, in order
  })

  it('honors a custom overFetchFactor for topK (default is 4)', async () => {
    send = sendReturning([])
    const store = new AgentCoreMemoryStore(
      baseConfig(send, { maxSearchResults: 3, minScore: 0.5, overFetchFactor: 10 })
    )
    await store.search('q')
    expect((lastInput.searchCriteria as { topK: number }).topK).toBe(30) // want(3) * overFetchFactor(10)
  })

  it('ignores overFetchFactor when no minScore floor is set (topK == want)', async () => {
    send = sendReturning([])
    const store = new AgentCoreMemoryStore(baseConfig(send, { maxSearchResults: 3, overFetchFactor: 10 }))
    await store.search('q')
    expect((lastInput.searchCriteria as { topK: number }).topK).toBe(3)
  })

  it('ceils a fractional overFetchFactor so topK stays an integer (the service requires int)', async () => {
    send = sendReturning([])
    const store = new AgentCoreMemoryStore(
      baseConfig(send, { maxSearchResults: 5, minScore: 0.5, overFetchFactor: 1.5 })
    )
    await store.search('q')
    const topK = (lastInput.searchCriteria as { topK: number }).topK
    expect(topK).toBe(8) // ceil(5 * 1.5) = ceil(7.5)
    expect(Number.isInteger(topK)).toBe(true)
  })

  it('drops unscored records under a positive floor (score undefined treated as 0)', async () => {
    send = sendReturning([record('1', 'scored', 0.9), record('2', 'unscored', undefined)])
    const store = new AgentCoreMemoryStore(baseConfig(send, { minScore: 0.5 }))
    const results = await store.search('q')
    expect(results.map((r) => r.content)).toEqual(['scored'])
  })

  it('maps a non-text MemoryContent member to empty content', async () => {
    send = sendReturning([
      {
        memoryRecordId: 'x',
        content: { $unknown: ['blob', {}] },
        score: 0.9,
        namespaces: [],
        memoryStrategyId: 's',
        createdAt: new Date(),
      },
    ])
    const store = new AgentCoreMemoryStore(baseConfig(send))
    const results = await store.search('q')
    expect(results[0]!.content).toBe('')
  })

  it('returns [] on empty results', async () => {
    send = vi.fn(async () => ({ memoryRecordSummaries: undefined }))
    const store = new AgentCoreMemoryStore(baseConfig(send))
    expect(await store.search('q')).toEqual([])
  })

  it('propagates retrieve errors (MemoryManager isolates them via allSettled)', async () => {
    send = vi.fn(async () => {
      throw new Error('throttled')
    })
    const store = new AgentCoreMemoryStore(baseConfig(send))
    await expect(store.search('q')).rejects.toThrow('throttled')
  })
})

describe('AgentCoreMemoryStore.addMessages', () => {
  it('writable store sends events through the sender', async () => {
    const sent: CapturedCommand[] = []
    const send = vi.fn(async (command: CapturedCommand) => {
      sent.push(command)
      return {}
    })
    const store = new AgentCoreMemoryStore(baseConfig(send, { writable: true }))
    await store.addMessages([userMsg('remember this')])
    expect(sent).toHaveLength(1)
    expect(sent[0]!.input).toMatchObject({
      payload: [{ conversational: { role: 'USER', content: { text: 'remember this' } } }],
    })
  })

  it('forwards context.sequenceNumbers to the sender (deterministic token path)', async () => {
    const sent: CapturedCommand[] = []
    const send = vi.fn(async (command: CapturedCommand) => {
      sent.push(command)
      return {}
    })
    const store = new AgentCoreMemoryStore(baseConfig(send, { writable: true }))
    await store.addMessages([userMsg('x')], { sequenceNumbers: [42] })
    // One event; token anchors on a per-sender run id (a UUID), not sessionId, spanning [firstSeq,lastSeq].
    expect(sent[0]!.input.clientToken).toMatch(/^mem-1-actor-1-[0-9a-f-]{36}-42-42$/)
  })

  it('batches a multi-message turn into a single createEvent', async () => {
    const sent: CapturedCommand[] = []
    const send = vi.fn(async (command: CapturedCommand) => {
      sent.push(command)
      return {}
    })
    const store = new AgentCoreMemoryStore(baseConfig(send, { writable: true }))
    await store.addMessages([userMsg('first'), { role: 'assistant', content: [{ text: 'second' }] }], {
      sequenceNumbers: [0, 1],
    })
    expect(send).toHaveBeenCalledTimes(1)
    expect((sent[0]!.input.payload as unknown[]).length).toBe(2)
  })

  it('throws if addMessages is called on a non-writable store', async () => {
    const send = vi.fn(async () => ({}))
    const store = new AgentCoreMemoryStore(baseConfig(send, { writable: false }))
    await expect(store.addMessages([userMsg('x')])).rejects.toThrow(/not writable/)
  })
})

describe('AgentCoreMemoryStore construction', () => {
  it('only a writable store carries extraction', () => {
    const send = vi.fn(async () => ({}))
    const trigger = { name: 't', attach: () => {} }
    const writable = new AgentCoreMemoryStore(baseConfig(send, { writable: true, extraction: { trigger } }))
    const readonly = new AgentCoreMemoryStore(baseConfig(send, { writable: false, extraction: { trigger } }))
    expect(writable.extraction).toBeDefined()
    expect(readonly.extraction).toBeUndefined()
  })

  it('warns when extraction is set on a non-writable store (so it is not silently dropped)', () => {
    const send = vi.fn(async () => ({}))
    const trigger = { name: 't', attach: () => {} }
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    new AgentCoreMemoryStore(baseConfig(send, { writable: false, extraction: { trigger } }))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('writable is false'))
    warn.mockRestore()
  })

  it('does not warn for a recall-only store with no extraction', () => {
    const send = vi.fn(async () => ({}))
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    new AgentCoreMemoryStore(baseConfig(send, { writable: false }))
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('self-names from the namespace template when no name is given', () => {
    const send = vi.fn(async () => ({}))
    const { name: _drop, ...noName } = baseConfig(send, { namespace: '/users/{actorId}/facts' })
    const store = new AgentCoreMemoryStore(noName as AgentCoreMemoryStoreConfig)
    expect(store.name).toBe('users-facts')
  })

  it('defaults writable to false (recall-safe) when omitted', () => {
    const send = vi.fn(async () => ({}))
    const { writable: _drop, ...noWritable } = baseConfig(send)
    const store = new AgentCoreMemoryStore(noWritable as AgentCoreMemoryStoreConfig)
    expect(store.writable).toBe(false)
  })

  it('stands alone with flat identity (no factory needed)', async () => {
    const sent: CapturedCommand[] = []
    const send = vi.fn(async (command: CapturedCommand) => {
      sent.push(command)
      return {}
    })
    // The whole point of the refactor: a usable store from flat identity + namespace, no factory.
    const store = new AgentCoreMemoryStore({
      memoryId: 'mem-1',
      actorId: 'actor-1',
      sessionId: 'sess-1',
      client: fakeClient(send),
      namespace: '/users/{actorId}/facts',
      writable: true,
      extraction: true,
    })
    expect(store.name).toBe('users-facts')
    expect(store.writable).toBe(true)
    expect(store.extraction).toBe(true)
    await store.addMessages([userMsg('hi')])
    expect(sent).toHaveLength(1)
    expect(sent[0]!.input).toMatchObject({ memoryId: 'mem-1', actorId: 'actor-1', sessionId: 'sess-1' })
  })

  it('flat identity validates missing ids with a clear error', () => {
    const send = vi.fn(async () => ({}))
    expect(
      () =>
        new AgentCoreMemoryStore({
          memoryId: '',
          actorId: 'actor-1',
          sessionId: 'sess-1',
          client: fakeClient(send),
          namespace: '/users/{actorId}/facts',
        })
    ).toThrow(/memoryId must be a non-empty/)
  })
})

describe('AgentCoreMemoryStore validation', () => {
  const send = vi.fn(async () => ({}))
  const cfg = (overrides: ConfigOverrides = {}, identity: Partial<AgentCoreMemoryConfig> = {}) =>
    baseConfig(send, { ...identity, ...overrides })

  it.each([
    ['memoryId', { memoryId: '' }],
    ['actorId', { actorId: '   ' }],
    ['sessionId', { sessionId: '' }],
  ] as const)('throws on empty/whitespace %s', (field, identity) => {
    expect(() => new AgentCoreMemoryStore(cfg({}, identity))).toThrow(new RegExp(`${field} must be a non-empty`))
  })

  it('throws on an empty namespace', () => {
    expect(() => new AgentCoreMemoryStore(cfg({ namespace: '   ' }))).toThrow(/namespace must be a non-empty/)
  })

  it('throws when the resolved namespace still contains an unresolved placeholder', () => {
    // {memoryStrategyId} is not resolved client-side; the AgentCore read path rejects "{"/"}".
    expect(
      () => new AgentCoreMemoryStore(cfg({ namespace: '/strategies/{memoryStrategyId}/actors/{actorId}/facts' }))
    ).toThrow(/unresolved placeholder "\{memoryStrategyId\}"/)
  })

  it('accepts a namespace whose only placeholders are {actorId}/{sessionId}', () => {
    expect(() => new AgentCoreMemoryStore(cfg({ namespace: '/users/{actorId}/facts' }))).not.toThrow()
  })

  it.each([NaN, -0.1, 1.5, Infinity])('throws on invalid minScore %s', (minScore) => {
    expect(() => new AgentCoreMemoryStore(cfg({ minScore }))).toThrow(
      /minScore must be a finite number between 0 and 1/
    )
  })

  it.each([0, -1, 2.5])('throws on maxSearchResults %s', (maxSearchResults) => {
    expect(() => new AgentCoreMemoryStore(cfg({ maxSearchResults }))).toThrow(
      /maxSearchResults must be a positive integer/
    )
  })

  it.each([0, 0.5, NaN, Infinity])('throws on invalid overFetchFactor %s', (overFetchFactor) => {
    expect(() => new AgentCoreMemoryStore(cfg({ overFetchFactor }))).toThrow(/overFetchFactor must be a number >= 1/)
  })
})
