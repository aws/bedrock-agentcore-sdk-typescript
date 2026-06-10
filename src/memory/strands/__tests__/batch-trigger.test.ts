import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentCoreBatchTrigger } from '../batch-trigger.js'
import type { ExtractionTriggerContext, LocalAgent, MessageData } from '../_strands-memory-types.js'

/** A sentinel "event constructor" object the trigger subscribes to. */
const MESSAGE_ADDED_EVENT = { name: 'MessageAddedEvent' }

/**
 * Fake agent that captures the hook callback registered for MESSAGE_ADDED_EVENT and lets a test
 * drive message-added events directly.
 */
function makeAgentContext(): {
  agent: LocalAgent
  fire: ReturnType<typeof vi.fn>
  emit: (message: MessageData) => void
  context: ExtractionTriggerContext
} {
  let cb: ((event: unknown) => void) | undefined
  const agent: LocalAgent = {
    addHook: (eventType, callback) => {
      if (eventType === MESSAGE_ADDED_EVENT) cb = callback
      return () => {}
    },
  }
  const fire = vi.fn()
  const context: ExtractionTriggerContext = { agent, fire }
  const emit = (message: MessageData): void => {
    if (!cb) throw new Error('no hook registered')
    cb({ message })
  }
  return { agent, fire, emit, context }
}

const msg = (text = 'hi'): MessageData => ({ role: 'user', content: [{ text }] })

describe('AgentCoreBatchTrigger validation', () => {
  it('rejects non-positive messageCount', () => {
    expect(() => new AgentCoreBatchTrigger({ messageCount: 0, messageAddedEvent: MESSAGE_ADDED_EVENT })).toThrow()
  })
  it('rejects non-positive maxBytes', () => {
    expect(() => new AgentCoreBatchTrigger({ maxBytes: -1, messageAddedEvent: MESSAGE_ADDED_EVENT })).toThrow()
  })
  it('rejects negative maxDelayMs', () => {
    expect(() => new AgentCoreBatchTrigger({ maxDelayMs: -5, messageAddedEvent: MESSAGE_ADDED_EVENT })).toThrow()
  })
})

describe('AgentCoreBatchTrigger cadence', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('fires on messageCount', () => {
    const { context, fire, emit } = makeAgentContext()
    new AgentCoreBatchTrigger({ messageCount: 3, maxDelayMs: 0, messageAddedEvent: MESSAGE_ADDED_EVENT }).attach(
      context
    )
    emit(msg())
    emit(msg())
    expect(fire).not.toHaveBeenCalled()
    emit(msg())
    expect(fire).toHaveBeenCalledTimes(1)
  })

  it('resets the counter after firing (fires again every N)', () => {
    const { context, fire, emit } = makeAgentContext()
    new AgentCoreBatchTrigger({ messageCount: 2, maxDelayMs: 0, messageAddedEvent: MESSAGE_ADDED_EVENT }).attach(
      context
    )
    emit(msg())
    emit(msg()) // fire 1
    emit(msg())
    emit(msg()) // fire 2
    expect(fire).toHaveBeenCalledTimes(2)
  })

  it('fires on maxBytes (accumulated text length)', () => {
    const { context, fire, emit } = makeAgentContext()
    new AgentCoreBatchTrigger({
      messageCount: 100,
      maxBytes: 10,
      maxDelayMs: 0,
      messageAddedEvent: MESSAGE_ADDED_EVENT,
    }).attach(context)
    emit(msg('12345')) // 5
    expect(fire).not.toHaveBeenCalled()
    emit(msg('67890')) // 10 -> fire
    expect(fire).toHaveBeenCalledTimes(1)
  })

  it('fires on maxDelayMs after the first un-fired message', () => {
    const { context, fire, emit } = makeAgentContext()
    new AgentCoreBatchTrigger({ messageCount: 100, maxDelayMs: 5000, messageAddedEvent: MESSAGE_ADDED_EVENT }).attach(
      context
    )
    emit(msg())
    expect(fire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(5000)
    expect(fire).toHaveBeenCalledTimes(1)
  })

  it('clears the pending timer when a count-fire happens first (no double fire)', () => {
    const { context, fire, emit } = makeAgentContext()
    new AgentCoreBatchTrigger({ messageCount: 2, maxDelayMs: 5000, messageAddedEvent: MESSAGE_ADDED_EVENT }).attach(
      context
    )
    emit(msg()) // arms timer
    emit(msg()) // count-fire, should clear timer
    expect(fire).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(10000)
    expect(fire).toHaveBeenCalledTimes(1) // timer did not also fire
  })

  it('isolates state across two stores sharing one trigger instance (per-attach closures)', () => {
    const trigger = new AgentCoreBatchTrigger({
      messageCount: 2,
      maxDelayMs: 0,
      messageAddedEvent: MESSAGE_ADDED_EVENT,
    })
    const a = makeAgentContext()
    const b = makeAgentContext()
    trigger.attach(a.context)
    trigger.attach(b.context)

    a.emit(msg()) // a: 1
    b.emit(msg()) // b: 1
    expect(a.fire).not.toHaveBeenCalled()
    expect(b.fire).not.toHaveBeenCalled()
    a.emit(msg()) // a: 2 -> a fires, b unaffected
    expect(a.fire).toHaveBeenCalledTimes(1)
    expect(b.fire).not.toHaveBeenCalled()
  })
})
