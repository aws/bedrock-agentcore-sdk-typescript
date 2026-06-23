import { randomUUID } from 'crypto'
import { type BedrockAgentCoreClient, CreateEventCommand } from '@aws-sdk/client-bedrock-agentcore'
import type { MessageData } from '@strands-agents/sdk'
import { extractText, isUserOrAssistantWithText, mapRole } from './format.js'
import { DEFAULT_MAX_TURNS_PER_EVENT, type MetadataProvider } from './types.js'

export interface AgentCoreEventSenderConfig {
  client: BedrockAgentCoreClient
  memoryId: string
  actorId: string
  sessionId: string
  metadataProvider?: MetadataProvider | undefined
  /**
   * Run-unique id anchoring the idempotency `clientToken`. Defaults to a fresh UUID per sender. A new
   * sender is built per `(actorId, sessionId)` per process, so this distinguishes runs even when the
   * framework's per-message sequence numbers reset to 0 (e.g. on session restore).
   */
  runId?: string
  /**
   * Maximum conversational turns packed into a single `createEvent`. A batch larger than this splits
   * into `ceil(n / maxTurnsPerEvent)` events. Defaults to {@link DEFAULT_MAX_TURNS_PER_EVENT}; bounds
   * the payload well under the service limit.
   */
  maxTurnsPerEvent?: number
}

/** A message paired with the sequence number the coordinator assigned it (when available). */
interface SeqMessage {
  message: MessageData
  seq: number | undefined
}

/** A group of turns that become one `createEvent` (same metadata, capped at maxTurnsPerEvent). */
interface EventGroup {
  items: SeqMessage[]
  metadata: Record<string, unknown> | undefined
}

/**
 * Writes a batch of role-tagged messages to AgentCore, packing the turns into as few `createEvent`
 * calls as possible. `createEvent` accepts an array of conversational turns, so one flush of N turns
 * becomes a single call (chunked at `maxTurnsPerEvent`) rather than N calls — this is what lets the
 * extraction trigger cadence actually control API-call volume. AgentCore extracts a multi-turn event
 * into the same long-term records it would from N single-turn events.
 *
 * Error handling is delegated to the Strands `ExtractionCoordinator`: a failed `createEvent` throws
 * out of {@link sendBatch}, which makes the coordinator roll back its high-water mark and re-fire the
 * batch on the next trigger (with its own backoff and repeated-failure logging). The sender therefore
 * keeps no retry/timeout/drop machinery of its own — that would duplicate or fight the coordinator. A
 * caller that wants a per-request timeout configures it on the `client` it passes in (which also bounds
 * the read path).
 *
 * Idempotency: when the framework provides per-message sequence numbers (via
 * `AddMessagesContext.sequenceNumbers`), each event gets a deterministic `clientToken` derived from the
 * sequence range it covers, so a coordinator re-fire of the same batch dedups exactly. Because sequence
 * numbers reset to 0 across runs, the token also folds in a run-unique id (see
 * {@link AgentCoreEventSenderConfig.runId}). Without sequence numbers no token is sent; a re-fire then
 * writes one duplicate event, which AgentCore's server-side consolidation collapses at the record level
 * (wasteful but not incorrect). The token derivation is isolated in {@link tokenForSeqs} so it can move
 * to a stable per-message id when the framework exposes one.
 */
export class AgentCoreEventSender {
  private readonly client: BedrockAgentCoreClient
  private readonly memoryId: string
  private readonly actorId: string
  private readonly sessionId: string
  private readonly metadataProvider: MetadataProvider | undefined
  private readonly runId: string
  private readonly maxTurnsPerEvent: number

  constructor(config: AgentCoreEventSenderConfig) {
    this.client = config.client
    this.memoryId = config.memoryId
    this.actorId = config.actorId
    this.sessionId = config.sessionId
    this.metadataProvider = config.metadataProvider
    this.runId = config.runId ?? randomUUID()
    const cap = config.maxTurnsPerEvent ?? DEFAULT_MAX_TURNS_PER_EVENT
    if (!Number.isInteger(cap) || cap < 1) {
      throw new Error(`AgentCoreEventSender: maxTurnsPerEvent must be a positive integer, got ${cap}`)
    }
    this.maxTurnsPerEvent = cap
  }

  /**
   * Send a batch. The writable turns are packed into one `createEvent` per {@link EventGroup} (chunked
   * by `maxTurnsPerEvent` and split where per-message metadata changes). `sequenceNumbers` (when the
   * framework provides them) are index-aligned with `messages` and key each event's `clientToken`.
   * Throws an `AggregateError` if any event fails, so the coordinator retries the batch.
   */
  async sendBatch(messages: MessageData[], sequenceNumbers?: readonly number[]): Promise<void> {
    const sendable: SeqMessage[] = messages
      .map((message, i) => ({ message, seq: sequenceNumbers?.[i] }))
      .filter((m) => isUserOrAssistantWithText(m.message))
    if (sendable.length === 0) return

    const groups = this.groupIntoEvents(sendable)
    const results = await Promise.allSettled(groups.map((g) => this.sendEvent(g)))
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((f) => f.reason),
        `AgentCore createEvent failed for ${failures.length} of ${groups.length} event(s)`
      )
    }
  }

  /**
   * Partition the sendable turns into events. A new event starts when the per-message metadata changes
   * (the event's `metadata` is per-event in AgentCore, so turns in one event must share it) or when the
   * current event reaches `maxTurnsPerEvent`. With no `metadataProvider`, all turns share the empty
   * signature and collapse into size-capped events.
   */
  private groupIntoEvents(sendable: SeqMessage[]): EventGroup[] {
    const groups: EventGroup[] = []
    let current: EventGroup | undefined
    let currentSig: string | undefined
    for (const item of sendable) {
      const metadata = this.metadataProvider?.(item.message)
      const sig = metadata ? JSON.stringify(metadata) : ''
      const atCap = current !== undefined && current.items.length >= this.maxTurnsPerEvent
      if (current === undefined || sig !== currentSig || atCap) {
        current = { items: [], metadata }
        groups.push(current)
        currentSig = sig
      }
      current.items.push(item)
    }
    return groups
  }

  private async sendEvent(group: EventGroup): Promise<void> {
    const payload = group.items.map((item) => ({
      conversational: { role: mapRole(item.message), content: { text: extractText(item.message) } },
    }))
    const clientToken = this.tokenForSeqs(group.items.map((item) => item.seq))

    const command = new CreateEventCommand({
      memoryId: this.memoryId,
      actorId: this.actorId,
      sessionId: this.sessionId,
      eventTimestamp: new Date(),
      payload,
      ...(clientToken !== undefined && { clientToken }),
      ...(group.metadata && { metadata: toAgentCoreMetadata(group.metadata) }),
    })

    await this.client.send(command)
  }

  /**
   * Deterministic re-fire-stable token for an event covering the given sequence numbers, or `undefined`
   * when any is missing (then we tolerate error-path duplicates; consolidation is the backstop). The
   * token spans the event's `[firstSeq, lastSeq]`; a coordinator re-fire of the same batch reproduces
   * the same range. Never time/random-based per call — the run-unique part is fixed for the sender's
   * lifetime. Isolated here so it can switch to a stable per-message id when the framework exposes one.
   */
  private tokenForSeqs(seqs: (number | undefined)[]): string | undefined {
    if (seqs.length === 0 || seqs.some((s) => s === undefined)) return undefined
    const nums = seqs as number[]
    return `${this.memoryId}-${this.actorId}-${this.runId}-${nums[0]}-${nums[nums.length - 1]}`
  }
}

/** Map a lenient metadata bag to AgentCore's `{ stringValue }` event-metadata shape. */
function toAgentCoreMetadata(metadata: Record<string, unknown>): Record<string, { stringValue: string }> {
  const out: Record<string, { stringValue: string }> = {}
  for (const [key, value] of Object.entries(metadata)) {
    out[key] = { stringValue: typeof value === 'string' ? value : JSON.stringify(value) }
  }
  return out
}
