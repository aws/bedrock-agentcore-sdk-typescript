import { describe, expect, it, vi } from 'vitest'
import type { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore'
import { createAgentCoreMemoryStores, assertWritableTopology } from '../factory.js'
import type { CreateAgentCoreMemoryStoresInput } from '../factory.js'
import { AgentCoreMemoryStore } from '../store.js'
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

  it('marks the namespace flagged `writable: true` as the writer (not just the first)', () => {
    const stores = createAgentCoreMemoryStores(
      baseInput({
        namespaces: [
          { namespace: '/strategy/s/actor/{actorId}/facts' },
          { namespace: '/strategy/s/actor/{actorId}/preferences', writable: true },
        ],
        extraction: { cadence: new FakeTrigger() },
      })
    )
    const writable = stores.filter((s) => s.writable)
    expect(writable).toHaveLength(1)
    expect(writable[0]!.name).toBe('strategy-s-actor-preferences')
  })

  it('honors an explicit writable:false — picks the next un-opted-out namespace as the default writer', () => {
    const stores = createAgentCoreMemoryStores(
      baseInput({
        namespaces: [
          { namespace: '/strategy/s/actor/{actorId}/facts', writable: false },
          { namespace: '/strategy/s/actor/{actorId}/preferences' },
        ],
        extraction: true,
      })
    )
    const writable = stores.filter((s) => s.writable)
    expect(writable).toHaveLength(1)
    expect(writable[0]!.name).toBe('strategy-s-actor-preferences') // NOT the opted-out first one
  })

  it('throws when extraction is on but every namespace opts out with writable:false', () => {
    expect(() =>
      createAgentCoreMemoryStores(
        baseInput({
          namespaces: [
            { namespace: '/a/{actorId}', writable: false },
            { namespace: '/b/{actorId}', writable: false },
          ],
          extraction: true,
        })
      )
    ).toThrow(/every namespace is marked writable: false/)
  })

  it('throws when two namespaces are flagged writable (namespace-free createEvent would duplicate)', () => {
    expect(() =>
      createAgentCoreMemoryStores(
        baseInput({
          namespaces: [
            { namespace: '/a/{actorId}', writable: true },
            { namespace: '/b/{actorId}', writable: true },
          ],
        })
      )
    ).toThrow(/at most one store may be writable/)
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
    // Passed straight through as `true`, not eagerly wrapped in a trigger — the MemoryManager resolves
    // its own default (IntervalTrigger) itself.
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
  it('returns a single writable store reading the explicit parentNamespace', () => {
    const stores = createAgentCoreMemoryStores(
      baseInput({ readMode: 'subtree', parentNamespace: '/strategy/s/actor/{actorId}' })
    )
    expect(stores).toHaveLength(1)
    expect(stores[0]!.writable).toBe(true)
    expect(stores[0]!.extraction).toBeDefined()
  })

  it('throws when subtree mode is used without an explicit parentNamespace', () => {
    expect(() => createAgentCoreMemoryStores(baseInput({ readMode: 'subtree' }))).toThrow(
      /subtree readMode requires an explicit parentNamespace/
    )
  })
})

describe('createAgentCoreMemoryStores - validation', () => {
  it('throws when no namespaces are provided', () => {
    expect(() => createAgentCoreMemoryStores(baseInput({ namespaces: [] }))).toThrow(/at least one namespace/)
  })

  it('throws when a namespace entry is empty/whitespace', () => {
    expect(() => createAgentCoreMemoryStores(baseInput({ namespaces: [{ namespace: '   ' }] }))).toThrow(
      /namespaces\[0\]\.namespace must be a non-empty/
    )
  })

  it.each([
    ['empty actorId', { actorId: '' }],
    ['empty sessionId', { sessionId: '  ' }],
    ['empty memoryId', { memoryId: '' }],
  ])('throws on %s (propagated from the store constructor)', (_label, override) => {
    expect(() => createAgentCoreMemoryStores(baseInput(override))).toThrow(/must be a non-empty string/)
  })

  it('throws when a namespace still has an unresolved placeholder after substitution', () => {
    expect(() =>
      createAgentCoreMemoryStores(
        baseInput({ namespaces: [{ namespace: '/strategies/{memoryStrategyId}/actors/{actorId}' }] })
      )
    ).toThrow(/\{memoryStrategyId\}/)
  })

  it('subtree parentNamespace with an unresolved placeholder surfaces it loudly at construction', () => {
    // After {actorId} resolves, {memoryStrategyId} remains in the parent path -> the store constructor
    // throws rather than querying a brace string the service would reject.
    expect(() =>
      createAgentCoreMemoryStores(
        baseInput({
          readMode: 'subtree',
          parentNamespace: '/strategies/{memoryStrategyId}/actors/{actorId}',
        })
      )
    ).toThrow(/\{memoryStrategyId\}/)
  })

  it('binds actorId/sessionId so a multi-actor server gets distinct stores per call', () => {
    const a = createAgentCoreMemoryStores(baseInput({ actorId: 'user-A' }))
    const b = createAgentCoreMemoryStores(baseInput({ actorId: 'user-B' }))
    // Distinct instances; behavior verified via search namespace resolution elsewhere.
    expect(a[0]).not.toBe(b[0])
  })
})

describe('assertWritableTopology', () => {
  const store = (overrides: { writable?: boolean; name?: string } = {}): AgentCoreMemoryStore =>
    new AgentCoreMemoryStore({
      memoryId: 'mem-1',
      actorId: 'actor-1',
      sessionId: 'sess-1',
      client: fakeClient,
      namespace: '/users/{actorId}/facts',
      name: overrides.name ?? 'facts',
      ...(overrides.writable !== undefined && { writable: overrides.writable }),
    })

  it('accepts zero writable stores (recall-only)', () => {
    expect(() => assertWritableTopology([store(), store({ name: 'prefs' })])).not.toThrow()
  })

  it('accepts exactly one writable store', () => {
    expect(() => assertWritableTopology([store({ writable: true }), store({ name: 'prefs' })])).not.toThrow()
  })

  it('throws on more than one writable store', () => {
    expect(() =>
      assertWritableTopology([store({ writable: true, name: 'a' }), store({ writable: true, name: 'b' })])
    ).toThrow(/at most one store may be writable/)
  })

  it('throws when extraction is expected but no store is writable', () => {
    expect(() => assertWritableTopology([store()], true)).toThrow(/no store is writable/)
  })

  it('does not require a writer when extraction is not expected', () => {
    expect(() => assertWritableTopology([store()], false)).not.toThrow()
  })
})
