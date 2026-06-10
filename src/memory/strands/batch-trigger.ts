import { ExtractionTrigger, type ExtractionTriggerContext, type MessageData } from './_strands-memory-types.js'
import { extractText } from './format.js'

const DEFAULT_MESSAGE_COUNT = 10
const DEFAULT_MAX_DELAY_MS = 5000

/**
 * Constructor injected so the trigger can subscribe to message-added events without importing the
 * SDK's concrete `MessageAddedEvent` (which is not in a published `@strands-agents/sdk` yet). At the
 * release flip this defaults to the real `MessageAddedEvent`.
 */
export interface AgentCoreBatchTriggerOptions {
  /** Fire after this many messages accumulate since the last fire. Default 10. */
  messageCount?: number
  /** Fire once accumulated message text reaches this many characters. Default: unset (off). */
  maxBytes?: number
  /** Fire at most this long after the first un-fired message, in ms. Default 5000. `0` disables the timer. */
  maxDelayMs?: number
  /**
   * The hook-event constructor to subscribe to (the SDK's `MessageAddedEvent`). Injected so this
   * file does not depend on the unpublished SDK memory/hook surface; the factory supplies it.
   */
  messageAddedEvent: unknown
}

/** Shape of the message-added hook event we read (structural; matches the SDK's `MessageAddedEvent`). */
interface MessageAddedLike {
  message: MessageData
}

function hasMessage(event: unknown): event is MessageAddedLike {
  return (
    typeof event === 'object' &&
    event !== null &&
    'message' in event &&
    typeof (event as { message?: unknown }).message === 'object'
  )
}

/**
 * Custom write-cadence trigger: fires extraction by message count, accumulated content size, or
 * wall-clock time — the granularity AgentCore needs to control `createEvent` volume, which the
 * built-in turn-based triggers (`InvocationTrigger` / `IntervalTrigger`) don't offer.
 *
 * All cadence state lives in a closure created in {@link attach}, never in instance fields, so one
 * trigger instance attached to multiple stores keeps independent counters (mirrors the SDK's
 * `IntervalTrigger`). The pending timer is cleared on every fire so it never strands the event loop.
 */
export class AgentCoreBatchTrigger extends ExtractionTrigger {
  readonly name = 'agentcore-batch'

  private readonly messageCount: number
  private readonly maxBytes: number | undefined
  private readonly maxDelayMs: number
  private readonly messageAddedEvent: unknown

  constructor(options: AgentCoreBatchTriggerOptions) {
    super()
    const messageCount = options.messageCount ?? DEFAULT_MESSAGE_COUNT
    if (!Number.isInteger(messageCount) || messageCount < 1) {
      throw new Error(`AgentCoreBatchTrigger: messageCount must be a positive integer, got ${messageCount}`)
    }
    if (options.maxBytes !== undefined && (!Number.isInteger(options.maxBytes) || options.maxBytes < 1)) {
      throw new Error(`AgentCoreBatchTrigger: maxBytes must be a positive integer, got ${options.maxBytes}`)
    }
    const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
    if (!Number.isFinite(maxDelayMs) || maxDelayMs < 0) {
      throw new Error(`AgentCoreBatchTrigger: maxDelayMs must be a non-negative number, got ${maxDelayMs}`)
    }
    this.messageCount = messageCount
    this.maxBytes = options.maxBytes
    this.maxDelayMs = maxDelayMs
    this.messageAddedEvent = options.messageAddedEvent
  }

  attach(context: ExtractionTriggerContext): void {
    const { messageCount, maxBytes, maxDelayMs } = this

    // Closure-local cadence state: independent per attach, so a shared instance is safe across stores.
    let n = 0
    let bytes = 0
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined

    const reset = (): void => {
      n = 0
      bytes = 0
      if (timer) {
        globalThis.clearTimeout(timer)
        timer = undefined
      }
    }

    const fire = (): void => {
      reset()
      context.fire() // fire-and-forget; coordinator only processes messages past the high-water mark
    }

    context.agent.addHook(this.messageAddedEvent, (event: unknown) => {
      n++
      if (maxBytes !== undefined && hasMessage(event)) {
        bytes += extractText(event.message).length
      }
      if (!timer && maxDelayMs > 0) {
        timer = globalThis.setTimeout(fire, maxDelayMs)
      }
      if (n >= messageCount || (maxBytes !== undefined && bytes >= maxBytes)) {
        fire()
      }
    })
  }
}
