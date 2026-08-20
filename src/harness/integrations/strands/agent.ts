import { BedrockAgentCoreClient, InvokeHarnessCommand } from '@aws-sdk/client-bedrock-agentcore'
import {
  AgentResult,
  ConcurrentInvocationError,
  ContextWindowOverflowError,
  MaxTokensError,
  ModelError,
  ModelThrottledError,
} from '@strands-agents/sdk'
import type { ContentBlock, ContentBlockData, InvokeArgs, InvokeOptions, MessageData } from '@strands-agents/sdk'
import {
  AgentCoreHarnessResultEvent,
  AgentCoreHarnessStreamUpdateEvent,
  type AgentCoreHarnessStreamEvent,
} from './events.js'
import { HarnessStreamDecoder } from './stream-decoder.js'
import type { AgentCoreHarnessAgentConfig } from './types.js'

const DEFAULT_MAX_ATTEMPTS = 1
const CONTEXT_WINDOW_OVERFLOW_MESSAGES = [
  'input is too long for requested model',
  'input length and `max_tokens` exceed context limit',
  'too many total text bytes',
  'prompt is too long',
]

/**
 * Adapts one deployed [AgentCore Harness](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness.html)
 * to the Strands `InvokableAgent` interface, so a Harness composes into a Strands `Graph`.
 *
 * Each call sends one non-empty text message through `InvokeHarness`; message history contributes only
 * its latest user message.
 *
 * The deployed Harness owns its model, system prompt, tools, skills, memory, limits, and agent loop, and
 * runs tool calls inside its own microVM. Reuse one `runtimeSessionId` to continue a conversation.
 *
 * @experimental
 *
 * @example
 * ```typescript
 * import { randomUUID } from 'node:crypto'
 * import { AgentCoreHarnessAgent } from 'bedrock-agentcore/experimental/harness/strands'
 *
 * const agent = new AgentCoreHarnessAgent({
 *   harnessArn: process.env.AGENTCORE_HARNESS_ARN!,
 *   runtimeSessionId: randomUUID(),
 * })
 *
 * const result = await agent.invoke('Tell me about your local environment.')
 * console.log(result.toString())
 * ```
 */
export class AgentCoreHarnessAgent {
  private readonly _client: BedrockAgentCoreClient
  private readonly _harnessArn: string
  private readonly _runtimeSessionId: string
  private _isInvoking = false

  /** Identifier unique to this Harness session. */
  readonly id: string

  /** Name surfaced to Strands multi-agent primitives. */
  readonly name?: string

  /** Description surfaced to Strands multi-agent primitives. */
  readonly description?: string

  /**
   * Creates a Harness adapter.
   *
   * @param config - Harness identity, session, and optional AgentCore client
   */
  constructor(config: AgentCoreHarnessAgentConfig) {
    this._harnessArn = config.harnessArn
    this._runtimeSessionId = config.runtimeSessionId
    this.id = config.id ?? `${config.harnessArn}:${config.runtimeSessionId}`
    if (config.name !== undefined) this.name = config.name
    if (config.description !== undefined) this.description = config.description

    // AgentCore owns Harness ARN and session-ID validation.
    this._client = config.client ?? new BedrockAgentCoreClient({ maxAttempts: DEFAULT_MAX_ATTEMPTS })
  }

  /**
   * Invokes the deployed Harness and returns its final result.
   *
   * @param args - Non-empty text as a string, text blocks, or message history
   * @param options - Cancellation and invocation state; other options are unsupported
   * @returns Final Harness result
   */
  async invoke(args: InvokeArgs, options?: InvokeOptions): Promise<AgentResult> {
    const generator = this.stream(args, options)
    let next = await generator.next()
    while (!next.done) {
      next = await generator.next()
    }
    return next.value
  }

  /**
   * Streams one `InvokeHarness` request.
   *
   * @param args - Non-empty text as a string, text blocks, or message history
   * @param options - Cancellation and invocation state; other options are unsupported
   * @returns Raw Harness events followed by the final result event and generator return value
   */
  stream(
    args: InvokeArgs,
    options?: InvokeOptions
  ): AsyncGenerator<AgentCoreHarnessStreamEvent, AgentResult, undefined> {
    const transportAbortController = new AbortController()
    const generator = this._stream(args, options, transportAbortController)
    const close = generator.return.bind(generator)
    const fail = generator.throw.bind(generator)

    generator.return = (
      value: AgentResult | PromiseLike<AgentResult>
    ): Promise<IteratorResult<AgentCoreHarnessStreamEvent, AgentResult>> => {
      transportAbortController.abort()
      return close(value)
    }
    generator.throw = (error?: unknown): Promise<IteratorResult<AgentCoreHarnessStreamEvent, AgentResult>> => {
      transportAbortController.abort()
      return fail(error)
    }
    return generator
  }

  private async *_stream(
    args: InvokeArgs,
    options: InvokeOptions | undefined,
    transportAbortController: AbortController
  ): AsyncGenerator<AgentCoreHarnessStreamEvent, AgentResult, undefined> {
    if (this._isInvoking) {
      throw new ConcurrentInvocationError(
        'AgentCoreHarnessAgent is already processing an invocation. Wait for the current invoke() or stream() call to complete before invoking again.'
      )
    }
    this._isInvoking = true
    const invocationState = options?.invocationState ?? {}
    const abortSignal = options?.cancelSignal
      ? AbortSignal.any([transportAbortController.signal, options.cancelSignal])
      : transportAbortController.signal
    const decoder = new HarnessStreamDecoder()

    try {
      const text = textFromInvokeArgs(args)
      if (options?.structuredOutputSchema !== undefined) {
        throw new TypeError('InvokeOptions.structuredOutputSchema is not supported by AgentCoreHarnessAgent.')
      }
      if (options?.limits !== undefined) {
        throw new TypeError('InvokeOptions.limits is not supported by AgentCoreHarnessAgent.')
      }

      if (!abortSignal.aborted) {
        const maxAttempts = await this._client.config.maxAttempts()
        if (maxAttempts !== DEFAULT_MAX_ATTEMPTS) {
          throw new TypeError(
            `AgentCoreHarnessAgent requires an AgentCore client configured with maxAttempts: 1; received ${maxAttempts}.`
          )
        }

        try {
          const response = await this._client.send(
            new InvokeHarnessCommand({
              harnessArn: this._harnessArn,
              runtimeSessionId: this._runtimeSessionId,
              messages: [{ role: 'user', content: [{ text }] }],
            }),
            { abortSignal }
          )
          for await (const chunk of response.stream ?? []) {
            if (abortSignal.aborted) break

            const streamError = chunk.internalServerException ?? chunk.validationException ?? chunk.runtimeClientError
            if (streamError) throw streamError

            const event = chunk as AgentCoreHarnessStreamUpdateEvent['event']
            yield new AgentCoreHarnessStreamUpdateEvent(event)
            decoder.accept(event)
          }
        } catch (error) {
          if (!abortSignal.aborted) throw normalizeHarnessError(error)
        }
      }

      const decoded = decoder.complete(abortSignal.aborted ? 'cancelled' : undefined)
      if (!abortSignal.aborted) throwIfUnrecoverable(decoded.stopReason, decoded.message)
      const result = new AgentResult({
        stopReason: decoded.stopReason,
        lastMessage: decoded.message,
        invocationState,
      })
      yield new AgentCoreHarnessResultEvent({ result })
      return result
    } finally {
      this._isInvoking = false
    }
  }
}

function textFromInvokeArgs(args: InvokeArgs): string {
  if (args.length === 0) throw new TypeError('AgentCoreHarnessAgent input must contain non-empty text.')
  if (typeof args === 'string') return args

  const first = args[0]!
  if ('interruptResponse' in first) {
    throw new TypeError('AgentCoreHarnessAgent does not support interrupt response input.')
  }

  if ('role' in first) {
    // Message history: the Harness owns conversation state under `runtimeSessionId`, so only the
    // newest user message is sent. Replaying earlier turns would duplicate them server-side.
    const latestUserMessage = Array.from(args as MessageData[])
      .reverse()
      .find((message) => message.role === 'user')
    if (latestUserMessage === undefined) {
      throw new TypeError('AgentCoreHarnessAgent message input must include at least one user message.')
    }
    return textFromContentBlocks(latestUserMessage.content)
  }

  return textFromContentBlocks(args as ContentBlock[] | ContentBlockData[])
}

function textFromContentBlocks(blocks: ContentBlock[] | ContentBlockData[]): string {
  const text: string[] = []
  for (const value of blocks) {
    if ('type' in value && value.type !== 'textBlock') {
      throw new TypeError(`AgentCoreHarnessAgent accepts only text content blocks; received ${value.type}.`)
    }
    if (!('text' in value)) {
      throw new TypeError('AgentCoreHarnessAgent accepts only text content blocks.')
    }
    text.push(value.text)
  }
  const joined = text.join('\n')
  if (joined.length === 0) throw new TypeError('AgentCoreHarnessAgent input must contain non-empty text.')
  return joined
}

function throwIfUnrecoverable(stopReason: AgentResult['stopReason'], message: AgentResult['lastMessage']): void {
  switch (stopReason) {
    case 'maxTokens':
      throw new MaxTokensError(
        'Model reached maximum token limit. This is an unrecoverable state that requires intervention.',
        message
      )
    case 'interrupted':
    case 'malformedModelOutput':
    case 'malformedToolUse':
      throw new ModelError(`Harness ended the turn with an unrecoverable stop reason: ${stopReason}`)
    case 'toolUse':
    case 'toolResult':
    case 'pauseTurn':
      throw new ModelError(
        `AgentCoreHarnessAgent cannot complete a Harness continuation with stop reason: ${stopReason}`
      )
  }
}

function normalizeHarnessError(error: unknown): ModelError {
  if (error instanceof ModelError) return error

  const message =
    typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : String(error)
  if (error instanceof Error && error.name === 'ThrottlingException') {
    return new ModelThrottledError(message, { cause: error })
  }
  const normalizedMessage = message.toLowerCase()
  if (CONTEXT_WINDOW_OVERFLOW_MESSAGES.some((phrase) => normalizedMessage.includes(phrase))) {
    return new ContextWindowOverflowError(message)
  }
  return new ModelError(message, { cause: error })
}
