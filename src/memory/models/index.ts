import { DictWrapper } from './dict-wrapper.js'

/**
 * Represents an actor summary.
 */
export class ActorSummary extends DictWrapper {
  constructor(data: Record<string, unknown>) {
    super(data)
  }

  get actorId(): string | undefined {
    return this.get('actorId') as string | undefined
  }
}

/**
 * Represents a conversation branch.
 */
export class Branch extends DictWrapper {
  constructor(data: Record<string, unknown>) {
    super(data)
  }

  get name(): string | undefined {
    return this.get('name') as string | undefined
  }

  get rootEventId(): string | undefined {
    return this.get('rootEventId') as string | undefined
  }

  get firstEventId(): string | undefined {
    return this.get('firstEventId') as string | undefined
  }

  get eventCount(): number | undefined {
    return this.get('eventCount') as number | undefined
  }

  get created(): Date | string | undefined {
    return this.get('created') as Date | string | undefined
  }
}

/**
 * Represents an event.
 */
export class Event extends DictWrapper {
  constructor(data: Record<string, unknown>) {
    super(data)
  }

  get eventId(): string | undefined {
    return this.get('eventId') as string | undefined
  }

  get actorId(): string | undefined {
    return this.get('actorId') as string | undefined
  }

  get sessionId(): string | undefined {
    return this.get('sessionId') as string | undefined
  }

  get eventTimestamp(): Date | string | undefined {
    return this.get('eventTimestamp') as Date | string | undefined
  }

  get payload(): unknown[] | undefined {
    return this.get('payload') as unknown[] | undefined
  }

  get branch(): Record<string, unknown> | undefined {
    return this.get('branch') as Record<string, unknown> | undefined
  }
}

/**
 * Represents an event message (conversational content).
 */
export class EventMessage extends DictWrapper {
  constructor(data: Record<string, unknown>) {
    super(data)
  }

  get role(): string | undefined {
    return this.get('role') as string | undefined
  }

  get content(): Record<string, unknown> | undefined {
    return this.get('content') as Record<string, unknown> | undefined
  }

  get text(): string | undefined {
    const content = this.content
    return content?.text as string | undefined
  }
}

/**
 * Represents a memory record.
 */
export class MemoryRecord extends DictWrapper {
  constructor(data: Record<string, unknown>) {
    super(data)
  }

  get memoryRecordId(): string | undefined {
    return this.get('memoryRecordId') as string | undefined
  }

  get content(): Record<string, unknown> | undefined {
    return this.get('content') as Record<string, unknown> | undefined
  }

  get relevanceScore(): number | undefined {
    return this.get('relevanceScore') as number | undefined
  }

  get namespace(): string | undefined {
    return this.get('namespace') as string | undefined
  }
}

/**
 * Represents a session summary.
 */
export class SessionSummary extends DictWrapper {
  constructor(data: Record<string, unknown>) {
    super(data)
  }

  get sessionId(): string | undefined {
    return this.get('sessionId') as string | undefined
  }

  get actorId(): string | undefined {
    return this.get('actorId') as string | undefined
  }

  get createdAt(): Date | string | undefined {
    return this.get('createdAt') as Date | string | undefined
  }

  get lastEventAt(): Date | string | undefined {
    return this.get('lastEventAt') as Date | string | undefined
  }
}

// Re-exports
export { DictWrapper } from './dict-wrapper.js'
export * from './filters.js'
