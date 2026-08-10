import { describe, expect, it } from 'vitest'
import type { InvokeHarnessStreamOutput } from '@aws-sdk/client-bedrock-agentcore'
import {
  ConcurrentInvocationError,
  ContextWindowOverflowError,
  MaxTokensError,
  Message,
  ModelError,
  ModelThrottledError,
  ReasoningBlock,
  TextBlock,
} from '@strands-agents/sdk'
import { AgentCoreHarnessStreamUpdateEvent } from '../events.js'
import {
  HARNESS_ARN,
  RUNTIME_SESSION_ID,
  collectGenerator,
  commandInput,
  createHarnessAgent,
  createMockControlClient,
  createMockClient,
  harnessEvent,
  harnessStream,
} from './harness-test-helpers.js'

async function* cancelledStream(controller: AbortController): AsyncGenerator<InvokeHarnessStreamOutput> {
  yield harnessEvent.messageStart()
  yield harnessEvent.textDelta('partial')
  controller.abort()
  throw new Error('aborted')
}

describe('AgentCoreHarnessAgent', () => {
  describe('constructor', () => {
    it('derives identity from the Harness session and accepts overrides', () => {
      expect(createHarnessAgent()).toMatchObject({
        id: `${HARNESS_ARN}:${RUNTIME_SESSION_ID}`,
      })
      expect(
        createHarnessAgent({ id: 'research-harness', name: 'researcher', description: 'does research' })
      ).toMatchObject({
        id: 'research-harness',
        name: 'researcher',
        description: 'does research',
      })
    })
  })

  describe('stream', () => {
    it('sends one text request and streams raw events before the final result', async () => {
      const metadata = harnessEvent.metadata({ inputTokens: 10, outputTokens: 4, totalTokens: 14 }, 25)
      const events = [
        harnessEvent.messageStart(),
        harnessEvent.textDelta('Complete.'),
        harnessEvent.contentBlockStop(),
        harnessEvent.messageStop('end_turn'),
        metadata,
      ]
      const { client, send } = createMockClient(harnessStream(...events))
      const { client: controlClient, send: getHarness } = createMockControlClient()
      const invocationState = { requestId: 'request-1' }

      const { items, result } = await collectGenerator(
        createHarnessAgent({ client, controlClient }).stream('Run it.', { invocationState })
      )

      expect(getHarness).not.toHaveBeenCalled()
      expect(send).toHaveBeenCalledOnce()
      expect(commandInput(send)).toStrictEqual({
        harnessArn: HARNESS_ARN,
        runtimeSessionId: RUNTIME_SESSION_ID,
        messages: [{ role: 'user', content: [{ text: 'Run it.' }] }],
      })
      expect(send.mock.calls[0]![1]).toStrictEqual({ abortSignal: expect.any(AbortSignal) })
      expect(result).toMatchObject({
        stopReason: 'endTurn',
        lastMessage: { role: 'assistant', content: [new TextBlock('Complete.')] },
        invocationState,
      })
      expect(items).toStrictEqual([
        ...events.map((event) => new AgentCoreHarnessStreamUpdateEvent(event)),
        expect.objectContaining({ type: 'agentCoreHarnessResultEvent', result }),
      ])
    })

    it('returns only pre-abort content when an aborted stream throws', async () => {
      const controller = new AbortController()
      const stream = cancelledStream(controller)
      const { client, send } = createMockClient(stream)

      const { items, result } = await collectGenerator(
        createHarnessAgent({ client }).stream('Run it.', { cancelSignal: controller.signal })
      )

      expect(result.stopReason).toBe('cancelled')
      expect(result.lastMessage.content).toStrictEqual([new TextBlock('partial')])
      expect(items).toStrictEqual([
        new AgentCoreHarnessStreamUpdateEvent(harnessEvent.messageStart()),
        new AgentCoreHarnessStreamUpdateEvent(harnessEvent.textDelta('partial')),
        expect.objectContaining({ type: 'agentCoreHarnessResultEvent', result }),
      ])
      expect(send.mock.calls[0]![1]).toStrictEqual({ abortSignal: expect.any(AbortSignal) })
      expect((send.mock.calls[0]![1] as { abortSignal: AbortSignal }).abortSignal.aborted).toBe(true)
    })

    it('preserves partial content when the consumer aborts after receiving a raw delta', async () => {
      const controller = new AbortController()
      async function* streamUntilClosed(): AsyncGenerator<InvokeHarnessStreamOutput> {
        yield harnessEvent.messageStart()
        yield harnessEvent.textDelta('partial')
        await new Promise<void>((resolve) => {
          if (controller.signal.aborted) resolve()
          else controller.signal.addEventListener('abort', () => resolve(), { once: true })
        })
      }
      const { client } = createMockClient(streamUntilClosed())
      const generator = createHarnessAgent({ client }).stream('Run it.', { cancelSignal: controller.signal })

      await generator.next()
      await generator.next()
      controller.abort()
      const { result } = await collectGenerator(generator)

      expect(result.stopReason).toBe('cancelled')
      expect(result.lastMessage.content).toStrictEqual([new TextBlock('partial')])
    })

    it('does not decode a buffered chunk returned by the read that triggers cancellation', async () => {
      const controller = new AbortController()
      const events = [harnessEvent.messageStart(), harnessEvent.textDelta('before'), harnessEvent.textDelta(' after')]
      let index = 0
      const stream: AsyncIterableIterator<InvokeHarnessStreamOutput> = {
        [Symbol.asyncIterator]() {
          return this
        },
        next() {
          const value = events[index++]
          if (index === events.length) controller.abort()
          return Promise.resolve(value === undefined ? { done: true, value } : { done: false, value })
        },
        return() {
          return Promise.resolve({ done: true, value: undefined })
        },
      }
      const { client } = createMockClient(stream)

      const { items, result } = await collectGenerator(
        createHarnessAgent({ client }).stream('Run it.', { cancelSignal: controller.signal })
      )

      expect(result.stopReason).toBe('cancelled')
      expect(result.lastMessage.content).toStrictEqual([new TextBlock('before')])
      expect(items).toStrictEqual([
        new AgentCoreHarnessStreamUpdateEvent(events[0]!),
        new AgentCoreHarnessStreamUpdateEvent(events[1]!),
        expect.objectContaining({ type: 'agentCoreHarnessResultEvent', result }),
      ])
    })

    it('does not send a request when already cancelled', async () => {
      const { client, send } = createMockClient(harnessStream())

      const result = await createHarnessAgent({ client }).invoke('Run it.', { cancelSignal: AbortSignal.abort() })

      expect(result.stopReason).toBe('cancelled')
      expect(send).not.toHaveBeenCalled()
    })

    it('emits an unmapped raw event before waiting for a later Harness event', async () => {
      let markWaiting: () => void = () => {}
      let releaseStream: () => void = () => {}
      const waiting = new Promise<void>((resolve) => {
        markWaiting = resolve
      })
      const release = new Promise<void>((resolve) => {
        releaseStream = resolve
      })
      const toolResultStart = harnessEvent.toolResultStart('tool-1')
      async function* delayedErrorStream(): AsyncGenerator<InvokeHarnessStreamOutput> {
        yield harnessEvent.messageStart()
        yield toolResultStart
        markWaiting()
        await release
        yield { internalServerException: { message: 'later failure' } } as InvokeHarnessStreamOutput
      }
      const { client } = createMockClient(delayedErrorStream())
      const generator = createHarnessAgent({ client }).stream('Run it.')

      expect(await generator.next()).toMatchObject({
        done: false,
        value: new AgentCoreHarnessStreamUpdateEvent(harnessEvent.messageStart()),
      })
      expect(await generator.next()).toMatchObject({
        done: false,
        value: new AgentCoreHarnessStreamUpdateEvent(toolResultStart),
      })
      const pendingFailure = generator.next()
      await waiting
      releaseStream()

      await expect(pendingFailure).rejects.toThrow('later failure')
    })

    it('does not buffer unmapped Harness events ahead of the stream consumer', async () => {
      let produced = 0
      async function* countedStream(): AsyncGenerator<InvokeHarnessStreamOutput> {
        const events = [
          harnessEvent.messageStart(),
          harnessEvent.toolResultStart('tool-1'),
          harnessEvent.toolResultDelta('first'),
          harnessEvent.toolResultDelta('second'),
        ]
        for (const event of events) {
          produced += 1
          yield event
        }
      }
      const { client } = createMockClient(countedStream())
      const generator = createHarnessAgent({ client }).stream('Run it.')

      await generator.next()
      expect(await generator.next()).toMatchObject({
        done: false,
        value: new AgentCoreHarnessStreamUpdateEvent(harnessEvent.toolResultStart('tool-1')),
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(produced).toBe(2)

      await generator.return(undefined as never)
    })

    it('releases the invocation when the consumer stops streaming', async () => {
      const { client, send } = createMockClient()
      send.mockImplementationOnce((_command, options) => {
        async function* untilAborted(): AsyncGenerator<InvokeHarnessStreamOutput> {
          yield harnessEvent.messageStart()
          await new Promise<void>((resolve) => {
            const signal = options?.abortSignal as
              | { addEventListener(type: 'abort', listener: () => void, options: { once: boolean }): void }
              | undefined
            if (options?.abortSignal?.aborted) resolve()
            else signal?.addEventListener('abort', () => resolve(), { once: true })
          })
        }
        return Promise.resolve({ stream: untilAborted() }) as never
      })
      send.mockResolvedValueOnce({
        stream: harnessStream(
          harnessEvent.messageStart(),
          harnessEvent.textDelta('Available again.'),
          harnessEvent.messageStop('end_turn')
        ),
      } as never)
      const agent = createHarnessAgent({ client })
      const generator = agent.stream('Run it.')

      expect(await generator.next()).toMatchObject({
        done: false,
        value: new AgentCoreHarnessStreamUpdateEvent(harnessEvent.messageStart()),
      })
      await generator.return(undefined as never)

      await expect(agent.invoke('Run it again.')).resolves.toMatchObject({
        stopReason: 'endTurn',
        lastMessage: { content: [new TextBlock('Available again.')] },
      })
      expect(send).toHaveBeenCalledTimes(2)
    })

    it('rejects a concurrent invocation and releases the instance afterward', async () => {
      let release: (response: { stream: AsyncGenerator<InvokeHarnessStreamOutput> }) => void
      const pending = new Promise<{ stream: AsyncGenerator<InvokeHarnessStreamOutput> }>((resolve) => {
        release = resolve
      })
      const { client, send } = createMockClient()
      send.mockReturnValueOnce(pending as never)
      const agent = createHarnessAgent({ client })

      const first = agent.invoke('First')
      await expect(agent.invoke('Second')).rejects.toBeInstanceOf(ConcurrentInvocationError)
      release!({ stream: harnessStream(harnessEvent.messageStart(), harnessEvent.messageStop('end_turn')) })
      await first

      send.mockResolvedValueOnce({
        stream: harnessStream(harnessEvent.messageStart(), harnessEvent.messageStop('end_turn')),
      } as never)
      await expect(agent.invoke('Third')).resolves.toMatchObject({ stopReason: 'endTurn' })
    })
  })

  describe('input normalization', () => {
    it.each([
      {
        label: 'text blocks',
        args: [new TextBlock('Line one'), new TextBlock('Line two')],
        expected: 'Line one\nLine two',
      },
      {
        label: 'message history',
        args: [
          new Message({ role: 'user', content: [new TextBlock('Earlier')] }),
          new Message({ role: 'assistant', content: [new TextBlock('Reply')] }),
          new Message({ role: 'user', content: [new TextBlock('Latest'), new TextBlock('request')] }),
        ],
        expected: 'Latest\nrequest',
      },
    ])('normalizes $label before calling AgentCore', async ({ args, expected }) => {
      const { client, send } = createMockClient(
        harnessStream(harnessEvent.messageStart(), harnessEvent.messageStop('end_turn'))
      )

      await createHarnessAgent({ client }).invoke(args)

      expect(commandInput(send).messages).toStrictEqual([{ role: 'user', content: [{ text: expected }] }])
    })

    it.each([
      { label: 'empty string', args: '', options: undefined, message: 'input must contain non-empty text' },
      { label: 'empty array', args: [], options: undefined, message: 'input must contain non-empty text' },
      {
        label: 'non-text blocks',
        args: [new ReasoningBlock({ text: 'private reasoning' })],
        options: undefined,
        message: 'accepts only text content blocks; received reasoningBlock',
      },
      {
        label: 'history without a user message',
        args: [new Message({ role: 'assistant', content: [new TextBlock('No user message')] })],
        options: undefined,
        message: 'must include at least one user message',
      },
      {
        label: 'checkpoint resume',
        args: { checkpointResume: { checkpoint: { position: 'afterModel' } } },
        options: undefined,
        message: 'does not support checkpoint resume input',
      },
      {
        label: 'structuredOutputSchema',
        args: 'Hi',
        options: { structuredOutputSchema: { _output: undefined } },
        message: 'structuredOutputSchema is not supported',
      },
      { label: 'limits', args: 'Hi', options: { limits: { turns: 1 } }, message: 'limits is not supported' },
    ])('rejects $label before calling AgentCore', async ({ args, options, message }) => {
      const { client, send } = createMockClient(harnessStream())

      const rejection = await createHarnessAgent({ client })
        .invoke(args as never, options as never)
        .catch((error: unknown) => error)

      expect(rejection).toBeInstanceOf(TypeError)
      expect(rejection).toMatchObject({ message: expect.stringContaining(message) })
      expect(send).not.toHaveBeenCalled()
    })
  })

  describe('errors', () => {
    it.each([
      {
        label: 'internalServerException',
        errorChunk: { internalServerException: { message: 'internal failure' } } as InvokeHarnessStreamOutput,
        error: ModelError,
        message: 'internal failure',
      },
      {
        label: 'a context-window validationException',
        errorChunk: { validationException: { message: 'Prompt is too long' } } as InvokeHarnessStreamOutput,
        error: ContextWindowOverflowError,
        message: 'Prompt is too long',
      },
      {
        label: 'a generic validationException',
        errorChunk: { validationException: { message: 'bad request' } } as InvokeHarnessStreamOutput,
        error: ModelError,
        message: 'bad request',
      },
      {
        label: 'runtimeClientError',
        errorChunk: { runtimeClientError: { message: 'runtime failure' } } as InvokeHarnessStreamOutput,
        error: ModelError,
        message: 'runtime failure',
      },
    ])('translates $label from the stream', async ({ errorChunk, error, message }) => {
      const { client } = createMockClient(harnessStream(errorChunk))

      const rejection = await createHarnessAgent({ client })
        .invoke('Run it.')
        .catch((thrown: unknown) => thrown)

      expect(rejection).toBeInstanceOf(error)
      expect(rejection).toMatchObject({ message })
    })

    it('rejects malformed tool input before returning a tool-use result', async () => {
      const { client } = createMockClient(
        harnessStream(
          harnessEvent.messageStart(),
          harnessEvent.toolUseStart('tool-1', 'deployed_inline'),
          harnessEvent.toolUseDelta('{'),
          harnessEvent.contentBlockStop(),
          harnessEvent.messageStop('tool_use')
        )
      )

      await expect(createHarnessAgent({ client }).invoke('Run it.')).rejects.toThrow(
        'Unable to parse Harness tool input JSON.'
      )
    })

    it('surfaces max-token termination as MaxTokensError carrying the partial message', async () => {
      const { client } = createMockClient(
        harnessStream(
          harnessEvent.messageStart(),
          harnessEvent.textDelta('partial'),
          harnessEvent.messageStop('max_tokens')
        )
      )

      const rejection = await createHarnessAgent({ client })
        .invoke('Run it.')
        .catch((thrown: unknown) => thrown)

      expect(rejection).toBeInstanceOf(MaxTokensError)
      expect((rejection as MaxTokensError).partialMessage.content).toStrictEqual([new TextBlock('partial')])
    })

    it.each(['interrupted', 'malformed_model_output', 'malformed_tool_use'])(
      'rejects the non-resumable stop reason %s',
      async (stopReason) => {
        const { client } = createMockClient(
          harnessStream(
            harnessEvent.messageStart(),
            harnessEvent.textDelta('partial'),
            harnessEvent.messageStop(stopReason)
          )
        )

        await expect(createHarnessAgent({ client }).invoke('Run it.')).rejects.toThrow(
          'Harness ended the turn with an unrecoverable stop reason'
        )
      }
    )

    it.each([
      { name: 'ThrottlingException', error: ModelThrottledError },
      { name: 'OtherException', error: ModelError },
    ])('normalizes a rejected AgentCore request ($name)', async ({ name, error }) => {
      const original = Object.assign(new Error('request failed'), { name })
      const { client, send } = createMockClient()
      send.mockRejectedValueOnce(original)

      const rejection = await createHarnessAgent({ client })
        .invoke('Run it.')
        .catch((thrown: unknown) => thrown)

      expect(rejection).toBeInstanceOf(error)
      expect(rejection).toMatchObject({ message: 'request failed', cause: original })
    })

    it('maps a rejected request whose message signals context overflow', async () => {
      const { client, send } = createMockClient()
      send.mockRejectedValueOnce(new Error('Input is too long for requested model'))

      const rejection = await createHarnessAgent({ client })
        .invoke('Run it.')
        .catch((thrown: unknown) => thrown)

      expect(rejection).toBeInstanceOf(ContextWindowOverflowError)
      expect((rejection as ContextWindowOverflowError).cause).toBeInstanceOf(Error)
    })
  })
})
