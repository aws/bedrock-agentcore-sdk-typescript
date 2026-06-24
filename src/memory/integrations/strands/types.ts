import type { AwsCredentialIdentityProvider } from '@aws-sdk/types'
import type { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore'
import type { ExtractionConfig, JSONValue, MemoryStoreConfig, MessageData } from '@strands-agents/sdk'

/** Default region used when none is supplied and `AWS_REGION` is unset. */
export const DEFAULT_REGION = 'us-west-2'

/** Default per-store result cap when neither call-level nor store-level `maxSearchResults` is set. */
export const DEFAULT_MAX_SEARCH_RESULTS = 5

/** Default over-fetch multiplier applied to `topK` when a `minScore` floor is configured (see store search). */
export const DEFAULT_OVERFETCH_FACTOR = 4

/** Hard cap on `topK` so over-fetching never requests an unbounded page. */
export const MAX_TOPK = 100

/**
 * Default maximum conversational turns packed into a single `createEvent`. One flush of N turns is sent
 * as `ceil(n / this)` events instead of N calls — the lever that lets trigger cadence control API-call
 * volume. Kept well under the service's accepted payload size.
 */
export const DEFAULT_MAX_TURNS_PER_EVENT = 50

/**
 * Prefix for the store-provided metadata keys on a returned {@link MemoryStore} entry (`_id`, `_score`,
 * `_namespaces`, `_createdAt`). Underscored so they never collide with user-defined metadata; callers
 * should avoid this prefix for their own keys.
 */
export const RESERVED_METADATA_PREFIX = '_'

/**
 * How a store's `search()` targets AgentCore long-term records.
 * - `'per-namespace'`: query one exact namespace prefix (`namespace`); one store per namespace.
 * - `'subtree'`: query a parent path hierarchically (`namespacePath`), covering all child namespaces.
 */
export type ReadMode = 'per-namespace' | 'subtree'

/**
 * Per-message metadata attached to each `createEvent`. Returns a JSON bag; the sender maps each value
 * to AgentCore's `{ stringValue }` event-metadata shape (stringifying non-strings).
 *
 * AgentCore restricts metadata values to `[a-zA-Z0-9\s._:/=+@-]` (letters, digits, whitespace, and
 * `._:/=+@-`). Prefer scalar string/number/boolean values; **avoid arrays/objects** — they stringify to
 * JSON containing `[]{}",` which the service rejects. A value outside the allowed set throws a clear
 * client-side error (naming the key) rather than failing opaquely server-side at `createEvent`.
 */
export type MetadataProvider = (message: MessageData) => Record<string, JSONValue>

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

  /**
   * Max conversational turns packed into a single `createEvent` write (see
   * {@link DEFAULT_MAX_TURNS_PER_EVENT}). Lower it to cap payload size; the extraction trigger cadence
   * controls how many turns accumulate before a flush.
   */
  readonly maxTurnsPerEvent?: number | undefined

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

  /**
   * Multiplier applied to `topK` when `minScore` is set, so the client-side floor doesn't under-deliver
   * when above-floor records sit deeper in the ranking. Defaults to {@link DEFAULT_OVERFETCH_FACTOR}.
   * Ignored when no `minScore` floor is configured. The over-fetched `topK` is capped at {@link MAX_TOPK}.
   */
  readonly overFetchFactor?: number

  /** Required here (the base leaves it optional): exactly one store in a factory set is writable. */
  readonly writable: boolean

  /**
   * Present only on the writable store; AgentCore uses server-side extraction, so no client extractor.
   * `true` defers to the MemoryManager's default cadence (its `IntervalTrigger`); an object sets a
   * custom trigger/filter.
   */
  readonly extraction?: boolean | ExtractionConfig
}

/**
 * Resolve a namespace template against an actor/session, substituting `{actorId}` and `{sessionId}`.
 *
 * Only these two placeholders are resolved client-side. AgentCore resolves every placeholder (including
 * `{memoryStrategyId}`) at *extraction* time and stores records under the fully-resolved concrete path,
 * but `retrieveMemoryRecords` does NOT resolve placeholders on the *read* path — and in fact rejects a
 * `{`/`}` in the namespace with a `ValidationException`. So any unresolved placeholder left here would
 * make recall fail. {@link assertResolvedNamespace} catches that at construction with a clear message.
 */
export function resolveNamespace(template: string, actorId: string, sessionId: string): string {
  return template.replace(/\{actorId\}/g, actorId).replace(/\{sessionId\}/g, sessionId)
}

/** Matches any `{placeholder}` token left in a string. */
const UNRESOLVED_PLACEHOLDER = /\{[^{}]*\}/

/**
 * Throw if `resolved` still contains a `{placeholder}`. AgentCore's retrieve path rejects brace
 * characters, so an unresolved token guarantees a failed recall; failing here turns that into a clear,
 * construction-time error instead of an opaque service `ValidationException` at first search.
 */
export function assertResolvedNamespace(resolved: string, template: string): void {
  const match = resolved.match(UNRESOLVED_PLACEHOLDER)
  if (match) {
    throw new Error(
      `AgentCoreMemoryStore: namespace "${template}" still contains the unresolved placeholder ` +
        `"${match[0]}" after substitution. Only {actorId} and {sessionId} are resolved client-side; ` +
        `the AgentCore retrieve path does not resolve placeholders and rejects "{"/"}". Provide a ` +
        `namespace whose only placeholders are {actorId}/{sessionId}, or pre-substitute the others ` +
        `(e.g. a concrete strategy id) before constructing the store.`
    )
  }
}

/** Throw if a required string field is missing or whitespace-only. */
export function assertNonEmpty(value: string | undefined, field: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`AgentCoreMemoryStore: ${field} must be a non-empty string`)
  }
  return value
}
