import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore'
import type { AwsCredentialIdentityProvider } from '@aws-sdk/types'
import type { ExtractionConfig, ExtractionTrigger } from './_strands-memory-types.js'
import { AgentCoreBatchTrigger } from './batch-trigger.js'
import { AgentCoreMemoryStore } from './store.js'
import {
  type AgentCoreMemoryConfig,
  type AgentCoreMemoryStoreConfig,
  type AgentCoreWriteOptions,
  DEFAULT_REGION,
  type MetadataProvider,
  type ReadMode,
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
}

/**
 * Object form of the {@link CreateAgentCoreMemoryStoresInput.extraction} switch: writable, with
 * optional control over write cadence and which namespace owns the write stream.
 */
export interface AgentCoreExtractionConfig {
  /**
   * Write cadence. Omit to use the default {@link AgentCoreBatchTrigger} (requires `messageAddedEvent`
   * on the factory input so the default can be constructed).
   */
  cadence?: ExtractionTrigger | ExtractionTrigger[]
  /**
   * Which namespace hosts the single write stream (by `namespace` template). Defaults to the first
   * namespace. Ignored for `subtree` (its one store is the writer).
   */
  namespace?: string
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
   * with the default cadence (needs `messageAddedEvent`); `{ cadence?, namespace? }` means writable
   * with a custom cadence and/or a chosen write namespace.
   */
  extraction?: boolean | AgentCoreExtractionConfig

  /**
   * The SDK's `MessageAddedEvent` constructor, used to build the default cadence trigger when
   * `extraction` is `true` or `{ cadence }` is omitted. Required only when a default trigger is needed.
   * (Injected because `MessageAddedEvent` is not yet in a published `@strands-agents/sdk`.)
   */
  messageAddedEvent?: unknown

  metadataProvider?: MetadataProvider
  writeOptions?: AgentCoreWriteOptions

  region?: string
  credentialsProvider?: AwsCredentialIdentityProvider
  /** Shared client; one is constructed (and reused across the returned stores) if omitted. */
  client?: BedrockAgentCoreClient
}

function slugifyNamespace(ns: string): string {
  // Strip `{placeholder}` segments, then collapse remaining non-alphanumerics to `-`.
  // `[^{}]*` (excludes both braces) is unambiguous and linear — no polynomial-backtracking risk.
  const slug = ns
    .replace(/\{[^{}]*\}/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.length > 0 ? slug : 'agentcore-memory'
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

function ensureUniqueNames(stores: AgentCoreMemoryStore[]): void {
  const seen = new Set<string>()
  for (const s of stores) {
    if (seen.has(s.name)) {
      throw new Error(`createAgentCoreMemoryStores: duplicate store name "${s.name}"; names must be unique`)
    }
    seen.add(s.name)
  }
}

/**
 * Build one store's config. Optional identity fields are spread conditionally so explicit `undefined`
 * never violates `exactOptionalPropertyTypes`.
 */
function buildStoreConfig(args: {
  config: AgentCoreMemoryConfig
  ns: AgentCoreNamespaceConfig
  fallbackName: string
  namespace: string
  readMode: ReadMode
  writable: boolean
  extraction: ExtractionConfig | undefined
}): AgentCoreMemoryStoreConfig {
  const { config, ns, fallbackName, namespace, readMode, writable, extraction } = args
  return {
    config,
    name: ns.name ?? fallbackName,
    namespace,
    readMode,
    writable,
    ...(ns.description !== undefined && { description: ns.description }),
    ...(ns.maxSearchResults !== undefined && { maxSearchResults: ns.maxSearchResults }),
    ...(ns.minScore !== undefined && { minScore: ns.minScore }),
    ...(writable && extraction !== undefined && { extraction }),
  }
}

/**
 * Build the AgentCore store topology for one `(actorId, sessionId)`, ready to spread into
 * `MemoryManagerConfig.stores`.
 *
 * - `per-namespace` (default): one store per namespace; when `extraction` is enabled, exactly one
 *   (the `extraction.namespace`, else the first) is writable and carries `addMessages` + `extraction`.
 *   The rest are search-only. When `extraction` is omitted/`false`, all stores are search-only.
 * - `subtree`: one store reading a parent path via `namespacePath` (writable iff `extraction` is enabled).
 *
 * Because `createEvent` is namespace-free, writes always go through exactly one store regardless of
 * read shape. A multi-actor/session server calls this once per `(actorId, sessionId)`.
 */
export function createAgentCoreMemoryStores(input: CreateAgentCoreMemoryStoresInput): AgentCoreMemoryStore[] {
  if (input.namespaces.length === 0) {
    throw new Error('createAgentCoreMemoryStores: at least one namespace is required')
  }

  const readMode: ReadMode = input.readMode ?? 'per-namespace'

  // Resolve the single `extraction` switch into: is writing enabled, with what cadence, on which namespace.
  const writeEnabled = input.extraction !== undefined && input.extraction !== false
  const extractionObj: AgentCoreExtractionConfig = typeof input.extraction === 'object' ? input.extraction : {}
  const extraction: ExtractionConfig | undefined = writeEnabled
    ? { trigger: extractionObj.cadence ?? defaultTrigger(input.messageAddedEvent) }
    : undefined

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
    ...(input.writeOptions !== undefined && { writeOptions: input.writeOptions }),
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
        fallbackName: slugifyNamespace(parent),
        namespace: parent,
        readMode: 'subtree',
        writable: writeEnabled,
        extraction,
      })
    )
    return [store]
  }

  // per-namespace
  const writeNamespace = extractionObj.namespace ?? input.namespaces[0]!.namespace
  let writableAssigned = false

  const stores = input.namespaces.map((ns) => {
    const isWriter = writeEnabled && !writableAssigned && ns.namespace === writeNamespace
    if (isWriter) writableAssigned = true
    return new AgentCoreMemoryStore(
      buildStoreConfig({
        config,
        ns,
        fallbackName: slugifyNamespace(ns.namespace),
        namespace: ns.namespace,
        readMode: 'per-namespace',
        writable: isWriter,
        extraction,
      })
    )
  })

  if (writeEnabled && !writableAssigned) {
    throw new Error(
      `createAgentCoreMemoryStores: extraction.namespace "${writeNamespace}" did not match any of the provided namespaces`
    )
  }

  ensureUniqueNames(stores)
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
 * namespace. `extraction` works the same (omit for recall-only).
 *
 * @example
 * ```typescript
 * const store = createAgentCoreMemoryStore({
 *   memoryId, actorId, sessionId,
 *   namespace: '/users/{actorId}/facts',
 *   extraction: { cadence: new AgentCoreBatchTrigger({ messageAddedEvent: MessageAddedEvent }) },
 * })
 * new MemoryManager({ stores: [store] })
 * ```
 */
export function createAgentCoreMemoryStore(input: CreateAgentCoreMemoryStoreInput): AgentCoreMemoryStore {
  const { namespace, name, description, maxSearchResults, minScore, ...rest } = input
  const ns: AgentCoreNamespaceConfig = {
    namespace,
    ...(name !== undefined && { name }),
    ...(description !== undefined && { description }),
    ...(maxSearchResults !== undefined && { maxSearchResults }),
    ...(minScore !== undefined && { minScore }),
  }
  return createAgentCoreMemoryStores({ ...rest, namespaces: [ns], readMode: 'per-namespace' })[0]!
}

/** Build the default write-cadence trigger; requires the SDK's MessageAddedEvent to be supplied. */
function defaultTrigger(messageAddedEvent: unknown): ExtractionTrigger {
  if (messageAddedEvent === undefined) {
    throw new Error(
      'createAgentCoreMemoryStores: enabling extraction without an explicit cadence requires ' +
        '`messageAddedEvent` (the SDK MessageAddedEvent) so the default trigger can be built; ' +
        'pass it, or provide extraction.cadence.'
    )
  }
  return new AgentCoreBatchTrigger({ messageAddedEvent })
}
