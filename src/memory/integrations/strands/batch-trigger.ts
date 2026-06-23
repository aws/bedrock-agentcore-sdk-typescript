import { ExtractionTrigger, type ExtractionTriggerContext, MessageAddedEvent } from '@strands-agents/sdk'
import { extractText, isUserOrAssistantWithText } from './format.js'

const DEFAULT_MESSAGE_COUNT = 10
const DEFAULT_MAX_DELAY_MS = 5000

export interface AgentCoreBatchTriggerOptions {
  /** Fire after this many messages accumulate since the last fire. Default 10. */
  messageCount?: number
  /** Fire once accumulated message text reaches this many bytes (UTF-8). Default: unset (off). */
  maxBytes?: number
  /** Fire at most this long after the first un-fired message, in ms. Default 5000. `0` disables the timer. */
  maxDelayMs?: number
}

/**
 * Optional write-cadence trigger that fires by message count, accumulated content size, or wall-clock
 * time. Its one unique capability over the built-in Strands triggers (`InvocationTrigger` /
 * `IntervalTrigger`) is non-turn-gated cadence: those only evaluate on `AfterInvocationEvent` (so the
 * finest they express is "every N turns"), whereas this can flush on a timer (`maxDelayMs`) or a size
 * threshold (`maxBytes`) between/within turns.
 *
 * When it actually matters: a **long-lived server that does NOT flush every turn** — there the timer
 * writes the tail of a conversation that has gone quiet without waiting for a next turn that may never
 * come. It is NOT needed for the common per-invocation-`flush()` pattern (flush force-drains regardless
 * of trigger), and it is NOT the write-cost lever — payload batching in the sender (one `createEvent`
 * per flush) reduces API calls under *any* trigger. `extraction: true` deliberately uses the Strands
 * default; reach for this only when you need time/size-based cadence.
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

  constructor(options: AgentCoreBatchTriggerOptions = {}) {
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

    context.agent.addHook(MessageAddedEvent, (event) => {
      // Count only user/assistant turns carrying text — the messages that become AgentCore events.
      // This matches the coordinator's per-turn write accounting (it filters with the same predicate)
      // and ignores tool-only / empty turns, which the sender skips anyway.
      // `event.message` is a `Message` class; toJSON() gives the plain `MessageData` the formatters want.
      const message = event.message.toJSON()
      if (!isUserOrAssistantWithText(message)) {
        return
      }
      n++
      if (maxBytes !== undefined) {
        // UTF-8 byte length (not .length) so the cap matches the bytes AgentCore actually receives.
        bytes += globalThis.Buffer.byteLength(extractText(message), 'utf8')
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
