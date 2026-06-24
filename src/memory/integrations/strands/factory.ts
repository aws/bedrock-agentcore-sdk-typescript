import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore'
import type { AwsCredentialIdentityProvider } from '@aws-sdk/types'
import type { ExtractionConfig, ExtractionTrigger, MemoryMessageFilter } from '@strands-agents/sdk'
import { AgentCoreMemoryStore } from './store.js'
import {
  type AgentCoreMemoryConfig,
  type AgentCoreMemoryStoreConfig,
  DEFAULT_REGION,
  type MetadataProvider,
} from './types.js'

/** How the factory builds a read store: one store per namespace, or one store over a common parent subtree. */
export type ReadMode = 'per-namespace' | 'subtree'

/** Per-namespace read configuration. */
export interface AgentCoreNamespaceConfig {
  /** Namespace template, e.g. `/strategy/{id}/actor/{actorId}/preferences`. */
  namespace: string
  /** Store name; defaults to a slug derived from the namespace. */
  name?: string
  description?: string
  maxSearchResults?: number
  minScore?: number
  /** Over-fetch multiplier when `minScore` is set (see {@link AgentCoreMemoryStoreConfig.overFetchFactor}). */
  overFetchFactor?: number
  /**
   * Marks this namespace's store as the single write sink (`addMessages` + extraction). Because
   * `createEvent` is namespace-free, at most one store may be writable. When `extraction` is enabled and
   * no namespace sets this, the first namespace is the writer. {@link assertWritableTopology} enforces
   * the at-most-one rule.
   */
  writable?: boolean
}

/**
 * Object form of the {@link CreateAgentCoreMemoryStoresInput.extraction} switch: writable, with optional
 * control over write cadence and which message content is written.
 */
export interface AgentCoreExtractionConfig {
  /**
   * Write cadence — when buffered turns are flushed to `createEvent`. Omit to defer to the
   * MemoryManager's default (Strands' `IntervalTrigger`, every few turns), consistent with other Strands
   * stores. Pass any Strands {@link ExtractionTrigger} (e.g. `IntervalTrigger`/`InvocationTrigger`), or
   * an array to compose several.
   *
   * Cadence vs durability: a trigger only controls *when* a flush is dispatched (fire-and-forget; the
   * coordinator never awaits it). At a true end-of-session there is no next turn, so a tail that hasn't
   * fired is lost. The durability mechanism is {@link MemoryManager.flush}, called where the runtime is
   * alive (e.g. the end of an invocation handler) — it awaits the writes. Cadence reduces API-call
   * volume; `flush()` guarantees the data lands.
   */
  cadence?: ExtractionTrigger | ExtractionTrigger[]
  /**
   * Which message content blocks to exclude before writing (the extraction `filter`). Omit to use the
   * framework default (drops tool use/result). Forwarded to the store's `ExtractionConfig.filter`.
   */
  filter?: MemoryMessageFilter
}

export interface CreateAgentCoreMemoryStoresInput {
  memoryId: string
  actorId: string
  sessionId: string

  /** Read namespaces. `per-namespace` yields one store each; `subtree` yields one store over a common parent. */
  namespaces: AgentCoreNamespaceConfig[]

  /** Default `'per-namespace'`. */
  readMode?: ReadMode

  /** `subtree` only: explicit parent path. If omitted, the longest common prefix of `namespaces` is used. */
  parentNamespace?: string

  /**
   * The single write switch (mirrors the framework's `boolean | config` shorthand). For AgentCore,
   * writable, extraction-enabled, and "writes via createEvent" are one concept, so they collapse here:
   * omitted or `false` means recall-only (every store search-only, no writes); `true` means writable
   * with the framework's default cadence; `{ cadence?, filter? }` means writable with a custom
   * cadence/filter. Which namespace is the writer is chosen by the per-namespace `writable` flag (else
   * the first namespace).
   */
  extraction?: boolean | AgentCoreExtractionConfig

  metadataProvider?: MetadataProvider

  /**
   * Max conversational turns packed into one `createEvent` write (default
   * {@link DEFAULT_MAX_TURNS_PER_EVENT}). Combined with the extraction trigger cadence, this controls
   * write API-call volume: a flush of N turns is sent as `ceil(n / maxTurnsPerEvent)` events.
   */
  maxTurnsPerEvent?: number

  region?: string
  credentialsProvider?: AwsCredentialIdentityProvider
  /** Shared client; one is constructed (and reused across the returned stores) if omitted. */
  client?: BedrockAgentCoreClient
}

/** Longest common path-segment prefix of the given namespace templates. */
function commonParent(namespaces: string[]): string | undefined {
  if (namespaces.length === 0) return undefined
  const split = namespaces.map((ns) => ns.split('/'))
  const first = split[0]!
  const prefix: string[] = []
  for (let i = 0; i < first.length; i++) {
    const seg = first[i]
    if (split.every((parts) => parts[i] === seg)) prefix.push(seg!)
    else break
  }
  const joined = prefix.join('/')
  return joined.length > 0 ? joined : undefined
}

/**
 * Build one store's config from the shared identity bundle + per-namespace settings. Emits the
 * {@link AgentCoreReadTarget} arm matching `readMode` (`namespacePath` for subtree, else `namespace`).
 * Optional fields are spread conditionally so explicit `undefined` never violates
 * `exactOptionalPropertyTypes`. The store self-names from the template, so `name` is only set when the
 * caller gave one explicitly.
 */
function buildStoreConfig(args: {
  config: AgentCoreMemoryConfig
  ns: AgentCoreNamespaceConfig
  template: string
  readMode: ReadMode
  writable: boolean
  extraction: boolean | ExtractionConfig | undefined
}): AgentCoreMemoryStoreConfig {
  const { config, ns, template, readMode, writable, extraction } = args
  return {
    // Spread the shared identity flat — same client/identity object reused across the set.
    ...config,
    ...(readMode === 'subtree' ? { namespacePath: template } : { namespace: template }),
    writable,
    ...(ns.name !== undefined && { name: ns.name }),
    ...(ns.description !== undefined && { description: ns.description }),
    ...(ns.maxSearchResults !== undefined && { maxSearchResults: ns.maxSearchResults }),
    ...(ns.minScore !== undefined && { minScore: ns.minScore }),
    ...(ns.overFetchFactor !== undefined && { overFetchFactor: ns.overFetchFactor }),
    ...(writable && extraction !== undefined && { extraction }),
  }
}

/**
 * Enforce the AgentCore write topology: **at most one** store may be writable. Because `createEvent` is
 * namespace-free (it writes the whole conversation to the `(memoryId, actorId, sessionId)` stream),
 * two writable stores would emit duplicate events — and nothing upstream dedupes them (the
 * `MemoryManager` schedules each extraction store independently; the per-sender idempotency token is
 * keyed on a per-store run id, so it cannot collapse cross-store duplicates). The single-writer rule can
 * therefore only be enforced here, at construction. Exported so hand-built (`new`) multi-store setups
 * can guard themselves too.
 *
 * - `0` writable: OK (recall-only) — unless `expectExtraction` is set (a writer is required to run it).
 * - `1` writable: OK.
 * - `>1` writable: always an error.
 */
export function assertWritableTopology(stores: readonly AgentCoreMemoryStore[], expectExtraction = false): void {
  const writers = stores.filter((s) => s.writable)
  if (writers.length > 1) {
    throw new Error(
      `AgentCore memory: at most one store may be writable, but ${writers.length} are ` +
        `(${writers.map((s) => `"${s.name}"`).join(', ')}). createEvent is namespace-free, so multiple ` +
        'writable stores would write duplicate events to the same (memoryId, actorId, sessionId) stream. ' +
        'Mark exactly one namespace writable.'
    )
  }
  if (expectExtraction && writers.length === 0) {
    throw new Error(
      'AgentCore memory: extraction is enabled but no store is writable. Mark one namespace ' +
        '`writable: true` (or omit extraction for recall-only).'
    )
  }
}

/**
 * Build the AgentCore store topology for one `(actorId, sessionId)`, ready to spread into
 * `MemoryManagerConfig.stores`.
 *
 * - `per-namespace` (default): one store per namespace; when `extraction` is enabled, exactly one
 *   (the namespace flagged `writable`, else the first) is writable and carries `addMessages` +
 *   `extraction`. The rest are search-only. When `extraction` is omitted/`false`, all stores are
 *   search-only (unless a namespace is explicitly `writable`).
 * - `subtree`: one store reading a parent path via `namespacePath` (writable iff `extraction` is enabled).
 *
 * Because `createEvent` is namespace-free, writes always go through exactly one store regardless of read
 * shape; {@link assertWritableTopology} enforces that. A multi-actor/session server calls this once per
 * `(actorId, sessionId)`.
 */
export function createAgentCoreMemoryStores(input: CreateAgentCoreMemoryStoresInput): AgentCoreMemoryStore[] {
  if (input.namespaces.length === 0) {
    throw new Error('createAgentCoreMemoryStores: at least one namespace is required')
  }
  input.namespaces.forEach((ns, i) => {
    if (ns.namespace === undefined || ns.namespace.trim().length === 0) {
      throw new Error(`createAgentCoreMemoryStores: namespaces[${i}].namespace must be a non-empty string`)
    }
  })

  const readMode: ReadMode = input.readMode ?? 'per-namespace'

  // Resolve the single `extraction` switch into the store-facing `boolean | ExtractionConfig` value. We
  // pass `true` straight through (rather than eagerly building a trigger) so the MemoryManager applies
  // its own default cadence; we only build an `ExtractionConfig` when a custom cadence/filter is given.
  const writeEnabled = input.extraction !== undefined && input.extraction !== false
  const extractionObj: AgentCoreExtractionConfig = typeof input.extraction === 'object' ? input.extraction : {}
  const hasCustomConfig = extractionObj.cadence !== undefined || extractionObj.filter !== undefined
  const extraction: boolean | ExtractionConfig | undefined = !writeEnabled
    ? undefined
    : hasCustomConfig
      ? {
          ...(extractionObj.cadence !== undefined && { trigger: extractionObj.cadence }),
          ...(extractionObj.filter !== undefined && { filter: extractionObj.filter }),
        }
      : true

  const client =
    input.client ??
    new BedrockAgentCoreClient({
      region: input.region ?? process.env.AWS_REGION ?? DEFAULT_REGION,
      ...(input.credentialsProvider && { credentials: input.credentialsProvider }),
    })

  // Shared connection + write identity, built once and reused across every store in this set.
  const config: AgentCoreMemoryConfig = {
    memoryId: input.memoryId,
    actorId: input.actorId,
    sessionId: input.sessionId,
    ...(input.metadataProvider !== undefined && { metadataProvider: input.metadataProvider }),
    ...(input.maxTurnsPerEvent !== undefined && { maxTurnsPerEvent: input.maxTurnsPerEvent }),
    client,
  }

  if (readMode === 'subtree') {
    const parent = input.parentNamespace ?? commonParent(input.namespaces.map((n) => n.namespace))
    if (parent === undefined) {
      throw new Error(
        'createAgentCoreMemoryStores: subtree readMode requires a common parent namespace; ' +
          'pass parentNamespace explicitly or use readMode: "per-namespace"'
      )
    }
    const store = new AgentCoreMemoryStore(
      buildStoreConfig({
        config,
        ns: input.namespaces[0]!,
        template: parent,
        readMode: 'subtree',
        writable: writeEnabled,
        extraction,
      })
    )
    return [store]
  }

  // per-namespace: a store is the writer if its namespace is flagged `writable`. If extraction is
  // enabled and none is flagged, default to the first. Each explicit flag is honored as-is (we do NOT
  // collapse multiple flags to one) so a caller that mis-flags two namespaces is caught loudly by
  // assertWritableTopology rather than having the extra flag silently dropped. Only the writer carries
  // `extraction`.
  const anyFlagged = input.namespaces.some((ns) => ns.writable === true)
  const defaultWriterIndex = !anyFlagged && writeEnabled ? 0 : -1

  const stores = input.namespaces.map((ns, i) => {
    const isWriter = ns.writable === true || i === defaultWriterIndex
    return new AgentCoreMemoryStore(
      buildStoreConfig({
        config,
        ns,
        template: ns.namespace,
        readMode: 'per-namespace',
        writable: isWriter,
        extraction: isWriter ? extraction : undefined,
      })
    )
  })

  // At most one writable always; exactly one required when extraction is enabled. (Store-name
  // uniqueness is validated by the MemoryManager constructor, so we don't re-check it here.)
  assertWritableTopology(stores, writeEnabled)
  return stores
}

/** Input for {@link createAgentCoreMemoryStore} — the singular form, for one namespace. */
export interface CreateAgentCoreMemoryStoreInput
  extends
    Omit<CreateAgentCoreMemoryStoresInput, 'namespaces' | 'readMode' | 'parentNamespace'>,
    AgentCoreNamespaceConfig {}

/**
 * Convenience wrapper for the common single-namespace case: returns one {@link AgentCoreMemoryStore}
 * instead of an array. Equivalent to `createAgentCoreMemoryStores` with a single `per-namespace`
 * namespace. `extraction` works the same (omit for recall-only); the single store is the writer when
 * extraction is enabled.
 *
 * The store now stands alone (`new AgentCoreMemoryStore({ memoryId, actorId, sessionId, namespace })`),
 * so this is a thin convenience for the named single-namespace path; the topology assertion still runs.
 *
 * @example
 * ```typescript
 * const store = createAgentCoreMemoryStore({
 *   memoryId, actorId, sessionId,
 *   namespace: '/users/{actorId}/facts',
 *   extraction: true,
 * })
 * new MemoryManager({ stores: [store] })
 * ```
 */
export function createAgentCoreMemoryStore(input: CreateAgentCoreMemoryStoreInput): AgentCoreMemoryStore {
  const { namespace, name, description, maxSearchResults, minScore, overFetchFactor, writable, ...rest } = input
  const ns: AgentCoreNamespaceConfig = {
    namespace,
    ...(name !== undefined && { name }),
    ...(description !== undefined && { description }),
    ...(maxSearchResults !== undefined && { maxSearchResults }),
    ...(minScore !== undefined && { minScore }),
    ...(overFetchFactor !== undefined && { overFetchFactor }),
    ...(writable !== undefined && { writable }),
  }
  return createAgentCoreMemoryStores({ ...rest, namespaces: [ns], readMode: 'per-namespace' })[0]!
}
