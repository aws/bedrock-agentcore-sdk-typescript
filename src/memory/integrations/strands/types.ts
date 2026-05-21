import type { Message, SystemPrompt } from '@strands-agents/sdk'
import type { MemoryClientConfig } from '../../types.js'
import type { MemoryClient } from '../../client.js'

export interface NamespaceConfig {
  topK?: number
  relevanceScore?: number
}

export type DroppedEventReason = 'retry-failed' | 'max-drain-iterations' | 'post-shutdown' | 'timeout'

export interface DroppedEventInfo {
  reason: DroppedEventReason
  count: number
  clientToken?: string | undefined
  cause?: unknown
}

export interface ExtractionConfig {
  /**
   * Number of buffered messages that triggers an automatic flush.
   *
   * Note: this controls *when* the buffer drains, not how many messages are
   * sent per API call. The service's `createEvent` accepts one event at a
   * time, so each buffered message becomes one `createEvent` call regardless
   * of `batchSize`. Lower values reduce buffering latency and memory; higher
   * values reduce flush overhead at the cost of holding messages in memory
   * longer.
   *
   * Default: 10. Must be a positive integer.
   */
  batchSize?: number
  /**
   * Maximum time (in milliseconds) a message can sit in the buffer before
   * being flushed. Resets each time the buffer drains.
   *
   * Default: 5000. Must be non-negative and finite.
   */
  batchTimeoutMs?: number
  messageFilter?: (message: Message) => boolean
  fireAndForget?: boolean
  /**
   * Per-event timeout (in milliseconds) for `createEvent` requests. If the
   * service doesn't respond within this window, the request is rejected and
   * the retry uses the same `clientToken` for idempotency.
   *
   * Default: 10000. Must be a positive finite number.
   */
  flushTimeoutMs?: number
  /**
   * Upper bound on the number of flush passes performed in a single drain.
   * Guards against pathological producers that keep adding messages while
   * the buffer is being drained. Any messages still buffered after the cap
   * is reached are reported via `onDroppedEvents` with reason
   * `'max-drain-iterations'`.
   *
   * Default: 10. Must be a positive integer.
   */
  maxDrainIterations?: number
  /**
   * Callback fired whenever extraction drops one or more events. Gives
   * customers a structured hook for alerting / metrics that `console.warn`
   * alone doesn't provide. Called synchronously; keep the handler fast.
   */
  onDroppedEvents?: (info: DroppedEventInfo) => void
}

export interface InjectionConfig {
  namespaces: Record<string, NamespaceConfig>
  automatic?: boolean
  searchTool?: boolean
  maxInjectionChars?: number
  contextTag?: string
  formatMemories?: (records: MemoryRecordGroup[]) => string
}

export interface AgentCoreMemoryConfig {
  memoryId: string
  actorId: string
  sessionId: string
  extraction?: boolean | ExtractionConfig
  injection?: InjectionConfig
  metadataProvider?: (message: Message) => Record<string, { stringValue: string }>
  memoryClient?: MemoryClientConfig | MemoryClient
}

export interface MemoryRecordGroup {
  namespace: string
  label: string
  records: MemoryRecord[]
}

export interface MemoryRecord {
  content: string
  score?: number
  createdAt?: Date
}

export interface ResolvedExtractionConfig {
  batchSize: number
  batchTimeoutMs: number
  messageFilter: (message: Message) => boolean
  fireAndForget: boolean
  flushTimeoutMs: number
  maxDrainIterations: number
  onDroppedEvents: ((info: DroppedEventInfo) => void) | undefined
}

export type MetadataProviderFn = (message: Message) => Record<string, { stringValue: string }>

const DEFAULT_EXTRACTION: ResolvedExtractionConfig = {
  batchSize: 10,
  batchTimeoutMs: 5000,
  messageFilter: () => true,
  fireAndForget: false,
  flushTimeoutMs: 10000,
  maxDrainIterations: 10,
  onDroppedEvents: undefined,
}

function isNonNegative(n: number): boolean {
  return Number.isFinite(n) && n >= 0 && !Object.is(n, -0)
}

export function resolveExtractionConfig(
  config: boolean | ExtractionConfig | undefined
): ResolvedExtractionConfig | null {
  if (config === undefined || config === false) {
    return null
  }
  if (config === true) {
    return Object.freeze({ ...DEFAULT_EXTRACTION })
  }
  if (config.batchSize !== undefined && (!Number.isInteger(config.batchSize) || config.batchSize < 1)) {
    throw new TypeError(`extraction.batchSize must be a positive integer, got ${config.batchSize}`)
  }
  if (config.batchTimeoutMs !== undefined && !isNonNegative(config.batchTimeoutMs)) {
    throw new TypeError(`extraction.batchTimeoutMs must be a non-negative finite number, got ${config.batchTimeoutMs}`)
  }
  if (config.flushTimeoutMs !== undefined && (!isNonNegative(config.flushTimeoutMs) || config.flushTimeoutMs < 1)) {
    throw new TypeError(`extraction.flushTimeoutMs must be a positive finite number, got ${config.flushTimeoutMs}`)
  }
  if (
    config.maxDrainIterations !== undefined &&
    (!Number.isInteger(config.maxDrainIterations) || config.maxDrainIterations < 1)
  ) {
    throw new TypeError(`extraction.maxDrainIterations must be a positive integer, got ${config.maxDrainIterations}`)
  }
  return Object.freeze({
    batchSize: config.batchSize ?? DEFAULT_EXTRACTION.batchSize,
    batchTimeoutMs: config.batchTimeoutMs ?? DEFAULT_EXTRACTION.batchTimeoutMs,
    messageFilter: config.messageFilter ?? DEFAULT_EXTRACTION.messageFilter,
    fireAndForget: config.fireAndForget ?? DEFAULT_EXTRACTION.fireAndForget,
    flushTimeoutMs: config.flushTimeoutMs ?? DEFAULT_EXTRACTION.flushTimeoutMs,
    maxDrainIterations: config.maxDrainIterations ?? DEFAULT_EXTRACTION.maxDrainIterations,
    onDroppedEvents: config.onDroppedEvents ?? DEFAULT_EXTRACTION.onDroppedEvents,
  })
}

export function resolveNamespaceTemplate(ns: string, actorId: string, sessionId: string): string {
  return ns.replace(/\{actorId\}/g, actorId).replace(/\{sessionId\}/g, sessionId)
}

export function resolveNamespaces(
  namespaces: Record<string, NamespaceConfig>,
  actorId: string,
  sessionId: string
): Record<string, NamespaceConfig> {
  const resolved: Record<string, NamespaceConfig> = {}
  for (const [ns, cfg] of Object.entries(namespaces)) {
    resolved[resolveNamespaceTemplate(ns, actorId, sessionId)] = cfg
  }
  return resolved
}

export type { SystemPrompt }
