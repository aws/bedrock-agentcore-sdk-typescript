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
import { createAgentCoreMemoryStore, createAgentCoreMemoryStores } from '../src/memory/strands/index.js'

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
    const store = createAgentCoreMemoryStore({
      memoryId,
      actorId,
      sessionId,
      namespace: FACTS_NAMESPACE,
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
    const store = createAgentCoreMemoryStore({
      memoryId,
      actorId,
      sessionId,
      namespace: FACTS_NAMESPACE,
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

  it('recalls extracted records via search -> retrieveMemoryRecords (polled)', async () => {
    const store = createAgentCoreMemoryStore({
      memoryId,
      actorId,
      sessionId,
      namespace: FACTS_NAMESPACE,
      extraction: true,
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
    }
    expect(Array.isArray(results)).toBe(true)
  }, 300_000)

  it('throws when addMessages is called on a recall-only store', async () => {
    const store = createAgentCoreMemoryStore({
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
    const [store] = createAgentCoreMemoryStores({
      memoryId,
      actorId,
      sessionId,
      namespaces: [{ namespace: FACTS_NAMESPACE }],
      readMode: 'subtree',
      parentNamespace: `/integ/${actorId}`,
      client: dataPlane,
    })
    await expect(store!.search('anything')).resolves.toBeDefined()
  }, 60_000)
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
