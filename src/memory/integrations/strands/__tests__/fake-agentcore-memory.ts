import type { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore'

/**
 * In-memory stand-in for the AgentCore Memory event data plane (`CreateEvent`, `ListEvents`,
 * `DeleteEvent`), used as the `client` of the session storage under test.
 *
 * It enforces the documented service limits the storage must respect, so a test passes only when the
 * storage would also be accepted by the real service:
 * - payload: at most 100 items per event, each item at most 100 KB serialized, the event at most 10 MB
 * - metadata: at most 15 entries, values at most 256 characters from `[a-zA-Z0-9\s._:/=+@-]`
 * - ListEvents: `maxResults` 1..100 (default 20), at most 5 metadata filter expressions (AND-ed)
 * - actorId / sessionId patterns
 *
 * `ListEvents` returns events newest first, as the service does.
 */
export class FakeAgentCoreMemory {
  readonly events: StoredEvent[] = []
  readonly calls: { name: string; input: Record<string, unknown> }[] = []
  /** Command name to an error thrown on the next N calls of that command. */
  readonly failures = new Map<string, { error: Error; remaining: number }>()

  private _nextId = 0
  private _sequence = 0

  /** A `BedrockAgentCoreClient` whose `send` is served by this fake. */
  client(): BedrockAgentCoreClient {
    return { send: (command: unknown) => this.send(command as Command) } as unknown as BedrockAgentCoreClient
  }

  /** Make the next `times` calls of `commandName` reject with `error`. */
  failNext(commandName: string, error: Error, times = 1): void {
    this.failures.set(commandName, { error, remaining: times })
  }

  /** Count recorded calls of one command. */
  count(commandName: string): number {
    return this.calls.filter((c) => c.name === commandName).length
  }

  async send(command: Command): Promise<unknown> {
    const name = command.constructor.name
    this.calls.push({ name, input: command.input })
    const failure = this.failures.get(name)
    if (failure !== undefined && failure.remaining > 0) {
      failure.remaining -= 1
      throw failure.error
    }
    switch (name) {
      case 'CreateEventCommand':
        return this._createEvent(command.input as unknown as CreateEventInput)
      case 'ListEventsCommand':
        return this._listEvents(command.input as unknown as ListEventsInput)
      case 'DeleteEventCommand':
        return this._deleteEvent(command.input as unknown as DeleteEventInput)
      default:
        throw new Error(`FakeAgentCoreMemory: unsupported command ${name}`)
    }
  }

  private _createEvent(input: CreateEventInput): { event: Record<string, unknown> } {
    assertActorId(input.actorId)
    assertSessionId(input.sessionId)
    if (input.payload.length > 100) throw validation(`payload has ${input.payload.length} items, max 100`)
    let eventBytes = 0
    for (const item of input.payload) {
      const bytes = utf8Length(JSON.stringify(item))
      if (bytes > 100 * 1000) throw validation(`payload item is ${bytes} bytes, max 100 KB`)
      eventBytes += bytes
    }
    if (eventBytes > 10 * 1000 * 1000) throw validation(`event is ${eventBytes} bytes, max 10 MB`)
    const metadata = input.metadata ?? {}
    if (Object.keys(metadata).length > 15) throw validation('metadata has more than 15 entries')
    for (const [key, value] of Object.entries(metadata)) {
      if (key.length < 1 || key.length > 128 || !METADATA_PATTERN.test(key)) throw validation(`bad key ${key}`)
      const v = value.stringValue
      if (typeof v !== 'string' || v.length > 256 || !METADATA_PATTERN.test(v)) throw validation(`bad value ${v}`)
    }
    const event: StoredEvent = {
      memoryId: input.memoryId,
      actorId: input.actorId,
      sessionId: input.sessionId,
      eventId: `0000000000000-${String(this._nextId++).padStart(8, '0')}`,
      // The service stores eventTimestamp at millisecond resolution.
      eventTimestamp: new Date(Math.floor(input.eventTimestamp.getTime())),
      payload: JSON.parse(JSON.stringify(input.payload)) as StoredEvent['payload'],
      metadata: JSON.parse(JSON.stringify(metadata)) as StoredEvent['metadata'],
      sequence: this._sequence++,
    }
    this.events.push(event)
    return { event: { eventId: event.eventId } }
  }

  private _listEvents(input: ListEventsInput): { events: Record<string, unknown>[]; nextToken?: string } {
    assertActorId(input.actorId)
    assertSessionId(input.sessionId)
    const maxResults = input.maxResults ?? 20
    if (maxResults < 1 || maxResults > 100) throw validation(`maxResults ${maxResults} outside 1..100`)
    const expressions = input.filter?.eventMetadata ?? []
    if (expressions.length > 5) throw validation('more than 5 eventMetadata filter expressions')

    const matching = this.events
      .filter((e) => e.memoryId === input.memoryId && e.actorId === input.actorId && e.sessionId === input.sessionId)
      .filter((e) => expressions.every((x) => matches(e, x)))
      .sort((a, b) => b.eventTimestamp.getTime() - a.eventTimestamp.getTime() || b.sequence - a.sequence)

    const offset = input.nextToken !== undefined ? Number(input.nextToken) : 0
    const page = matching.slice(offset, offset + maxResults)
    const next = offset + maxResults < matching.length ? String(offset + maxResults) : undefined
    return {
      events: page.map((e) => ({
        memoryId: e.memoryId,
        actorId: e.actorId,
        sessionId: e.sessionId,
        eventId: e.eventId,
        eventTimestamp: new Date(e.eventTimestamp.getTime()),
        metadata: e.metadata,
        payload: input.includePayloads === false ? undefined : e.payload,
      })),
      ...(next !== undefined && { nextToken: next }),
    }
  }

  private _deleteEvent(input: DeleteEventInput): { eventId: string } {
    const index = this.events.findIndex(
      (e) =>
        e.memoryId === input.memoryId &&
        e.actorId === input.actorId &&
        e.sessionId === input.sessionId &&
        e.eventId === input.eventId
    )
    if (index === -1) {
      const error = new Error(`event ${input.eventId} not found`)
      error.name = 'ResourceNotFoundException'
      throw error
    }
    this.events.splice(index, 1)
    return { eventId: input.eventId }
  }
}

/** Build an error whose `name` matches an AWS service exception. */
export function awsError(name: string, message = name): Error {
  const error = new Error(message)
  error.name = name
  return error
}

interface Command {
  constructor: { name: string }
  input: Record<string, unknown>
}

interface StoredEvent {
  memoryId: string
  actorId: string
  sessionId: string
  eventId: string
  eventTimestamp: Date
  payload: { blob?: unknown }[]
  metadata: Record<string, { stringValue: string }>
  sequence: number
}

interface CreateEventInput {
  memoryId: string
  actorId: string
  sessionId: string
  eventTimestamp: Date
  payload: { blob?: unknown }[]
  metadata?: Record<string, { stringValue: string }>
}

interface ListEventsInput {
  memoryId: string
  actorId: string
  sessionId: string
  includePayloads?: boolean
  maxResults?: number
  nextToken?: string
  filter?: { eventMetadata?: FilterExpression[] }
}

interface FilterExpression {
  left: { metadataKey: string }
  operator: 'EQUALS_TO' | 'EXISTS' | 'NOT_EXISTS'
  right?: { metadataValue: { stringValue: string } }
}

interface DeleteEventInput {
  memoryId: string
  actorId: string
  sessionId: string
  eventId: string
}

const METADATA_PATTERN = /^[a-zA-Z0-9\s._:/=+@-]*$/

function matches(event: StoredEvent, expression: FilterExpression): boolean {
  const value = event.metadata[expression.left.metadataKey]?.stringValue
  switch (expression.operator) {
    case 'EXISTS':
      return value !== undefined
    case 'NOT_EXISTS':
      return value === undefined
    case 'EQUALS_TO':
      return value !== undefined && value === expression.right?.metadataValue.stringValue
  }
}

function assertActorId(actorId: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_/:-]*$/.test(actorId) || actorId.length > 255) {
    throw validation(`bad actorId ${actorId}`)
  }
}

function assertSessionId(sessionId: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(sessionId) || sessionId.length > 100) {
    throw validation(`bad sessionId ${sessionId}`)
  }
}

function validation(message: string): Error {
  return awsError('ValidationException', message)
}

function utf8Length(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}
