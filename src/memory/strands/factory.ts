import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore'
import type { AwsCredentialIdentityProvider } from '@aws-sdk/types'
import type { ExtractionConfig, ExtractionTrigger } from './_strands-memory-types.js'
import { AgentCoreMemoryStore } from './store.js'
import {
  type AgentCoreMemoryConfig,
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
   * `per-namespace` only: which namespace hosts the single write stream (by `namespace` template).
   * Defaults to the first namespace. Ignored for `subtree` (its one store is the writer).
   */
  writeNamespace?: string

  /** Extraction trigger(s) for the writable store. Defaults to the caller wiring their own; required to extract. */
  trigger: ExtractionTrigger | ExtractionTrigger[]

  metadataProvider?: MetadataProvider
  writeOptions?: AgentCoreWriteOptions

  region?: string
  credentialsProvider?: AwsCredentialIdentityProvider
  /** Shared client; one is constructed (and reused across the returned stores) if omitted. */
  client?: BedrockAgentCoreClient
}

function slugifyNamespace(ns: string): string {
  const slug = ns
    .replace(/\{[^}]+\}/g, '')
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
 * Build the AgentCore store topology for one `(actorId, sessionId)`, ready to spread into
 * `MemoryManagerConfig.stores`.
 *
 * - `per-namespace` (default): one store per namespace; exactly one (the `writeNamespace`, else the
 *   first) is `writable` and carries `addMessages` + `extraction`. The rest are search-only.
 * - `subtree`: one writable store reading a parent path via `namespacePath`.
 *
 * Because `createEvent` is namespace-free, writes always go through exactly one store regardless of
 * read shape. A multi-actor/session server calls this once per `(actorId, sessionId)`.
 */
export function createAgentCoreMemoryStores(input: CreateAgentCoreMemoryStoresInput): AgentCoreMemoryStore[] {
  if (input.namespaces.length === 0) {
    throw new Error('createAgentCoreMemoryStores: at least one namespace is required')
  }

  const readMode: ReadMode = input.readMode ?? 'per-namespace'
  const extraction: ExtractionConfig = { trigger: input.trigger }

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
    metadataProvider: input.metadataProvider,
    writeOptions: input.writeOptions,
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
    const store = new AgentCoreMemoryStore({
      config,
      name: input.namespaces[0]!.name ?? slugifyNamespace(parent),
      description: input.namespaces[0]!.description,
      maxSearchResults: input.namespaces[0]!.maxSearchResults,
      minScore: input.namespaces[0]!.minScore,
      namespace: parent,
      readMode: 'subtree',
      writable: true,
      extraction,
    })
    return [store]
  }

  // per-namespace
  const writeNamespace = input.writeNamespace ?? input.namespaces[0]!.namespace
  let writableAssigned = false

  const stores = input.namespaces.map((ns) => {
    const isWriter = !writableAssigned && ns.namespace === writeNamespace
    if (isWriter) writableAssigned = true
    return new AgentCoreMemoryStore({
      config,
      name: ns.name ?? slugifyNamespace(ns.namespace),
      description: ns.description,
      maxSearchResults: ns.maxSearchResults,
      minScore: ns.minScore,
      namespace: ns.namespace,
      readMode: 'per-namespace',
      writable: isWriter,
      ...(isWriter && { extraction }),
    })
  })

  if (!writableAssigned) {
    throw new Error(
      `createAgentCoreMemoryStores: writeNamespace "${writeNamespace}" did not match any of the provided namespaces`
    )
  }

  ensureUniqueNames(stores)
  return stores
}
