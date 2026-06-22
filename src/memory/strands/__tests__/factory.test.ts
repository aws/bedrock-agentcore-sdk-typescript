import { describe, expect, it, vi } from 'vitest'
import type { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore'
import { createAgentCoreMemoryStores, createAgentCoreMemoryStore } from '../factory.js'
import type { CreateAgentCoreMemoryStoresInput } from '../factory.js'
import { ExtractionTrigger, type ExtractionTriggerContext, type MemoryContentBlockType } from '@strands-agents/sdk'

const fakeClient = { send: vi.fn(async () => ({})) } as unknown as BedrockAgentCoreClient

class FakeTrigger extends ExtractionTrigger {
  readonly name = 'fake'
  attach(_context: ExtractionTriggerContext): void {}
}

const baseInput = (overrides: Partial<CreateAgentCoreMemoryStoresInput> = {}): CreateAgentCoreMemoryStoresInput => ({
  memoryId: 'mem-1',
  actorId: 'actor-1',
  sessionId: 'sess-1',
  namespaces: [
    { namespace: '/strategy/s/actor/{actorId}/facts' },
    { namespace: '/strategy/s/actor/{actorId}/preferences' },
  ],
  extraction: { cadence: new FakeTrigger() },
  client: fakeClient,
  ...overrides,
})

describe('createAgentCoreMemoryStores - per-namespace (default)', () => {
  it('returns one store per namespace', () => {
    const stores = createAgentCoreMemoryStores(baseInput())
    expect(stores).toHaveLength(2)
  })

  it('marks exactly one store writable (the first namespace by default)', () => {
    const stores = createAgentCoreMemoryStores(baseInput())
    const writable = stores.filter((s) => s.writable)
    expect(writable).toHaveLength(1)
    expect(writable[0]!.name).toBe('strategy-s-actor-facts')
  })

  it('only the writable store carries extraction', () => {
    const stores = createAgentCoreMemoryStores(baseInput())
    expect(stores.find((s) => s.writable)!.extraction).toBeDefined()
    expect(stores.find((s) => !s.writable)!.extraction).toBeUndefined()
  })

  it('a custom cadence becomes an ExtractionConfig with that trigger', () => {
    const trigger = new FakeTrigger()
    const stores = createAgentCoreMemoryStores(baseInput({ extraction: { cadence: trigger } }))
    const writable = stores.find((s) => s.writable)!
    expect(writable.extraction).toEqual({ trigger })
  })

  it('threads the extraction filter through to the writable store', () => {
    const filter = { exclude: ['toolUse', 'toolResult', 'image'] satisfies MemoryContentBlockType[] }
    const stores = createAgentCoreMemoryStores(baseInput({ extraction: { cadence: new FakeTrigger(), filter } }))
    const writable = stores.find((s) => s.writable)!
    expect(writable.extraction).toMatchObject({ filter })
  })

  it('honors an explicit extraction.namespace', () => {
    const stores = createAgentCoreMemoryStores(
      baseInput({ extraction: { cadence: new FakeTrigger(), namespace: '/strategy/s/actor/{actorId}/preferences' } })
    )
    expect(stores.find((s) => s.writable)!.name).toBe('strategy-s-actor-preferences')
  })

  it('throws if extraction.namespace matches nothing', () => {
    expect(() =>
      createAgentCoreMemoryStores(baseInput({ extraction: { cadence: new FakeTrigger(), namespace: '/nope' } }))
    ).toThrow(/did not match/)
  })

  it('recall-only: no store is writable when extraction is omitted', () => {
    const { extraction: _omit, ...recallOnly } = baseInput()
    const stores = createAgentCoreMemoryStores(recallOnly)
    expect(stores).toHaveLength(2)
    expect(stores.every((s) => !s.writable)).toBe(true)
    expect(stores.every((s) => s.extraction === undefined)).toBe(true)
  })

  it('recall-only: extraction: false is also recall-only', () => {
    const stores = createAgentCoreMemoryStores(baseInput({ extraction: false }))
    expect(stores.every((s) => !s.writable)).toBe(true)
  })

  it('extraction: true passes the boolean through (MemoryManager applies its default cadence)', () => {
    const stores = createAgentCoreMemoryStores(baseInput({ extraction: true }))
    const writable = stores.filter((s) => s.writable)
    expect(writable).toHaveLength(1)
    // Passed straight through as `true`, not eagerly wrapped in an AgentCoreBatchTrigger — the MM
    // resolves the default trigger itself.
    expect(writable[0]!.extraction).toBe(true)
  })

  it('derives unique names and respects explicit names', () => {
    const stores = createAgentCoreMemoryStores(
      baseInput({
        namespaces: [
          { namespace: '/a/{actorId}', name: 'alpha' },
          { namespace: '/b/{actorId}', name: 'beta' },
        ],
      })
    )
    expect(stores.map((s) => s.name)).toEqual(['alpha', 'beta'])
  })

  it('falls back to a default name when a namespace slug would be empty', () => {
    const stores = createAgentCoreMemoryStores(baseInput({ namespaces: [{ namespace: '{actorId}' }] }))
    expect(stores[0]!.name).toBe('agentcore-memory')
  })

  // Store-name uniqueness is enforced by the MemoryManager constructor, not the factory, so the
  // factory no longer throws on duplicates (deferred per review).
})

describe('createAgentCoreMemoryStores - subtree', () => {
  it('returns a single writable store reading the common parent', () => {
    const stores = createAgentCoreMemoryStores(baseInput({ readMode: 'subtree' }))
    expect(stores).toHaveLength(1)
    expect(stores[0]!.writable).toBe(true)
    expect(stores[0]!.extraction).toBeDefined()
  })

  it('uses an explicit parentNamespace when given', () => {
    const stores = createAgentCoreMemoryStores(
      baseInput({ readMode: 'subtree', parentNamespace: '/strategy/s/actor/{actorId}' })
    )
    expect(stores).toHaveLength(1)
  })

  it('throws when namespaces share no common parent and none is given', () => {
    expect(() =>
      createAgentCoreMemoryStores(
        baseInput({
          readMode: 'subtree',
          namespaces: [{ namespace: 'alpha/x' }, { namespace: 'beta/y' }],
        })
      )
    ).toThrow(/common parent/)
  })
})

describe('createAgentCoreMemoryStore (singular)', () => {
  it('returns a single store for one namespace', () => {
    const store = createAgentCoreMemoryStore({
      memoryId: 'mem-1',
      actorId: 'actor-1',
      sessionId: 'sess-1',
      namespace: '/users/{actorId}/facts',
      extraction: { cadence: new FakeTrigger() },
      client: fakeClient,
    })
    expect(store.name).toBe('users-facts')
    expect(store.writable).toBe(true)
    expect(store.extraction).toBeDefined()
  })

  it('is recall-only when extraction is omitted', () => {
    const store = createAgentCoreMemoryStore({
      memoryId: 'mem-1',
      actorId: 'actor-1',
      sessionId: 'sess-1',
      namespace: '/users/{actorId}/facts',
      client: fakeClient,
    })
    expect(store.writable).toBe(false)
    expect(store.extraction).toBeUndefined()
  })

  it('honors an explicit name', () => {
    const store = createAgentCoreMemoryStore({
      memoryId: 'mem-1',
      actorId: 'actor-1',
      sessionId: 'sess-1',
      namespace: '/users/{actorId}/facts',
      name: 'facts',
      client: fakeClient,
    })
    expect(store.name).toBe('facts')
  })
})

describe('createAgentCoreMemoryStores - validation', () => {
  it('throws when no namespaces are provided', () => {
    expect(() => createAgentCoreMemoryStores(baseInput({ namespaces: [] }))).toThrow(/at least one namespace/)
  })

  it('binds actorId/sessionId so a multi-actor server gets distinct stores per call', () => {
    const a = createAgentCoreMemoryStores(baseInput({ actorId: 'user-A' }))
    const b = createAgentCoreMemoryStores(baseInput({ actorId: 'user-B' }))
    // Distinct instances; behavior verified via search namespace resolution elsewhere.
    expect(a[0]).not.toBe(b[0])
  })
})
