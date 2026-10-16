import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore'
import { Agent, SessionManager } from '@strands-agents/sdk'
import type { Snapshot, SnapshotLocation } from '@strands-agents/sdk'
import {
  AgentCoreMemorySnapshotStorage,
  createAgentCoreMemorySessionStorage,
} from '../src/memory/integrations/strands/index.js'

/**
 * Integration tests for the AgentCore Memory-backed Strands session storage against the live data plane.
 *
 * Gated on `AGENTCORE_MEMORY_ID`: the tests run only when it names an existing memory resource (no
 * strategies are needed; short-term events are enough). They write under a unique session id and delete
 * it in `afterAll`.
 *
 * Permissions: bedrock-agentcore:{CreateEvent,ListEvents,DeleteEvent} on the memory.
 *
 * To run: AGENTCORE_MEMORY_ID=<memory id> AWS_REGION=<region> npm run test:integ -- memory-session-storage
 */

const memoryId = process.env.AGENTCORE_MEMORY_ID
const REGION = process.env.AWS_REGION || 'us-west-2'

const describeWithMemory = memoryId ? describe : describe.skip

describeWithMemory('AgentCoreMemorySnapshotStorage (live data plane)', () => {
  const client = new BedrockAgentCoreClient({ region: REGION })
  const sessionId = `session-storage-integ-${Date.now().toString(36)}`
  const actorId = 'session-storage-integ'
  const location: SnapshotLocation = { sessionId, scope: 'agent', scopeId: 'default' }
  let storage: AgentCoreMemorySnapshotStorage

  beforeAll(() => {
    storage = new AgentCoreMemorySnapshotStorage({ memoryId: memoryId!, actorId, client })
  })

  const snapshot = (text: string): Snapshot => ({
    scope: 'agent',
    schemaVersion: '1.0',
    createdAt: new Date().toISOString(),
    data: { messages: [{ role: 'user', content: [{ text }] }] },
    appData: {},
  })

  afterAll(async () => {
    if (!storage) return
    try {
      await storage.deleteSession({ sessionId })
    } catch (err) {
      console.warn('Failed to delete integration test session:', err)
    }
  })

  it('round-trips the latest snapshot and replaces it on the next save', async () => {
    await storage.saveSnapshot({ location, snapshotId: 'latest', isLatest: true, snapshot: snapshot('first') })
    await storage.saveSnapshot({ location, snapshotId: 'latest', isLatest: true, snapshot: snapshot('second') })
    const loaded = await storage.loadSnapshot({ location })
    expect(loaded?.data).toEqual(snapshot('second').data)
  }, 60_000)

  it('chunks a snapshot larger than one payload item and reassembles it', async () => {
    const big = snapshot('large turn '.repeat(30_000))
    const bigLocation = { ...location, scopeId: 'big' }
    await storage.saveSnapshot({ location: bigLocation, snapshotId: 'latest', isLatest: true, snapshot: big })
    const loaded = await storage.loadSnapshot({ location: bigLocation })
    expect(loaded?.data).toEqual(big.data)
  }, 60_000)

  it('lists immutable snapshots and loads one by id', async () => {
    const ids = ['0192d3a0-0000-7000-8000-000000000001', '0192d3a0-0000-7000-8000-000000000002']
    for (const id of ids) {
      await storage.saveSnapshot({ location, snapshotId: id, isLatest: false, snapshot: snapshot(id) })
    }
    expect(await storage.listSnapshotIds({ location })).toEqual(ids)
    expect((await storage.loadSnapshot({ location, snapshotId: ids[0]! }))?.data).toEqual(snapshot(ids[0]!).data)
  }, 60_000)

  it('restores an agent conversation through the Strands SessionManager', async () => {
    const agentSession = `${sessionId}-agent`
    const make = (): SessionManager =>
      new SessionManager({
        sessionId: agentSession,
        storage: createAgentCoreMemorySessionStorage({ memoryId: memoryId!, actorId, client }),
      })
    const first = new Agent({
      id: 'assistant',
      messages: [{ role: 'user', content: [{ text: 'Remember the number 42.' }] }],
      sessionManager: make(),
    })
    await first.sessionManager!.saveSnapshot({ target: first, isLatest: true })

    const second = new Agent({ id: 'assistant', sessionManager: make() })
    await second.initialize()
    expect(second.messages).toHaveLength(1)

    await second.sessionManager!.deleteSession()
  }, 60_000)

  it('deletes the session', async () => {
    const doomed = { ...location, sessionId: `${sessionId}-doomed` }
    await storage.saveSnapshot({ location: doomed, snapshotId: 'latest', isLatest: true, snapshot: snapshot('x') })
    await storage.deleteSession({ sessionId: doomed.sessionId })
    expect(await storage.loadSnapshot({ location: doomed })).toBeNull()
  }, 60_000)
})
