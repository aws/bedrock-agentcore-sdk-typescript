import type { AwsCredentialIdentityProvider } from '@aws-sdk/types'
import type { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore'
import type { ExtractionConfig, MemoryStoreConfig, MessageData } from './_strands-memory-types.js'

/** Default region used when none is supplied and `AWS_REGION` is unset. */
export const DEFAULT_REGION = 'us-west-2'

/** Default per-store result cap when neither call-level nor store-level `maxSearchResults` is set. */
export const DEFAULT_MAX_SEARCH_RESULTS = 5

/** Over-fetch multiplier applied to `topK` when a `minScore` floor is configured (see store search). */
export const OVERFETCH_FACTOR = 4

/** Hard cap on `topK` so over-fetching never requests an unbounded page. */
export const MAX_TOPK = 100

/**
 * How a store's `search()` targets AgentCore long-term records.
 * - `'per-namespace'`: query one exact namespace prefix (`namespace`); one store per namespace.
 * - `'subtree'`: query a parent path hierarchically (`namespacePath`), covering all child namespaces.
 */
export type ReadMode = 'per-namespace' | 'subtree'

/** Per-message metadata attached to each `createEvent`. Values use the AgentCore metadata shape. */
export type MetadataProvider = (message: MessageData) => Record<string, { stringValue: string }>

/** Reason a buffered write was dropped, surfaced to {@link AgentCoreWriteOptions.onDropped}. */
export type DropReason = 'retry-failed' | 'timeout'

/** Information about a dropped event write. */
export interface DroppedEventInfo {
  reason: DropReason
  /** The text of the message whose event was dropped, for diagnostics. */
  text: string
  cause?: unknown
}

/** Batching/resilience knobs for the write fan-out. */
export interface AgentCoreWriteOptions {
  /** Per-`createEvent` timeout in ms (a slow send is dropped, not retried forever). Default 10000. */
  sendTimeoutMs?: number
  /** Called when an event is dropped after its single retry or on timeout. */
  onDropped?: (info: DroppedEventInfo) => void
}

/**
 * Reusable connection + write-identity config, shared across the stores of one
 * `(actorId, sessionId)`. Build it once and spin up one store per namespace (mirrors the shared-config
 * pattern used by `BedrockKnowledgeBaseStore`). Fixed for the store's lifetime; a multi-actor server
 * builds a fresh config per `(actorId, sessionId)`.
 */
export interface AgentCoreMemoryConfig {
  /** AgentCore Memory resource id. */
  readonly memoryId: string
  /** AgentCore actor id. */
  readonly actorId: string
  /** AgentCore session id. */
  readonly sessionId: string

  /** Optional per-message metadata attached to each `createEvent`. */
  readonly metadataProvider?: MetadataProvider | undefined
  /** Resilience knobs for the write path. */
  readonly writeOptions?: AgentCoreWriteOptions | undefined

  /** Region for the default client. Ignored if `client` is supplied. */
  readonly region?: string | undefined
  /** Credentials for the default client. Ignored if `client` is supplied. */
  readonly credentialsProvider?: AwsCredentialIdentityProvider | undefined
  /** Pre-constructed AWS client (e.g. shared across a set of stores). */
  readonly client?: BedrockAgentCoreClient | undefined
}

/**
 * Config for a single {@link AgentCoreMemoryStore}.
 *
 * Extends the framework's {@link MemoryStoreConfig} (contributing `name` / `description` /
 * `maxSearchResults` / `writable` / `extraction`) with the shared {@link AgentCoreMemoryConfig} and
 * this store's per-namespace identity. The factory builds the shared `config` once and one of these
 * per namespace.
 */
export interface AgentCoreMemoryStoreConfig extends MemoryStoreConfig {
  /** Shared connection + write identity, reused across the stores of one `(actorId, sessionId)`. */
  readonly config: AgentCoreMemoryConfig

  /**
   * The namespace template this store reads from (e.g. `/strategy/{id}/actor/{actorId}/preferences`).
   * `{actorId}` / `{sessionId}` are substituted at construction. For `readMode: 'subtree'` this is the
   * parent path queried via `namespacePath`; for `'per-namespace'` it is the prefix queried via `namespace`.
   */
  readonly namespace: string
  readonly readMode: ReadMode

  /** Optional client-side relevance floor; records scoring below it are dropped from results. */
  readonly minScore?: number

  /** Required here (the base leaves it optional): exactly one store in a factory set is writable. */
  readonly writable: boolean

  /** Present only on the writable store; AgentCore uses server-side extraction, so no client extractor. */
  readonly extraction?: ExtractionConfig
}

/**
 * Resolve a namespace template against an actor/session, substituting `{actorId}` and `{sessionId}`.
 * Unknown placeholders are left intact (e.g. `{memoryStrategyId}`, which the service resolves).
 */
export function resolveNamespace(template: string, actorId: string, sessionId: string): string {
  return template.replace(/\{actorId\}/g, actorId).replace(/\{sessionId\}/g, sessionId)
}
