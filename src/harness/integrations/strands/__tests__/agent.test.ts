import { describe, expect, it, type MockInstance, vi } from 'vitest'
import {
  BedrockAgentCoreClient,
  InvokeHarnessCommand,
  type HarnessReasoningContentBlockDelta,
  type InvokeHarnessStreamOutput,
} from '@aws-sdk/client-bedrock-agentcore'
import {
  ConcurrentInvocationError,
  ContextWindowOverflowError,
  MaxTokensError,
  Message,
  ModelThrottledError,
  ReasoningBlock,
  TextBlock,
} from '@strands-agents/sdk'
import { Graph } from '@strands-agents/sdk/multiagent'
import { AgentCoreHarnessAgent } from '../agent.js'
import type { AgentCoreHarnessStreamUpdateEvent } from '../events.js'
import type { AgentCoreHarnessAgentConfig } from '../types.js'

const HARNESS_ARN = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/TestHarness-abcdefghij'
const RUNTIME_SESSION_ID = 'session-id-padded-to-thirty-three'

type SendMock = MockInstance<BedrockAgentCoreClient['send']>
type HarnessEvent = AgentCoreHarnessStreamUpdateEvent['event']

const harnessEvent = {
  messageStart: (role: 'assistant' | 'user' = 'assistant'): HarnessEvent =>
    ({ messageStart: { role } }) as HarnessEvent,
  textDelta: (text: string): HarnessEvent => ({ contentBlockDelta: { delta: { text } } }) as HarnessEvent,
  reasoningDelta: (reasoningContent: HarnessReasoningContentBlockDelta): HarnessEvent =>
    ({ contentBlockDelta: { delta: { reasoningContent } } }) as HarnessEvent,
  contentBlockStop: (): HarnessEvent => ({ contentBlockStop: {} }) as HarnessEvent,
  messageStop: (stopReason: string): HarnessEvent => ({ messageStop: { stopReason } }) as HarnessEvent,
}

describe('AgentCoreHarnessAgent', () => {
  it('rejects an injected client that can retry a stateful turn', async () => {
    const client = new BedrockAgentCoreClient({ region: 'us-east-1', maxAttempts: 2 })
    const send = vi.spyOn(client, 'send')

    await expect(createHarnessAgent({ client }).invoke('Run it.')).rejects.toThrow(
      'requires an AgentCore client configured with maxAttempts: 1; received 2'
    )
    expect(send).not.toHaveBeenCalled()
  })

  it('sends one text request and streams raw events before the final result', async () => {
    const events = [
      harnessEvent.messageStart(),
      harnessEvent.textDelta('Discarded turn'),
      harnessEvent.messageStop('tool_use'),
      harnessEvent.messageStart(),
      harnessEvent.reasoningDelta({ text: 'considering' }),
      harnessEvent.reasoningDelta({ signature: 'signed' }),
      harnessEvent.contentBlockStop(),
      harnessEvent.textDelta('Complete.'),
      harnessEvent.messageStop('end_turn'),
    ]
    const { client, send } = createMockClient(harnessStream(...events))
    const { items, result } = await collectGenerator(
      createHarnessAgent({ client }).stream([
        new Message({ role: 'user', content: [new TextBlock('Earlier')] }),
        new Message({ role: 'assistant', content: [new TextBlock('Reply')] }),
        new Message({ role: 'user', content: [new TextBlock('Latest'), new TextBlock('request')] }),
      ])
    )

    expect(commandInput(send)).toStrictEqual({
      harnessArn: HARNESS_ARN,
      runtimeSessionId: RUNTIME_SESSION_ID,
      messages: [{ role: 'user', content: [{ text: 'Latest\nrequest' }] }],
    })
    expect(result).toMatchObject({
      stopReason: 'endTurn',
      lastMessage: {
        role: 'assistant',
        content: [new ReasoningBlock({ text: 'considering', signature: 'signed' }), new TextBlock('Complete.')],
      },
    })
    expect(items.map((event) => event.toJSON())).toStrictEqual([
      ...events.map((event) => ({ type: 'agentCoreHarnessStreamUpdateEvent', event })),
      { type: 'agentCoreHarnessResultEvent', result },
    ])
  })

  it('does not decode a buffered chunk returned by the read that triggers cancellation', async () => {
    const controller = new globalThis.AbortController()
    const events = [harnessEvent.messageStart(), harnessEvent.textDelta('before'), harnessEvent.textDelta(' after')]
    const stream = (async function* (): AsyncGenerator<InvokeHarnessStreamOutput> {
      yield events[0]!
      yield events[1]!
      controller.abort()
      yield events[2]!
    })()

    const { items, result } = await collectGenerator(
      createHarnessAgent({ client: createMockClient(stream).client }).stream('Run it.', {
        cancelSignal: controller.signal,
      })
    )

    expect(result).toMatchObject({ stopReason: 'cancelled', lastMessage: { content: [new TextBlock('before')] } })
    expect(items.map((event) => event.type)).toStrictEqual([
      'agentCoreHarnessStreamUpdateEvent',
      'agentCoreHarnessStreamUpdateEvent',
      'agentCoreHarnessResultEvent',
    ])
  })

  it('rejects concurrent work, then aborts and releases when the consumer stops', async () => {
    const { client, send } = createMockClient()
    send.mockImplementationOnce((_command, options) => {
      return new Promise((_resolve, reject) => {
        options!.abortSignal!.onabort = (): void => reject(new Error('aborted'))
      }) as never
    })
    send.mockResolvedValueOnce({ stream: textTurn('Available again.') } as never)
    const agent = createHarnessAgent({ client })
    const generator = agent.stream('Run it.')

    const pendingNext = generator.next()
    await expect(agent.invoke('Concurrent')).rejects.toBeInstanceOf(ConcurrentInvocationError)
    const pendingReturn = generator.return(undefined as never)

    await expect(pendingNext).resolves.toMatchObject({ value: { result: { stopReason: 'cancelled' } } })
    await pendingReturn
    await expect(agent.invoke('Run it again.')).resolves.toMatchObject({ stopReason: 'endTurn' })
  })

  it.each([
    ['empty input', '', undefined],
    ['non-text input', [new ReasoningBlock({ text: 'private' })], undefined],
    ['interrupt response', [{ interruptResponse: { interruptId: 'interrupt-1', response: 'continue' } }], undefined],
    ['structured output', 'Hi', { structuredOutputSchema: {} }],
    ['limits', 'Hi', { limits: { turns: 1 } }],
  ])('rejects %s before calling AgentCore', async (_label, args, options) => {
    const { client, send } = createMockClient()
    const invocation = createHarnessAgent({ client }).invoke(args as never, options as never)

    await expect(invocation).rejects.toBeInstanceOf(TypeError)
    expect(send).not.toHaveBeenCalled()
  })

  it('translates a context-window validation error from the stream', async () => {
    const { client } = createMockClient(
      harnessStream({ validationException: { message: 'Prompt is too long' } } as InvokeHarnessStreamOutput)
    )
    await expect(createHarnessAgent({ client }).invoke('Run it.')).rejects.toBeInstanceOf(ContextWindowOverflowError)
  })

  it('rejects a terminal tool request instead of reporting a successful result', async () => {
    const { client } = createMockClient(
      harnessStream(harnessEvent.messageStart(), harnessEvent.messageStop('tool_use'))
    )
    await expect(createHarnessAgent({ client }).invoke('Run it.')).rejects.toThrow(
      'cannot complete a Harness continuation with stop reason: toolUse'
    )
  })

  it('surfaces max-token termination with the partial message', async () => {
    const { client } = createMockClient(
      harnessStream(
        harnessEvent.messageStart(),
        harnessEvent.textDelta('partial'),
        harnessEvent.messageStop('max_tokens')
      )
    )
    const error = await createHarnessAgent({ client })
      .invoke('Run it.')
      .catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(MaxTokensError)
    expect((error as MaxTokensError).partialMessage.content).toStrictEqual([new TextBlock('partial')])
  })

  it('normalizes a throttled AgentCore request', async () => {
    const error = Object.assign(new Error('request failed'), { name: 'ThrottlingException' })
    const { client, send } = createMockClient()
    send.mockRejectedValueOnce(error)

    await expect(createHarnessAgent({ client }).invoke('Run it.')).rejects.toBeInstanceOf(ModelThrottledError)
  })

  it('runs as a Graph node and receives its predecessor output', async () => {
    const { client, send } = createMockClient(textTurn('Upstream summary'), textTurn('Harness graph result'))
    const upstream = createHarnessAgent({ client, id: 'upstream' })
    const downstream = createHarnessAgent({ client, id: 'downstream' })
    const graph = new Graph({ nodes: [upstream, downstream], edges: [[upstream.id, downstream.id]] })

    const result = await graph.invoke('Original task')

    expect(result.content).toStrictEqual([new TextBlock('Harness graph result')])
    expect(commandInput(send, 1).messages![0]!.content![0]).toMatchObject({
      text: expect.stringContaining('Upstream summary'),
    })
  })
})

async function* harnessStream(...events: InvokeHarnessStreamOutput[]): AsyncGenerator<InvokeHarnessStreamOutput> {
  yield* events
}

function textTurn(text: string): AsyncGenerator<InvokeHarnessStreamOutput> {
  return harnessStream(harnessEvent.messageStart(), harnessEvent.textDelta(text), harnessEvent.messageStop('end_turn'))
}

function createMockClient(...streams: AsyncIterable<InvokeHarnessStreamOutput>[]): {
  client: BedrockAgentCoreClient
  send: SendMock
} {
  const client = new BedrockAgentCoreClient({ region: 'us-east-1', maxAttempts: 1 })
  const send = vi.spyOn(client, 'send')
  streams.forEach((stream) => send.mockResolvedValueOnce({ stream } as never))
  return { client, send }
}

function commandInput(send: SendMock, index = 0): InvokeHarnessCommand['input'] {
  return (send.mock.calls[index]![0] as InvokeHarnessCommand).input
}

function createHarnessAgent(config: Partial<AgentCoreHarnessAgentConfig> = {}): AgentCoreHarnessAgent {
  return new AgentCoreHarnessAgent({
    harnessArn: HARNESS_ARN,
    runtimeSessionId: RUNTIME_SESSION_ID,
    ...config,
  })
}

async function collectGenerator<T, R>(generator: AsyncGenerator<T, R, undefined>): Promise<{ items: T[]; result: R }> {
  const items: T[] = []
  let next = await generator.next()
  while (!next.done) {
    items.push(next.value)
    next = await generator.next()
  }
  return { items, result: next.value }
}
