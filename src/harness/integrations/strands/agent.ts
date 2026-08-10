import { BedrockAgentCoreClient, type InvokeHarnessStreamOutput } from '@aws-sdk/client-bedrock-agentcore'
import { BedrockAgentCoreControlClient } from '@aws-sdk/client-bedrock-agentcore-control'
import {
  AfterInvocationEvent,
  Agent,
  AgentResult,
  BeforeToolsEvent,
  ConcurrentInvocationError,
  InterventionHandler,
  MessageAddedEvent,
} from '@strands-agents/sdk'
import type { InvokeArgs, InvokeOptions, Message, ToolResultBlock } from '@strands-agents/sdk'
import { AgentCoreHarnessResultEvent, AgentCoreHarnessStreamUpdateEvent } from './events.js'
import type { AgentCoreHarnessStreamEvent } from './events.js'
import { HarnessModel } from './model.js'
import type { AgentCoreHarnessAgentConfig } from './types.js'

const DEFAULT_MAX_ATTEMPTS = 1

/**
 * Adapts one deployed [AgentCore Harness](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness.html)
 * to the Strands `InvokableAgent` interface, so a Harness composes into a Strands `Graph`.
 *
 * The deployed Harness owns its model, system prompt, tools, skills, memory, limits, and server-side
 * agent loop. Local Strands tools registered through `tools` are translated into per-invocation
 * Harness `inline_function` definitions and merged with the deployed tools. Strands owns local tool
 * execution, interventions, and human-in-the-loop interrupt/resume behavior.
 *
 * @example
 * ```typescript
 * import { randomUUID } from 'node:crypto'
 * import { FunctionTool } from '@strands-agents/sdk'
 * import { AgentCoreHarnessAgent } from 'bedrock-agentcore/experimental/harness/strands'
 *
 * const getWeather = new FunctionTool({
 *   name: 'get_weather',
 *   description: 'Get the current weather',
 *   inputSchema: {
 *     type: 'object',
 *     properties: { city: { type: 'string' } },
 *     required: ['city'],
 *   },
 *   callback: async (input) => {
 *     const { city } = input as { city: string }
 *     return fetchWeather(city)
 *   },
 * })
 *
 * const agent = new AgentCoreHarnessAgent({
 *   harnessArn: process.env.AGENTCORE_HARNESS_ARN!,
 *   runtimeSessionId: randomUUID(),
 *   tools: [getWeather],
 * })
 *
 * const result = await agent.invoke('What is the weather in Seattle?')
 * console.log(result.toString())
 * ```
 */
export class AgentCoreHarnessAgent {
  private readonly _agent: Agent
  private readonly _model: HarnessModel
  private _isInvoking = false
  private _cancelRequested = false
  private _cancelledToolResults: Message | undefined

  /** Identifier unique to this Harness session. */
  readonly id: string

  /** Name surfaced to Strands multi-agent primitives. */
  readonly name?: string

  /** Description surfaced to Strands multi-agent primitives. */
  readonly description?: string

  /**
   * Creates a Harness adapter.
   *
   * @param config - Harness identity, dynamic inline-function tools, and optional client configuration
   */
  constructor(config: AgentCoreHarnessAgentConfig) {
    this.id = config.id ?? `${config.harnessArn}:${config.runtimeSessionId}`
    if (config.name !== undefined) this.name = config.name
    if (config.description !== undefined) this.description = config.description

    // Harness identifiers are validated by AgentCore, not here: the service owns the ARN and
    // session-ID formats, and duplicating them client-side would reject valid future shapes.
    const client = config.client ?? new BedrockAgentCoreClient({ maxAttempts: DEFAULT_MAX_ATTEMPTS })
    const controlClient = config.controlClient ?? new BedrockAgentCoreControlClient({})
    assertSupportedInterventions(config.interventions)

    this._model = new HarnessModel({
      client,
      controlClient,
      harnessArn: config.harnessArn,
      runtimeSessionId: config.runtimeSessionId,
    })
    this._agent = new Agent({
      model: this._model,
      id: this.id,
      printer: false,
      retryStrategy: null,
      tools: config.tools ?? [],
      ...(this.name !== undefined && { name: this.name }),
      ...(this.description !== undefined && { description: this.description }),
      ...(config.interventions !== undefined && { interventions: config.interventions }),
    })
    this._agent.addHook(BeforeToolsEvent, () => this._cancelPendingTools())
    this._agent.addHook(MessageAddedEvent, (event) => this._captureCancelledToolResults(event))
    this._agent.addHook(AfterInvocationEvent, (event) => this._resumeCancelledInlineFunction(event))
  }

  /**
   * Invokes the deployed Harness, executes requested inline functions locally, and returns the final
   * result.
   *
   * @param args - Text, message input, or interrupt responses for a paused inline function
   * @param options - Cancellation and invocation state; other options are unsupported
   * @returns Final Harness result after all local inline-function callbacks complete
   * @throws {@link https://strandsagents.com | ConcurrentInvocationError} If this instance is already invoking
   * @throws TypeError If input or invocation options are unsupported
   * @throws {@link https://strandsagents.com | ModelThrottledError} If AgentCore reports throttling
   * @throws {@link https://strandsagents.com | ModelError} If AgentCore or the Harness stream fails
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
   * Streams every raw event from all Harness requests in the turn, followed by one final result event.
   *
   * A turn can contain multiple Harness requests when an inline function executes locally. Events from
   * every request are yielded in arrival order under the same `runtimeSessionId`.
   *
   * @param args - Text, message input, or interrupt responses for a paused inline function
   * @param options - Cancellation and invocation state; other options are unsupported
   * @returns Raw Harness events followed by the final result event and generator return value
   * @throws {@link https://strandsagents.com | ConcurrentInvocationError} If this instance is already invoking
   * @throws TypeError If input or invocation options are unsupported
   * @throws {@link https://strandsagents.com | ModelThrottledError} If AgentCore reports throttling
   * @throws {@link https://strandsagents.com | ModelError} If AgentCore or the Harness stream fails
   */
  async *stream(
    args: InvokeArgs,
    options?: InvokeOptions
  ): AsyncGenerator<AgentCoreHarnessStreamEvent, AgentResult, undefined> {
    this._acquireLock()
    this._cancelRequested = false
    this._cancelledToolResults = undefined
    let generator: ReturnType<Agent['stream']> | undefined
    let completed = false
    const rawEvents = new RawEventQueue()
    const transportAbortController = new AbortController()
    const cancelSignal = options?.cancelSignal
    const cancelInvocation = (): void => {
      this._cancelRequested = true
      if (this._model.isInvokingHarness) {
        transportAbortController.abort()
      } else {
        this._agent.cancel()
      }
    }
    try {
      assertSupportedInvocation(args, options)
      if (cancelSignal?.aborted) {
        this._cancelRequested = true
        transportAbortController.abort()
      } else {
        cancelSignal?.addEventListener('abort', cancelInvocation, { once: true })
      }
      this._model.resetInvocationState(transportAbortController.signal, (event) => rawEvents.push(event))

      generator = this._agent.stream(args, withoutCancelSignal(options))
      let emittedResult: AgentResult | undefined
      let agentOutcome = generator.next().then((next) => ({ type: 'agent' as const, next }))

      while (true) {
        const outcome = await Promise.race([agentOutcome, rawEvents.wait().then(() => ({ type: 'raw' as const }))])
        yield* rawEventUpdates(rawEvents.drain())

        if (outcome.type === 'raw') continue
        if (outcome.next.done) {
          const result = emittedResult ?? outcome.next.value
          completed = true
          yield new AgentCoreHarnessResultEvent({ result })
          return result
        }

        if (outcome.next.value.type === 'agentResultEvent') {
          emittedResult = outcome.next.value.result
        }
        agentOutcome = generator.next().then((next) => ({ type: 'agent' as const, next }))
      }
    } catch (error) {
      yield* rawEventUpdates(rawEvents.drain())
      throw error
    } finally {
      cancelSignal?.removeEventListener('abort', cancelInvocation)
      try {
        if (generator !== undefined && !completed) {
          transportAbortController.abort()
        }
        if (generator !== undefined && !completed) {
          await generator.return(undefined as never)
        }
      } finally {
        this._model.clearInvocationState()
        this._isInvoking = false
      }
    }
  }

  private _acquireLock(): void {
    if (this._isInvoking) {
      throw new ConcurrentInvocationError(
        'AgentCoreHarnessAgent is already processing an invocation. ' +
          'Wait for the current invoke() or stream() call to complete before invoking again.'
      )
    }
    this._isInvoking = true
  }

  private _captureCancelledToolResults(event: MessageAddedEvent): void {
    if (!this._cancelRequested || !this._model.hasPendingInlineFunctions || event.message.role !== 'user') return

    const toolResults = event.message.content.filter(
      (block): block is ToolResultBlock => block.type === 'toolResultBlock'
    )
    if (toolResults.length === event.message.content.length && toolResults.length > 0) {
      this._cancelledToolResults = event.message
    }
  }

  private _cancelPendingTools(): void {
    if (this._cancelRequested) this._agent.cancel()
  }

  private _resumeCancelledInlineFunction(event: AfterInvocationEvent): void {
    if (!this._cancelRequested || !this._model.hasPendingInlineFunctions) return

    event.resume = this._model.cancellationContinuation(this._cancelledToolResults)
    this._cancelledToolResults = undefined
  }
}

class RawEventQueue {
  private readonly _events: RawEventEntry[] = []
  private _ready: Promise<void> | undefined
  private _resolveReady: (() => void) | undefined

  async push(event: InvokeHarnessStreamOutput): Promise<void> {
    let markConsumed: () => void = () => {}
    const consumed = new Promise<void>((resolve) => {
      markConsumed = resolve
    })
    this._events.push({ event, markConsumed })
    this._resolveReady?.()
    await consumed
  }

  drain(): RawEventEntry[] {
    const events = this._events.splice(0)
    this._ready = undefined
    this._resolveReady = undefined
    return events
  }

  wait(): Promise<void> {
    if (this._events.length > 0) return Promise.resolve()
    this._ready ??= new Promise((resolve) => {
      this._resolveReady = resolve
    })
    return this._ready
  }
}

interface RawEventEntry {
  event: InvokeHarnessStreamOutput
  markConsumed: () => void
}

function* rawEventUpdates(events: RawEventEntry[]): Generator<AgentCoreHarnessStreamUpdateEvent, void, undefined> {
  for (const { event, markConsumed } of events) {
    try {
      yield new AgentCoreHarnessStreamUpdateEvent(event as AgentCoreHarnessStreamUpdateEvent['event'])
    } finally {
      markConsumed()
    }
  }
}

function assertSupportedInvocation(args: InvokeArgs, options: InvokeOptions | undefined): void {
  if (typeof args === 'string' && args.length === 0) {
    throw new TypeError('AgentCoreHarnessAgent input must contain non-empty text.')
  }
  if (Array.isArray(args) && args.length === 0) {
    throw new TypeError('AgentCoreHarnessAgent input must contain non-empty text.')
  }
  if (typeof args !== 'string' && !Array.isArray(args)) {
    throw new TypeError('AgentCoreHarnessAgent does not support checkpoint resume input.')
  }
  if (options?.structuredOutputSchema !== undefined) {
    throw new TypeError('InvokeOptions.structuredOutputSchema is not supported by AgentCoreHarnessAgent.')
  }
  if (options?.limits !== undefined) {
    throw new TypeError('InvokeOptions.limits is not supported by AgentCoreHarnessAgent.')
  }
}

function assertSupportedInterventions(interventions: InterventionHandler[] | undefined): void {
  for (const intervention of interventions ?? []) {
    const unsupportedMethods = (['beforeInvocation', 'beforeModelCall', 'afterModelCall'] as const).filter(
      (method) => intervention[method] !== InterventionHandler.prototype[method]
    )
    if (unsupportedMethods.length > 0) {
      throw new TypeError(
        `AgentCoreHarnessAgent intervention '${intervention.name}' overrides unsupported lifecycle methods: ` +
          `${unsupportedMethods.join(', ')}. Only beforeToolCall and afterToolCall are supported.`
      )
    }
  }
}

function withoutCancelSignal(options: InvokeOptions | undefined): InvokeOptions | undefined {
  if (options === undefined) return undefined

  const agentOptions = { ...options }
  delete agentOptions.cancelSignal
  return agentOptions
}
