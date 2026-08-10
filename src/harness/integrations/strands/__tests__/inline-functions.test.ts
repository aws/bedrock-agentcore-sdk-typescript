import { describe, expect, it, vi } from 'vitest'
import type { InvokeHarnessStreamOutput } from '@aws-sdk/client-bedrock-agentcore'
import {
  BeforeToolCallEvent,
  ConcurrentInvocationError,
  FunctionTool,
  InterruptResponseContent,
  InterventionActions,
  InterventionHandler,
} from '@strands-agents/sdk'
import type { ToolContext } from '@strands-agents/sdk'
import {
  HARNESS_ARN,
  HARNESS_ID,
  RUNTIME_SESSION_ID,
  commandInput,
  createHarnessAgent,
  createMockControlClient,
  createMockClient,
  getHarnessInput,
  harnessEvent,
  harnessStream,
  inlineFunctionTurn,
  textTurn,
} from './harness-test-helpers.js'

class ConfirmToolCall extends InterventionHandler {
  readonly name = 'confirm-tool-call'

  override beforeToolCall(event: BeforeToolCallEvent): ReturnType<(typeof InterventionActions)['confirm']> {
    return InterventionActions.confirm(`Approve ${event.toolUse.name}?`)
  }
}

class UnsupportedLifecycleIntervention extends InterventionHandler {
  readonly name = 'unsupported-lifecycle'

  override beforeInvocation(): ReturnType<(typeof InterventionActions)['guide']> {
    return InterventionActions.guide('Replace the invocation')
  }

  override beforeModelCall(): ReturnType<(typeof InterventionActions)['guide']> {
    return InterventionActions.guide('Replace the request')
  }

  override afterModelCall(): ReturnType<(typeof InterventionActions)['guide']> {
    return InterventionActions.guide('Try again')
  }
}

class RewriteToolUseId extends InterventionHandler {
  readonly name = 'rewrite-tool-use-id'

  override beforeToolCall(event: BeforeToolCallEvent): ReturnType<(typeof InterventionActions)['transform']> {
    return InterventionActions.transform(() => {
      event.toolUse.toolUseId = 'rewritten-id'
    })
  }
}

describe('AgentCoreHarnessAgent', () => {
  describe('inline functions', () => {
    it('rejects model lifecycle interventions', () => {
      expect(() => createHarnessAgent({ interventions: [new UnsupportedLifecycleIntervention()] })).toThrow(
        "intervention 'unsupported-lifecycle' overrides unsupported lifecycle methods: " +
          'beforeInvocation, beforeModelCall, afterModelCall'
      )
    })

    it('executes text and JSON callbacks and continues the same Harness session', async () => {
      const weather = vi.fn((_input: unknown): string => '72F')
      const profile = vi.fn((_input: unknown): { units: string } => ({ units: 'fahrenheit' }))
      const weatherTool = new FunctionTool({
        name: 'get_weather',
        description: 'Get weather',
        inputSchema: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
          additionalProperties: false,
        },
        callback: weather,
      })
      const profileTool = new FunctionTool({
        name: 'get_profile',
        description: 'Get preferences',
        callback: profile,
      })
      const deployedTools = [
        {
          type: 'remote_mcp' as const,
          name: 'deployed_search',
          config: { remoteMcp: { url: 'https://example.com/mcp' } },
        },
        {
          type: 'inline_function' as const,
          name: 'get_weather',
          config: {
            inlineFunction: {
              description: 'Deployed weather callback',
              inputSchema: { type: 'object' },
            },
          },
        },
      ]
      const expectedTools = [
        deployedTools[0],
        {
          type: 'inline_function',
          name: 'get_weather',
          config: {
            inlineFunction: {
              description: 'Get weather',
              inputSchema: {
                type: 'object',
                properties: { city: { type: 'string' } },
                required: ['city'],
                additionalProperties: false,
              },
            },
          },
        },
        {
          type: 'inline_function',
          name: 'get_profile',
          config: {
            inlineFunction: {
              description: 'Get preferences',
              inputSchema: {
                type: 'object',
                properties: {},
                additionalProperties: false,
              },
            },
          },
        },
      ]
      const { client, send } = createMockClient(
        inlineFunctionTurn(
          { toolUseId: 'weather-1', name: 'get_weather', input: { city: 'Seattle' } },
          { toolUseId: 'profile-1', name: 'get_profile', input: {} }
        ),
        textTurn('It is 72F in Seattle.')
      )
      const { client: controlClient, send: getHarness } = createMockControlClient(deployedTools, ['deployed_search'])
      const agent = createHarnessAgent({
        client,
        controlClient,
        tools: [weatherTool, profileTool],
      })

      const result = await agent.invoke('What is the weather?')

      expect(result.toString()).toBe('It is 72F in Seattle.')
      expect(weather.mock.calls.map(([input]) => input)).toStrictEqual([{ city: 'Seattle' }])
      expect(profile.mock.calls.map(([input]) => input)).toStrictEqual([{}])
      expect(getHarness).toHaveBeenCalledOnce()
      expect(getHarnessInput(getHarness)).toStrictEqual({ harnessId: HARNESS_ID })
      expect(send).toHaveBeenCalledTimes(2)
      expect(commandInput(send, 0)).toStrictEqual({
        harnessArn: HARNESS_ARN,
        runtimeSessionId: RUNTIME_SESSION_ID,
        messages: [{ role: 'user', content: [{ text: 'What is the weather?' }] }],
        tools: expectedTools,
        allowedTools: ['deployed_search', 'get_weather', 'get_profile'],
      })
      expect(commandInput(send, 1)).toStrictEqual({
        harnessArn: HARNESS_ARN,
        runtimeSessionId: RUNTIME_SESSION_ID,
        messages: [
          {
            role: 'assistant',
            content: [
              {
                toolUse: {
                  name: 'get_weather',
                  toolUseId: 'weather-1',
                  input: { city: 'Seattle' },
                  type: 'tool_use',
                },
              },
              {
                toolUse: {
                  name: 'get_profile',
                  toolUseId: 'profile-1',
                  input: {},
                  type: 'tool_use',
                },
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                toolResult: {
                  toolUseId: 'weather-1',
                  status: 'success',
                  type: 'tool_use',
                  content: [{ text: '72F' }],
                },
              },
              {
                toolResult: {
                  toolUseId: 'profile-1',
                  status: 'success',
                  type: 'tool_use',
                  content: [{ text: '{"units":"fahrenheit"}' }],
                },
              },
            ],
          },
        ],
        tools: expectedTools,
        allowedTools: ['deployed_search', 'get_weather', 'get_profile'],
      })
    })

    it.each([
      {
        label: 'a callback failure',
        tools: [
          new FunctionTool({
            name: 'failing_tool',
            description: 'Fails',
            callback: (): never => {
              throw new Error('callback failed')
            },
          }),
        ],
        name: 'failing_tool',
        expectedMessage: 'Error: callback failed',
      },
      {
        label: 'an unknown callback',
        tools: [],
        name: 'missing_tool',
        expectedMessage: "Tool 'missing_tool' not found in registry",
      },
      {
        label: 'unsupported callback content',
        tools: [
          new FunctionTool({
            name: 'capture_image',
            description: 'Capture an image',
            callback: () => ({
              image: {
                format: 'png',
                source: { url: 'https://example.com/image.png' },
              },
            }),
          }),
        ],
        name: 'capture_image',
        expectedMessage:
          'AgentCoreHarnessAgent supports only text and JSON inline-function results; received imageBlock.',
      },
    ])('returns $label to the Harness as an error result', async ({ tools, name, expectedMessage }) => {
      const { client, send } = createMockClient(
        inlineFunctionTurn({ toolUseId: 'tool-1', name, input: {} }),
        textTurn('Handled the tool error.')
      )
      const agent = createHarnessAgent({ client, tools })

      const result = await agent.invoke('Run the tool.')

      expect(result.toString()).toBe('Handled the tool error.')
      expect(commandInput(send, 1).messages![1]!.content).toStrictEqual([
        {
          toolResult: {
            toolUseId: 'tool-1',
            status: 'error',
            type: 'tool_use',
            content: [{ text: expectedMessage }],
          },
        },
      ])
    })

    it('preserves the Harness tool-use ID when an intervention rewrites the local ID', async () => {
      const { client, send } = createMockClient(
        inlineFunctionTurn({ toolUseId: 'service-id', name: 'local_tool', input: {} }),
        textTurn('Completed.')
      )
      const agent = createHarnessAgent({
        client,
        tools: [new FunctionTool({ name: 'local_tool', description: 'Run locally', callback: () => 'done' })],
        interventions: [new RewriteToolUseId()],
      })

      await agent.invoke('Run it.')

      expect(commandInput(send, 1).messages).toStrictEqual([
        {
          role: 'assistant',
          content: [
            {
              toolUse: {
                name: 'local_tool',
                toolUseId: 'service-id',
                input: {},
                type: 'tool_use',
              },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              toolResult: {
                toolUseId: 'service-id',
                status: 'success',
                type: 'tool_use',
                content: [{ text: 'done' }],
              },
            },
          ],
        },
      ])
    })

    it('pauses for an intervention and resumes after approval without repeating the Harness call', async () => {
      const callback = vi.fn((_input: unknown): string => 'deleted')
      const { client, send } = createMockClient(
        inlineFunctionTurn({ toolUseId: 'delete-1', name: 'delete_record', input: { id: '123' } }),
        textTurn('Record deleted.')
      )
      const agent = createHarnessAgent({
        client,
        tools: [new FunctionTool({ name: 'delete_record', description: 'Delete a record', callback })],
        interventions: [new ConfirmToolCall()],
      })

      const interrupted = await agent.invoke('Delete record 123.')

      expect(interrupted).toMatchObject({
        stopReason: 'interrupt',
        interrupts: [{ name: 'confirm-tool-call', reason: 'Approve delete_record?' }],
      })
      expect(callback).not.toHaveBeenCalled()
      expect(send).toHaveBeenCalledOnce()

      const result = await agent.invoke([
        new InterruptResponseContent({
          interruptId: interrupted.interrupts![0]!.id,
          response: 'yes',
        }),
      ])

      expect(result.toString()).toBe('Record deleted.')
      expect(callback).toHaveBeenCalledOnce()
      expect(send).toHaveBeenCalledTimes(2)
    })

    it('returns a denied intervention to the Harness without executing the callback', async () => {
      const callback = vi.fn((_input: unknown): string => 'must not execute')
      const { client, send } = createMockClient(
        inlineFunctionTurn({ toolUseId: 'delete-1', name: 'delete_record', input: { id: '123' } }),
        textTurn('Deletion was denied.')
      )
      const agent = createHarnessAgent({
        client,
        tools: [new FunctionTool({ name: 'delete_record', description: 'Delete a record', callback })],
        interventions: [new ConfirmToolCall()],
      })
      const interrupted = await agent.invoke('Delete record 123.')

      const result = await agent.invoke([
        new InterruptResponseContent({
          interruptId: interrupted.interrupts![0]!.id,
          response: 'no',
        }),
      ])

      expect(result.toString()).toBe('Deletion was denied.')
      expect(callback).not.toHaveBeenCalled()
      expect(commandInput(send, 1).messages![1]!.content![0]).toMatchObject({
        toolResult: { toolUseId: 'delete-1', status: 'error' },
      })
    })

    it('resumes an interrupt raised inside the inline-function callback', async () => {
      const callback = vi.fn((_input: unknown, context: ToolContext): string => {
        const response = context.interrupt<string>({
          name: 'provide_code',
          reason: 'Provide the authorization code',
        })
        return `code=${response}`
      })
      const { client, send } = createMockClient(
        inlineFunctionTurn({ toolUseId: 'authorize-1', name: 'authorize', input: {} }),
        textTurn('Authorized.')
      )
      const agent = createHarnessAgent({
        client,
        tools: [new FunctionTool({ name: 'authorize', description: 'Authorize an action', callback })],
      })

      const interrupted = await agent.invoke('Authorize the action.')
      const result = await agent.invoke([
        new InterruptResponseContent({
          interruptId: interrupted.interrupts![0]!.id,
          response: 'ABC123',
        }),
      ])

      expect(interrupted).toMatchObject({
        stopReason: 'interrupt',
        interrupts: [{ name: 'provide_code', reason: 'Provide the authorization code' }],
      })
      expect(result.toString()).toBe('Authorized.')
      expect(callback).toHaveBeenCalledTimes(2)
      expect(commandInput(send, 1).messages![1]!.content![0]).toMatchObject({
        toolResult: { status: 'success', content: [{ text: 'code=ABC123' }] },
      })
    })

    it.each(['server_tool_use', 'mcp_tool_use'])(
      'does not execute %s events as local callbacks',
      async (toolUseType) => {
        const callback = vi.fn((_input: unknown): string => 'must not execute')
        const { client, send } = createMockClient(
          harnessStream(
            harnessEvent.messageStart(),
            harnessEvent.toolUseStart('browser-1', 'browser', toolUseType),
            harnessEvent.toolUseDelta('{"url":"https://example.com"}'),
            harnessEvent.contentBlockStop(),
            harnessEvent.messageStop('tool_use'),
            harnessEvent.messageStart('user'),
            harnessEvent.toolResultStart('browser-1'),
            harnessEvent.toolResultDelta('Example Domain'),
            harnessEvent.contentBlockStop(),
            harnessEvent.messageStop('tool_result'),
            harnessEvent.messageStart(),
            harnessEvent.textDelta('The page is Example Domain.'),
            harnessEvent.contentBlockStop(),
            harnessEvent.messageStop('end_turn')
          )
        )
        const agent = createHarnessAgent({
          client,
          tools: [new FunctionTool({ name: 'browser', description: 'Browse', callback })],
        })

        const result = await agent.invoke('Open example.com.')

        expect(result.toString()).toBe('The page is Example Domain.')
        expect(callback).not.toHaveBeenCalled()
        expect(send).toHaveBeenCalledOnce()
      }
    )

    it('does not execute a terminal tool use with an omitted type', async () => {
      const callback = vi.fn((_input: unknown): string => 'must not execute')
      const { client, send } = createMockClient(
        harnessStream(
          harnessEvent.messageStart(),
          harnessEvent.toolUseStart('tool-1', 'local_tool', null),
          harnessEvent.toolUseDelta('{"url":"https://example.com"}'),
          harnessEvent.contentBlockStop(),
          harnessEvent.messageStop('tool_use')
        )
      )
      const agent = createHarnessAgent({
        client,
        tools: [new FunctionTool({ name: 'local_tool', description: 'Run locally', callback })],
      })

      await expect(agent.invoke('Run it.')).rejects.toThrow('Harness returned an incomplete non-inline tool call.')

      expect(callback).not.toHaveBeenCalled()
      expect(send).toHaveBeenCalledOnce()
    })

    it('keeps the active callback invocation isolated from a rejected concurrent call', async () => {
      let markCallbackStarted: () => void = () => {}
      let finishCallback: (result: string) => void = () => {}
      const callbackStarted = new Promise<void>((resolve) => {
        markCallbackStarted = resolve
      })
      const callbackResult = new Promise<string>((resolve) => {
        finishCallback = resolve
      })
      const callback = vi.fn(async (): Promise<string> => {
        markCallbackStarted()
        return callbackResult
      })
      const { client, send } = createMockClient(
        inlineFunctionTurn({ toolUseId: 'tool-1', name: 'local_tool', input: {} }),
        textTurn('Completed the first invocation.')
      )
      const agent = createHarnessAgent({
        client,
        tools: [new FunctionTool({ name: 'local_tool', description: 'Run locally', callback })],
      })

      const first = agent.invoke('First invocation.')
      await callbackStarted
      const concurrentRejection = await agent
        .invoke('Second invocation.', { cancelSignal: AbortSignal.abort() })
        .catch((error: unknown) => error)
      finishCallback('done')
      const result = await first

      expect(concurrentRejection).toBeInstanceOf(ConcurrentInvocationError)
      expect(result.toString()).toBe('Completed the first invocation.')
      expect(send).toHaveBeenCalledTimes(2)
    })

    it('cancels the continuation request after an inline function executes', async () => {
      const controller = new AbortController()
      async function* cancelledContinuation(): AsyncGenerator<InvokeHarnessStreamOutput> {
        yield harnessEvent.messageStart()
        yield harnessEvent.textDelta('partial continuation')
        controller.abort()
        throw new Error('aborted')
      }
      const { client, send } = createMockClient(
        inlineFunctionTurn({ toolUseId: 'tool-1', name: 'local_tool', input: {} }),
        cancelledContinuation()
      )
      const agent = createHarnessAgent({
        client,
        tools: [new FunctionTool({ name: 'local_tool', description: 'Local tool', callback: () => 'done' })],
      })

      const result = await agent.invoke('Run it.', { cancelSignal: controller.signal })

      expect(result.stopReason).toBe('cancelled')
      expect(result.toString()).toBe('partial continuation')
      expect(send).toHaveBeenCalledTimes(2)
      expect(send.mock.calls[1]![1]).toStrictEqual({ abortSignal: expect.any(AbortSignal) })
      expect((send.mock.calls[1]![1] as { abortSignal: AbortSignal }).abortSignal.aborted).toBe(true)
    })

    it('resolves a completed inline call when cancellation wins after message stop', async () => {
      const controller = new AbortController()
      async function* completedThenCancelled(): AsyncGenerator<InvokeHarnessStreamOutput> {
        yield* inlineFunctionTurn({ toolUseId: 'tool-1', name: 'local_tool', input: {} })
        controller.abort()
      }
      const callback = vi.fn((): string => 'must not execute')
      const { client, send } = createMockClient(completedThenCancelled(), textTurn('Remote turn resolved.'))
      const agent = createHarnessAgent({
        client,
        tools: [new FunctionTool({ name: 'local_tool', description: 'Local tool', callback })],
      })

      const result = await agent.invoke('Run it.', { cancelSignal: controller.signal })

      expect(result.stopReason).toBe('cancelled')
      expect(callback).not.toHaveBeenCalled()
      expect(send).toHaveBeenCalledTimes(2)
      expect(commandInput(send, 1).messages![1]!.content).toStrictEqual([
        {
          toolResult: {
            toolUseId: 'tool-1',
            status: 'error',
            type: 'tool_use',
            content: [{ text: 'Tool execution cancelled' }],
          },
        },
      ])
    })

    it('cancels a pre-aborted HITL resume without executing its callback', async () => {
      const callback = vi.fn((): string => 'must not execute')
      const { client, send } = createMockClient(
        inlineFunctionTurn({ toolUseId: 'delete-1', name: 'delete_record', input: { id: '123' } }),
        textTurn('Remote turn resolved.')
      )
      const agent = createHarnessAgent({
        client,
        tools: [new FunctionTool({ name: 'delete_record', description: 'Delete a record', callback })],
        interventions: [new ConfirmToolCall()],
      })
      const interrupted = await agent.invoke('Delete record 123.')

      const result = await agent.invoke(
        [
          new InterruptResponseContent({
            interruptId: interrupted.interrupts![0]!.id,
            response: 'yes',
          }),
        ],
        { cancelSignal: AbortSignal.abort() }
      )

      expect(result.stopReason).toBe('cancelled')
      expect(callback).not.toHaveBeenCalled()
      expect(send).toHaveBeenCalledTimes(2)
      expect(commandInput(send, 1).messages![1]!.content).toStrictEqual([
        {
          toolResult: {
            toolUseId: 'delete-1',
            status: 'error',
            type: 'tool_use',
            content: [{ text: 'Tool execution cancelled' }],
          },
        },
      ])
    })

    it('submits the inline-function result before returning cancellation during a callback', async () => {
      const controller = new AbortController()
      let markCallbackStarted: () => void = () => {}
      let finishCallback: () => void = () => {}
      const callbackStarted = new Promise<void>((resolve) => {
        markCallbackStarted = resolve
      })
      const callbackFinished = new Promise<void>((resolve) => {
        finishCallback = resolve
      })
      const callback = vi.fn(async (_input: unknown, context: ToolContext): Promise<string> => {
        markCallbackStarted()
        await callbackFinished
        expect(context.agent.cancelSignal.aborted).toBe(true)
        return 'done'
      })
      const { client, send } = createMockClient(
        inlineFunctionTurn({ toolUseId: 'tool-1', name: 'local_tool', input: {} }),
        textTurn('Remote turn resolved.')
      )
      const agent = createHarnessAgent({
        client,
        tools: [new FunctionTool({ name: 'local_tool', description: 'Run locally', callback })],
      })

      const invocation = agent.invoke('Run it.', { cancelSignal: controller.signal })
      await callbackStarted
      controller.abort()
      finishCallback()
      const result = await invocation

      expect(result.stopReason).toBe('cancelled')
      expect(send).toHaveBeenCalledTimes(2)
      expect(commandInput(send, 1).messages![1]!.content).toStrictEqual([
        {
          toolResult: {
            toolUseId: 'tool-1',
            status: 'success',
            type: 'tool_use',
            content: [{ text: 'done' }],
          },
        },
      ])
    })

    it('cancels additional inline functions requested while resolving cancellation', async () => {
      const controller = new AbortController()
      let markCallbackStarted: () => void = () => {}
      let finishCallback: () => void = () => {}
      const callbackStarted = new Promise<void>((resolve) => {
        markCallbackStarted = resolve
      })
      const callbackFinished = new Promise<void>((resolve) => {
        finishCallback = resolve
      })
      const firstCallback = vi.fn(async (): Promise<string> => {
        markCallbackStarted()
        await callbackFinished
        return 'first result'
      })
      const secondCallback = vi.fn((): string => 'must not execute')
      const { client, send } = createMockClient(
        inlineFunctionTurn({ toolUseId: 'first-1', name: 'first_tool', input: {} }),
        inlineFunctionTurn({ toolUseId: 'second-1', name: 'second_tool', input: {} }),
        textTurn('Remote turn resolved.')
      )
      const agent = createHarnessAgent({
        client,
        tools: [
          new FunctionTool({ name: 'first_tool', description: 'First local tool', callback: firstCallback }),
          new FunctionTool({ name: 'second_tool', description: 'Second local tool', callback: secondCallback }),
        ],
      })

      const invocation = agent.invoke('Run it.', { cancelSignal: controller.signal })
      await callbackStarted
      controller.abort()
      finishCallback()
      const result = await invocation

      expect(result.stopReason).toBe('cancelled')
      expect(firstCallback).toHaveBeenCalledOnce()
      expect(secondCallback).not.toHaveBeenCalled()
      expect(send).toHaveBeenCalledTimes(3)
      expect(commandInput(send, 2).messages![1]!.content).toStrictEqual([
        {
          toolResult: {
            toolUseId: 'second-1',
            status: 'error',
            type: 'tool_use',
            content: [{ text: 'Tool execution cancelled' }],
          },
        },
      ])
    })

    it('clears cancellation state when a cleanup continuation request fails', async () => {
      const controller = new AbortController()
      let markCallbackStarted: () => void = () => {}
      let finishCallback: () => void = () => {}
      const callbackStarted = new Promise<void>((resolve) => {
        markCallbackStarted = resolve
      })
      const callbackFinished = new Promise<void>((resolve) => {
        finishCallback = resolve
      })
      const firstCallback = vi.fn(async (): Promise<string> => {
        markCallbackStarted()
        await callbackFinished
        return 'first result'
      })
      const secondCallback = vi.fn((): string => 'second result')
      const { client, send } = createMockClient(
        inlineFunctionTurn({ toolUseId: 'first-1', name: 'first_tool', input: {} })
      )
      send.mockRejectedValueOnce(new Error('cleanup failed') as never)
      send.mockResolvedValueOnce({
        stream: inlineFunctionTurn({ toolUseId: 'second-1', name: 'second_tool', input: {} }),
      } as never)
      send.mockResolvedValueOnce({ stream: textTurn('Second invocation completed.') } as never)
      const agent = createHarnessAgent({
        client,
        tools: [
          new FunctionTool({ name: 'first_tool', description: 'First local tool', callback: firstCallback }),
          new FunctionTool({ name: 'second_tool', description: 'Second local tool', callback: secondCallback }),
        ],
      })

      const firstInvocation = agent.invoke('Run the first tool.', { cancelSignal: controller.signal })
      await callbackStarted
      controller.abort()
      finishCallback()
      await expect(firstInvocation).rejects.toThrow('cleanup failed')

      const secondResult = await agent.invoke('Run the second tool.')

      expect(secondCallback).toHaveBeenCalledOnce()
      expect(secondResult.stopReason).toBe('endTurn')
      expect(secondResult.toString()).toBe('Second invocation completed.')
      expect(send).toHaveBeenCalledTimes(4)
    })
  })
})
