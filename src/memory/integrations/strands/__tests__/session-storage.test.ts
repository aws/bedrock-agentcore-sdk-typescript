import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CreateEventCommand } from '@aws-sdk/client-bedrock-agentcore'
import { Agent, SessionManager } from '@strands-agents/sdk'
import type { Snapshot, SnapshotLocation } from '@strands-agents/sdk'
import {
  AgentCoreSessionStorageError,
  AgentCoreSnapshotStorage,
  createAgentCoreSessionStorage,
  DEFAULT_MAX_CHUNK_BYTES,
  DEFAULT_SESSION_ACTOR_ID,
  type AgentCoreSessionStorageConfig,
} from '../session-storage.js'
import { logger } from '../logger.js'
import { awsError, FakeAgentCoreMemory } from './fake-agentcore-memory.js'

const MEMORY_ID = 'mem_session-abcdefghij'
const location: SnapshotLocation = { sessionId: 'session-1', scope: 'agent', scopeId: 'default' }

function snapshot(text: string, scope: Snapshot['scope'] = 'agent'): Snapshot {
  return {
    scope,
    schemaVersion: '1.0',
    createdAt: '2026-10-16T00:00:00.000Z',
    data: { messages: [{ role: 'user', content: [{ text }] }] },
    appData: {},
  }
}

/** A valid UUID v7 whose 48-bit timestamp is `ms`, so lexicographic order follows `ms`. */
function uuidV7(ms: number): string {
  const hex = ms.toString(16).padStart(12, '0')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-000000000000`
}

/** Metadata of one stored event as a plain string map. */
function metadataOf(event: { metadata: Record<string, { stringValue: string }> }): Record<string, string> {
  return Object.fromEntries(Object.entries(event.metadata).map(([k, v]) => [k, v.stringValue]))
}

describe('AgentCoreSnapshotStorage', () => {
  let fake: FakeAgentCoreMemory

  const makeStorage = (overrides: Partial<AgentCoreSessionStorageConfig> = {}): AgentCoreSnapshotStorage =>
    new AgentCoreSnapshotStorage({ memoryId: MEMORY_ID, client: fake.client(), ...overrides })

  beforeEach(() => {
    fake = new FakeAgentCoreMemory()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  describe('construction', () => {
    it('rejects an empty memoryId', () => {
      expect(() => new AgentCoreSnapshotStorage({ memoryId: ' ', client: fake.client() })).toThrow(
        'AgentCoreSnapshotStorage: memoryId must be a non-empty string'
      )
    })

    it.each([
      ['an empty string', ''],
      ['a leading hyphen', '-user'],
      ['a character outside the pattern', 'user@example.com'],
      ['a doubled colon', 'tenant::user'],
      ['a trailing colon', 'tenant:'],
      ['more than 255 characters', 'a'.repeat(256)],
    ])('rejects an actorId with %s', (_label, actorId) => {
      expect(() => makeStorage({ actorId })).toThrow(/actorId/)
    })

    it('accepts an actorId using the full AgentCore pattern', async () => {
      const storage = makeStorage({ actorId: 'tenant-1:user_42/web' })
      await storage.saveSnapshot({ location, snapshotId: 'latest', isLatest: true, snapshot: snapshot('hi') })
      expect(fake.events[0]!.actorId).toBe('tenant-1:user_42/web')
    })

    it('uses the default actorId when none is given', async () => {
      await makeStorage().saveSnapshot({ location, snapshotId: 'latest', isLatest: true, snapshot: snapshot('hi') })
      expect(fake.events[0]!.actorId).toBe(DEFAULT_SESSION_ACTOR_ID)
    })

    it.each([0, 15, 100_001, 1.5, Number.NaN])('rejects maxChunkBytes=%s', (maxChunkBytes) => {
      expect(() => makeStorage({ maxChunkBytes })).toThrow(/maxChunkBytes must be an integer between 16 and 100000/)
    })

    it('builds its own client when none is supplied', () => {
      expect(() => new AgentCoreSnapshotStorage({ memoryId: MEMORY_ID, region: 'eu-west-1' })).not.toThrow()
    })

    it('createAgentCoreSessionStorage returns a SessionStorage wrapping the snapshot storage', async () => {
      const storage = createAgentCoreSessionStorage({ memoryId: MEMORY_ID, client: fake.client() })
      expect(storage.snapshot).toBeInstanceOf(AgentCoreSnapshotStorage)
      await storage.snapshot.saveSnapshot({ location, snapshotId: 'latest', isLatest: true, snapshot: snapshot('x') })
      expect(await storage.snapshot.loadSnapshot({ location })).toEqual(snapshot('x'))
    })
  })

  describe('saveSnapshot / loadSnapshot', () => {
    it('round-trips the latest snapshot', async () => {
      const storage = makeStorage()
      await storage.saveSnapshot({ location, snapshotId: 'latest', isLatest: true, snapshot: snapshot('hello') })
      expect(await storage.loadSnapshot({ location })).toEqual(snapshot('hello'))
    })

    it('returns null when nothing was saved', async () => {
      expect(await makeStorage().loadSnapshot({ location })).toBeNull()
      expect(await makeStorage().loadSnapshot({ location, snapshotId: uuidV7(1) })).toBeNull()
    })

    it('writes one blob event per snapshot with the documented metadata layout', async () => {
      await makeStorage({ actorId: 'user-7' }).saveSnapshot({
        location,
        snapshotId: 'latest',
        isLatest: true,
        snapshot: snapshot('hi'),
      })

      expect(fake.count('CreateEventCommand')).toBe(1)
      const event = fake.events[0]!
      expect(event).toMatchObject({ memoryId: MEMORY_ID, actorId: 'user-7', sessionId: 'session-1' })
      expect(event.payload).toEqual([{ blob: JSON.stringify(snapshot('hi')) }])
      expect(metadataOf(event)).toEqual({
        'strands.layout': '1',
        'strands.kind': 'snapshot',
        'strands.location': 'agent/default',
        'strands.snapshotId': 'latest',
        'strands.isLatest': 'true',
        'strands.writeId': expect.stringMatching(/^[0-9a-f-]{36}$/),
        'strands.part': '0',
        'strands.partCount': '1',
      })
    })

    it('loads the newest latest snapshot and prunes the ones it supersedes', async () => {
      const storage = makeStorage()
      for (const text of ['one', 'two', 'three']) {
        await storage.saveSnapshot({ location, snapshotId: 'latest', isLatest: true, snapshot: snapshot(text) })
      }
      expect(await storage.loadSnapshot({ location })).toEqual(snapshot('three'))
      expect(fake.events).toHaveLength(1)
      expect(fake.count('DeleteEventCommand')).toBe(2)
    })

    it('orders saves made within the same millisecond', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-10-16T12:00:00.000Z'))
      const storage = makeStorage()
      await storage.saveSnapshot({ location, snapshotId: 'latest', isLatest: true, snapshot: snapshot('first') })
      await storage.saveSnapshot({ location, snapshotId: 'latest', isLatest: true, snapshot: snapshot('second') })
      expect(await storage.loadSnapshot({ location })).toEqual(snapshot('second'))
    })

    it('restores across instances, as after a cold start', async () => {
      await makeStorage().saveSnapshot({ location, snapshotId: 'latest', isLatest: true, snapshot: snapshot('kept') })
      expect(await makeStorage().loadSnapshot({ location })).toEqual(snapshot('kept'))
    })

    it('keeps immutable snapshots apart from the latest one and loads them by id', async () => {
      const storage = makeStorage()
      const id = uuidV7(1_000)
      await storage.saveSnapshot({ location, snapshotId: id, isLatest: false, snapshot: snapshot('checkpoint') })
      await storage.saveSnapshot({ location, snapshotId: 'latest', isLatest: true, snapshot: snapshot('now') })

      expect(await storage.loadSnapshot({ location, snapshotId: id })).toEqual(snapshot('checkpoint'))
      expect(await storage.loadSnapshot({ location })).toEqual(snapshot('now'))
      expect(await storage.loadSnapshot({ location, snapshotId: uuidV7(2_000) })).toBeNull()
      expect(fake.count('DeleteEventCommand')).toBe(0)
    })

    it('isolates scopes, scope ids and sessions', async () => {
      const storage = makeStorage()
      const other: SnapshotLocation = { sessionId: 'session-1', scope: 'agent', scopeId: 'planner' }
      const multi: SnapshotLocation = { sessionId: 'session-1', scope: 'multiAgent', scopeId: 'default' }
      const otherSession: SnapshotLocation = { sessionId: 'session-2', scope: 'agent', scopeId: 'default' }
      await storage.saveSnapshot({ location, snapshotId: 'latest', isLatest: true, snapshot: snapshot('a') })
      await storage.saveSnapshot({ location: other, snapshotId: 'latest', isLatest: true, snapshot: snapshot('b') })
      await storage.saveSnapshot({
        location: multi,
        snapshotId: 'latest',
        isLatest: true,
        snapshot: snapshot('c', 'multiAgent'),
      })

      expect(await storage.loadSnapshot({ location })).toEqual(snapshot('a'))
      expect(await storage.loadSnapshot({ location: other })).toEqual(snapshot('b'))
      expect(await storage.loadSnapshot({ location: multi })).toEqual(snapshot('c', 'multiAgent'))
      expect(await storage.loadSnapshot({ location: otherSession })).toBeNull()
      expect(fake.events).toHaveLength(3)
    })

    it('isolates actors sharing one memory', async () => {
      await makeStorage({ actorId: 'alice' }).saveSnapshot({
        location,
        snapshotId: 'latest',
        isLatest: true,
        snapshot: snapshot('alice'),
      })
      expect(await makeStorage({ actorId: 'bob' }).loadSnapshot({ location })).toBeNull()
    })
  })

  describe('chunking', () => {
    it('splits a snapshot larger than one payload item and reassembles it', async () => {
      const storage = makeStorage()
      const big = snapshot('x'.repeat(300_000))
      await storage.saveSnapshot({ location, snapshotId: 'latest', isLatest: true, snapshot: big })

      expect(fake.count('CreateEventCommand')).toBe(1)
      const items = fake.events[0]!.payload
      expect(items.length).toBe(5)
      for (const item of items) {
        // The chunk's escaped text is within the limit; the two enclosing quotes are the envelope.
        const serialized = Buffer.byteLength(JSON.stringify(item.blob), 'utf8')
        expect(serialized).toBeLessThanOrEqual(DEFAULT_MAX_CHUNK_BYTES + 2)
      }
      expect(await storage.loadSnapshot({ location })).toEqual(big)
    })

    it('measures chunks by their escaped UTF-8 size so quotes, newlines and multi-byte text stay in bounds', async () => {
      const storage = makeStorage({ maxChunkBytes: 64 })
      const text = 'say "hi"\n\\ né 日本語 🎉 '.repeat(40)
      await storage.saveSnapshot({ location, snapshotId: 'latest', isLatest: true, snapshot: snapshot(text) })

      for (const item of fake.events.flatMap((e) => e.payload)) {
        expect(Buffer.byteLength(JSON.stringify(item.blob), 'utf8')).toBeLessThanOrEqual(64 + 2)
      }
      expect(await storage.loadSnapshot({ location })).toEqual(snapshot(text))
    })

    it('spreads more than 100 chunks across several events and reassembles them in order', async () => {
      const storage = makeStorage({ maxChunkBytes: 16 })
      const text = Array.from({ length: 400 }, (_, i) => `turn ${i};`).join(' ')
      await storage.saveSnapshot({ location, snapshotId: 'latest', isLatest: true, snapshot: snapshot(text) })

      const events = fake.events
      expect(events.length).toBeGreaterThan(1)
      expect(events.every((e) => e.payload.length <= 100)).toBe(true)
      expect(new Set(events.map((e) => metadataOf(e)['strands.writeId'])).size).toBe(1)
      expect(events.map((e) => metadataOf(e)['strands.part'])).toEqual(events.map((_, i) => String(i)))
      expect(events.every((e) => metadataOf(e)['strands.partCount'] === String(events.length))).toBe(true)
      expect(await storage.loadSnapshot({ location })).toEqual(snapshot(text))
    })

    it('replaces a multi-event latest snapshot with a newer one', async () => {
      const storage = makeStorage({ maxChunkBytes: 16 })
      const long = (tag: string): Snapshot => snapshot(`${tag} `.repeat(800))
      await storage.saveSnapshot({ location, snapshotId: 'latest', isLatest: true, snapshot: long('old') })
      await storage.saveSnapshot({ location, snapshotId: 'latest', isLatest: true, snapshot: long('new') })
      expect(await storage.loadSnapshot({ location })).toEqual(long('new'))
      expect(new Set(fake.events.map((e) => metadataOf(e)['strands.writeId'])).size).toBe(1)
    })

    it('ignores a write with a missing part', async () => {
      const storage = makeStorage({ maxChunkBytes: 16 })
      const id = uuidV7(5)
      await storage.saveSnapshot({ location, snapshotId: id, isLatest: false, snapshot: snapshot('y '.repeat(900)) })
      fake.events.splice(1, 1)

      expect(await storage.loadSnapshot({ location, snapshotId: id })).toBeNull()
      expect(await storage.listSnapshotIds({ location })).toEqual([])
    })
  })

  describe('listSnapshotIds', () => {
    it('returns an empty list when there are no immutable snapshots', async () => {
      const storage = makeStorage()
      await storage.saveSnapshot({ location, snapshotId: 'latest', isLatest: true, snapshot: snapshot('x') })
      expect(await storage.listSnapshotIds({ location })).toEqual([])
    })

    it('lists every immutable snapshot id chronologically across ListEvents pages', async () => {
      const storage = makeStorage()
      const ids = Array.from({ length: 150 }, (_, i) => uuidV7(10_000 + i))
      for (const id of [...ids].reverse()) {
        await storage.saveSnapshot({ location, snapshotId: id, isLatest: false, snapshot: snapshot(id) })
      }

      expect(await storage.listSnapshotIds({ location })).toEqual(ids)
      expect(fake.count('ListEventsCommand')).toBe(2)
    })

    it('supports limit and an exclusive startAfter cursor', async () => {
      const storage = makeStorage()
      const ids = [1, 2, 3, 4, 5].map((n) => uuidV7(n))
      for (const id of ids) {
        await storage.saveSnapshot({ location, snapshotId: id, isLatest: false, snapshot: snapshot(id) })
      }

      const page1 = await storage.listSnapshotIds({ location, limit: 2 })
      const page2 = await storage.listSnapshotIds({ location, limit: 2, startAfter: page1.at(-1)! })
      const page3 = await storage.listSnapshotIds({ location, startAfter: page2.at(-1)! })
      expect([page1, page2, page3]).toEqual([ids.slice(0, 2), ids.slice(2, 4), ids.slice(4)])
      expect(await storage.listSnapshotIds({ location, limit: 0 })).toEqual([])
    })

    it('rejects a startAfter cursor that is not a UUID v7', async () => {
      await expect(makeStorage().listSnapshotIds({ location, startAfter: 'not-a-uuid' })).rejects.toThrow(
        /is not a valid UUID v7 snapshot ID/
      )
    })

    it('lists only the requested scope', async () => {
      const storage = makeStorage()
      await storage.saveSnapshot({ location, snapshotId: uuidV7(1), isLatest: false, snapshot: snapshot('a') })
      await storage.saveSnapshot({
        location: { ...location, scopeId: 'other' },
        snapshotId: uuidV7(2),
        isLatest: false,
        snapshot: snapshot('b'),
      })
      expect(await storage.listSnapshotIds({ location })).toEqual([uuidV7(1)])
    })
  })

  describe('deleteSession', () => {
    it('deletes every snapshot and manifest event of the session and nothing else', async () => {
      const storage = makeStorage()
      await storage.saveSnapshot({ location, snapshotId: 'latest', isLatest: true, snapshot: snapshot('a') })
      await storage.saveSnapshot({ location, snapshotId: uuidV7(1), isLatest: false, snapshot: snapshot('b') })
      await storage.saveSnapshot({
        location: { ...location, scope: 'multiAgent', scopeId: 'graph' },
        snapshotId: 'latest',
        isLatest: true,
        snapshot: snapshot('c', 'multiAgent'),
      })
      await storage.saveManifest({ location, manifest: { schemaVersion: '1.0', updatedAt: 'now' } })
      await storage.saveSnapshot({
        location: { ...location, sessionId: 'session-2' },
        snapshotId: 'latest',
        isLatest: true,
        snapshot: snapshot('other session'),
      })
      // A conversational event written to the same AgentCore session by another component.
      await fake.client().send(
        new CreateEventCommand({
          memoryId: MEMORY_ID,
          actorId: DEFAULT_SESSION_ACTOR_ID,
          sessionId: 'session-1',
          eventTimestamp: new Date(),
          payload: [{ conversational: { role: 'USER', content: { text: 'hi' } } }],
        })
      )

      await storage.deleteSession({ sessionId: 'session-1' })

      expect(await storage.loadSnapshot({ location })).toBeNull()
      expect(await storage.listSnapshotIds({ location })).toEqual([])
      expect(fake.events.map((e) => e.sessionId).sort()).toEqual(['session-1', 'session-2'])
      expect(fake.events.find((e) => e.sessionId === 'session-1')!.payload[0]).toHaveProperty('conversational')
    })

    it('is a no-op for an unknown session', async () => {
      await expect(makeStorage().deleteSession({ sessionId: 'nobody' })).resolves.toBeUndefined()
      expect(fake.count('DeleteEventCommand')).toBe(0)
    })

    it('wraps a DeleteEvent failure', async () => {
      const storage = makeStorage()
      await storage.saveSnapshot({ location, snapshotId: 'latest', isLatest: true, snapshot: snapshot('a') })
      fake.failNext('DeleteEventCommand', awsError('AccessDeniedException'))
      await expect(storage.deleteSession({ sessionId: 'session-1' })).rejects.toThrow(AgentCoreSessionStorageError)
    })
  })

  describe('manifest', () => {
    it('returns a default manifest when none was saved', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-10-16T08:00:00.000Z'))
      expect(await makeStorage().loadManifest({ location })).toEqual({
        schemaVersion: '1.0',
        updatedAt: '2026-10-16T08:00:00.000Z',
      })
    })

    it('saves, replaces and loads the manifest', async () => {
      const storage = makeStorage()
      await storage.saveManifest({ location, manifest: { schemaVersion: '1.0', updatedAt: 'first' } })
      await storage.saveManifest({ location, manifest: { schemaVersion: '1.0', updatedAt: 'second' } })
      expect(await storage.loadManifest({ location })).toEqual({ schemaVersion: '1.0', updatedAt: 'second' })
      expect(fake.events).toHaveLength(1)
      expect(metadataOf(fake.events[0]!)['strands.kind']).toBe('manifest')
    })
  })

  describe('identifier mapping', () => {
    it('maps the Strands sessionId to the AgentCore sessionId unchanged', async () => {
      const sessionId = 'b6f1d0c2-1d0e-4c55-9d61-6a1f0e4b2c3d-runtime'
      await makeStorage().saveSnapshot({
        location: { ...location, sessionId },
        snapshotId: 'latest',
        isLatest: true,
        snapshot: snapshot('x'),
      })
      expect(fake.events[0]!.sessionId).toBe(sessionId)
    })

    it.each([
      ['starts with an underscore', '_session'],
      ['starts with a hyphen', '-session'],
      ['has uppercase letters', 'Session'],
      ['is longer than 100 characters', 's'.repeat(101)],
    ])('rejects a sessionId that %s', async (_label, sessionId) => {
      const storage = makeStorage()
      await expect(storage.loadSnapshot({ location: { ...location, sessionId } })).rejects.toThrow(/sessionId/)
      await expect(storage.deleteSession({ sessionId })).rejects.toThrow(/sessionId/)
      expect(fake.calls).toHaveLength(0)
    })

    it.each([
      ['scopeId', { ...location, scopeId: 'My Agent' }],
      ['scopeId', { ...location, scopeId: 'a'.repeat(246) }],
      ['scope', { ...location, scope: 'team' as SnapshotLocation['scope'] }],
    ])('rejects an invalid %s', async (field, bad) => {
      await expect(makeStorage().loadSnapshot({ location: bad })).rejects.toThrow(new RegExp(field))
    })

    it('rejects an invalid snapshotId', async () => {
      const storage = makeStorage()
      await expect(
        storage.saveSnapshot({ location, snapshotId: 'Bad Id', isLatest: false, snapshot: snapshot('x') })
      ).rejects.toThrow(/snapshotId/)
      await expect(storage.loadSnapshot({ location, snapshotId: '../x' })).rejects.toThrow(/snapshotId/)
    })
  })

  describe('errors', () => {
    it('wraps a CreateEvent failure and keeps the AWS error as the cause', async () => {
      const cause = awsError('AccessDeniedException', 'not allowed')
      fake.failNext('CreateEventCommand', cause)
      const error = await makeStorage()
        .saveSnapshot({ location, snapshotId: 'latest', isLatest: true, snapshot: snapshot('x') })
        .catch((e: unknown) => e)

      expect(error).toBeInstanceOf(AgentCoreSessionStorageError)
      expect((error as Error).name).toBe('AgentCoreSessionStorageError')
      expect((error as Error).message).toMatch(/failed to save snapshot.*session-1.*AccessDeniedException: not allowed/)
      expect((error as Error).cause).toBe(cause)
    })

    it('rolls back the parts already written when a later part fails', async () => {
      const storage = makeStorage({ maxChunkBytes: 16 })
      await storage.saveSnapshot({ location, snapshotId: 'latest', isLatest: true, snapshot: snapshot('before') })
      const send = fake.send.bind(fake)
      let creates = 0
      vi.spyOn(fake, 'send').mockImplementation(async (command) => {
        if (command.constructor.name === 'CreateEventCommand' && ++creates === 2) throw awsError('ThrottledException')
        return send(command)
      })

      await expect(
        storage.saveSnapshot({ location, snapshotId: 'latest', isLatest: true, snapshot: snapshot('z '.repeat(900)) })
      ).rejects.toThrow(/ThrottledException/)
      expect(await storage.loadSnapshot({ location })).toEqual(snapshot('before'))
      expect(fake.events).toHaveLength(1)
    })

    it('logs and rethrows the write error when the rollback also fails', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
      const storage = makeStorage({ maxChunkBytes: 16 })
      const send = fake.send.bind(fake)
      let creates = 0
      vi.spyOn(fake, 'send').mockImplementation(async (command) => {
        if (command.constructor.name === 'CreateEventCommand' && ++creates === 2) throw awsError('ThrottledException')
        if (command.constructor.name === 'DeleteEventCommand') throw awsError('ServiceException')
        return send(command)
      })

      await expect(
        storage.saveSnapshot({ location, snapshotId: 'latest', isLatest: true, snapshot: snapshot('z '.repeat(900)) })
      ).rejects.toThrow(/ThrottledException/)
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/event_id=<.+> \| failed to roll back a partial write/))
    })

    it('keeps a save successful when pruning the superseded snapshot fails', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
      const storage = makeStorage()
      await storage.saveSnapshot({ location, snapshotId: 'latest', isLatest: true, snapshot: snapshot('old') })
      fake.failNext('DeleteEventCommand', awsError('ThrottledException'))

      await storage.saveSnapshot({ location, snapshotId: 'latest', isLatest: true, snapshot: snapshot('new') })
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/failed to delete a superseded event/))
      expect(fake.events).toHaveLength(2)
      expect(await storage.loadSnapshot({ location })).toEqual(snapshot('new'))
    })

    it('keeps a save successful when listing superseded events fails', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
      const storage = makeStorage()
      fake.failNext('ListEventsCommand', awsError('ThrottledException'))
      await storage.saveSnapshot({ location, snapshotId: 'latest', isLatest: true, snapshot: snapshot('x') })
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/failed to prune superseded events/))
      expect(await storage.loadSnapshot({ location })).toEqual(snapshot('x'))
    })

    it('wraps a ListEvents failure on load', async () => {
      fake.failNext('ListEventsCommand', awsError('ThrottledException', 'slow down'))
      await expect(makeStorage().loadSnapshot({ location })).rejects.toThrow(
        /AgentCoreSnapshotStorage: failed to load snapshot .*ThrottledException: slow down/
      )
    })

    it('treats ResourceNotFoundException on reads as no data', async () => {
      const storage = makeStorage()
      fake.failNext('ListEventsCommand', awsError('ResourceNotFoundException'), 3)
      expect(await storage.loadSnapshot({ location })).toBeNull()
      expect(await storage.listSnapshotIds({ location })).toEqual([])
      expect((await storage.loadManifest({ location })).schemaVersion).toBe('1.0')
    })

    it('reports a snapshot whose payload is not text', async () => {
      const storage = makeStorage()
      await storage.saveSnapshot({ location, snapshotId: 'latest', isLatest: true, snapshot: snapshot('x') })
      fake.events[0]!.payload = [{ blob: { not: 'text' } }]
      await expect(storage.loadSnapshot({ location })).rejects.toThrow(/stored payload is not a text chunk/)
    })

    it('reports a snapshot whose payload is not valid JSON', async () => {
      const storage = makeStorage()
      await storage.saveSnapshot({ location, snapshotId: 'latest', isLatest: true, snapshot: snapshot('x') })
      fake.events[0]!.payload = [{ blob: '{"truncated":' }]
      const error = await storage.loadSnapshot({ location }).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(AgentCoreSessionStorageError)
      expect((error as Error).message).toMatch(/stored snapshot is not valid JSON/)
      expect((error as Error).cause).toBeInstanceOf(SyntaxError)
    })

    it('reports a non-Error rejection by its string form', async () => {
      vi.spyOn(fake, 'send').mockRejectedValue('boom')
      await expect(makeStorage().loadSnapshot({ location })).rejects.toThrow(/: boom$/)
    })
  })

  describe('with the Strands SessionManager', () => {
    it('persists an agent conversation and restores it into a fresh agent', async () => {
      const storage = createAgentCoreSessionStorage({
        memoryId: MEMORY_ID,
        actorId: 'user-1',
        client: fake.client(),
      })
      const first = new Agent({
        id: 'assistant',
        messages: [
          { role: 'user', content: [{ text: 'My name is Margaret.' }] },
          { role: 'assistant', content: [{ text: 'Nice to meet you, Margaret.' }] },
        ],
        sessionManager: new SessionManager({ sessionId: 'family-session', storage }),
      })
      await first.sessionManager!.saveSnapshot({ target: first, isLatest: true })

      // A new storage instance and agent, as after a cold start of the runtime.
      const restoredStorage = createAgentCoreSessionStorage({
        memoryId: MEMORY_ID,
        actorId: 'user-1',
        client: fake.client(),
      })
      const second = new Agent({
        id: 'assistant',
        sessionManager: new SessionManager({ sessionId: 'family-session', storage: restoredStorage }),
      })
      await second.initialize()

      expect(second.messages.map((m) => m.content.map((c) => ('text' in c ? c.text : '')).join(''))).toEqual([
        'My name is Margaret.',
        'Nice to meet you, Margaret.',
      ])
      expect(fake.events.every((e) => e.actorId === 'user-1' && e.sessionId === 'family-session')).toBe(true)
    })
  })
})
