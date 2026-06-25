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
  /** Marks this the single write sink. Defaults to the first namespace when extraction is enabled; see {@link assertWritableTopology}. */
  writable?: boolean
}

/**
 * Object form of the {@link CreateAgentCoreMemoryStoresInput.extraction} switch: writable, with optional
 * control over write cadence and which message content is written.
 */
export interface AgentCoreExtractionConfig {
  /**
   * When buffered turns are flushed to `createEvent`. Omit for the MemoryManager's default
   * (`IntervalTrigger`); pass any Strands {@link ExtractionTrigger} or an array. A trigger only sets
   * cadence (fire-and-forget) — `MemoryManager.flush()` is what guarantees durability.
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

  /**
   * Read namespaces — one store is built per entry, each reading its own exact namespace prefix. To read a
   * whole subtree instead, that is a single store: construct it directly with
   * `new AgentCoreMemoryStore({ ...identity, namespacePath })`.
   */
  namespaces: AgentCoreNamespaceConfig[]

  /**
   * The single write switch: omit/`false` = recall-only; `true` = writable with the default cadence;
   * `{ cadence?, filter? }` = writable with a custom cadence/filter. The writer namespace is chosen by
   * the per-namespace `writable` flag (else the first).
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

/** Optional fields are spread conditionally so an explicit `undefined` never violates `exactOptionalPropertyTypes`. */
function buildStoreConfig(args: {
  config: AgentCoreMemoryConfig
  ns: AgentCoreNamespaceConfig
  writable: boolean
  extraction: boolean | ExtractionConfig | undefined
}): AgentCoreMemoryStoreConfig {
  const { config, ns, writable, extraction } = args
  return {
    // Spread the shared identity flat — same client/identity object reused across the set.
    ...config,
    namespace: ns.namespace,
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
 * At most one store may be writable. `createEvent` is namespace-free (it writes the whole conversation to
 * the `(memoryId, actorId, sessionId)` stream), so two writers would emit duplicate events that nothing
 * upstream dedupes — and a store can't see its siblings, so the rule can only be enforced here, at
 * construction. Exported so hand-built (`new`) multi-store setups can guard themselves. With
 * `expectExtraction`, a writer is required (0 writers throws).
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
 * Build the stores for one `(actorId, sessionId)` — one shared client, one writer — ready to spread into
 * `MemoryManagerConfig.stores`. Called once per `(actorId, sessionId)` by a multi-actor server.
 */
export function createAgentCoreMemoryStores(input: CreateAgentCoreMemoryStoresInput): AgentCoreMemoryStore[] {
  if (!Array.isArray(input.namespaces) || input.namespaces.length === 0) {
    throw new Error('createAgentCoreMemoryStores: at least one namespace is required')
  }
  input.namespaces.forEach((ns, i) => {
    if (ns === null || typeof ns !== 'object' || typeof ns.namespace !== 'string' || ns.namespace.trim().length === 0) {
      throw new Error(`createAgentCoreMemoryStores: namespaces[${i}].namespace must be a non-empty string`)
    }
  })

  // Validated here too, not only in the sender: a recall-only set never builds a sender.
  if (
    input.maxTurnsPerEvent !== undefined &&
    (!Number.isInteger(input.maxTurnsPerEvent) || input.maxTurnsPerEvent < 1)
  ) {
    throw new Error(
      `createAgentCoreMemoryStores: maxTurnsPerEvent must be a positive integer, got ${input.maxTurnsPerEvent}`
    )
  }

  // `true` passes through (the MemoryManager applies its own default cadence); only a custom
  // cadence/filter builds an ExtractionConfig. `!Array.isArray` stops a stray array (typeof === 'object')
  // being duck-typed as a config.
  const writeEnabled = input.extraction !== undefined && input.extraction !== false
  const extractionObj: AgentCoreExtractionConfig =
    typeof input.extraction === 'object' && !Array.isArray(input.extraction) ? input.extraction : {}
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

  // The default writer skips namespaces that explicitly opted out (`writable: false`) rather than
  // overriding them; multiple explicit `writable: true` flags are left intact so assertWritableTopology
  // catches the conflict loudly instead of silently picking one.
  const anyFlagged = input.namespaces.some((ns) => ns.writable === true)
  const defaultWriterIndex =
    !anyFlagged && writeEnabled ? input.namespaces.findIndex((ns) => ns.writable !== false) : -1
  if (writeEnabled && !anyFlagged && defaultWriterIndex === -1) {
    throw new Error(
      'createAgentCoreMemoryStores: extraction is enabled but every namespace is marked writable: false; ' +
        'leave one namespace un-opted-out (or set writable: true on the intended writer).'
    )
  }

  const stores = input.namespaces.map((ns, i) => {
    const isWriter = ns.writable === true || i === defaultWriterIndex
    return new AgentCoreMemoryStore(
      buildStoreConfig({
        config,
        ns,
        writable: isWriter,
        extraction: isWriter ? extraction : undefined,
      })
    )
  })

  // Store-name uniqueness is validated by the MemoryManager constructor, so we don't re-check it here.
  assertWritableTopology(stores, writeEnabled)
  return stores
}
