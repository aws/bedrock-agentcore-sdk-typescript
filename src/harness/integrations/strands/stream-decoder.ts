import type {
  HarnessContentBlockDelta,
  HarnessContentBlockStart,
  HarnessStopReason,
  HarnessToolResultContentBlock,
  InvokeHarnessStreamOutput,
} from '@aws-sdk/client-bedrock-agentcore'
import {
  JsonBlock,
  Message,
  ModelContentBlockDeltaEvent,
  ModelContentBlockStartEvent,
  ModelContentBlockStopEvent,
  ModelError,
  ModelMessageStartEvent,
  ModelMessageStopEvent,
  ModelMetadataEvent,
  ReasoningBlock,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
} from '@strands-agents/sdk'
import type {
  ContentBlock,
  JSONValue,
  ModelStreamEvent,
  Role,
  StopReason,
  ToolResultContent,
  ToolResultStatus,
} from '@strands-agents/sdk'

/** Harness wire stop reasons mapped onto the Strands `StopReason` vocabulary. */
const STOP_REASON_MAP = {
  end_turn: 'endTurn',
  tool_use: 'toolUse',
  tool_result: 'toolResult',
  max_tokens: 'maxTokens',
  stop_sequence: 'stopSequence',
  content_filtered: 'contentFiltered',
  model_context_window_exceeded: 'modelContextWindowExceeded',
  max_iterations_exceeded: 'limitTurns',
  max_output_tokens_exceeded: 'limitOutputTokens',
  timeout_exceeded: 'timeoutExceeded',
  interrupted: 'interrupted',
  partial_turn: 'pauseTurn',
  malformed_model_output: 'malformedModelOutput',
  malformed_tool_use: 'malformedToolUse',
} satisfies Record<HarnessStopReason, StopReason>

interface DecodedHarnessInvocation {
  /** Most recent message completed by the Harness. */
  message: Message

  /** Reason the most recent message stopped. */
  stopReason: StopReason

  /** Deferred parse failure for a streamed tool input. */
  toolInputParseError?: SyntaxError

  /** Whether the final message stopped on a tool call that cannot execute locally. */
  terminalNonInlineToolUse?: true
}

/**
 * Reconstructs the final Strands message from an `InvokeHarness` event stream.
 *
 * The Harness streams a message as `messageStart`, interleaved content-block start/delta/stop events,
 * and `messageStop`. A single invocation may stream several messages (an assistant tool-use turn, then
 * the tool-result turn, then the final answer); each `messageStart` resets the accumulated content so
 * the decoder holds the latest message only.
 */
export class HarnessStreamDecoder {
  private readonly _state: StreamState = {
    messageStarted: false,
    role: 'assistant',
    content: [],
    pending: undefined,
    stopReason: undefined,
    toolInputParseError: undefined,
    nonInlineToolUseInMessage: false,
  }

  /**
   * Folds one Harness stream event into the invocation.
   *
   * @param event - Harness event to process
   * @returns Canonical Strands model events represented by this Harness event
   */
  accept(event: InvokeHarnessStreamOutput): ModelStreamEvent[] {
    const modelEvents: ModelStreamEvent[] = []
    accumulate(this._state, event, modelEvents)
    return modelEvents
  }

  /**
   * Completes the invocation.
   *
   * @returns Final message and stop reason
   * @throws {@link https://strandsagents.com | ModelError} When the stream did not complete a message
   */
  complete(): DecodedHarnessInvocation {
    const decoded = this.tryComplete()
    if (decoded === undefined) {
      throw new ModelError('AgentCore Harness stream ended without completing a message')
    }
    return decoded
  }

  /**
   * Completes the invocation when a message-stop event has already arrived.
   *
   * @returns Final message and stop reason, or `undefined` for an incomplete stream
   */
  tryComplete(): DecodedHarnessInvocation | undefined {
    if (this._state.stopReason === undefined) return undefined

    return {
      message: toMessage(this._state),
      stopReason: this._state.stopReason,
      ...(this._state.toolInputParseError !== undefined && {
        toolInputParseError: this._state.toolInputParseError,
      }),
      ...(this._state.stopReason === 'toolUse' &&
        this._state.nonInlineToolUseInMessage && { terminalNonInlineToolUse: true }),
    }
  }

  /**
   * Returns the message assembled before a cancelled stream ended.
   *
   * @returns Partially reconstructed message
   */
  partialMessage(): Message {
    return toMessage(this._state)
  }
}

/** A content block still accumulating deltas, not yet appended to the message. */
type PendingBlock =
  | { kind: 'text'; text: string }
  | { kind: 'toolUse'; toolUseId: string; name: string; input: string }
  | { kind: 'toolResult'; toolUseId: string; status: ToolResultStatus; content: ToolResultContent[] }
  | { kind: 'reasoning'; text: string; signature?: string; redactedContent?: Uint8Array }

interface StreamState {
  messageStarted: boolean
  role: Role
  content: ContentBlock[]
  pending: PendingBlock | undefined
  stopReason: StopReason | undefined
  toolInputParseError: SyntaxError | undefined
  nonInlineToolUseInMessage: boolean
}

function accumulate(state: StreamState, event: InvokeHarnessStreamOutput, modelEvents: ModelStreamEvent[]): void {
  if ('messageStart' in event && event.messageStart) {
    flushPending(state, modelEvents)
    state.messageStarted = true
    state.content.length = 0
    state.stopReason = undefined
    state.toolInputParseError = undefined
    state.nonInlineToolUseInMessage = false
    state.role = roleFromHarness(event.messageStart.role)
    modelEvents.push(new ModelMessageStartEvent({ type: 'modelMessageStartEvent', role: state.role }))
  }
  if ('contentBlockStart' in event && event.contentBlockStart) {
    assertMessageStarted(state)
    flushPending(state, modelEvents)
    state.pending = startBlock(state, event.contentBlockStart.start, modelEvents)
  }
  if ('contentBlockDelta' in event && event.contentBlockDelta) {
    assertMessageStarted(state)
    applyDelta(state, event.contentBlockDelta.delta, modelEvents)
  }
  if ('contentBlockStop' in event && event.contentBlockStop) {
    assertMessageStarted(state)
    if (state.pending === undefined) {
      throw new ModelError('AgentCore Harness contentBlockStop event has no active content block')
    }
    flushPending(state, modelEvents)
  }
  if ('messageStop' in event && event.messageStop) {
    assertMessageStarted(state)
    flushPending(state, modelEvents)
    state.stopReason = stopReasonFromHarness(event.messageStop.stopReason)
    state.messageStarted = false
    modelEvents.push(new ModelMessageStopEvent({ type: 'modelMessageStopEvent', stopReason: state.stopReason }))
  }
  if ('metadata' in event && event.metadata) {
    modelEvents.push(metadataFromHarness(event.metadata))
  }
}

function assertMessageStarted(state: StreamState): void {
  if (!state.messageStarted) {
    throw new ModelError('AgentCore Harness content event arrived outside a message')
  }
}

function toMessage(state: StreamState): Message {
  flushPending(state)
  return new Message({ role: state.role, content: state.content })
}

function roleFromHarness(role: string | undefined): Role {
  if (role === 'assistant' || role === 'user') return role
  throw new ModelError(`AgentCore Harness messageStart event has invalid role '${String(role)}'`)
}

/**
 * Maps a Harness wire stop reason to the Strands vocabulary.
 *
 * @param stopReason - Harness wire stop reason
 * @returns Corresponding Strands stop reason
 */
function stopReasonFromHarness(stopReason: string | undefined): StopReason {
  if (stopReason === undefined || stopReason.trim().length === 0) {
    throw new ModelError('AgentCore Harness messageStop event is missing a non-empty stopReason')
  }
  const mapped = STOP_REASON_MAP[stopReason as HarnessStopReason]
  if (mapped !== undefined) return mapped
  throw new ModelError(`AgentCore Harness returned unsupported stop reason '${stopReason}'`)
}

function startBlock(
  state: StreamState,
  start: HarnessContentBlockStart | undefined,
  modelEvents: ModelStreamEvent[]
): PendingBlock | undefined {
  if (start && 'toolUse' in start && start.toolUse) {
    const toolUseId = requiredWireString(start.toolUse.toolUseId, 'tool-use start', 'toolUseId')
    const name = requiredWireString(start.toolUse.name, 'tool-use start', 'name')
    state.nonInlineToolUseInMessage ||= start.toolUse.type !== 'tool_use'
    modelEvents.push(
      new ModelContentBlockStartEvent({
        type: 'modelContentBlockStartEvent',
        start: { type: 'toolUseStart', toolUseId, name },
      })
    )
    return {
      kind: 'toolUse',
      toolUseId,
      name,
      input: '',
    }
  }
  if (start && 'toolResult' in start && start.toolResult) {
    return {
      kind: 'toolResult',
      toolUseId: requiredWireString(start.toolResult.toolUseId, 'tool-result start', 'toolUseId'),
      status: start.toolResult.status === 'error' ? 'error' : 'success',
      content: [],
    }
  }
  throw new ModelError('AgentCore Harness returned an unsupported content-block start')
}

function requiredWireString(value: string | undefined, event: string, field: string): string {
  if (value !== undefined && value.length > 0) return value
  throw new ModelError(`AgentCore Harness ${event} event is missing a non-empty ${field}`)
}

function applyDelta(
  state: StreamState,
  delta: HarnessContentBlockDelta | undefined,
  modelEvents: ModelStreamEvent[]
): void {
  if (!delta) return
  const pending = state.pending

  if ('text' in delta && delta.text !== undefined) {
    if (pending?.kind === 'reasoning') {
      pending.text += delta.text
      modelEvents.push(
        new ModelContentBlockDeltaEvent({
          type: 'modelContentBlockDeltaEvent',
          delta: { type: 'reasoningContentDelta', text: delta.text },
        })
      )
    } else {
      if (pending?.kind === 'text') pending.text += delta.text
      else {
        if (pending !== undefined) {
          throw new ModelError(`AgentCore Harness text delta interrupted a ${pending.kind} content block`)
        }
        state.pending = { kind: 'text', text: delta.text }
        modelEvents.push(new ModelContentBlockStartEvent({ type: 'modelContentBlockStartEvent' }))
      }
      modelEvents.push(
        new ModelContentBlockDeltaEvent({
          type: 'modelContentBlockDeltaEvent',
          delta: { type: 'textDelta', text: delta.text },
        })
      )
    }
    return
  }
  if ('toolUse' in delta && delta.toolUse && pending?.kind === 'toolUse') {
    const input = delta.toolUse.input ?? ''
    pending.input += input
    modelEvents.push(
      new ModelContentBlockDeltaEvent({
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'toolUseInputDelta', input },
      })
    )
    return
  }
  if ('toolUse' in delta && delta.toolUse) {
    throw new ModelError('AgentCore Harness tool-use delta has no active tool-use block')
  }
  if ('toolResult' in delta && delta.toolResult && pending?.kind === 'toolResult') {
    for (const item of delta.toolResult) {
      pending.content.push(toolResultContentFromHarness(item))
    }
    return
  }
  if ('toolResult' in delta && delta.toolResult) {
    throw new ModelError('AgentCore Harness tool-result delta has no active tool-result block')
  }
  if ('reasoningContent' in delta && delta.reasoningContent) {
    applyReasoningDelta(state, delta.reasoningContent, modelEvents)
    return
  }
  throw new ModelError('AgentCore Harness returned an unsupported content-block delta')
}

function applyReasoningDelta(
  state: StreamState,
  reasoning: HarnessReasoningDelta,
  modelEvents: ModelStreamEvent[]
): void {
  const pending = state.pending
  if (pending?.kind === 'reasoning') {
    if ('text' in reasoning && reasoning.text !== undefined) pending.text += reasoning.text
    if ('signature' in reasoning && reasoning.signature !== undefined) {
      pending.signature = (pending.signature ?? '') + reasoning.signature
    }
    if ('redactedContent' in reasoning && reasoning.redactedContent !== undefined) {
      pending.redactedContent = concatBytes(pending.redactedContent, reasoning.redactedContent)
    }
  } else {
    if (pending !== undefined) {
      throw new ModelError(`AgentCore Harness reasoning delta interrupted a ${pending.kind} content block`)
    }
    state.pending = {
      kind: 'reasoning',
      text: 'text' in reasoning && reasoning.text ? reasoning.text : '',
      ...('signature' in reasoning && reasoning.signature !== undefined && { signature: reasoning.signature }),
      ...('redactedContent' in reasoning &&
        reasoning.redactedContent !== undefined && { redactedContent: reasoning.redactedContent }),
    }
    modelEvents.push(new ModelContentBlockStartEvent({ type: 'modelContentBlockStartEvent' }))
  }
  modelEvents.push(
    new ModelContentBlockDeltaEvent({
      type: 'modelContentBlockDeltaEvent',
      delta: { type: 'reasoningContentDelta', ...reasoning },
    })
  )
}

function metadataFromHarness(
  metadata: NonNullable<InvokeHarnessStreamOutput.MetadataMember['metadata']>
): ModelMetadataEvent {
  const usage = metadata.usage
  const metrics = metadata.metrics
  return new ModelMetadataEvent({
    type: 'modelMetadataEvent',
    ...(usage?.inputTokens !== undefined &&
      usage.outputTokens !== undefined &&
      usage.totalTokens !== undefined && {
        usage: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          ...(usage.cacheReadInputTokens !== undefined && {
            cacheReadInputTokens: usage.cacheReadInputTokens,
          }),
          ...(usage.cacheWriteInputTokens !== undefined && {
            cacheWriteInputTokens: usage.cacheWriteInputTokens,
          }),
        },
      }),
    ...(metrics?.latencyMs !== undefined && { metrics: { latencyMs: metrics.latencyMs } }),
  })
}

/** The reasoning arm of {@link HarnessContentBlockDelta}, which the AWS SDK does not name separately. */
type HarnessReasoningDelta = Extract<HarnessContentBlockDelta, { reasoningContent: unknown }>['reasoningContent']

function concatBytes(current: Uint8Array | undefined, chunk: Uint8Array): Uint8Array {
  if (current === undefined) return chunk
  const combined = new Uint8Array(current.length + chunk.length)
  combined.set(current)
  combined.set(chunk, current.length)
  return combined
}

function flushPending(state: StreamState, modelEvents?: ModelStreamEvent[]): void {
  const pending = state.pending
  if (!pending) return
  switch (pending.kind) {
    case 'text':
      if (pending.text) state.content.push(new TextBlock(pending.text))
      break
    case 'toolUse': {
      let input: JSONValue = {}
      if (pending.input) {
        try {
          input = JSON.parse(pending.input) as JSONValue
        } catch (error) {
          // Retain the first failure and keep decoding: the caller raises it once the turn ends, so a
          // truncated tool input does not mask a stop reason or later content in the same stream.
          if (error instanceof SyntaxError && !state.toolInputParseError) state.toolInputParseError = error
        }
      }
      state.content.push(new ToolUseBlock({ toolUseId: pending.toolUseId, name: pending.name, input }))
      break
    }
    case 'toolResult':
      state.content.push(
        new ToolResultBlock({ toolUseId: pending.toolUseId, status: pending.status, content: pending.content })
      )
      break
    case 'reasoning':
      state.content.push(
        new ReasoningBlock({
          ...(pending.text && { text: pending.text }),
          ...(pending.signature !== undefined && { signature: pending.signature }),
          ...(pending.redactedContent !== undefined && { redactedContent: pending.redactedContent }),
        })
      )
      break
  }
  if (modelEvents !== undefined && pending.kind !== 'toolResult') {
    modelEvents.push(new ModelContentBlockStopEvent({ type: 'modelContentBlockStopEvent' }))
  }
  state.pending = undefined
}

function toolResultContentFromHarness(item: HarnessToolResultContentBlock): ToolResultContent {
  if ('json' in item && item.json !== undefined) return new JsonBlock({ json: item.json as JSONValue })
  if ('text' in item && item.text !== undefined) return new TextBlock(item.text)
  throw new ModelError(`AgentCore Harness returned unsupported tool-result content '${item.$unknown[0]}'`)
}
