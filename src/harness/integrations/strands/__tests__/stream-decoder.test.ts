import { describe, expect, it } from 'vitest'
import type { InvokeHarnessStreamOutput } from '@aws-sdk/client-bedrock-agentcore'
import { JsonBlock, Message, ModelError, ReasoningBlock, TextBlock, ToolResultBlock } from '@strands-agents/sdk'
import { HarnessStreamDecoder } from '../stream-decoder.js'
import { harnessEvent } from './harness-test-helpers.js'

function decode(...events: InvokeHarnessStreamOutput[]): ReturnType<HarnessStreamDecoder['complete']> {
  const decoder = new HarnessStreamDecoder()
  for (const event of events) decoder.accept(event)
  return decoder.complete()
}

describe('HarnessStreamDecoder', () => {
  it('emits model events and reconstructs the final message from one fold', () => {
    const decoder = new HarnessStreamDecoder()
    const modelEvents = [
      harnessEvent.messageStart(),
      harnessEvent.textDelta('Done.'),
      harnessEvent.contentBlockStop(),
      harnessEvent.messageStop('end_turn'),
    ].flatMap((streamEvent) => decoder.accept(streamEvent))

    expect(modelEvents.map(({ type }) => type)).toStrictEqual([
      'modelMessageStartEvent',
      'modelContentBlockStartEvent',
      'modelContentBlockDeltaEvent',
      'modelContentBlockStopEvent',
      'modelMessageStopEvent',
    ])
    expect(decoder.complete()).toStrictEqual({
      message: new Message({ role: 'assistant', content: [new TextBlock('Done.')] }),
      stopReason: 'endTurn',
    })
  })

  describe('complete', () => {
    it('keeps the latest message and assembles its reasoning and text blocks', () => {
      const result = decode(
        harnessEvent.messageStart(),
        harnessEvent.textDelta('superseded'),
        harnessEvent.messageStop('end_turn'),
        harnessEvent.messageStart('user'),
        harnessEvent.messageStop('tool_result'),
        harnessEvent.messageStart(),
        harnessEvent.reasoningDelta({ text: 'considering' }),
        harnessEvent.reasoningDelta({ signature: 'signed' }),
        harnessEvent.contentBlockStop(),
        harnessEvent.textDelta('Complete.'),
        harnessEvent.contentBlockStop(),
        harnessEvent.messageStop('end_turn')
      )

      expect(result).toStrictEqual({
        message: new Message({
          role: 'assistant',
          content: [new ReasoningBlock({ text: 'considering', signature: 'signed' }), new TextBlock('Complete.')],
        }),
        stopReason: 'endTurn',
      })
    })

    it('decodes text and JSON content from an error tool result', () => {
      const result = decode(
        harnessEvent.messageStart(),
        harnessEvent.toolResultStart('tool-1', 'error'),
        harnessEvent.toolResultDelta([{ text: 'boom' }, { json: { code: 42 } }]),
        harnessEvent.contentBlockStop(),
        harnessEvent.messageStop('tool_result')
      )

      expect(result).toStrictEqual({
        message: new Message({
          role: 'assistant',
          content: [
            new ToolResultBlock({
              toolUseId: 'tool-1',
              status: 'error',
              content: [new TextBlock('boom'), new JsonBlock({ json: { code: 42 } })],
            }),
          ],
        }),
        stopReason: 'toolResult',
      })
    })

    it.each([
      {
        label: 'content before message start',
        events: [harnessEvent.textDelta('orphaned')],
      },
      {
        label: 'a tool-use delta without a block start',
        events: [harnessEvent.messageStart(), harnessEvent.toolUseDelta('{}')],
      },
      {
        label: 'an unknown block start',
        events: [
          harnessEvent.messageStart(),
          { contentBlockStart: { start: { $unknown: ['futureBlock', {}] } } } as InvokeHarnessStreamOutput,
        ],
      },
    ])('rejects $label', ({ events }) => {
      expect(() => decode(...events)).toThrow(ModelError)
    })

    it('rejects a stream without a completed message', () => {
      const decoder = new HarnessStreamDecoder()
      decoder.accept(harnessEvent.messageStart())
      decoder.accept(harnessEvent.textDelta('no stop event'))

      expect(() => decoder.complete()).toThrow(
        new ModelError('AgentCore Harness stream ended without completing a message')
      )
    })
  })
})
