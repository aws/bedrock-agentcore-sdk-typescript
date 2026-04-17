/**
 * Integration tests for MemoryClient custom helpers.
 *
 * Covers: createMemoryAndWait, createOrGetMemory, deleteMemoryAndWait,
 *         getLastKTurns, listBranches.
 *
 * Requires:
 * - AWS credentials configured (SDK credential chain)
 * - AWS_REGION env var (defaults to us-west-2)
 * - IAM perms: bedrock-agentcore:{Create,Get,Delete}Memory, CreateEvent,
 *   ListEvents
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { MemoryClient } from '../src/memory/client.js'

const REGION = process.env.AWS_REGION || 'us-west-2'
const RUN_ID = Date.now()
const createdMemoryIds = new Set<string>()

describe.concurrent('MemoryClient Integration Tests', () => {
  let client: MemoryClient

  beforeAll(() => {
    client = new MemoryClient({ region: REGION })
  })

  afterAll(async () => {
    await Promise.allSettled(Array.from(createdMemoryIds).map((memoryId) => client.deleteMemory({ memoryId })))
  })

  describe('createMemoryAndWait()', () => {
    it('creates a memory and waits for ACTIVE status', async () => {
      const name = `test_mem_cmw_${RUN_ID}`
      const result = await client.createMemoryAndWait(
        { name, eventExpiryDuration: 30 },
        { maxWaitSeconds: 600, pollIntervalMs: 5_000 }
      )

      expect(result.memory).toBeDefined()
      expect(result.memory!.id).toEqual(expect.any(String))
      expect(result.memory!.status).toBe('ACTIVE')
      createdMemoryIds.add(result.memory!.id!)
    }, 720_000)
  })

  describe('createOrGetMemory()', () => {
    it('returns the existing memory on the second call', async () => {
      const name = `test_mem_cog_${RUN_ID}`

      const first = await client.createOrGetMemory({ name, eventExpiryDuration: 30 })
      const firstId = first.memory!.id!
      createdMemoryIds.add(firstId)

      const second = await client.createOrGetMemory({ name, eventExpiryDuration: 30 })
      expect(second.memory!.id).toBe(firstId)
    }, 60_000)
  })

  describe('deleteMemoryAndWait()', () => {
    it('deletes a memory and polls until it is gone', async () => {
      const name = `test_mem_del_${RUN_ID}`
      const created = await client.createMemoryAndWait(
        { name, eventExpiryDuration: 30 },
        { maxWaitSeconds: 600, pollIntervalMs: 5_000 }
      )
      const memoryId = created.memory!.id!

      await client.deleteMemoryAndWait(memoryId, { maxWaitSeconds: 600, pollIntervalMs: 5_000 })

      await expect(client.getMemory({ memoryId })).rejects.toThrow()
    }, 720_000)
  })

  describe('getLastKTurns()', () => {
    it('groups events into conversational turns and respects k', async () => {
      const name = `test_mem_turns_${RUN_ID}`
      const created = await client.createMemoryAndWait(
        { name, eventExpiryDuration: 30 },
        { maxWaitSeconds: 600, pollIntervalMs: 5_000 }
      )
      const memoryId = created.memory!.id!
      createdMemoryIds.add(memoryId)

      const actorId = 'actor-1'
      const sessionId = `session-${RUN_ID}`
      const baseTs = new Date()

      // Post two full turns: USER/ASSISTANT, USER/ASSISTANT
      const messages: Array<{ role: 'USER' | 'ASSISTANT'; text: string }> = [
        { role: 'USER', text: 'hello' },
        { role: 'ASSISTANT', text: 'hi there' },
        { role: 'USER', text: 'how are you?' },
        { role: 'ASSISTANT', text: 'doing well' },
      ]
      for (let i = 0; i < messages.length; i++) {
        await client.createEvent({
          memoryId,
          actorId,
          sessionId,
          eventTimestamp: new Date(baseTs.getTime() + i * 1000),
          payload: [{ conversational: { role: messages[i]!.role, content: { text: messages[i]!.text } } }],
        })
      }

      const lastOne = await client.getLastKTurns({ memoryId, actorId, sessionId, k: 1 })
      expect(lastOne).toHaveLength(1)
      expect(lastOne[0]!.length).toBeGreaterThanOrEqual(1)

      const lastMany = await client.getLastKTurns({ memoryId, actorId, sessionId, k: 10 })
      expect(lastMany.length).toBeGreaterThanOrEqual(1)
      expect(lastMany.length).toBeLessThanOrEqual(10)
    }, 720_000)
  })

  describe('listBranches()', () => {
    it('reports main plus any branched events', async () => {
      const name = `test_mem_branch_${RUN_ID}`
      const created = await client.createMemoryAndWait(
        { name, eventExpiryDuration: 30 },
        { maxWaitSeconds: 600, pollIntervalMs: 5_000 }
      )
      const memoryId = created.memory!.id!
      createdMemoryIds.add(memoryId)

      const actorId = 'actor-branch'
      const sessionId = `session-branch-${RUN_ID}`
      const baseTs = new Date()

      const root = await client.createEvent({
        memoryId,
        actorId,
        sessionId,
        eventTimestamp: baseTs,
        payload: [{ conversational: { role: 'USER', content: { text: 'root' } } }],
      })
      const rootEventId = root.event!.eventId!

      await client.createEvent({
        memoryId,
        actorId,
        sessionId,
        eventTimestamp: new Date(baseTs.getTime() + 1000),
        payload: [{ conversational: { role: 'ASSISTANT', content: { text: 'main reply' } } }],
      })

      await client.createEvent({
        memoryId,
        actorId,
        sessionId,
        eventTimestamp: new Date(baseTs.getTime() + 2000),
        branch: { name: 'alt', rootEventId },
        payload: [{ conversational: { role: 'ASSISTANT', content: { text: 'alt reply' } } }],
      })

      const branches = await client.listBranches({ memoryId, actorId, sessionId })
      const names = branches.map((b) => b.name).sort()
      expect(names).toContain('main')
      expect(names).toContain('alt')

      const alt = branches.find((b) => b.name === 'alt')!
      expect(alt.rootEventId).toBe(rootEventId)
      expect(alt.eventCount).toBeGreaterThanOrEqual(1)
    }, 720_000)
  })
})
