/// <reference types="node" />

import type { Plugin, Tool } from '@strands-agents/sdk'
import { BeforeInvocationEvent, MessageAddedEvent, AfterInvocationEvent } from '@strands-agents/sdk'
import type { LocalAgent, Message, SystemPrompt } from '@strands-agents/sdk'
import { MemoryClient } from '../../client.js'
import type {
  AgentCoreMemoryConfig,
  DroppedEventInfo,
  InjectionConfig,
  MemoryRecordGroup,
  MemoryRecord,
  ResolvedExtractionConfig,
  NamespaceConfig,
} from './types.js'
import { resolveExtractionConfig, resolveNamespaces } from './types.js'
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
import { AsyncBatcher } from './batcher.js'
import type { BatchDropInfo } from './batcher.js'

interface BufferedMessage {
  message: Message
  clientToken: string
}

interface AgentWithSystemPrompt {
  systemPrompt?: SystemPrompt | undefined
  messages: Message[]
}

// Tracks which AgentCoreMemory instance owns which Agent. Prevents two plugins
// from both hooking the same agent — that path silently duplicates every
// extracted event under two actorIds, doubling cost + confusing LTM. A customer
// who wants multi-actor should use withActor() / withMetadataProvider() forks
// on separate agents, or construct two plugins on separate agents with distinct
// contextTags. This guard makes the failure loud instead of silent.
const AGENT_REGISTRY = new WeakMap<object, AgentCoreMemory>()

export class AgentCoreMemory implements Plugin {
  readonly name = 'agentcore-memory'

  private readonly client: MemoryClient
  private readonly originalConfig: AgentCoreMemoryConfig
  private readonly extractionConfig: ResolvedExtractionConfig | null
  private readonly injectionConfig: InjectionConfig | null
  private readonly resolvedNamespaces: Record<string, NamespaceConfig>
  private agent!: AgentWithSystemPrompt
  private initialized = false
  private batcher: AsyncBatcher<BufferedMessage> | null = null
  private searchMemoryTool?: Tool
  private tokenCounter = 0

  constructor(config: AgentCoreMemoryConfig) {
    this.originalConfig = config
    this.extractionConfig = resolveExtractionConfig(config.extraction)
    this.injectionConfig = config.injection ?? null

    if (config.memoryClient instanceof MemoryClient) {
      this.client = config.memoryClient as unknown as MemoryClient
    } else {
      this.client = new MemoryClient(config.memoryClient)
    }

    this.resolvedNamespaces = this.injectionConfig
      ? resolveNamespaces(this.injectionConfig.namespaces, config.actorId, config.sessionId)
      : {}

    if (this.injectionConfig?.searchTool) {
      this.searchMemoryTool = createSearchMemoryTool(this.client, {
        memoryId: config.memoryId,
        namespaces: this.resolvedNamespaces,
      })
    }

    if (this.extractionConfig) {
      this.batcher = new AsyncBatcher<BufferedMessage>({
        batchSize: this.extractionConfig.batchSize,
        batchTimeoutMs: this.extractionConfig.batchTimeoutMs,
        sendTimeoutMs: this.extractionConfig.flushTimeoutMs,
        maxDrainIterations: this.extractionConfig.maxDrainIterations,
        send: (entry: BufferedMessage): Promise<unknown> => this.sendOne(entry.message, entry.clientToken),
        onDropped: (info: BatchDropInfo): void => this.handleBatcherDrop(info),
        keyOf: (entry: BufferedMessage): string => entry.clientToken,
        logPrefix: '[agentcore-memory]',
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
    const existing = AGENT_REGISTRY.get(agent as unknown as object)
    if (existing) {
      throw new Error(
        'AgentCoreMemory: another AgentCoreMemory plugin is already registered on this agent. ' +
          'Registering two plugins on the same agent silently duplicates every extracted event. ' +
          'If you need multi-actor memory, use separate Agent instances with one plugin each, or ' +
          'use plugin.withActor() to fork actors within a single agent.'
      )
    }
    AGENT_REGISTRY.set(agent as unknown as object, this)
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
    return new AgentCoreMemory({ ...config, memoryClient: source.client })
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
    const templateKeys = Object.keys(config.namespaces)
    const resolvedKeys = Object.keys(this.resolvedNamespaces)

    const results = await Promise.all(
      templateKeys.map(async (templateNs, idx) => {
        const apiNamespace = resolvedKeys[idx]!
        const nsConfig = config.namespaces[templateNs]!
        const response = await this.client.retrieveMemoryRecords({
          memoryId: this.originalConfig.memoryId,
          namespace: apiNamespace,
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
          namespace: apiNamespace,
          label: deriveLabel(templateNs),
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
      this.batcher!.add({ message, clientToken: this.generateClientToken() })
    } catch (err) {
      console.warn('[agentcore-memory] Error buffering message:', err)
    }
  }

  private async handleAfterInvocation(): Promise<void> {
    if (!this.batcher) return
    if (this.extractionConfig!.fireAndForget) {
      void this.batcher.flush()
    } else {
      await this.batcher.flush()
    }
  }

  /**
   * Force an immediate flush of any buffered events and wait for completion.
   * Safe to call from user code when the agent terminates or a checkpoint is needed.
   * Loops until the buffer is empty or {@link ResolvedExtractionConfig.maxDrainIterations}
   * is reached.
   */
  async flush(): Promise<void> {
    if (!this.batcher) return
    await this.batcher.flush()
  }

  /**
   * Stop accepting new buffered messages, cancel pending timers, and await the
   * final flush. After shutdown the plugin is inert — subsequent events are ignored.
   */
  async shutdown(): Promise<void> {
    if (!this.batcher) return
    await this.batcher.shutdown()
  }

  private shouldBuffer(message: Message): boolean {
    if (!this.extractionConfig) return false
    const role = message.role
    if (role !== 'user' && role !== 'assistant') return false
    // Skip messages with no extractable text (image-only, tool-use-only,
    // reasoning-only). Prevents wasted createEvent calls with text: "".
    if (!extractText(message)) return false
    return this.extractionConfig.messageFilter(message)
  }

  /**
   * Translates the batcher's generic {@link BatchDropInfo} into the plugin's
   * customer-facing {@link DroppedEventInfo} (which uses `clientToken` instead
   * of the generic `key`). Errors thrown in the customer callback are swallowed
   * with a warning so the plugin never crashes the agent.
   */
  private handleBatcherDrop(info: BatchDropInfo): void {
    const cb = this.extractionConfig?.onDroppedEvents
    if (!cb) return
    const dropInfo: DroppedEventInfo = {
      reason: info.reason,
      count: info.count,
      ...(info.key !== undefined ? { clientToken: info.key } : {}),
      ...(info.cause !== undefined ? { cause: info.cause } : {}),
    }
    try {
      cb(dropInfo)
    } catch (err) {
      console.warn('[agentcore-memory] onDroppedEvents callback threw:', err)
    }
  }

  private sendOne(message: Message, clientToken: string): Promise<unknown> {
    const text = extractText(message)
    const metadata = this.originalConfig.metadataProvider?.(message)
    return this.client.createEvent({
      memoryId: this.originalConfig.memoryId,
      actorId: this.originalConfig.actorId,
      sessionId: this.originalConfig.sessionId,
      eventTimestamp: new Date(),
      clientToken,
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

  private generateClientToken(): string {
    const { sessionId, actorId } = this.originalConfig
    const counter = this.tokenCounter++
    return `${sessionId}-${actorId}-${Date.now()}-${counter}-${Math.random().toString(36).slice(2, 10)}`
  }
}
