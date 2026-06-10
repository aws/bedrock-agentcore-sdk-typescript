/**
 * TEMPORARY local mirror of the Strands `MemoryStore` / extraction interface.
 *
 * The interface this integration implements is merged into `strands-agents/harness-sdk`
 * (PR #2671, "feat: add memory extraction") but is NOT yet in a published `@strands-agents/sdk`
 * (latest published is 1.4.0, which predates the merge). We vendor a verbatim mirror here so the
 * integration can be built and tested now.
 *
 * Source of truth: `strands-ts/src/memory/types.ts` and `strands-ts/src/memory/extraction/types.ts`
 * at harness-sdk commit `058d943` (verified 2026-06-10).
 *
 * RELEASE FLIP: once `@strands-agents/sdk` publishes the memory module, delete this file and change
 * the imports in this folder from `./_strands-memory-types.js` to `@strands-agents/sdk`. The symbol
 * names here match the merged interface exactly, so the swap is import-only.
 */

/** JSON value, mirrors `@strands-agents/sdk` `JSONValue`. */
export type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue }

/** Message role, mirrors `@strands-agents/sdk` `Role`. */
export type Role = 'user' | 'assistant'

/** Plain-text content block, mirrors `TextBlockData`. */
export interface TextBlockData {
  text: string
}

/**
 * A content block within a message. The mirror only needs the text member plus the tool members
 * (so the filter's discriminator keys line up); other block kinds are represented structurally.
 */
export type ContentBlockData =
  | TextBlockData
  | { toolUse: unknown }
  | { toolResult: unknown }
  | { reasoning: unknown }
  | { image: unknown }
  | { video: unknown }
  | { document: unknown }
  | { citations: unknown }
  | { guardContent: unknown }
  | { cachePoint: unknown }

/** Mirrors `MessageMetadata` (only the `custom` bag is relevant to us). */
export interface MessageMetadata {
  custom?: Record<string, JSONValue>
  [key: string]: unknown
}

/** Mirrors `MessageData`: a role-tagged turn of content blocks. */
export interface MessageData {
  role: Role
  content: ContentBlockData[]
  metadata?: MessageMetadata
}

/** Minimal `Tool` shape (we do not register store-native tools; present for interface parity). */
export type Tool = unknown

/**
 * Minimal `LocalAgent` surface a trigger needs: `addHook`. Mirrors the relevant slice of the SDK's
 * `LocalAgent`. We keep it structural so our `attach()` compiles against either the mirror or the
 * real SDK.
 */
export interface LocalAgent {
  addHook(eventType: unknown, callback: (event: unknown) => void, options?: { order?: number }): () => void
}

// --- memory/types.ts mirror ---

export interface MemoryEntry {
  content: string
  storeName?: string
  metadata?: Record<string, JSONValue>
}

export interface SearchOptions {
  maxSearchResults?: number
}

/** Extension point the manager passes to `addMessages`. Empty today; may carry per-message `seqs`. */
export interface AddMessagesContext {
  /**
   * NOT YET IN THE MERGED INTERFACE. Requested addition (see `strands-seq-ask.md`): per-message
   * stable sequence numbers, aligned 1:1 with the `messages` arg, enabling an exactly-once
   * `clientToken`. Optional so the mirror matches today's empty interface; the sender reads it when present.
   */
  seqs?: number[]
}

export interface MemoryStoreConfig {
  readonly name: string
  readonly description?: string
  readonly maxSearchResults?: number
  readonly writable?: boolean
  readonly extraction?: ExtractionConfig
}

export interface MemoryStore extends MemoryStoreConfig {
  readonly writable: boolean
  search(query: string, options?: SearchOptions): Promise<MemoryEntry[]>
  add?(content: string, metadata?: Record<string, JSONValue>): Promise<unknown>
  addMessages?(messages: MessageData[], context?: AddMessagesContext): Promise<unknown>
  getTools?(): Tool[]
}

// --- memory/extraction/types.ts mirror ---

export type MemoryContentBlockType =
  | 'text'
  | 'toolUse'
  | 'toolResult'
  | 'reasoning'
  | 'image'
  | 'video'
  | 'document'
  | 'citations'
  | 'guardContent'
  | 'cachePoint'

export interface MemoryMessageFilter {
  exclude: MemoryContentBlockType[]
}

export const DEFAULT_MEMORY_MESSAGE_FILTER: MemoryMessageFilter = {
  exclude: ['toolUse', 'toolResult'],
}

export interface ExtractionResult {
  content: string
  metadata?: Record<string, JSONValue>
}

export interface ExtractorContext {
  defaultModel?: unknown
}

export interface Extractor {
  extract(messages: MessageData[], context?: ExtractorContext): Promise<ExtractionResult[]>
}

export interface ExtractionTriggerContext {
  agent: LocalAgent
  /** Fire-and-forget: dispatches extraction for this trigger's store; never blocks the loop. */
  fire: () => void
}

/**
 * Abstract base for write-cadence triggers. Mirrors the SDK's `ExtractionTrigger`.
 * Subclass and implement `attach()` for custom cadence.
 */
export abstract class ExtractionTrigger {
  abstract readonly name: string
  abstract attach(context: ExtractionTriggerContext): void
}

export interface ExtractionConfig {
  trigger: ExtractionTrigger | ExtractionTrigger[]
  extractor?: Extractor
  filter?: MemoryMessageFilter
}
