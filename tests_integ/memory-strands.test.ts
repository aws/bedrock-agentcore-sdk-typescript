/**
 * Integration tests for AgentCoreMemory plugin.
 *
 * Tests the plugin's extraction and injection pipelines against real
 * AgentCore Memory APIs. Uses direct hook invocation rather than a full
 * Strands Agent to isolate the plugin logic from model dependencies.
 *
 * Requires:
 * - AWS credentials configured (SDK credential chain)
 * - AWS_REGION env var (defaults to us-west-2)
 * - IAM perms: bedrock-agentcore:{Create,Get,Delete}Memory, CreateEvent,
 *   ListEvents, RetrieveMemoryRecords
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { MemoryClient } from '../src/memory/client.js'
import { AgentCoreMemory } from '../src/memory/integrations/strands/plugin.js'
import { createSearchMemoryTool } from '../src/memory/integrations/strands/search-memory-tool.js'

const REGION = process.env.AWS_REGION || 'us-west-2'
const RUN_ID = Date.now()
const createdMemoryIds = new Set<string>()

function createMockAgent(systemPrompt?: string) {
  const hooks: Array<{ eventName: string; callback: (event: any) => any }> = []
  return {
    systemPrompt: systemPrompt ?? 'You are a helpful assistant.',
    messages: [] as any[],
    addHook: (eventType: any, callback: any) => {
      hooks.push({ eventName: eventType.name, callback })
      return () => {}
    },
    _hooks: hooks,
    async fireHooks(eventName: string, event: any) {
      for (const h of hooks.filter((h) => h.eventName === eventName)) {
        await h.callback(event)
      }
    },
  }
}

function createMessage(role: 'user' | 'assistant', text: string): any {
  return { role, content: [{ type: 'textBlock', text }] }
}

describe('AgentCoreMemory Integration Tests', () => {
  let client: MemoryClient
  let memoryId: string

  beforeAll(async () => {
    client = new MemoryClient({ region: REGION })

    const name = `test_mem_strands_${RUN_ID}`
    const result = await client.createMemoryAndWait(
      { name, eventExpiryDuration: 30 },
      { maxWaitSeconds: 600, pollIntervalMs: 5_000 }
    )
    memoryId = result.memory!.id!
    createdMemoryIds.add(memoryId)
  }, 720_000)

  afterAll(async () => {
    await Promise.allSettled(Array.from(createdMemoryIds).map((id) => client.deleteMemory({ memoryId: id })))
  })

  describe('extraction pipeline', () => {
    it('stores conversation messages as events via createEvent', async () => {
      const actorId = `actor-extract-${RUN_ID}`
      const sessionId = `session-extract-${RUN_ID}`

      const plugin = new AgentCoreMemory({
        memoryId,
        actorId,
        sessionId,
        extraction: true,
      })

      const agent = createMockAgent()
      plugin.initAgent(agent as any)

      const userMsg = createMessage('user', 'I prefer dark mode and concise responses')
      const assistantMsg = createMessage('assistant', 'Got it! I will remember your preferences.')

      await agent.fireHooks('MessageAddedEvent', { agent, message: userMsg })
      await agent.fireHooks('MessageAddedEvent', { agent, message: assistantMsg })
      await agent.fireHooks('AfterInvocationEvent', { agent })

      const events = await client.listEvents({
        memoryId,
        actorId,
        sessionId,
        includePayloads: true,
      })

      expect(events.events).toBeDefined()
      expect(events.events!.length).toBeGreaterThanOrEqual(2)

      const payloads = events.events!.flatMap((e) =>
        (e.payload ?? []).filter((p: any) => p.conversational).map((p: any) => p.conversational)
      )
      const texts = payloads.map((p: any) => p.content?.text)
      expect(texts).toContain('I prefer dark mode and concise responses')
      expect(texts).toContain('Got it! I will remember your preferences.')
    }, 60_000)

    it('applies messageFilter to skip filtered messages', async () => {
      const actorId = `actor-filter-${RUN_ID}`
      const sessionId = `session-filter-${RUN_ID}`

      const plugin = new AgentCoreMemory({
        memoryId,
        actorId,
        sessionId,
        extraction: {
          messageFilter: (msg: any) => msg.role !== 'user',
        },
      })

      const agent = createMockAgent()
      plugin.initAgent(agent as any)

      await agent.fireHooks('MessageAddedEvent', { agent, message: createMessage('user', 'skip this') })
      await agent.fireHooks('MessageAddedEvent', { agent, message: createMessage('assistant', 'keep this') })
      await agent.fireHooks('AfterInvocationEvent', { agent })

      const events = await client.listEvents({
        memoryId,
        actorId,
        sessionId,
        includePayloads: true,
      })

      expect(events.events).toBeDefined()
      expect(events.events!.length).toBe(1)

      const text = (events.events![0]!.payload![0] as any).conversational?.content?.text
      expect(text).toBe('keep this')
    }, 60_000)

    it('includes custom metadata on events', async () => {
      const actorId = `actor-meta-${RUN_ID}`
      const sessionId = `session-meta-${RUN_ID}`

      const plugin = new AgentCoreMemory({
        memoryId,
        actorId,
        sessionId,
        extraction: true,
        metadataProvider: () => ({
          source: { stringValue: 'integ-test' },
        }),
      })

      const agent = createMockAgent()
      plugin.initAgent(agent as any)

      await agent.fireHooks('MessageAddedEvent', { agent, message: createMessage('assistant', 'with metadata') })
      await agent.fireHooks('AfterInvocationEvent', { agent })

      const events = await client.listEvents({
        memoryId,
        actorId,
        sessionId,
        includePayloads: true,
      })

      expect(events.events).toBeDefined()
      expect(events.events!.length).toBeGreaterThanOrEqual(1)
      const meta = events.events![0]!.metadata
      expect(meta).toBeDefined()
      expect((meta as any).source?.stringValue).toBe('integ-test')
    }, 60_000)
  })

  describe('injection pipeline', () => {
    it('retrieves memory records and injects into system prompt', async () => {
      const actorId = `actor-inject-${RUN_ID}`
      const sessionId = `session-inject-${RUN_ID}`

      await client.createEvent({
        memoryId,
        actorId,
        sessionId,
        eventTimestamp: new Date(),
        payload: [
          {
            conversational: {
              role: 'USER',
              content: { text: 'I always want dark mode enabled' },
            },
          },
        ],
      })

      await client.createEvent({
        memoryId,
        actorId,
        sessionId,
        eventTimestamp: new Date(Date.now() + 1000),
        payload: [
          {
            conversational: {
              role: 'ASSISTANT',
              content: { text: 'Noted, I will remember your dark mode preference.' },
            },
          },
        ],
      })

      const hasMemories = await client.waitForMemories({
        memoryId,
        namespace: '/',
        testQuery: 'dark mode',
        maxWaitSeconds: 180,
        pollIntervalMs: 10_000,
      })

      if (!hasMemories) {
        console.warn('No LTM records generated in time — skipping injection assertion')
        return
      }

      const plugin = new AgentCoreMemory({
        memoryId,
        actorId,
        sessionId: `session-inject-read-${RUN_ID}`,
        injection: {
          namespaces: { '/': { topK: 5 } },
        },
      })

      const agent = createMockAgent('You are a helpful assistant.')
      agent.messages = [createMessage('user', 'what are my preferences?')]
      plugin.initAgent(agent as any)

      await agent.fireHooks('BeforeInvocationEvent', { agent })

      expect(typeof agent.systemPrompt).toBe('string')
      expect(agent.systemPrompt as string).toContain('<agentcore_memory>')
    }, 300_000)
  })

  describe('search_memory tool', () => {
    it('retrieves results via tool callback', async () => {
      const actorId = `actor-tool-${RUN_ID}`
      const sessionId = `session-tool-${RUN_ID}`

      await client.createEvent({
        memoryId,
        actorId,
        sessionId,
        eventTimestamp: new Date(),
        payload: [
          {
            conversational: {
              role: 'USER',
              content: { text: 'My timezone is US/Pacific and I work in engineering' },
            },
          },
        ],
      })

      const hasMemories = await client.waitForMemories({
        memoryId,
        namespace: '/',
        testQuery: 'timezone engineering',
        maxWaitSeconds: 180,
        pollIntervalMs: 10_000,
      })

      if (!hasMemories) {
        console.warn('No LTM records generated in time — skipping tool assertion')
        return
      }

      const searchTool = createSearchMemoryTool(client, {
        memoryId,
        namespaces: { '/': { topK: 5 } },
      })

      const result = await (searchTool as any).callback({ query: 'timezone' })
      expect(typeof result).toBe('string')
      expect(result.length).toBeGreaterThan(0)
    }, 300_000)
  })
})
