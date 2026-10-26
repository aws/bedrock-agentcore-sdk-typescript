import { randomUUID } from 'crypto'
import {
  BedrockAgentCoreClient,
  CreateEventCommand,
  DeleteEventCommand,
  ListEventsCommand,
  type Event as AgentCoreEvent,
  type EventMetadataFilterExpression,
} from '@aws-sdk/client-bedrock-agentcore'
import type { AwsCredentialIdentityProvider } from '@aws-sdk/types'
import type { SessionStorage, Snapshot, SnapshotLocation, SnapshotManifest, SnapshotStorage } from '@strands-agents/sdk'
import { logger } from './logger.js'
import { assertNonEmpty, DEFAULT_REGION } from './types.js'

/** Actor id used for session events when the config does not name one. */
export const DEFAULT_SESSION_ACTOR_ID = 'strands-agent'

/**
 * Default upper bound, in bytes, of one serialized payload item. AgentCore caps a single
 * `CreateEvent` payload item at 100 KB; 64 KiB leaves headroom for the item's JSON envelope.
 */
export const DEFAULT_MAX_CHUNK_BYTES = 64 * 1024

/** Largest accepted `maxChunkBytes`: AgentCore's 100 KB payload-item limit, read as decimal kilobytes. */
export const MAX_CHUNK_BYTES = 100_000

/** Smallest accepted `maxChunkBytes`: room for the widest escaped character (six bytes) and then some. */
const MIN_CHUNK_BYTES = 16

/** AgentCore accepts at most 100 payload items per `CreateEvent`. */
const MAX_ITEMS_PER_EVENT = 100

/** Byte budget for one event's payload, kept under AgentCore's 10 MB event limit. */
const MAX_EVENT_BYTES = 8_000_000

/** `ListEvents` page size; 100 is the service maximum. */
const LIST_PAGE_SIZE = 100

/** Version of the event layout below, stored on every event so a later layout can coexist. */
const LAYOUT_VERSION = '1'

/** Schema version of the default manifest returned when none has been saved. */
const MANIFEST_SCHEMA_VERSION = '1.0'

/**
 * Event metadata keys. Every event this storage writes carries all of them, so a `ListEvents` metadata
 * filter can select exactly the events of one location and kind.
 */
const META = {
  layout: 'strands.layout',
  kind: 'strands.kind',
  location: 'strands.location',
  snapshotId: 'strands.snapshotId',
  isLatest: 'strands.isLatest',
  writeId: 'strands.writeId',
  part: 'strands.part',
  partCount: 'strands.partCount',
} as const

/** AgentCore sessionId rule combined with the Strands identifier rule (lowercase, digits, `-`, `_`). */
const SESSION_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/
const MAX_SESSION_ID_LENGTH = 100

/** Strands identifier rule, shared with its own file and S3 storages. */
const IDENTIFIER_PATTERN = /^[a-z0-9_-]+$/
const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SCOPES: readonly SnapshotLocation['scope'][] = ['agent', 'multiAgent']

/** AgentCore metadata values are at most 256 characters; the location value is `<scope>/<scopeId>`. */
const MAX_METADATA_VALUE_LENGTH = 256
const MAX_SCOPE_ID_LENGTH = MAX_METADATA_VALUE_LENGTH - 'multiAgent/'.length

/** AgentCore actorId: 1-255 characters, `[a-zA-Z0-9][a-zA-Z0-9-_/]*(?::[a-zA-Z0-9-_/]+)*[a-zA-Z0-9-_/]*`. */
const ACTOR_ID_CHARS = /^[a-zA-Z0-9][a-zA-Z0-9_/:-]*$/
const MAX_ACTOR_ID_LENGTH = 255

/**
 * Configuration for {@link AgentCoreSnapshotStorage}.
 */
export interface AgentCoreSessionStorageConfig {
  /** AgentCore Memory resource id. */
  readonly memoryId: string
  /** AgentCore actor that owns the session events, e.g. the end user. Defaults to {@link DEFAULT_SESSION_ACTOR_ID}. */
  readonly actorId?: string | undefined
  /** Upper bound, in bytes, of one serialized payload item. Defaults to {@link DEFAULT_MAX_CHUNK_BYTES}. */
  readonly maxChunkBytes?: number | undefined
  /** Region for the default client. Ignored if `client` is supplied. */
  readonly region?: string | undefined
  /** Credentials for the default client. Ignored if `client` is supplied. */
  readonly credentialsProvider?: AwsCredentialIdentityProvider | undefined
  /** Pre-constructed AWS client, created if omitted. */
  readonly client?: BedrockAgentCoreClient | undefined
}

/**
 * Raised when a session storage call to AgentCore Memory fails or returns data it cannot read. The
 * underlying AWS SDK error, when there is one, is the `cause`.
 */
export class AgentCoreSessionStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AgentCoreSessionStorageError'
  }
}

/** Metadata values that identify one stored document: its kind, location and selector fields. */
type Tags = Record<string, string>

/** The events of one write, keyed by part index. */
interface StoredWrite {
  writeId: string
  timestamp: number
  partCount: number
  parts: Map<number, AgentCoreEvent>
}

/**
 * AgentCore Memory as a Strands `SnapshotStorage`, so `new SessionManager({ storage })` keeps an
 * agent's session in AgentCore Memory short-term events, where it survives runtime cold starts.
 *
 * Mapping: the Strands `sessionId` is the AgentCore `sessionId` (unchanged), the configured `actorId`
 * owns every event, and the snapshot's `scope`/`scopeId` is the `strands.location` metadata value. Each
 * saved snapshot or manifest is one or more blob events: the JSON text split into chunks of at most
 * `maxChunkBytes`, packed up to 100 per event, tagged with a `strands.writeId` and
 * `strands.part`/`strands.partCount` so a read reassembles only complete writes.
 *
 * AgentCore events are append-only, so saving a new latest snapshot (or manifest) deletes the events of
 * the ones it supersedes; reads pick the newest complete write by `eventTimestamp`. Immutable snapshots
 * are never pruned. Events still expire after the memory's event expiry (7 to 365 days).
 *
 * @example
 * ```typescript
 * import { Agent, SessionManager } from '@strands-agents/sdk'
 * import { AgentCoreSnapshotStorage } from 'bedrock-agentcore/memory/strands'
 *
 * const snapshot = new AgentCoreSnapshotStorage({ memoryId: 'mem-abc', actorId: 'user-123' })
 * const agent = new Agent({
 *   sessionManager: new SessionManager({ sessionId: 'session-1', storage: { snapshot } }),
 * })
 * ```
 */
export class AgentCoreSnapshotStorage implements SnapshotStorage {
  private readonly _client: BedrockAgentCoreClient
  private readonly _memoryId: string
  private readonly _actorId: string
  private readonly _maxChunkBytes: number
  private readonly _itemsPerEvent: number
  private _lastTimestamp = 0

  constructor(config: AgentCoreSessionStorageConfig) {
    this._memoryId = assertNonEmpty(config.memoryId, 'memoryId', 'AgentCoreSnapshotStorage')
    this._actorId = assertActorId(config.actorId ?? DEFAULT_SESSION_ACTOR_ID)
    const maxChunkBytes = config.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES
    if (!Number.isInteger(maxChunkBytes) || maxChunkBytes < MIN_CHUNK_BYTES || maxChunkBytes > MAX_CHUNK_BYTES) {
      throw new Error(
        `AgentCoreSnapshotStorage: maxChunkBytes must be an integer between ${MIN_CHUNK_BYTES} and ` +
          `${MAX_CHUNK_BYTES}, got ${maxChunkBytes}`
      )
    }
    this._maxChunkBytes = maxChunkBytes
    this._itemsPerEvent = Math.min(MAX_ITEMS_PER_EVENT, Math.floor(MAX_EVENT_BYTES / maxChunkBytes))
    this._client =
      config.client ??
      new BedrockAgentCoreClient({
        region: config.region ?? process.env.AWS_REGION ?? DEFAULT_REGION,
        ...(config.credentialsProvider && { credentials: config.credentialsProvider }),
      })
  }

  /**
   * Persist a snapshot. A latest snapshot replaces the previous latest one for the location; an
   * immutable snapshot is added to the location's history under `snapshotId`.
   *
   * @param params - Location, snapshot id, whether it is the latest snapshot, and the snapshot
   */
  async saveSnapshot(params: {
    location: SnapshotLocation
    snapshotId: string
    isLatest: boolean
    snapshot: Snapshot
  }): Promise<void> {
    const sessionId = toAgentCoreSessionId(params.location.sessionId)
    const tags: Tags = {
      ...snapshotTags(params.location),
      [META.snapshotId]: assertIdentifier(params.snapshotId, 'snapshotId'),
      [META.isLatest]: String(params.isLatest),
    }
    const supersedes: Tags | undefined = params.isLatest
      ? { ...snapshotTags(params.location), [META.isLatest]: 'true' }
      : undefined
    await this._writeDocument(
      sessionId,
      tags,
      params.snapshot,
      supersedes,
      describeAction('save snapshot', params.location)
    )
  }

  /**
   * Load a snapshot: the latest one when `snapshotId` is omitted, otherwise that immutable snapshot.
   *
   * @param params - Location and optional snapshot id
   * @returns The snapshot, or `null` if none is stored
   */
  async loadSnapshot(params: { location: SnapshotLocation; snapshotId?: string }): Promise<Snapshot | null> {
    const sessionId = toAgentCoreSessionId(params.location.sessionId)
    const selector: Tags =
      params.snapshotId === undefined
        ? { [META.isLatest]: 'true' }
        : { [META.snapshotId]: assertIdentifier(params.snapshotId, 'snapshotId'), [META.isLatest]: 'false' }
    const tags = { ...snapshotTags(params.location), ...selector }
    return (await this._readNewest(
      sessionId,
      tags,
      describeAction('load snapshot', params.location)
    )) as Snapshot | null
  }

  /**
   * List the location's immutable snapshot ids in chronological order (UUID v7 order).
   *
   * @param params - Location, optional page size `limit`, and optional exclusive `startAfter` cursor
   * @returns Snapshot ids, oldest first
   */
  async listSnapshotIds(params: {
    location: SnapshotLocation
    limit?: number
    startAfter?: string
  }): Promise<string[]> {
    if (params.limit !== undefined && params.limit <= 0) return []
    if (params.startAfter !== undefined && !UUID_V7_PATTERN.test(params.startAfter)) {
      throw new Error(`'${params.startAfter}' is not a valid UUID v7 snapshot ID`)
    }
    const sessionId = toAgentCoreSessionId(params.location.sessionId)
    const tags = { ...snapshotTags(params.location), [META.isLatest]: 'false' }
    const events = await this._listEvents(sessionId, tags, false, describeAction('list snapshots', params.location))
    const ids = new Set<string>()
    for (const write of completeWrites(events)) {
      const id = metadataValue(write.parts.get(0)!, META.snapshotId)
      if (id !== undefined) ids.add(id)
    }
    const sorted = [...ids].sort().filter((id) => params.startAfter === undefined || id > params.startAfter)
    return params.limit !== undefined ? sorted.slice(0, params.limit) : sorted
  }

  /**
   * Delete every snapshot and manifest event this storage wrote for the session, in all scopes. Other
   * events in the same AgentCore session (for example conversational events) are left alone.
   *
   * @param params - The Strands session id
   */
  async deleteSession(params: { sessionId: string }): Promise<void> {
    const sessionId = toAgentCoreSessionId(params.sessionId)
    const action = `delete session "${params.sessionId}"`
    const events = await this._listEvents(sessionId, {}, false, action)
    for (const event of events) {
      await this._deleteEvent(sessionId, event.eventId!, action)
    }
  }

  /**
   * Load the location's manifest, or a fresh default manifest if none has been saved.
   *
   * @param params - Location
   * @returns The manifest
   */
  async loadManifest(params: { location: SnapshotLocation }): Promise<SnapshotManifest> {
    const sessionId = toAgentCoreSessionId(params.location.sessionId)
    const manifest = await this._readNewest(
      sessionId,
      manifestTags(params.location),
      describeAction('load manifest', params.location)
    )
    return (
      (manifest as SnapshotManifest | null) ?? {
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
      }
    )
  }

  /**
   * Save the location's manifest, replacing the previous one.
   *
   * @param params - Location and manifest
   */
  async saveManifest(params: { location: SnapshotLocation; manifest: SnapshotManifest }): Promise<void> {
    const sessionId = toAgentCoreSessionId(params.location.sessionId)
    const tags = manifestTags(params.location)
    await this._writeDocument(sessionId, tags, params.manifest, tags, describeAction('save manifest', params.location))
  }

  /**
   * Write `value` as one or more blob events tagged with `tags`. Parts are written in order; if one
   * fails, the parts already written are deleted and the error is thrown. With `supersedes`, events
   * matching it that are older than this write are then pruned.
   */
  private async _writeDocument(
    sessionId: string,
    tags: Tags,
    value: unknown,
    supersedes: Tags | undefined,
    action: string
  ): Promise<void> {
    const writeId = randomUUID()
    const timestamp = this._nextTimestamp()
    const parts = packParts(splitIntoChunks(JSON.stringify(value), this._maxChunkBytes), this._itemsPerEvent)
    const written: string[] = []
    try {
      for (const [index, chunks] of parts.entries()) {
        const response = await this._client.send(
          new CreateEventCommand({
            memoryId: this._memoryId,
            actorId: this._actorId,
            sessionId,
            eventTimestamp: timestamp,
            payload: chunks.map((blob) => ({ blob })),
            metadata: toMetadata({
              [META.layout]: LAYOUT_VERSION,
              ...tags,
              [META.writeId]: writeId,
              [META.part]: String(index),
              [META.partCount]: String(parts.length),
            }),
          })
        )
        if (response.event?.eventId !== undefined) written.push(response.event.eventId)
      }
    } catch (error) {
      await this._rollback(sessionId, written)
      throw wrapError(action, error)
    }
    if (supersedes !== undefined) {
      await this._pruneSuperseded(sessionId, supersedes, writeId, timestamp.getTime())
    }
  }

  /** Read and decode the newest complete write matching `tags`, or `null` if there is none. */
  private async _readNewest(sessionId: string, tags: Tags, action: string): Promise<unknown> {
    const events = await this._listEvents(sessionId, tags, true, action)
    const newest = completeWrites(events).sort((a, b) => b.timestamp - a.timestamp)[0]
    return newest === undefined ? null : decodeWrite(newest, action)
  }

  /**
   * All events of the session whose metadata matches `tags`, across every `ListEvents` page. With empty
   * `tags`, all events this storage wrote. A missing session or memory reads as no events.
   */
  private async _listEvents(
    sessionId: string,
    tags: Tags,
    includePayloads: boolean,
    action: string
  ): Promise<AgentCoreEvent[]> {
    const events: AgentCoreEvent[] = []
    let nextToken: string | undefined
    try {
      do {
        const response = await this._client.send(
          new ListEventsCommand({
            memoryId: this._memoryId,
            actorId: this._actorId,
            sessionId,
            includePayloads,
            maxResults: LIST_PAGE_SIZE,
            filter: { eventMetadata: toFilter(tags) },
            ...(nextToken !== undefined && { nextToken }),
          })
        )
        events.push(...(response.events ?? []))
        nextToken = response.nextToken
      } while (nextToken !== undefined)
    } catch (error) {
      if (isNotFound(error)) return []
      throw wrapError(action, error)
    }
    return events
  }

  /** Delete events matching `supersedes` that are older than the write just made. Failures only warn. */
  private async _pruneSuperseded(
    sessionId: string,
    supersedes: Tags,
    writeId: string,
    timestamp: number
  ): Promise<void> {
    let events: AgentCoreEvent[]
    try {
      events = await this._listEvents(sessionId, supersedes, false, 'list superseded events')
    } catch (error) {
      logger.warn(`session_id=<${sessionId}>, error=<${errorText(error)}> | failed to prune superseded events`)
      return
    }
    for (const event of events) {
      const stale = metadataValue(event, META.writeId) !== writeId && (event.eventTimestamp?.getTime() ?? 0) < timestamp
      if (!stale) continue
      try {
        await this._deleteEvent(sessionId, event.eventId!, 'delete superseded event')
      } catch (error) {
        logger.warn(
          `session_id=<${sessionId}>, event_id=<${event.eventId}>, error=<${errorText(error)}> | ` +
            'failed to delete a superseded event'
        )
      }
    }
  }

  /** Best-effort delete of the parts of a failed write. */
  private async _rollback(sessionId: string, eventIds: string[]): Promise<void> {
    for (const eventId of eventIds) {
      try {
        await this._deleteEvent(sessionId, eventId, 'roll back partial write')
      } catch (error) {
        logger.warn(
          `session_id=<${sessionId}>, event_id=<${eventId}>, error=<${errorText(error)}> | ` +
            'failed to roll back a partial write'
        )
      }
    }
  }

  private async _deleteEvent(sessionId: string, eventId: string, action: string): Promise<void> {
    try {
      await this._client.send(
        new DeleteEventCommand({ memoryId: this._memoryId, actorId: this._actorId, sessionId, eventId })
      )
    } catch (error) {
      throw wrapError(action, error)
    }
  }

  /**
   * A timestamp later than every one this instance has used. AgentCore stores `eventTimestamp` at
   * millisecond resolution, so two writes in the same millisecond would otherwise be unordered.
   */
  private _nextTimestamp(): Date {
    this._lastTimestamp = Math.max(Date.now(), this._lastTimestamp + 1)
    return new Date(this._lastTimestamp)
  }
}

/**
 * Build a Strands `SessionStorage` backed by AgentCore Memory, ready for `new SessionManager({ storage })`.
 *
 * @param config - AgentCore Memory connection and actor settings
 * @returns A session storage whose snapshot backend is an {@link AgentCoreSnapshotStorage}
 */
export function createAgentCoreSessionStorage(config: AgentCoreSessionStorageConfig): SessionStorage {
  return { snapshot: new AgentCoreSnapshotStorage(config) }
}

/**
 * Split `text` into chunks whose JSON-serialized UTF-8 size is at most `maxBytes` (excluding the two
 * enclosing quotes). Splits fall between code points, so no surrogate pair is broken.
 */
function splitIntoChunks(text: string, maxBytes: number): string[] {
  const chunks: string[] = []
  let start = 0
  let bytes = 0
  let i = 0
  while (i < text.length) {
    const codePoint = text.codePointAt(i)!
    const width = codePoint > 0xffff ? 2 : 1
    const cost = serializedBytes(codePoint)
    if (bytes + cost > maxBytes && i > start) {
      chunks.push(text.slice(start, i))
      start = i
      bytes = 0
    }
    bytes += cost
    i += width
  }
  chunks.push(text.slice(start))
  return chunks
}

/** Bytes one code point occupies inside a JSON string: escapes for `"`, `\` and controls, else UTF-8. */
function serializedBytes(codePoint: number): number {
  if (codePoint === 0x22 || codePoint === 0x5c) return 2
  if (codePoint < 0x20) return 6
  if (codePoint < 0x80) return 1
  if (codePoint < 0x800) return 2
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return 6
  if (codePoint <= 0xffff) return 3
  return 4
}

/** Group chunks into events of at most `itemsPerEvent` payload items. */
function packParts(chunks: string[], itemsPerEvent: number): string[][] {
  const parts: string[][] = []
  for (let i = 0; i < chunks.length; i += itemsPerEvent) {
    parts.push(chunks.slice(i, i + itemsPerEvent))
  }
  return parts
}

/** Group events by write and keep the writes whose every part is present. */
function completeWrites(events: AgentCoreEvent[]): StoredWrite[] {
  const writes = new Map<string, StoredWrite>()
  for (const event of events) {
    const writeId = metadataValue(event, META.writeId)
    const part = Number(metadataValue(event, META.part))
    const partCount = Number(metadataValue(event, META.partCount))
    if (writeId === undefined || !Number.isInteger(part) || !Number.isInteger(partCount)) continue
    let write = writes.get(writeId)
    if (write === undefined) {
      write = { writeId, timestamp: event.eventTimestamp?.getTime() ?? 0, partCount, parts: new Map() }
      writes.set(writeId, write)
    }
    write.parts.set(part, event)
  }
  return [...writes.values()].filter((w) =>
    Array.from({ length: w.partCount }, (_, part) => part).every((part) => w.parts.has(part))
  )
}

/** Concatenate a write's chunks in part and item order and parse the JSON text. */
function decodeWrite(write: StoredWrite, action: string): unknown {
  let text = ''
  for (let part = 0; part < write.partCount; part++) {
    for (const item of write.parts.get(part)!.payload ?? []) {
      if (typeof item.blob !== 'string') {
        throw new AgentCoreSessionStorageError(
          `AgentCoreSnapshotStorage: failed to ${action}: stored payload is not a text chunk ` +
            `(write_id=${write.writeId}, part=${part})`
        )
      }
      text += item.blob
    }
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new AgentCoreSessionStorageError(
      `AgentCoreSnapshotStorage: failed to ${action}: stored snapshot is not valid JSON (write_id=${write.writeId})`,
      { cause: error }
    )
  }
}

function snapshotTags(location: SnapshotLocation): Tags {
  return { [META.kind]: 'snapshot', [META.location]: toLocationValue(location) }
}

function manifestTags(location: SnapshotLocation): Tags {
  return { [META.kind]: 'manifest', [META.location]: toLocationValue(location) }
}

/** `<scope>/<scopeId>`, validated so it is a legal AgentCore metadata value. */
function toLocationValue(location: SnapshotLocation): string {
  if (!SCOPES.includes(location.scope)) {
    throw new Error(`AgentCoreSnapshotStorage: scope must be one of ${SCOPES.join(', ')}, got '${location.scope}'`)
  }
  const scopeId = assertIdentifier(location.scopeId, 'scopeId')
  if (scopeId.length > MAX_SCOPE_ID_LENGTH) {
    throw new Error(`AgentCoreSnapshotStorage: scopeId must be at most ${MAX_SCOPE_ID_LENGTH} characters`)
  }
  return `${location.scope}/${scopeId}`
}

/**
 * The AgentCore `sessionId` for a Strands session id: the same string, after checking it satisfies both
 * the Strands identifier rule and AgentCore's `[a-zA-Z0-9][a-zA-Z0-9-_]*`, 1-100 characters. Ids are not
 * rewritten: any lossy mapping could merge two Strands sessions into one AgentCore session.
 */
function toAgentCoreSessionId(sessionId: string): string {
  if (!SESSION_ID_PATTERN.test(sessionId) || sessionId.length > MAX_SESSION_ID_LENGTH) {
    throw new Error(
      `AgentCoreSnapshotStorage: sessionId '${sessionId}' must be 1-${MAX_SESSION_ID_LENGTH} lowercase ` +
        'letters, digits, hyphens or underscores, starting with a letter or digit (the AgentCore Memory ' +
        'sessionId pattern within the Strands identifier rule)'
    )
  }
  return sessionId
}

function assertIdentifier(value: string, field: string): string {
  if (!IDENTIFIER_PATTERN.test(value) || value.length > MAX_METADATA_VALUE_LENGTH) {
    throw new Error(
      `AgentCoreSnapshotStorage: ${field} '${value}' can only contain lowercase letters, numbers, ` +
        `hyphens, and underscores (at most ${MAX_METADATA_VALUE_LENGTH} characters)`
    )
  }
  return value
}

/**
 * Check an AgentCore actorId: 1-255 characters matching
 * `[a-zA-Z0-9][a-zA-Z0-9-_/]*(?::[a-zA-Z0-9-_/]+)*[a-zA-Z0-9-_/]*`, checked here as a linear character
 * class plus "no empty segment between colons and no trailing colon".
 */
function assertActorId(actorId: string): string {
  if (
    actorId.length > MAX_ACTOR_ID_LENGTH ||
    !ACTOR_ID_CHARS.test(actorId) ||
    actorId.includes('::') ||
    actorId.endsWith(':')
  ) {
    throw new Error(
      `AgentCoreSnapshotStorage: actorId '${actorId}' does not match the AgentCore actorId pattern ` +
        '(1-255 characters: letters, digits, -, _, / and single colons, starting with a letter or digit)'
    )
  }
  return actorId
}

function toMetadata(tags: Tags): Record<string, { stringValue: string }> {
  return Object.fromEntries(Object.entries(tags).map(([key, value]) => [key, { stringValue: value }]))
}

/** One `EQUALS_TO` expression per tag (AND-ed by the service); no tags selects every event of this storage. */
function toFilter(tags: Tags): EventMetadataFilterExpression[] {
  const entries = Object.entries(tags)
  if (entries.length === 0) {
    return [{ left: { metadataKey: META.kind }, operator: 'EXISTS' }]
  }
  return entries.map(
    ([key, value]): EventMetadataFilterExpression => ({
      left: { metadataKey: key },
      operator: 'EQUALS_TO',
      right: { metadataValue: { stringValue: value } },
    })
  )
}

function metadataValue(event: AgentCoreEvent, key: string): string | undefined {
  return event.metadata?.[key]?.stringValue
}

function describeAction(action: string, location: SnapshotLocation): string {
  return `${action} for session "${location.sessionId}" (${location.scope}/${location.scopeId})`
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.name === 'ResourceNotFoundException'
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

function wrapError(action: string, error: unknown): AgentCoreSessionStorageError {
  if (error instanceof AgentCoreSessionStorageError) return error
  return new AgentCoreSessionStorageError(`AgentCoreSnapshotStorage: failed to ${action}: ${errorText(error)}`, {
    cause: error,
  })
}
