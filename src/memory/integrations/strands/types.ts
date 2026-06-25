import type { AwsCredentialIdentityProvider } from '@aws-sdk/types'
import type { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore'
import type { JSONValue, MemoryStoreConfig, MessageData } from '@strands-agents/sdk'

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
 * How a store's `search()` targets AgentCore long-term records. A discriminated union that mirrors the
 * `RetrieveMemoryRecords` API directly — the member name *is* the read mode, so there is no separate
 * flag to keep in sync with the path:
 * - `{ namespace }`: query one exact namespace prefix (one store per namespace).
 * - `{ namespacePath }`: query a parent path hierarchically, covering all child namespaces (subtree).
 *
 * Exactly one member is present; the `?: never` on the other arm makes passing both a compile error.
 * Both carry a template whose `{actorId}`/`{sessionId}` are substituted at construction.
 */
export type AgentCoreReadTarget =
  | { readonly namespace: string; readonly namespacePath?: never }
  | { readonly namespacePath: string; readonly namespace?: never }

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
 * Connection + write identity for a store: the AgentCore memoryId/actorId/sessionId plus optional
 * client/credentials/tuning. Passed **flat** on every store config. The factory builds one of these once
 * (constructing the AWS client a single time) and spreads it across the stores of one actor/session set,
 * so they share the same client; a standalone store supplies the same fields directly to its constructor.
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
  /** Pre-constructed AWS client (created if omitted; the factory shares one across a store set). */
  readonly client?: BedrockAgentCoreClient | undefined
}

/**
 * Per-store fields layered on top of the framework's {@link MemoryStoreConfig} (which contributes
 * `name` / `description` / `maxSearchResults` / `writable` / `extraction`) and the read target.
 */
export interface AgentCoreMemoryStoreFields {
  /** Optional client-side relevance floor; records scoring below it are dropped from results. */
  readonly minScore?: number

  /**
   * Multiplier applied to `topK` when `minScore` is set, so the client-side floor doesn't under-deliver
   * when above-floor records sit deeper in the ranking. Defaults to {@link DEFAULT_OVERFETCH_FACTOR}.
   * Ignored when no `minScore` floor is configured. The over-fetched `topK` is capped at {@link MAX_TOPK}.
   */
  readonly overFetchFactor?: number
}

/**
 * Config for a single {@link AgentCoreMemoryStore}. One flat object: the {@link AgentCoreMemoryConfig}
 * identity (`memoryId`/`actorId`/`sessionId` required; client/credentials/tuning optional), the
 * {@link AgentCoreReadTarget} read-target union (`{ namespace }` exact, or `{ namespacePath }` subtree),
 * and the framework's store fields. `writable` defaults to `false` (recall-only); set it `true` to make
 * this the write sink. `name` defaults to a slug of the namespace template when omitted.
 */
export type AgentCoreMemoryStoreConfig = Omit<MemoryStoreConfig, 'name'> &
  AgentCoreMemoryConfig &
  AgentCoreReadTarget &
  AgentCoreMemoryStoreFields & {
    /** Store name; defaults to a slug of the namespace template (see {@link slugifyNamespace}) if omitted. */
    readonly name?: string
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
  // Replacer FUNCTIONS (not replacement strings): a value containing `$&`/`$\``/`$'`/`$$` would otherwise
  // be interpreted as a replacement pattern and silently corrupt the path. The function's return value
  // is inserted verbatim and is NOT re-scanned, which also prevents one substituted value (e.g. an
  // actorId literally containing "{sessionId}") from being re-substituted by the next replace.
  return template.replace(/\{actorId\}/g, () => actorId).replace(/\{sessionId\}/g, () => sessionId)
}

const UNRESOLVED_PLACEHOLDER = /\{[^{}]*\}/
const ANY_BRACE = /[{}]/

/**
 * Throw if `resolved` still contains a `{placeholder}` token or any lone brace. AgentCore's retrieve
 * path rejects brace characters, so either guarantees a failed recall; failing here turns that into a
 * clear, construction-time error instead of an opaque service `ValidationException` at first search.
 */
export function assertResolvedNamespace(resolved: string, template: string): void {
  const token = resolved.match(UNRESOLVED_PLACEHOLDER)
  const offending = token?.[0] ?? resolved.match(ANY_BRACE)?.[0]
  if (offending !== undefined) {
    throw new Error(
      `AgentCoreMemoryStore: namespace "${template}" still contains "${offending}" after substitution. ` +
        `Only {actorId} and {sessionId} are resolved client-side; the AgentCore retrieve path does not ` +
        `resolve placeholders and rejects "{"/"}". Provide a namespace whose only placeholders are ` +
        `{actorId}/{sessionId} (and no stray braces), or pre-substitute the others (e.g. a concrete ` +
        `strategy id) before constructing the store.`
    )
  }
}

export function assertNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`AgentCoreMemoryStore: ${field} must be a non-empty string`)
  }
  return value
}

/**
 * Derive a store name from a namespace template: strip `{placeholder}` segments, then collapse remaining
 * non-alphanumerics to `-`. `[^{}]*` (excludes both braces) is unambiguous and linear — no
 * polynomial-backtracking risk. Falls back to `'agentcore-memory'` if nothing usable remains.
 */
export function slugifyNamespace(ns: string): string {
  const slug = ns
    .replace(/\{[^{}]*\}/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.length > 0 ? slug : 'agentcore-memory'
}
