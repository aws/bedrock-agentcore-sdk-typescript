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
  private buffer: Array<{ message: Message; clientToken: string }> = []
  private flushTimer?: ReturnType<typeof globalThis.setTimeout> | undefined
  private pendingFlush: Promise<void> | null = null
  private shuttingDown = false
  private postShutdownDropWarned = false
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
      this.bufferMessage(message)
    } catch (err) {
      console.warn('[agentcore-memory] Error buffering message:', err)
    }
  }

  private async handleAfterInvocation(): Promise<void> {
    this.clearFlushTimer()
    if (this.extractionConfig!.fireAndForget) {
      void this.drainUntilEmpty()
    } else {
      await this.drainUntilEmpty()
    }
  }

  /**
   * Force an immediate flush of any buffered events and wait for completion.
   * Safe to call from user code when the agent terminates or a checkpoint is needed.
   * Loops until the buffer is empty or {@link ResolvedExtractionConfig.maxDrainIterations}
   * is reached.
   */
  async flush(): Promise<void> {
    if (!this.extractionConfig) return
    this.clearFlushTimer()
    await this.drainUntilEmpty()
  }

  /**
   * Stop accepting new buffered messages, cancel pending timers, and await the
   * final flush. After shutdown the plugin is inert — subsequent events are ignored.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true
    this.clearFlushTimer()
    if (!this.extractionConfig) return
    await this.drainUntilEmpty()
  }

  private shouldBuffer(message: Message): boolean {
    if (!this.extractionConfig) return false
    if (this.shuttingDown) {
      if (!this.postShutdownDropWarned) {
        this.postShutdownDropWarned = true
        console.warn('[agentcore-memory] Dropping message received after shutdown()')
      }
      this.notifyDropped({ reason: 'post-shutdown', count: 1 })
      return false
    }
    const role = message.role
    if (role !== 'user' && role !== 'assistant') return false
    // Skip messages with no extractable text (image-only, tool-use-only,
    // reasoning-only). Prevents wasted createEvent calls with text: "".
    if (!extractText(message)) return false
    return this.extractionConfig.messageFilter(message)
  }

  private notifyDropped(info: DroppedEventInfo): void {
    const cb = this.extractionConfig?.onDroppedEvents
    if (!cb) return
    try {
      cb(info)
    } catch (err) {
      console.warn('[agentcore-memory] onDroppedEvents callback threw:', err)
    }
  }

  private bufferMessage(message: Message): void {
    const clientToken = this.generateClientToken()
    this.buffer.push({ message, clientToken })

    if (this.buffer.length >= this.extractionConfig!.batchSize) {
      void this.drainUntilEmpty()
      return
    }

    if (!this.flushTimer && this.buffer.length === 1) {
      this.flushTimer = globalThis.setTimeout(() => {
        void this.drainUntilEmpty()
      }, this.extractionConfig!.batchTimeoutMs)
    }
  }

  /**
   * Drain the buffer across multiple flush passes. Each pass takes a snapshot
   * of the current buffer; any messages that arrive during the pass (from
   * concurrent MessageAddedEvent callbacks) are picked up on the next iteration.
   * Bounded by {@link ResolvedExtractionConfig.maxDrainIterations} to guard against
   * pathological producers.
   */
  private async drainUntilEmpty(): Promise<void> {
    if (this.pendingFlush) {
      await this.pendingFlush
      return
    }

    const run = async (): Promise<void> => {
      const maxIter = this.extractionConfig!.maxDrainIterations
      for (let i = 0; i < maxIter && this.buffer.length > 0; i++) {
        await this.flushBuffer()
      }
      if (this.buffer.length > 0) {
        const stranded = this.buffer.length
        console.warn(
          `[agentcore-memory] flush reached maxDrainIterations=${this.extractionConfig!.maxDrainIterations} with ${stranded} message(s) still buffered`
        )
        this.notifyDropped({ reason: 'max-drain-iterations', count: stranded })
      }
    }

    this.pendingFlush = run().finally(() => {
      this.pendingFlush = null
    })
    await this.pendingFlush
  }

  private async flushBuffer(): Promise<void> {
    if (this.buffer.length === 0) return

    const toFlush = [...this.buffer]
    this.buffer = []
    this.clearFlushTimer()

    const results = await Promise.allSettled(
      toFlush.map((entry) => this.createEventFromMessage(entry.message, entry.clientToken))
    )

    const failed: number[] = []
    for (let i = 0; i < results.length; i++) {
      if (results[i]!.status === 'rejected') failed.push(i)
    }

    if (failed.length === 0) return

    const retryResults = await Promise.allSettled(
      failed.map((i) => this.createEventFromMessage(toFlush[i]!.message, toFlush[i]!.clientToken))
    )
    const failedDetails: Array<{ token: string; reason: unknown }> = []
    for (let j = 0; j < retryResults.length; j++) {
      const r = retryResults[j]!
      if (r.status === 'rejected') {
        failedDetails.push({ token: toFlush[failed[j]!]!.clientToken, reason: r.reason })
      }
    }
    if (failedDetails.length === 0) return

    for (const detail of failedDetails) {
      console.warn(`[agentcore-memory] Dropping event after retry (clientToken=${detail.token}):`, detail.reason)
      this.notifyDropped({ reason: 'retry-failed', count: 1, clientToken: detail.token, cause: detail.reason })
    }
    console.warn(`[agentcore-memory] Dropped ${failedDetails.length} event(s) after retry`)
  }

  /**
   * Wraps each createEvent call in a Promise.race against flushTimeoutMs so a
   * hung remote can't stall agent.invoke() indefinitely. The body of the call is
   * wrapped in Promise.resolve().then(...) so a synchronous throw (e.g. from a
   * user-supplied metadataProvider) becomes a rejected promise instead of
   * escaping Promise.allSettled's isolation.
   */
  private createEventFromMessage(message: Message, clientToken: string): Promise<unknown> {
    const timeoutMs = this.extractionConfig!.flushTimeoutMs
    const call = Promise.resolve().then(() => {
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
    })

    let timer: ReturnType<typeof globalThis.setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = globalThis.setTimeout(() => {
        const msg = `[agentcore-memory] createEvent timed out after ${timeoutMs}ms (clientToken=${clientToken}); retry will use same token`
        console.warn(msg)
        this.notifyDropped({ reason: 'timeout', count: 1, clientToken, cause: new Error(msg) })
        reject(new Error(msg))
      }, timeoutMs)
    })

    return Promise.race([call, timeout]).finally(() => {
      if (timer) globalThis.clearTimeout(timer)
    })
  }

  private generateClientToken(): string {
    const { sessionId, actorId } = this.originalConfig
    const counter = this.tokenCounter++
    return `${sessionId}-${actorId}-${Date.now()}-${counter}-${Math.random().toString(36).slice(2, 10)}`
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) {
      globalThis.clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
  }
}
