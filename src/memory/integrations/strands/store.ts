import {
  BedrockAgentCoreClient,
  RetrieveMemoryRecordsCommand,
  type MemoryRecordSummary,
} from '@aws-sdk/client-bedrock-agentcore'
import type {
  AddMessagesContext,
  ExtractionConfig,
  JSONValue,
  MemoryEntry,
  MemoryStore,
  MessageData,
  SearchOptions,
} from '@strands-agents/sdk'
import {
  type AgentCoreMemoryStoreConfig,
  assertNonEmpty,
  assertResolvedNamespace,
  DEFAULT_MAX_SEARCH_RESULTS,
  DEFAULT_OVERFETCH_FACTOR,
  DEFAULT_REGION,
  MAX_TOPK,
  type ReadMode,
  RESERVED_METADATA_PREFIX,
  resolveNamespace,
} from './types.js'
import { AgentCoreEventSender } from './sender.js'
import { logger } from './logger.js'

/** Extract the text of a `MemoryContent` union member, if it is a text member. */
function memoryContentText(content: MemoryRecordSummary['content']): string {
  if (content && typeof content === 'object' && 'text' in content && typeof content.text === 'string') {
    return content.text
  }
  return ''
}

/**
 * AgentCore Memory as a Strands `MemoryStore`.
 *
 * - `search()` maps to `retrieveMemoryRecords` (long-term records).
 * - `addMessages()` maps each role-tagged message to a `createEvent` (short-term events; AgentCore
 *   extracts and consolidates into long-term records server-side). No `add()`: the conversation
 *   path is role-preserving, and a flat string would discard role.
 *
 * Identity and the namespace binding are fixed at construction. The factory builds one writable store
 * plus zero or more read-only stores per `(actorId, sessionId)`; only the writable one carries
 * `addMessages` + `extraction`.
 */
export class AgentCoreMemoryStore implements MemoryStore {
  readonly name: string
  readonly description?: string
  readonly maxSearchResults?: number
  readonly writable: boolean
  readonly extraction?: boolean | ExtractionConfig

  private readonly client: BedrockAgentCoreClient
  private readonly memoryId: string
  private readonly actorId: string
  private readonly sessionId: string
  private readonly resolvedNamespace: string
  private readonly readMode: ReadMode
  private readonly minScore?: number
  private readonly overFetchFactor: number
  private readonly sender?: AgentCoreEventSender

  constructor(storeConfig: AgentCoreMemoryStoreConfig) {
    const { config } = storeConfig
    this.name = storeConfig.name
    if (storeConfig.description !== undefined) this.description = storeConfig.description
    if (storeConfig.maxSearchResults !== undefined) {
      if (!Number.isInteger(storeConfig.maxSearchResults) || storeConfig.maxSearchResults < 1) {
        throw new Error(
          `AgentCoreMemoryStore: maxSearchResults must be a positive integer, got ${storeConfig.maxSearchResults}`
        )
      }
      this.maxSearchResults = storeConfig.maxSearchResults
    }
    this.writable = storeConfig.writable
    if (storeConfig.writable && storeConfig.extraction !== undefined) this.extraction = storeConfig.extraction
    this.memoryId = assertNonEmpty(config.memoryId, 'memoryId')
    this.actorId = assertNonEmpty(config.actorId, 'actorId')
    this.sessionId = assertNonEmpty(config.sessionId, 'sessionId')
    assertNonEmpty(storeConfig.namespace, 'namespace')
    this.resolvedNamespace = resolveNamespace(storeConfig.namespace, this.actorId, this.sessionId)
    assertResolvedNamespace(this.resolvedNamespace, storeConfig.namespace)
    this.readMode = storeConfig.readMode
    if (storeConfig.minScore !== undefined) {
      if (!Number.isFinite(storeConfig.minScore) || storeConfig.minScore < 0 || storeConfig.minScore > 1) {
        throw new Error(
          `AgentCoreMemoryStore: minScore must be a finite number between 0 and 1, got ${storeConfig.minScore}`
        )
      }
      this.minScore = storeConfig.minScore
    }
    if (
      storeConfig.overFetchFactor !== undefined &&
      (!Number.isFinite(storeConfig.overFetchFactor) || storeConfig.overFetchFactor < 1)
    ) {
      throw new Error(`AgentCoreMemoryStore: overFetchFactor must be a number >= 1, got ${storeConfig.overFetchFactor}`)
    }
    this.overFetchFactor = storeConfig.overFetchFactor ?? DEFAULT_OVERFETCH_FACTOR

    this.client =
      config.client ??
      new BedrockAgentCoreClient({
        region: config.region ?? process.env.AWS_REGION ?? DEFAULT_REGION,
        ...(config.credentialsProvider && { credentials: config.credentialsProvider }),
      })

    if (storeConfig.writable) {
      this.sender = new AgentCoreEventSender({
        client: this.client,
        memoryId: config.memoryId,
        actorId: config.actorId,
        sessionId: config.sessionId,
        metadataProvider: config.metadataProvider,
        ...(config.maxTurnsPerEvent !== undefined && { maxTurnsPerEvent: config.maxTurnsPerEvent }),
      })
    } else if (storeConfig.extraction !== undefined) {
      // extraction config on a non-writable store would be silently ignored (no write sink), so warn.
      logger.warn(
        `[agentcore-memory] store "${this.name}" has an extraction config but writable is false; ` +
          'extraction will not run for this store.'
      )
    }
  }

  // --- READ ---

  async search(query: string, options?: SearchOptions): Promise<MemoryEntry[]> {
    const want = options?.maxSearchResults ?? this.maxSearchResults ?? DEFAULT_MAX_SEARCH_RESULTS
    // With a minScore floor, over-fetch then trim so the client-side filter doesn't under-deliver
    // when above-floor records exist deeper in the ranking. With no floor, topK == want.
    const topK = this.minScore == null ? want : Math.min(want * this.overFetchFactor, MAX_TOPK)

    const command = new RetrieveMemoryRecordsCommand({
      memoryId: this.memoryId,
      searchCriteria: { searchQuery: query, topK },
      ...(this.readMode === 'subtree'
        ? { namespacePath: this.resolvedNamespace }
        : { namespace: this.resolvedNamespace }),
    })

    // Errors propagate: MemoryManager.search wraps each store's search() in Promise.allSettled, so a
    // throw is isolated to this store and surfaced through the manager's partial-failure handling
    // rather than swallowed here.
    const out = await this.client.send(command)
    return (out.memoryRecordSummaries ?? [])
      .filter((r) => this.minScore == null || (r.score ?? 0) >= this.minScore)
      .slice(0, want)
      .map((r) => this.toEntry(r))
  }

  private toEntry(record: MemoryRecordSummary): MemoryEntry {
    // Keys carry RESERVED_METADATA_PREFIX so these store-provided fields never collide with user metadata.
    const p = RESERVED_METADATA_PREFIX
    const metadata: Record<string, JSONValue> = {}
    if (record.memoryRecordId !== undefined) metadata[`${p}id`] = record.memoryRecordId
    if (record.score !== undefined) metadata[`${p}score`] = record.score
    if (record.namespaces !== undefined) metadata[`${p}namespaces`] = record.namespaces
    if (record.createdAt !== undefined) metadata[`${p}createdAt`] = record.createdAt.toISOString()
    return { content: memoryContentText(record.content), metadata }
  }

  // --- WRITE (no-extractor sink) ---

  async addMessages(messages: MessageData[], context?: AddMessagesContext): Promise<void> {
    if (!this.sender) {
      // Not writable: the manager should never call this, but guard so a misconfiguration is loud.
      throw new Error(`AgentCoreMemoryStore "${this.name}" is not writable; addMessages is unavailable`)
    }
    await this.sender.sendBatch(messages, context?.sequenceNumbers)
  }

  // `add` is intentionally not implemented (see class doc). `add_memory` stays off at the manager.
}
