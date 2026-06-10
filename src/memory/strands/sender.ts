import { type BedrockAgentCoreClient, CreateEventCommand } from '@aws-sdk/client-bedrock-agentcore'
import type { MessageData } from './_strands-memory-types.js'
import { extractText, isUserOrAssistantWithText, mapRole } from './format.js'
import type { AgentCoreWriteOptions, DropReason, MetadataProvider } from './types.js'

const DEFAULT_SEND_TIMEOUT_MS = 10000

export interface AgentCoreEventSenderConfig {
  client: BedrockAgentCoreClient
  memoryId: string
  actorId: string
  sessionId: string
  metadataProvider?: MetadataProvider | undefined
  writeOptions?: AgentCoreWriteOptions | undefined
}

/** A message paired with the seq the coordinator assigned it (when available). */
interface SeqMessage {
  message: MessageData
  seq: number | undefined
}

/**
 * Turns a batch of role-tagged messages into one `createEvent` per message.
 *
 * Resilience core (carried over in behavior from the shipped plugin's AsyncBatcher, without the
 * buffer — the extraction coordinator owns batching now): each send races a per-send timeout; failed
 * sends get exactly one retry; an event still failing after that is dropped (reported, never thrown,
 * so a write failure can't break the agent loop).
 *
 * Idempotency: v1 sends no `clientToken`, so a coordinator rollback-and-re-fire may create duplicate
 * events — which AgentCore's server-side consolidation collapses at the record level. When the
 * framework exposes a stable per-message `seq` (see `AddMessagesContext.seqs`), {@link sendBatch}
 * derives a deterministic `clientToken` so re-fires dedup exactly; distinct messages keep distinct
 * tokens, so genuinely-identical turns are never collapsed.
 */
export class AgentCoreEventSender {
  private readonly client: BedrockAgentCoreClient
  private readonly memoryId: string
  private readonly actorId: string
  private readonly sessionId: string
  private readonly metadataProvider: MetadataProvider | undefined
  private readonly sendTimeoutMs: number
  private readonly onDropped: AgentCoreWriteOptions['onDropped'] | undefined

  constructor(config: AgentCoreEventSenderConfig) {
    this.client = config.client
    this.memoryId = config.memoryId
    this.actorId = config.actorId
    this.sessionId = config.sessionId
    this.metadataProvider = config.metadataProvider
    this.sendTimeoutMs = config.writeOptions?.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS
    this.onDropped = config.writeOptions?.onDropped
  }

  /**
   * Send a batch. `seqs` (when the framework provides them) align 1:1 with `messages` and key a
   * deterministic, re-fire-stable `clientToken`.
   */
  async sendBatch(messages: MessageData[], seqs?: number[]): Promise<void> {
    const sendable: SeqMessage[] = messages
      .map((message, i) => ({ message, seq: seqs?.[i] }))
      .filter((m) => isUserOrAssistantWithText(m.message))

    const results = await Promise.allSettled(sendable.map((m) => this.sendOne(m)))

    const failed = sendable.filter((_, i) => results[i]!.status === 'rejected')
    if (failed.length === 0) return

    const retried = await Promise.allSettled(failed.map((m) => this.sendOne(m)))
    retried.forEach((r, i) => {
      if (r.status === 'rejected') {
        this.reportDropped(failed[i]!.message, 'retry-failed', (r as PromiseRejectedResult).reason)
      }
    })
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
      ...(metadata && { metadata }),
    })

    await this.withTimeout(
      // Promise.resolve().then(...) so a synchronous throw becomes a rejection (preserves allSettled isolation).
      Promise.resolve().then(() => this.client.send(command)),
      message
    )
  }

  /**
   * Deterministic when a stable `seq` is present (re-fire-safe idempotency); otherwise undefined
   * (v1: tolerate error-path duplicates, consolidation is the backstop). Never time/random-based,
   * which would defeat dedup across a re-fire.
   */
  private clientTokenFor(item: SeqMessage): string | undefined {
    if (item.seq === undefined) return undefined
    return `${this.memoryId}-${this.actorId}-${this.sessionId}-${item.seq}`
  }

  private async withTimeout(send: Promise<unknown>, message: MessageData): Promise<void> {
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = globalThis.setTimeout(() => {
        this.reportDropped(message, 'timeout')
        reject(new Error(`createEvent timed out after ${this.sendTimeoutMs}ms`))
      }, this.sendTimeoutMs)
    })
    try {
      await Promise.race([send, timeout])
    } finally {
      if (timer) globalThis.clearTimeout(timer)
    }
  }

  private reportDropped(message: MessageData, reason: DropReason, cause?: unknown): void {
    try {
      this.onDropped?.({ reason, text: extractText(message), ...(cause !== undefined && { cause }) })
    } catch (err) {
      // Never let a customer callback break the write path.
      console.warn('[agentcore-memory] onDropped callback threw:', err)
    }
  }
}
