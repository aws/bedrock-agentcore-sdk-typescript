import type {
  HarnessContentBlockDelta,
  HarnessStopReason,
  InvokeHarnessStreamOutput,
} from '@aws-sdk/client-bedrock-agentcore'
import { Message, ModelError, ReasoningBlock, TextBlock } from '@strands-agents/sdk'
import type { ContentBlock, Role, StopReason } from '@strands-agents/sdk'

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

/** Reconstructs the latest Strands message from an `InvokeHarness` stream. */
export class HarnessStreamDecoder {
  private _role: Role = 'assistant'
  private _content: ContentBlock[] = []
  private _pending: PendingBlock | undefined
  private _stopReason: StopReason | undefined

  /** Folds one Harness event into the latest message. */
  accept(event: InvokeHarnessStreamOutput): void {
    if (event.messageStart) {
      this._content = []
      this._pending = undefined
      this._stopReason = undefined
      this._role = event.messageStart.role ?? 'assistant'
      return
    }
    if (event.contentBlockStart || event.contentBlockStop) {
      this._flushPending()
    } else if (event.contentBlockDelta?.delta) {
      this._acceptDelta(event.contentBlockDelta.delta)
    } else if (event.messageStop) {
      this._flushPending()
      const stopReason = event.messageStop.stopReason
      this._stopReason = stopReason && (STOP_REASON_MAP[stopReason] ?? stopReason)
    }
  }

  /** Returns the completed message, optionally overriding its stop reason for cancellation. */
  complete(stopReason: StopReason | undefined = this._stopReason): { message: Message; stopReason: StopReason } {
    this._flushPending()
    if (stopReason === undefined) {
      throw new ModelError('AgentCore Harness stream ended without completing a message')
    }

    return { message: new Message({ role: this._role, content: this._content }), stopReason }
  }

  private _acceptDelta(delta: HarnessContentBlockDelta): void {
    if (delta.text !== undefined) {
      if (this._pending?.kind !== 'text') {
        this._flushPending()
        this._pending = { kind: 'text', text: '' }
      }
      this._pending.text += delta.text
      return
    }
    const reasoning = delta.reasoningContent
    if (!reasoning || '$unknown' in reasoning) return

    if (this._pending?.kind !== 'reasoning') {
      this._flushPending()
      this._pending = { kind: 'reasoning', text: '' }
    }
    if (reasoning.text !== undefined) {
      this._pending.text += reasoning.text
    } else if (reasoning.signature !== undefined) {
      this._pending.signature = (this._pending.signature ?? '') + reasoning.signature
    } else if (reasoning.redactedContent !== undefined) {
      this._pending.redactedContent = concatBytes(this._pending.redactedContent, reasoning.redactedContent)
    }
  }

  private _flushPending(): void {
    const pending = this._pending
    if (!pending) return

    if (pending.kind === 'text') {
      if (pending.text) this._content.push(new TextBlock(pending.text))
    } else {
      this._content.push(
        new ReasoningBlock({
          ...(pending.text && { text: pending.text }),
          ...(pending.signature !== undefined && { signature: pending.signature }),
          ...(pending.redactedContent !== undefined && { redactedContent: pending.redactedContent }),
        })
      )
    }
    this._pending = undefined
  }
}

type PendingBlock =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string; signature?: string; redactedContent?: Uint8Array }

function concatBytes(current: Uint8Array | undefined, chunk: Uint8Array): Uint8Array {
  if (current === undefined) return chunk
  const combined = new Uint8Array(current.length + chunk.length)
  combined.set(current)
  combined.set(chunk, current.length)
  return combined
}
