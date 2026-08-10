import {
  BedrockAgentCoreClient,
  InvokeHarnessCommand,
  type HarnessContentBlock,
  type HarnessInlineFunctionConfig,
  type HarnessMessage,
  type HarnessReasoningContentBlock,
  type HarnessTool,
  type InvokeHarnessStreamOutput,
} from '@aws-sdk/client-bedrock-agentcore'
import {
  GetHarnessCommand,
  type BedrockAgentCoreControlClient,
  type HarnessTool as ControlHarnessTool,
} from '@aws-sdk/client-bedrock-agentcore-control'
import {
  ContextWindowOverflowError,
  MaxTokensError,
  Message,
  Model,
  ModelError,
  ModelMetadataEvent,
  ModelThrottledError,
  TextBlock,
  ToolResultBlock,
} from '@strands-agents/sdk'
import type {
  BaseModelConfig,
  ContentBlock,
  JsonBlock,
  ModelStreamEvent,
  ReasoningBlock,
  StopReason,
  StreamOptions,
  ToolSpec,
  ToolUseBlock,
} from '@strands-agents/sdk'
import { HarnessStreamDecoder } from './stream-decoder.js'

const CONTEXT_WINDOW_OVERFLOW_MESSAGES = [
  'input is too long for requested model',
  'input length and `max_tokens` exceed context limit',
  'too many total text bytes',
  'prompt is too long',
]
const THROTTLING_ERROR_NAMES = new Set(['ThrottlingException', 'ThrottledException'])

interface HarnessModelConfig extends BaseModelConfig {
  modelId: string
}

interface HarnessModelOptions {
  client: BedrockAgentCoreClient
  controlClient: BedrockAgentCoreControlClient
  harnessArn: string
  runtimeSessionId: string
}

interface HarnessInvocationResult {
  message: Message
  stopReason: StopReason
  metadata?: ModelMetadataEvent
}

interface DeployedToolConfiguration {
  tools: HarnessTool[]
  allowedTools?: string[]
}

interface HarnessToolOverrides {
  tools?: HarnessTool[]
  allowedTools?: string[]
}

/**
 * Internal Strands model adapter that translates between `InvokeHarness` and Strands model events.
 *
 * The class is exported only for use by {@link AgentCoreHarnessAgent}; it is not part of the package
 * entry point.
 */
export class HarnessModel extends Model<HarnessModelConfig> {
  private readonly _client: BedrockAgentCoreClient
  private readonly _controlClient: BedrockAgentCoreControlClient
  private readonly _harnessArn: string
  private readonly _runtimeSessionId: string
  private _deployedToolConfiguration: Promise<DeployedToolConfiguration> | undefined
  private _cancelSignal: AbortSignal | undefined
  private _onRawEvent: ((event: InvokeHarnessStreamOutput) => Promise<void>) | undefined
  private _isInvokingHarness = false
  private _pendingInlineFunctionMessage: Message | undefined
  private _cancellationRoot: Message | undefined

  /**
   * Creates the internal Harness model adapter.
   *
   * @param options - Harness transport and cancellation dependencies
   */
  constructor(options: HarnessModelOptions) {
    super()
    this._client = options.client
    this._controlClient = options.controlClient
    this._harnessArn = options.harnessArn
    this._runtimeSessionId = options.runtimeSessionId
  }

  /**
   * Indicates that conversation history is owned by the deployed Harness.
   *
   * @returns Always `true`
   */
  override get stateful(): boolean {
    return true
  }

  /**
   * Returns the fixed model configuration used for tracing.
   *
   * @returns Harness identity represented as a model configuration
   */
  getConfig(): HarnessModelConfig {
    return { modelId: this._harnessArn }
  }

  /**
   * Rejects runtime model configuration changes because the deployed Harness owns its model.
   *
   * @param _modelConfig - Unsupported model configuration update
   */
  updateConfig(_modelConfig: HarnessModelConfig): void {
    throw new TypeError('AgentCoreHarnessAgent does not support model configuration updates.')
  }

  /** Whether an `InvokeHarness` request is currently active. */
  get isInvokingHarness(): boolean {
    return this._isInvokingHarness
  }

  /** Whether the Harness is waiting for inline-function results. */
  get hasPendingInlineFunctions(): boolean {
    return this._pendingInlineFunctionMessage !== undefined
  }

  /**
   * Builds the continuation needed to resolve a cancelled local inline-function execution.
   *
   * @param toolResults - Results already produced by Strands before cancellation completed
   * @returns Original Harness tool calls paired with success or cancellation results
   */
  cancellationContinuation(toolResults?: Message): Message[] {
    const assistantMessage = this._pendingInlineFunctionMessage
    if (assistantMessage === undefined) {
      throw new ModelError('AgentCoreHarnessAgent has no pending inline function to cancel.')
    }
    const resultMessage =
      this._cancellationRoot !== undefined || toolResults === undefined
        ? cancelledToolResults(assistantMessage)
        : toolResults
    // Cancellation may have aborted the request that produced this tool call. Cleanup is a new
    // transport phase and must be allowed to resolve the matching remote result.
    this._cancelSignal = undefined
    this._cancellationRoot ??= assistantMessage
    return [assistantMessage, resultMessage]
  }

  /**
   * Streams canonical Strands model events for one Harness request.
   *
   * @param messages - Current Strands conversation
   * @param options - Strands model options containing dynamic inline-function definitions
   * @returns Canonical model event stream
   */
  async *stream(messages: Message[], options?: StreamOptions): AsyncGenerator<ModelStreamEvent, void, undefined> {
    yield* this._invoke(messages, options?.toolSpecs)
  }

  /**
   * Streams canonical events while returning the message decoded from the complete Harness stream.
   *
   * Harness can stream tool-result messages that have no canonical Strands model-stream event. The
   * returned message therefore comes from {@link HarnessStreamDecoder}, while supported deltas still
   * flow through the standard Strands stream event types.
   *
   * @param messages - Current Strands conversation
   * @param options - Strands model options containing dynamic inline-function definitions
   * @returns Canonical events and the completed Harness message
   */
  override async *streamAggregated(
    messages: Message[],
    options?: StreamOptions
  ): AsyncGenerator<ModelStreamEvent | ContentBlock, HarnessInvocationResult, undefined> {
    return yield* this._invoke(messages, options?.toolSpecs)
  }

  /**
   * Clears invocation-scoped transport state before the outer agent starts.
   *
   * @param cancelSignal - External cancellation signal for the Harness request
   * @param onRawEvent - Callback invoked as each non-error Harness event arrives
   */
  resetInvocationState(
    cancelSignal: AbortSignal | undefined,
    onRawEvent: (event: InvokeHarnessStreamOutput) => Promise<void>
  ): void {
    this._deployedToolConfiguration = undefined
    this._cancelSignal = cancelSignal
    this._onRawEvent = onRawEvent
  }

  /**
   * Releases invocation-scoped callbacks and cancellation state.
   */
  clearInvocationState(): void {
    this._deployedToolConfiguration = undefined
    this._cancelSignal = undefined
    this._onRawEvent = undefined
    this._cancellationRoot = undefined
  }

  private async *_invoke(
    messages: Message[],
    toolSpecs: ToolSpec[] | undefined
  ): AsyncGenerator<ModelStreamEvent, HarnessInvocationResult, undefined> {
    const decoder = new HarnessStreamDecoder()
    const cancelSignal = this._cancelSignal
    let metadata: ModelMetadataEvent | undefined
    const continuation = this._pendingInlineFunctionMessage !== undefined
    const requestMessages = harnessMessagesFromStrands(messages, this._pendingInlineFunctionMessage)

    if (cancelSignal?.aborted) {
      return this._cancelled(decoder)
    }

    this._isInvokingHarness = true
    try {
      if (continuation) {
        this._pendingInlineFunctionMessage = undefined
      }
      const toolOverrides = await this._toolOverridesForInvocation(toolSpecs, cancelSignal)
      const response = await this._client.send(
        new InvokeHarnessCommand({
          harnessArn: this._harnessArn,
          runtimeSessionId: this._runtimeSessionId,
          messages: requestMessages,
          ...toolOverrides,
        }),
        cancelSignal ? { abortSignal: cancelSignal } : {}
      )

      if (response.stream) {
        for await (const chunk of response.stream) {
          if (cancelSignal?.aborted) {
            return this._cancelled(decoder)
          }
          const streamError = harnessStreamError(chunk)
          if (streamError) throw streamError

          const event = chunk
          const modelEvents = decoder.accept(event)
          await this._onRawEvent?.(event)
          for (const modelEvent of modelEvents) {
            if (modelEvent.type === 'modelMetadataEvent') {
              metadata = modelEvent
            }
            yield modelEvent
          }
        }
      }
    } catch (error) {
      if (cancelSignal?.aborted) {
        return this._cancelled(decoder)
      }
      throw normalizeHarnessError(error)
    } finally {
      this._isInvokingHarness = false
    }

    if (cancelSignal?.aborted) {
      return this._cancelled(decoder)
    }

    const decoded = decoder.complete()
    throwIfUnrecoverable(decoded)
    if (decoded.terminalNonInlineToolUse) {
      throw new ModelError('Harness returned an incomplete non-inline tool call.')
    }
    if (this._cancellationRoot !== undefined && continuation) {
      if (decoded.stopReason === 'toolUse') {
        this._pendingInlineFunctionMessage = decoded.message
        return { message: decoded.message, stopReason: 'cancelled', ...(metadata !== undefined && { metadata }) }
      }
      const cancelledMessage = this._cancellationRoot
      this._cancellationRoot = undefined
      this._pendingInlineFunctionMessage = undefined
      return { message: cancelledMessage, stopReason: 'cancelled', ...(metadata !== undefined && { metadata }) }
    }
    this._pendingInlineFunctionMessage = decoded.stopReason === 'toolUse' ? decoded.message : undefined
    return {
      message: decoded.message,
      stopReason: decoded.stopReason,
      ...(metadata !== undefined && { metadata }),
    }
  }

  private _cancelled(decoder: HarnessStreamDecoder): HarnessInvocationResult {
    const decoded = decoder.tryComplete()
    if (
      decoded?.stopReason === 'toolUse' &&
      !decoded.terminalNonInlineToolUse &&
      decoded.toolInputParseError === undefined
    ) {
      this._pendingInlineFunctionMessage = decoded.message
    }
    return { message: decoded?.message ?? decoder.partialMessage(), stopReason: 'cancelled' }
  }

  private async _toolOverridesForInvocation(
    toolSpecs: ToolSpec[] | undefined,
    cancelSignal: AbortSignal | undefined
  ): Promise<HarnessToolOverrides> {
    const inlineFunctions = inlineFunctionsFromStrands(toolSpecs)
    if (inlineFunctions === undefined) return {}

    this._deployedToolConfiguration ??= this._loadDeployedToolConfiguration(cancelSignal)
    const deployed = await this._deployedToolConfiguration
    return {
      tools: mergeHarnessTools(deployed.tools, inlineFunctions),
      ...(deployed.allowedTools !== undefined && {
        allowedTools: mergeAllowedTools(deployed.allowedTools, inlineFunctions),
      }),
    }
  }

  private async _loadDeployedToolConfiguration(
    cancelSignal: AbortSignal | undefined
  ): Promise<DeployedToolConfiguration> {
    const response = await this._controlClient.send(
      new GetHarnessCommand({ harnessId: harnessIdFromArn(this._harnessArn) }),
      cancelSignal ? { abortSignal: cancelSignal } : {}
    )
    return {
      tools: (response.harness?.tools ?? []).map(controlToolToInvokeTool),
      ...(response.harness?.allowedTools !== undefined && { allowedTools: response.harness.allowedTools }),
    }
  }
}

function inlineFunctionsFromStrands(toolSpecs: ToolSpec[] | undefined): HarnessTool[] | undefined {
  if (toolSpecs === undefined || toolSpecs.length === 0) return undefined

  return toolSpecs.map((toolSpec): HarnessTool => {
    const inputSchema = toolSpec.inputSchema ?? {
      type: 'object',
      properties: {},
      additionalProperties: false,
    }
    const inlineFunction: HarnessInlineFunctionConfig = {
      description: toolSpec.description,
      // Both types represent JSON documents, but JSONSchema7 lacks Smithy's string index signature.
      inputSchema: inputSchema as unknown as HarnessInlineFunctionConfig['inputSchema'],
    }
    return {
      type: 'inline_function',
      name: toolSpec.name,
      config: { inlineFunction },
    }
  })
}

function mergeHarnessTools(deployedTools: HarnessTool[], inlineFunctions: HarnessTool[]): HarnessTool[] {
  const inlineFunctionNames = new Set(inlineFunctions.map((tool) => tool.name))
  return [...deployedTools.filter((tool) => !inlineFunctionNames.has(tool.name)), ...inlineFunctions]
}

function mergeAllowedTools(deployedAllowedTools: string[], inlineFunctions: HarnessTool[]): string[] {
  if (deployedAllowedTools.includes('*')) return deployedAllowedTools
  return [
    ...new Set([
      ...deployedAllowedTools,
      ...inlineFunctions.flatMap((tool) => (tool.name === undefined ? [] : [tool.name])),
    ]),
  ]
}

function controlToolToInvokeTool(tool: ControlHarnessTool): HarnessTool {
  return {
    type: tool.type,
    ...(tool.name !== undefined && { name: tool.name }),
    ...(tool.config !== undefined && {
      // Control- and data-plane clients model the same service document as separate declarations.
      config: tool.config as HarnessTool['config'],
    }),
  }
}

function harnessIdFromArn(harnessArn: string): string {
  const match = /^arn:[^:]+:bedrock-agentcore:[^:]+:[^:]+:harness\/(.+)$/.exec(harnessArn)
  if (match?.[1] === undefined) {
    throw new TypeError(`Invalid AgentCore Harness ARN: ${harnessArn}`)
  }
  return match[1]
}

function harnessMessagesFromStrands(
  messages: Message[],
  pendingInlineFunctionMessage: Message | undefined
): HarnessMessage[] {
  const latestUserIndex = findLatestUserMessage(messages)
  if (latestUserIndex < 0) {
    throw new TypeError('AgentCoreHarnessAgent message input must include at least one user message.')
  }

  const latestUserMessage = messages[latestUserIndex]!
  const toolResults = latestUserMessage.content.filter(
    (block): block is ToolResultBlock => block.type === 'toolResultBlock'
  )
  if (toolResults.length === 0) {
    if (pendingInlineFunctionMessage !== undefined) {
      throw new ModelError(
        'AgentCoreHarnessAgent cannot start a new user turn while the Harness is waiting for inline-function results.'
      )
    }
    return [{ role: 'user', content: textContentFromStrands(latestUserMessage.content) }]
  }
  if (toolResults.length !== latestUserMessage.content.length) {
    throw new TypeError('AgentCoreHarnessAgent cannot mix inline-function results with other user content.')
  }

  if (pendingInlineFunctionMessage === undefined) {
    throw new ModelError('AgentCoreHarnessAgent received inline-function results without a pending Harness tool call.')
  }
  const pendingToolUses = pendingInlineFunctionMessage.content.filter(
    (block): block is ToolUseBlock => block.type === 'toolUseBlock'
  )
  if (pendingToolUses.length !== toolResults.length) {
    throw new ModelError(
      `AgentCoreHarnessAgent received ${toolResults.length} inline-function results for ` +
        `${pendingToolUses.length} pending Harness tool calls.`
    )
  }
  return [
    { role: 'assistant', content: assistantContentFromStrands(pendingInlineFunctionMessage.content) },
    {
      role: 'user',
      content: toolResults.map((result, index) => toolResultFromStrands(result, pendingToolUses[index]!.toolUseId)),
    },
  ]
}

function findLatestUserMessage(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.role === 'user') return index
  }
  return -1
}

function textContentFromStrands(blocks: ContentBlock[]): HarnessContentBlock[] {
  const unsupportedTypes = blocks.filter((block) => block.type !== 'textBlock').map((block) => block.type)
  if (unsupportedTypes.length > 0) {
    throw new TypeError(
      `AgentCoreHarnessAgent accepts only text content blocks; received ${unsupportedTypes.join(', ')}.`
    )
  }
  const text = blocks.map((block) => (block as TextBlock).text).join('\n')
  if (text.length === 0) {
    throw new TypeError('AgentCoreHarnessAgent input must contain non-empty text.')
  }
  return [{ text }]
}

function assistantContentFromStrands(blocks: ContentBlock[]): HarnessContentBlock[] {
  return blocks.map((block) => {
    switch (block.type) {
      case 'textBlock':
        return { text: block.text }
      case 'toolUseBlock':
        return toolUseFromStrands(block)
      case 'reasoningBlock':
        return reasoningFromStrands(block)
      default:
        throw new TypeError(
          `AgentCoreHarnessAgent cannot continue an inline function after assistant content type ${block.type}.`
        )
    }
  })
}

function toolUseFromStrands(block: ToolUseBlock): HarnessContentBlock {
  return {
    toolUse: {
      name: block.name,
      toolUseId: block.toolUseId,
      input: block.input,
      type: 'tool_use',
    },
  }
}

function reasoningFromStrands(block: ReasoningBlock): HarnessContentBlock {
  let reasoningContent: HarnessReasoningContentBlock
  if (block.redactedContent !== undefined) {
    reasoningContent = { redactedContent: block.redactedContent }
  } else {
    reasoningContent = {
      reasoningText: {
        text: block.text ?? '',
        ...(block.signature !== undefined && { signature: block.signature }),
      },
    }
  }
  return { reasoningContent }
}

function toolResultFromStrands(block: ToolResultBlock, toolUseId: string): HarnessContentBlock {
  try {
    return {
      toolResult: {
        toolUseId,
        status: block.status,
        type: 'tool_use',
        content: block.content.map((item) => {
          switch (item.type) {
            case 'textBlock':
              return { text: item.text }
            case 'jsonBlock':
              return { text: jsonToolResultText(item as JsonBlock) }
            default:
              throw new TypeError(
                `AgentCoreHarnessAgent supports only text and JSON inline-function results; received ${item.type}.`
              )
          }
        }),
      },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      toolResult: {
        toolUseId,
        status: 'error',
        type: 'tool_use',
        content: [{ text: message }],
      },
    }
  }
}

function cancelledToolResults(assistantMessage: Message): Message {
  const results = assistantMessage.content
    .filter((block): block is ToolUseBlock => block.type === 'toolUseBlock')
    .map(
      (block) =>
        new ToolResultBlock({
          toolUseId: block.toolUseId,
          status: 'error',
          content: [new TextBlock('Tool execution cancelled')],
        })
    )
  return new Message({ role: 'user', content: results })
}

function jsonToolResultText(block: JsonBlock): string {
  const text = JSON.stringify(block.json)
  if (text === undefined) {
    throw new TypeError('AgentCoreHarnessAgent could not serialize an inline-function JSON result.')
  }
  return text
}

function throwIfUnrecoverable(decoded: ReturnType<HarnessStreamDecoder['complete']>): void {
  switch (decoded.stopReason) {
    case 'maxTokens':
      throw new MaxTokensError(
        'Model reached maximum token limit. This is an unrecoverable state that requires intervention.',
        decoded.message
      )
    case 'interrupted':
    case 'malformedModelOutput':
    case 'malformedToolUse':
      throw new ModelError(`Harness ended the turn with an unrecoverable stop reason: ${decoded.stopReason}`)
  }
  if (decoded.toolInputParseError) {
    throw new ModelError('Unable to parse Harness tool input JSON.', { cause: decoded.toolInputParseError })
  }
}

function harnessStreamError(chunk: InvokeHarnessStreamOutput): ModelError | undefined {
  if ('internalServerException' in chunk && chunk.internalServerException) {
    return new ModelError(chunk.internalServerException.message ?? 'AgentCore Harness internal server error', {
      cause: chunk.internalServerException,
    })
  }
  if ('validationException' in chunk && chunk.validationException) {
    const message = chunk.validationException.message ?? 'AgentCore Harness validation error'
    if (isContextWindowOverflow(message)) {
      return contextWindowOverflowError(message, chunk.validationException)
    }
    return new ModelError(message, { cause: chunk.validationException })
  }
  if ('runtimeClientError' in chunk && chunk.runtimeClientError) {
    return new ModelError(chunk.runtimeClientError.message ?? 'AgentCore Harness runtime client error', {
      cause: chunk.runtimeClientError,
    })
  }
  return undefined
}

function normalizeHarnessError(error: unknown): Error {
  if (error instanceof ModelError) return error

  const normalized = error instanceof Error ? error : new Error(String(error))
  if (THROTTLING_ERROR_NAMES.has(normalized.name)) {
    return new ModelThrottledError(normalized.message, { cause: error })
  }
  if (isContextWindowOverflow(normalized.message)) {
    return contextWindowOverflowError(normalized.message, error)
  }
  return new ModelError(normalized.message, { cause: error })
}

function contextWindowOverflowError(message: string, cause: unknown): ContextWindowOverflowError {
  const error = new ContextWindowOverflowError(message)
  return Object.assign(error, { cause })
}

function isContextWindowOverflow(message: string): boolean {
  const normalized = message.toLowerCase()
  return CONTEXT_WINDOW_OVERFLOW_MESSAGES.some((phrase) => normalized.includes(phrase))
}
