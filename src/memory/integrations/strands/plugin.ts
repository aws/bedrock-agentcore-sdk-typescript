/// <reference types="node" />

import type { Plugin, Tool } from '@strands-agents/sdk'
import { BeforeInvocationEvent, MessageAddedEvent, AfterInvocationEvent } from '@strands-agents/sdk'
import type { LocalAgent, Message, SystemPrompt } from '@strands-agents/sdk'
import { MemoryClient } from '../../client.js'
import type {
  AgentCoreMemoryConfig,
  InjectionConfig,
  MemoryRecordGroup,
  MemoryRecord,
  ResolvedExtractionConfig,
} from './types.js'
import { resolveExtractionConfig } from './types.js'
import {
  deriveLabel,
  formatMemoryBlock,
  truncateToCharBudget,
  stripMemoryBlock,
  appendMemoryBlock,
  extractText,
  mapRole,
} from './format.js'
import { createSearchMemoryTool } from './search-memory-tool.js'

interface AgentWithSystemPrompt {
  systemPrompt?: SystemPrompt | undefined
  messages: Message[]
}

export class AgentCoreMemory implements Plugin {
  readonly name = 'agentcore-memory'

  private readonly client: MemoryClient
  private readonly originalConfig: AgentCoreMemoryConfig
  private readonly extractionConfig: ResolvedExtractionConfig | null
  private readonly injectionConfig: InjectionConfig | null
  private agent!: AgentWithSystemPrompt
  private initialized = false
  private buffer: Message[] = []
  private flushTimer?: ReturnType<typeof globalThis.setTimeout> | undefined
  private flushing = false
  private searchMemoryTool?: Tool

  constructor(config: AgentCoreMemoryConfig) {
    this.originalConfig = config
    this.extractionConfig = resolveExtractionConfig(config.extraction)
    this.injectionConfig = config.injection ?? null

    if (config.memoryClient instanceof MemoryClient) {
      this.client = config.memoryClient as unknown as MemoryClient
    } else {
      this.client = new MemoryClient(config.memoryClient)
    }

    if (this.injectionConfig?.searchTool) {
      this.searchMemoryTool = createSearchMemoryTool(this.client, {
        memoryId: config.memoryId,
        namespaces: this.injectionConfig.namespaces,
      })
    }

    if (this.injectionConfig && this.injectionConfig.automatic === false && !this.injectionConfig.searchTool) {
      console.warn(
        '[agentcore-memory] injection configured with automatic: false and searchTool: false — injection will do nothing'
      )
    }
  }

  initAgent(agent: LocalAgent): void {
    if (this.initialized) {
      throw new Error(
        'AgentCoreMemory plugin already initialized. Use withActor() or withMetadataProvider() to create a new instance for a different agent.'
      )
    }
    this.initialized = true
    this.agent = agent as unknown as AgentWithSystemPrompt

    if (this.injectionConfig && this.injectionConfig.automatic !== false) {
      agent.addHook(BeforeInvocationEvent, () => this.handleBeforeInvocation())
    }

    if (this.extractionConfig) {
      agent.addHook(MessageAddedEvent, (e) => this.handleMessageAdded(e))
      agent.addHook(AfterInvocationEvent, () => this.handleAfterInvocation())
    }
  }

  getTools(): Tool[] {
    if (this.searchMemoryTool) {
      return [this.searchMemoryTool]
    }
    return []
  }

  withActor(actorId: string): AgentCoreMemory {
    return AgentCoreMemory.cloneWithConfig(this, { ...this.originalConfig, actorId })
  }

  withMetadataProvider(fn: (message: Message) => Record<string, { stringValue: string }>): AgentCoreMemory {
    return AgentCoreMemory.cloneWithConfig(this, { ...this.originalConfig, metadataProvider: fn })
  }

  private static cloneWithConfig(source: AgentCoreMemory, config: AgentCoreMemoryConfig): AgentCoreMemory {
    const instance = new AgentCoreMemory(config)
    Object.defineProperty(instance, 'client', { value: source.client })
    return instance
  }

  private async handleBeforeInvocation(): Promise<void> {
    try {
      await this.retrieveAndInject()
    } catch (err) {
      const tag = this.injectionConfig!.contextTag ?? 'agentcore_memory'
      this.agent.systemPrompt = stripMemoryBlock(this.agent.systemPrompt, tag)
      console.warn('[agentcore-memory] Injection failed, continuing without memory context:', err)
    }
  }

  private async retrieveAndInject(): Promise<void> {
    const config = this.injectionConfig!
    const tag = config.contextTag ?? 'agentcore_memory'

    this.agent.systemPrompt = stripMemoryBlock(this.agent.systemPrompt, tag)

    const query = this.getSearchQuery()
    const namespaceEntries = Object.entries(config.namespaces)

    const results = await Promise.all(
      namespaceEntries.map(async ([ns, nsConfig]) => {
        const response = await this.client.retrieveMemoryRecords({
          memoryId: this.originalConfig.memoryId,
          namespace: ns,
          searchCriteria: {
            searchQuery: query,
            topK: nsConfig.topK ?? 5,
          },
        })

        let records: MemoryRecord[] = (response.memoryRecordSummaries ?? []).map((r) => {
          const record: MemoryRecord = {
            content: (r.content as { text?: string })?.text ?? '',
          }
          if (r.score !== undefined) record.score = r.score
          if (r.createdAt !== undefined) record.createdAt = r.createdAt
          return record
        })

        if (nsConfig.relevanceScore !== undefined) {
          records = records.filter((r) => (r.score ?? 0) >= nsConfig.relevanceScore!)
        }

        return {
          namespace: ns,
          label: deriveLabel(ns),
          records,
        } satisfies MemoryRecordGroup
      })
    )

    const groups = results.filter((g) => g.records.length > 0)
    if (groups.length === 0) return

    const maxChars = config.maxInjectionChars ?? 8000
    const truncated = truncateToCharBudget(groups, maxChars)

    const formatter = config.formatMemories ?? ((g: MemoryRecordGroup[]): string => formatMemoryBlock(g, tag))
    const block = formatter(truncated)

    if (!block) return

    this.agent.systemPrompt = appendMemoryBlock(this.agent.systemPrompt, block)
  }

  private getSearchQuery(): string {
    const messages = this.agent.messages
    const lastMsg = messages.length > 0 ? messages[messages.length - 1] : undefined
    if (!lastMsg) {
      return this.buildGenericQuery()
    }
    const text = extractText(lastMsg)
    return text || this.buildGenericQuery()
  }

  private buildGenericQuery(): string {
    if (!this.injectionConfig) return 'user context'
    const labels = Object.keys(this.injectionConfig.namespaces).map(deriveLabel)
    return `Retrieve relevant context about: ${labels.join(', ')}`
  }

  private handleMessageAdded(event: MessageAddedEvent): void {
    try {
      const message = event.message
      if (!this.shouldBuffer(message)) return
      this.bufferMessage(message)
    } catch (err) {
      console.warn('[agentcore-memory] Error buffering message:', err)
    }
  }

  private async handleAfterInvocation(): Promise<void> {
    try {
      this.clearFlushTimer()
      if (this.extractionConfig!.fireAndForget) {
        this.flushBuffer().catch((err) => console.warn('[agentcore-memory] Background flush failed:', err))
      } else {
        await this.flushBuffer()
      }
    } catch (err) {
      console.warn('[agentcore-memory] Extraction flush failed:', err)
    }
  }

  private shouldBuffer(message: Message): boolean {
    if (!this.extractionConfig) return false
    return this.extractionConfig.messageFilter(message)
  }

  private bufferMessage(message: Message): void {
    this.buffer.push(message)

    if (this.buffer.length >= this.extractionConfig!.batchSize) {
      this.flushBuffer().catch((err) => console.warn('[agentcore-memory] Early flush failed:', err))
      return
    }

    if (!this.flushTimer && this.buffer.length === 1) {
      this.flushTimer = globalThis.setTimeout(() => {
        this.flushBuffer().catch((err) => console.warn('[agentcore-memory] Timer flush failed:', err))
      }, this.extractionConfig!.batchTimeoutMs)
    }
  }

  private async flushBuffer(): Promise<void> {
    if (this.flushing) return
    if (this.buffer.length === 0) return

    this.flushing = true
    const toFlush = [...this.buffer]
    this.buffer = []
    this.clearFlushTimer()

    try {
      const results = await Promise.allSettled(toFlush.map((msg, i) => this.createEventFromMessage(msg, i)))

      const failed = results.map((r, i) => (r.status === 'rejected' ? i : null)).filter((i): i is number => i !== null)

      if (failed.length > 0) {
        const retryResults = await Promise.allSettled(failed.map((i) => this.createEventFromMessage(toFlush[i]!, i)))
        const stillFailed = retryResults.filter((r) => r.status === 'rejected').length
        if (stillFailed > 0) {
          console.warn(`[agentcore-memory] Dropped ${stillFailed} events after retry`)
        }
      }
    } finally {
      this.flushing = false
    }
  }

  private createEventFromMessage(message: Message, index: number): Promise<unknown> {
    const text = extractText(message)
    const metadata = this.originalConfig.metadataProvider?.(message)

    return this.client.createEvent({
      memoryId: this.originalConfig.memoryId,
      actorId: this.originalConfig.actorId,
      sessionId: this.originalConfig.sessionId,
      eventTimestamp: new Date(),
      clientToken: this.generateClientToken(index),
      payload: [
        {
          conversational: {
            role: mapRole(message),
            content: { text },
          },
        },
      ],
      ...(metadata && { metadata }),
    })
  }

  private generateClientToken(index: number): string {
    const { sessionId, actorId } = this.originalConfig
    return `${sessionId}-${actorId}-${Date.now()}-${index}`
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) {
      globalThis.clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
  }
}
