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
} from './_strands-memory-types.js'
import {
  type AgentCoreMemoryStoreConfig,
  DEFAULT_MAX_SEARCH_RESULTS,
  DEFAULT_REGION,
  MAX_TOPK,
  OVERFETCH_FACTOR,
  type ReadMode,
  resolveNamespace,
} from './types.js'
import { AgentCoreEventSender } from './sender.js'

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
  readonly extraction?: ExtractionConfig

  private readonly client: BedrockAgentCoreClient
  private readonly memoryId: string
  private readonly actorId: string
  private readonly sessionId: string
  private readonly resolvedNamespace: string
  private readonly readMode: ReadMode
  private readonly minScore?: number
  private readonly sender?: AgentCoreEventSender

  constructor(config: AgentCoreMemoryStoreConfig) {
    this.name = config.name
    if (config.description !== undefined) this.description = config.description
    if (config.maxSearchResults !== undefined) this.maxSearchResults = config.maxSearchResults
    this.writable = config.writable
    if (config.writable && config.extraction !== undefined) this.extraction = config.extraction
    this.memoryId = config.memoryId
    this.actorId = config.actorId
    this.sessionId = config.sessionId
    this.resolvedNamespace = resolveNamespace(config.namespace, config.actorId, config.sessionId)
    this.readMode = config.readMode
    if (config.minScore !== undefined) this.minScore = config.minScore

    this.client =
      config.client ??
      new BedrockAgentCoreClient({
        region: config.region ?? process.env.AWS_REGION ?? DEFAULT_REGION,
        ...(config.credentialsProvider && { credentials: config.credentialsProvider }),
      })

    if (config.writable) {
      this.sender = new AgentCoreEventSender({
        client: this.client,
        memoryId: config.memoryId,
        actorId: config.actorId,
        sessionId: config.sessionId,
        metadataProvider: config.metadataProvider,
        writeOptions: config.writeOptions,
      })
    }
  }

  // --- READ ---

  async search(query: string, options?: SearchOptions): Promise<MemoryEntry[]> {
    const want = options?.maxSearchResults ?? this.maxSearchResults ?? DEFAULT_MAX_SEARCH_RESULTS
    // With a minScore floor, over-fetch then trim so the client-side filter doesn't under-deliver
    // when above-floor records exist deeper in the ranking. With no floor, topK == want.
    const topK = this.minScore == null ? want : Math.min(want * OVERFETCH_FACTOR, MAX_TOPK)

    const command = new RetrieveMemoryRecordsCommand({
      memoryId: this.memoryId,
      searchCriteria: { searchQuery: query, topK },
      ...(this.readMode === 'subtree'
        ? { namespacePath: this.resolvedNamespace }
        : { namespace: this.resolvedNamespace }),
    })

    let summaries: MemoryRecordSummary[]
    try {
      const out = await this.client.send(command)
      summaries = out.memoryRecordSummaries ?? []
    } catch (err) {
      // Fail-open: a failed recall must never break the agent loop. Return nothing for this store.
      console.warn(`[agentcore-memory] search failed for store "${this.name}":`, err)
      return []
    }

    return summaries
      .filter((r) => this.minScore == null || (r.score ?? 0) >= this.minScore)
      .slice(0, want)
      .map((r) => this.toEntry(r))
  }

  private toEntry(record: MemoryRecordSummary): MemoryEntry {
    const metadata: Record<string, JSONValue> = {}
    if (record.memoryRecordId !== undefined) metadata.id = record.memoryRecordId
    if (record.score !== undefined) metadata.score = record.score
    if (record.namespaces !== undefined) metadata.namespaces = record.namespaces
    return { content: memoryContentText(record.content), metadata }
  }

  // --- WRITE (no-extractor sink) ---

  async addMessages(messages: MessageData[], context?: AddMessagesContext): Promise<void> {
    if (!this.sender) {
      // Not writable: the manager should never call this, but guard so a misconfiguration is loud.
      throw new Error(`AgentCoreMemoryStore "${this.name}" is not writable; addMessages is unavailable`)
    }
    await this.sender.sendBatch(messages, context?.seqs)
  }

  // `add` is intentionally not implemented (see class doc). `add_memory` stays off at the manager.
}
