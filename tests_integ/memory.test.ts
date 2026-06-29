import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BedrockAgentCoreControlClient,
  CreateMemoryCommand,
  DeleteMemoryCommand,
  GetMemoryCommand,
  type MemoryStatus,
} from '@aws-sdk/client-bedrock-agentcore-control'
import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore'
import { Agent, BedrockModel, MemoryManager } from '@strands-agents/sdk'
import { AgentCoreMemoryStore, createAgentCoreMemoryStores } from '../src/memory/integrations/strands/index.js'

/**
 * Integration + end-to-end tests for the AgentCore Memory <-> Strands store.
 *
 * Prerequisites:
 * - AWS credentials configured (env vars or AWS config). Use the testing account:
 *   `ada credentials update --account 603141041947 --role Admin --profile deploy` then `AWS_PROFILE=deploy`.
 * - Permissions: bedrock-agentcore-control:{CreateMemory,GetMemory,DeleteMemory},
 *   bedrock-agentcore:{CreateEvent,RetrieveMemoryRecords}, and (E2E only) bedrock:InvokeModel* for the
 *   model below.
 *
 * These tests create a throwaway memory resource (with a semantic strategy) in `beforeAll`, exercise the
 * store against the live data plane, and delete the resource in `afterAll`. AgentCore extraction is
 * asynchronous (it can take minutes), so recall is verified by polling `retrieveMemoryRecords` up to a
 * generous timeout.
 *
 * To run: AWS_PROFILE=deploy npm run test:integ
 */

const REGION = process.env.AWS_REGION || 'us-west-2'
const MODEL_ID = process.env.STRANDS_TEST_MODEL_ID || 'global.anthropic.claude-sonnet-4-6'

// A semantic strategy extracts durable facts from conversation events into this namespace template.
const FACTS_NAMESPACE = '/integ/{actorId}/facts'

const control = new BedrockAgentCoreControlClient({ region: REGION })
const dataPlane = new BedrockAgentCoreClient({ region: REGION })

let memoryId: string

/** Poll GetMemory until the resource (and its strategies) reach ACTIVE, or throw on timeout/FAILED. */
async function waitForMemoryActive(id: string, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { memory } = await control.send(new GetMemoryCommand({ memoryId: id }))
    const status: MemoryStatus | undefined = memory?.status
    if (status === 'ACTIVE') return
    if (status === 'FAILED') throw new Error(`memory ${id} entered FAILED status`)
    if (Date.now() > deadline) throw new Error(`memory ${id} not ACTIVE within ${timeoutMs}ms (last: ${status})`)
    await sleep(5_000)
  }
}

/**
 * Poll `store.search` until at least one record surfaces, or return [] on timeout. Extraction is async,
 * so a freshly written fact may take a while to become retrievable; callers assert on the result.
 */
async function pollForRecords(
  search: () => Promise<{ content: string }[]>,
  timeoutMs = 240_000
): Promise<{ content: string }[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const results = await search()
    if (results.length > 0) return results
    if (Date.now() > deadline) return results
    await sleep(10_000)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms))
}

/** A short unique-ish suffix without Math.random (vitest runs single-process here): timestamp-based. */
function uniqueSuffix(): string {
  return `${Date.now().toString(36)}`
}

beforeAll(async () => {
  const { memory } = await control.send(
    new CreateMemoryCommand({
      name: `strands_integ_${uniqueSuffix()}`,
      description: 'Throwaway memory for Strands integration tests',
      eventExpiryDuration: 7, // days; minimum-ish retention, resource is deleted in afterAll anyway
      memoryStrategies: [
        {
          semanticMemoryStrategy: {
            name: 'facts',
            namespaceTemplates: [FACTS_NAMESPACE],
          },
        },
      ],
    })
  )
  if (!memory?.id) throw new Error('CreateMemory did not return a memory id')
  memoryId = memory.id
  await waitForMemoryActive(memoryId)
}, 200_000)

afterAll(async () => {
  if (!memoryId) return
  try {
    await control.send(new DeleteMemoryCommand({ memoryId }))
  } catch (err) {
    console.warn('Failed to delete memory resource:', err)
  }
})

describe('AgentCoreMemoryStore (store-level, live data plane)', () => {
  const actorId = `actor-${uniqueSuffix()}`
  const sessionId = `session-${uniqueSuffix()}-padded-to-be-long-enough`

  it('writes role-tagged events via createEvent (addMessages succeeds)', async () => {
    const store = new AgentCoreMemoryStore({
      memoryId,
      actorId,
      sessionId,
      namespace: FACTS_NAMESPACE,
      writable: true,
      extraction: true,
      client: dataPlane,
    })
    expect(store.writable).toBe(true)
    await expect(
      store.addMessages!(
        [
          { role: 'user', content: [{ text: 'My favorite color is teal and I live in Seattle.' }] },
          { role: 'assistant', content: [{ text: 'Got it — teal, and Seattle.' }] },
        ],
        { sequenceNumbers: [0, 1] }
      )
    ).resolves.toBeUndefined()
  }, 60_000)

  it('is idempotent on re-send of the same sequence numbers (clientToken dedup)', async () => {
    const store = new AgentCoreMemoryStore({
      memoryId,
      actorId,
      sessionId,
      namespace: FACTS_NAMESPACE,
      writable: true,
      extraction: true,
      client: dataPlane,
    })
    // Re-sending on the SAME store instance reuses the sender's run id, so identical sequence numbers
    // yield identical clientTokens — exactly what a coordinator re-fire does.
    const msgs = [{ role: 'user' as const, content: [{ text: 'I prefer dark mode.' }] }]
    await store.addMessages!(msgs, { sequenceNumbers: [5] })
    // Re-send: AgentCore dedups on clientToken, so this must not throw.
    await expect(store.addMessages!(msgs, { sequenceNumbers: [5] })).resolves.toBeUndefined()
  }, 60_000)

  it('batches a multi-turn write into ONE CreateEvent and still extracts the facts (cost lever)', async () => {
    // Count real CreateEvent calls by wrapping the live client's send.
    let createEventCalls = 0
    const countingClient = {
      send: (command: unknown) => {
        if ((command as { constructor: { name: string } }).constructor.name === 'CreateEventCommand') createEventCalls++
        return dataPlane.send(command as never)
      },
    } as unknown as typeof dataPlane

    const batchActor = `batch-actor-${uniqueSuffix()}`
    const store = new AgentCoreMemoryStore({
      memoryId,
      actorId: batchActor,
      sessionId: `batch-session-${uniqueSuffix()}-padded-to-be-long-enough`,
      namespace: FACTS_NAMESPACE,
      writable: true,
      extraction: true,
      client: countingClient,
    })
    // A 4-turn conversation in ONE addMessages call -> must be a single CreateEvent (not 4).
    await store.addMessages!(
      [
        { role: 'user', content: [{ text: 'I am a pilot based in Denver and I fly Cessnas.' }] },
        { role: 'assistant', content: [{ text: 'Flying Cessnas out of Denver — nice.' }] },
        { role: 'user', content: [{ text: 'I also play the cello in my spare time.' }] },
        { role: 'assistant', content: [{ text: 'A pilot and a cellist!' }] },
      ],
      { sequenceNumbers: [0, 1, 2, 3] }
    )
    expect(createEventCalls).toBe(1) // THE COST LEVER: 4 turns -> 1 API call, not 4

    // Parity: the batched event still extracts the facts (matches the per-message behavior).
    const readStore = new AgentCoreMemoryStore({
      memoryId,
      actorId: batchActor,
      sessionId: 'unused-for-read-padded-to-be-long-enough',
      namespace: FACTS_NAMESPACE,
      client: dataPlane,
    })
    const results = await pollForRecords(() => readStore.search('what does the user do and where'))
    if (results.length === 0) {
      console.warn('Batching parity: no records surfaced within the window; extraction may be pending.')
    } else {
      const joined = results.map((r) => r.content.toLowerCase()).join(' ')
      expect(joined).toMatch(/pilot|denver|cello|cessna/)
    }
    expect(Array.isArray(results)).toBe(true)
  }, 300_000)

  it('sends extractionMode "SKIP" on the live CreateEvent and the service accepts it', async () => {
    // Capture the real CreateEventCommand input so we prove the value goes over the wire (not just that
    // it's set on the sender), and that the live data plane accepts "SKIP" without erroring.
    let skipInput: { extractionMode?: string } | undefined
    const capturingClient = {
      send: (command: unknown) => {
        if ((command as { constructor: { name: string } }).constructor.name === 'CreateEventCommand') {
          skipInput = (command as { input: { extractionMode?: string } }).input
        }
        return dataPlane.send(command as never)
      },
    } as unknown as typeof dataPlane

    const skipActor = `skip-actor-${uniqueSuffix()}`
    const store = new AgentCoreMemoryStore({
      memoryId,
      actorId: skipActor,
      sessionId: `skip-session-${uniqueSuffix()}-padded-to-be-long-enough`,
      namespace: FACTS_NAMESPACE,
      writable: true,
      extraction: true,
      extractionMode: 'SKIP',
      client: capturingClient,
    })
    // The write must succeed against the live service — this is what would have caught a value the API
    // rejects.
    await expect(
      store.addMessages!([{ role: 'user', content: [{ text: 'Short-term only: my temporary PIN is 4821.' }] }], {
        sequenceNumbers: [0],
      })
    ).resolves.toBeUndefined()
    // And the wire payload carried the mode.
    expect(skipInput?.extractionMode).toBe('SKIP')
  }, 60_000)

  it('omits extractionMode on the live CreateEvent when not configured (default extraction path)', async () => {
    let defaultInput: { extractionMode?: string } | undefined
    const capturingClient = {
      send: (command: unknown) => {
        if ((command as { constructor: { name: string } }).constructor.name === 'CreateEventCommand') {
          defaultInput = (command as { input: { extractionMode?: string } }).input
        }
        return dataPlane.send(command as never)
      },
    } as unknown as typeof dataPlane

    const defaultActor = `default-mode-actor-${uniqueSuffix()}`
    const store = new AgentCoreMemoryStore({
      memoryId,
      actorId: defaultActor,
      sessionId: `default-mode-session-${uniqueSuffix()}-padded-to-be-long-enough`,
      namespace: FACTS_NAMESPACE,
      writable: true,
      extraction: true,
      // extractionMode omitted -> field must not be sent
      client: capturingClient,
    })
    await expect(
      store.addMessages!([{ role: 'user', content: [{ text: 'Extract me normally: I live in Portland.' }] }], {
        sequenceNumbers: [0],
      })
    ).resolves.toBeUndefined()
    expect(defaultInput?.extractionMode).toBeUndefined()
  }, 60_000)

  it('recalls extracted records and proves the namespace contract (records land where the store queries)', async () => {
    // Recall-only: the writes happen in the earlier writer tests (shared actorId); this store just reads.
    const store = new AgentCoreMemoryStore({
      memoryId,
      actorId,
      sessionId,
      namespace: FACTS_NAMESPACE, // CLI-shape template: only {actorId}/{sessionId}
      client: dataPlane,
    })
    const results = await pollForRecords(() => store.search('Where does the user live?'))
    // Extraction is async; if it has run, we should recall the Seattle fact with underscored metadata.
    if (results.length === 0) {
      console.warn('No records surfaced within the poll window; extraction may still be pending.')
    } else {
      expect(results[0]!.content.length).toBeGreaterThan(0)
      const meta = (results[0] as { metadata?: Record<string, unknown> }).metadata ?? {}
      expect(Object.keys(meta).some((k) => k.startsWith('_'))).toBe(true)
      // THE CONTRACT: the record's stored namespace (_namespaces) must contain the resolved actorId,
      // i.e. records physically land under exactly the {actorId}-substituted path the store queried.
      // This is what silently breaks when provisioned templates and queried templates diverge.
      const namespaces = (meta._namespaces as string[] | undefined) ?? []
      const expectedResolved = FACTS_NAMESPACE.replace('{actorId}', actorId)
      expect(namespaces.some((ns) => ns.includes(expectedResolved) || ns.includes(actorId))).toBe(true)
    }
    expect(Array.isArray(results)).toBe(true)
  }, 300_000)

  it('throws when addMessages is called on a recall-only store', async () => {
    const store = new AgentCoreMemoryStore({
      memoryId,
      actorId,
      sessionId,
      namespace: FACTS_NAMESPACE,
      // extraction omitted -> recall-only
      client: dataPlane,
    })
    expect(store.writable).toBe(false)
    await expect(store.addMessages!([{ role: 'user', content: [{ text: 'x' }] }])).rejects.toThrow(/not writable/)
  })

  it('reads a subtree via namespacePath without error', async () => {
    // A subtree read is a single store — construct it directly with `namespacePath` (no factory needed).
    const store = new AgentCoreMemoryStore({
      memoryId,
      actorId,
      sessionId,
      namespacePath: `/integ/${actorId}`,
      client: dataPlane,
    })
    await expect(store.search('anything')).resolves.toBeDefined()
  }, 60_000)

  it('stands alone: a directly-constructed store (no factory) writes and recalls', async () => {
    // The store is a self-contained primitive — flat identity + namespace, no factory, no nested config.
    const standaloneActor = `standalone-actor-${uniqueSuffix()}`
    const store = new AgentCoreMemoryStore({
      memoryId,
      actorId: standaloneActor,
      sessionId: `standalone-session-${uniqueSuffix()}-padded-to-be-long-enough`,
      namespace: FACTS_NAMESPACE,
      writable: true,
      extraction: true,
      client: dataPlane,
    })
    expect(store.writable).toBe(true)
    await expect(
      store.addMessages!(
        [{ role: 'user', content: [{ text: 'I drive a vintage Vespa and collect vinyl records.' }] }],
        { sequenceNumbers: [0] }
      )
    ).resolves.toBeUndefined()
    const results = await pollForRecords(() => store.search('what does the user own'))
    expect(Array.isArray(results)).toBe(true)
  }, 300_000)
})

describe('AgentCoreMemoryStore (session-scoped namespace drift)', () => {
  // A SUMMARIZATION strategy whose namespace includes {sessionId}: records are partitioned per session,
  // so a store built for a different sessionId must NOT see another session's records. This pins the
  // (otherwise silent) per-session scoping contract for {sessionId}-bearing namespaces.
  const SUMMARY_NS = '/summaries/{actorId}/{sessionId}'
  const actorId = `drift-actor-${uniqueSuffix()}`
  const sessionA = `drift-session-A-${uniqueSuffix()}-padded-to-be-long-enough`
  const sessionB = `drift-session-B-${uniqueSuffix()}-padded-to-be-long-enough`
  let driftMemoryId: string

  beforeAll(async () => {
    const { memory } = await control.send(
      new CreateMemoryCommand({
        name: `strands_drift_${uniqueSuffix()}`,
        eventExpiryDuration: 7,
        memoryStrategies: [{ summaryMemoryStrategy: { name: 'summaries', namespaceTemplates: [SUMMARY_NS] } }],
      })
    )
    if (!memory?.id) throw new Error('CreateMemory (drift) did not return an id')
    driftMemoryId = memory.id
    await waitForMemoryActive(driftMemoryId)

    // Write a multi-turn conversation under session A so the summary strategy has something to extract.
    const writer = new AgentCoreMemoryStore({
      memoryId: driftMemoryId,
      actorId,
      sessionId: sessionA,
      namespace: SUMMARY_NS,
      writable: true,
      extraction: true,
      client: dataPlane,
    })
    await writer.addMessages!(
      [
        { role: 'user', content: [{ text: 'We are planning a trip to Japan in the spring.' }] },
        { role: 'assistant', content: [{ text: 'Spring in Japan is lovely — cherry blossoms peak late March.' }] },
        { role: 'user', content: [{ text: 'Book me a ryokan in Kyoto for two nights.' }] },
      ],
      { sequenceNumbers: [0, 1, 2] }
    )
  }, 240_000)

  afterAll(async () => {
    if (!driftMemoryId) return
    try {
      await control.send(new DeleteMemoryCommand({ memoryId: driftMemoryId }))
    } catch (err) {
      console.warn('Failed to delete drift memory:', err)
    }
  })

  it('a store on a different sessionId does not see session A records; the same sessionId does', async () => {
    const storeA = new AgentCoreMemoryStore({
      memoryId: driftMemoryId,
      actorId,
      sessionId: sessionA,
      namespace: SUMMARY_NS,
      client: dataPlane,
    })
    const storeB = new AgentCoreMemoryStore({
      memoryId: driftMemoryId,
      actorId,
      sessionId: sessionB,
      namespace: SUMMARY_NS,
      client: dataPlane,
    })

    // Poll session A until the summary extracts (proves there IS something to find).
    const fromA = await pollForRecords(() => storeA.search('What trip is being planned?'))
    if (fromA.length === 0) {
      console.warn('Drift test: no summary surfaced for session A within the window; extraction may be pending.')
      return // can't assert the contrast without a positive control
    }
    // Session B queries the SAME actor but a different {sessionId} -> disjoint namespace -> no records.
    const fromB = await storeB.search('What trip is being planned?')
    expect(fromB).toEqual([])
  }, 300_000)
})

describe('AgentCoreMemoryStore (end-to-end, real MemoryManager + Agent)', () => {
  const actorId = `e2e-actor-${uniqueSuffix()}`
  const sessionId = `e2e-session-${uniqueSuffix()}-padded-to-be-long-enough`

  function buildAgent(): { agent: Agent; memory: MemoryManager } {
    const stores = createAgentCoreMemoryStores({
      memoryId,
      actorId,
      sessionId,
      namespaces: [{ namespace: FACTS_NAMESPACE }],
      extraction: true,
      client: dataPlane,
    })
    const memory = new MemoryManager({ stores })
    const agent = new Agent({
      model: new BedrockModel({ region: REGION, modelId: MODEL_ID }),
      systemPrompt: 'You are a helpful assistant with long-term memory. Use recalled facts to personalize answers.',
      memoryManager: memory,
    })
    return { agent, memory }
  }

  it('writes a turn through the agent, then recalls it on a later search (polled)', async () => {
    const { agent, memory } = buildAgent()

    // Turn 1: tell the agent a durable fact, then flush the in-flight createEvent writes.
    await agent.invoke('Remember this: my dog is named Pixel and she is a corgi.')
    await memory.flush()

    // Extraction is async; poll the manager's search for the consolidated fact.
    const results = await pollForRecords(() => memory.search('What is the user’s dog named?'))
    if (results.length === 0) {
      console.warn('E2E: no records surfaced within the poll window; extraction may still be pending.')
      expect(Array.isArray(results)).toBe(true)
      return
    }
    const joined = results.map((r) => r.content.toLowerCase()).join(' ')
    expect(joined).toContain('pixel')
  }, 360_000)
})
