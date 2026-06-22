import { type BedrockAgentCoreClient, CreateEventCommand } from '@aws-sdk/client-bedrock-agentcore'
import type { MessageData } from '@strands-agents/sdk'
import { extractText, isUserOrAssistantWithText, mapRole } from './format.js'
import type { MetadataProvider } from './types.js'

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
}

/** A message paired with the sequence number the coordinator assigned it (when available). */
interface SeqMessage {
  message: MessageData
  seq: number | undefined
}

/**
 * Turns a batch of role-tagged messages into one `createEvent` per message.
 *
 * Error handling is delegated to the Strands `ExtractionCoordinator`: a failed `createEvent` throws
 * out of {@link sendBatch}, which makes the coordinator roll back its high-water mark and re-fire the
 * batch on the next trigger (with its own backoff and repeated-failure logging). The sender therefore
 * keeps no retry/timeout/drop machinery of its own — that would duplicate or fight the coordinator. A
 * caller that wants a per-request timeout configures it on the `client` it passes in (which also bounds
 * the read path).
 *
 * Idempotency: when the framework provides per-message sequence numbers (via
 * `AddMessagesContext.sequenceNumbers`), {@link sendBatch} derives a deterministic `clientToken` so a
 * coordinator re-fire dedups exactly — distinct messages keep distinct tokens, so genuinely-identical
 * turns are never collapsed. Because sequence numbers reset to 0 across runs, the token combines the
 * number with a run-unique id (see {@link AgentCoreEventSenderConfig.runId}). Without sequence numbers
 * the sender sends no token; a re-fire may then create duplicate events, which AgentCore's server-side
 * consolidation collapses at the record level (wasteful but not incorrect).
 */
export class AgentCoreEventSender {
  private readonly client: BedrockAgentCoreClient
  private readonly memoryId: string
  private readonly actorId: string
  private readonly sessionId: string
  private readonly metadataProvider: MetadataProvider | undefined
  private readonly runId: string

  constructor(config: AgentCoreEventSenderConfig) {
    this.client = config.client
    this.memoryId = config.memoryId
    this.actorId = config.actorId
    this.sessionId = config.sessionId
    this.metadataProvider = config.metadataProvider
    this.runId = config.runId ?? globalThis.crypto.randomUUID()
  }

  /**
   * Send a batch. `sequenceNumbers` (when the framework provides them) are index-aligned with
   * `messages` and key a deterministic, re-fire-stable `clientToken`. Throws if any `createEvent`
   * fails, so the coordinator retries the batch.
   */
  async sendBatch(messages: MessageData[], sequenceNumbers?: readonly number[]): Promise<void> {
    const sendable: SeqMessage[] = messages
      .map((message, i) => ({ message, seq: sequenceNumbers?.[i] }))
      .filter((m) => isUserOrAssistantWithText(m.message))

    // Surface the first failure (others are reported by AggregateError) so the coordinator re-fires.
    const results = await Promise.allSettled(sendable.map((m) => this.sendOne(m)))
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((f) => f.reason),
        `AgentCore createEvent failed for ${failures.length} of ${sendable.length} message(s)`
      )
    }
  }

  private async sendOne(item: SeqMessage): Promise<void> {
    const { message } = item
    const text = extractText(message)
    const metadata = this.metadataProvider?.(message)
    const clientToken = this.clientTokenFor(item)

    const command = new CreateEventCommand({
      memoryId: this.memoryId,
      actorId: this.actorId,
      sessionId: this.sessionId,
      eventTimestamp: new Date(),
      payload: [{ conversational: { role: mapRole(message), content: { text } } }],
      ...(clientToken !== undefined && { clientToken }),
      ...(metadata && { metadata: toAgentCoreMetadata(metadata) }),
    })

    await this.client.send(command)
  }

  /**
   * Deterministic when a stable `seq` is present (re-fire-safe idempotency); otherwise undefined
   * (tolerate error-path duplicates, consolidation is the backstop). Never time/random-based per call,
   * which would defeat dedup across a re-fire; the run-unique part is fixed for the sender's lifetime.
   */
  private clientTokenFor(item: SeqMessage): string | undefined {
    if (item.seq === undefined) return undefined
    return `${this.memoryId}-${this.actorId}-${this.runId}-${item.seq}`
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
