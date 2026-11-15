import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore'
import type { BedrockAgentCoreClientConfig } from '@aws-sdk/client-bedrock-agentcore'
import type { AwsCredentialIdentityProvider } from '@aws-sdk/types'
import type { z } from 'zod'
import type { BedrockAgentCoreApp } from './app.js'
import { RuntimeArnSchema } from './types.js'

/**
 * Configuration for {@link createInvokeClient}.
 */
export interface InvokeClientConfig {
  /**
   * ARN of the deployed agent runtime. Its region is used unless `clientConfig.region` is set.
   */
  agentRuntimeArn: string

  /**
   * Optional AWS credentials provider. Defaults to the AWS SDK credential chain.
   */
  credentialsProvider?: AwsCredentialIdentityProvider

  /**
   * Optional AWS SDK client configuration for advanced use cases.
   */
  clientConfig?: Partial<BedrockAgentCoreClientConfig>
}

/**
 * Per call options for {@link InvokeClient.invoke}.
 */
export interface InvokeOptions {
  /**
   * Runtime session ID, sent as `runtimeSessionId`.
   */
  sessionId?: string

  /**
   * Endpoint name or version of the agent runtime.
   */
  qualifier?: string

  /**
   * Signal that cancels the request and the response stream.
   */
  abortSignal?: AbortSignal
}

/**
 * Typed client for invoking a deployed {@link BedrockAgentCoreApp}.
 */
export interface InvokeClient<TApp> {
  /**
   * Invokes the agent runtime.
   *
   * @param input - Request payload, typed from the app's `requestSchema` input
   * @param options - Per call options
   * @returns Each event the app streams, or its single response when it does not stream
   * @throws Error when the app reports a failure through an SSE `error` event
   */
  invoke(input: InvokeInput<TApp>, options?: InvokeOptions): AsyncIterable<InvokeEvent<TApp>>
}

/**
 * Request payload type of an app, inferred from its `requestSchema` input. `unknown` without a schema.
 */
export type InvokeInput<TApp> =
  TApp extends BedrockAgentCoreApp<infer TSchema, infer _TResult> ? z.input<TSchema> : never

/**
 * Event type a client receives from an app, inferred from what its `process` handler returns or yields.
 */
export type InvokeEvent<TApp> =
  TApp extends BedrockAgentCoreApp<infer _TSchema, infer TResult> ? ResponseEvent<Awaited<TResult>> : never

type ResponseEvent<TResult> = TResult extends AsyncIterable<infer TChunk> ? StreamEvent<TChunk> : TResult

type StreamEvent<TChunk> = TChunk extends string | Uint8Array
  ? string
  : TChunk extends { data: infer TData }
    ? TChunk extends { event: infer TName extends string }
      ? { event: TName; data: TData }
      : TData
    : TChunk

/**
 * Creates a client whose input and events are typed from a {@link BedrockAgentCoreApp} type.
 *
 * @param config - Client configuration
 * @returns A typed invoke client
 */
export function createInvokeClient<TApp>(config: InvokeClientConfig): InvokeClient<TApp> {
  const agentRuntimeArn = RuntimeArnSchema.parse(config.agentRuntimeArn)
  const client = new BedrockAgentCoreClient({
    region: agentRuntimeArn.split(':')[3]!,
    ...(config.credentialsProvider && { credentials: config.credentialsProvider }),
    ...config.clientConfig,
  })

  return {
    async *invoke(input, options = {}): AsyncGenerator<InvokeEvent<TApp>> {
      const command = new InvokeAgentRuntimeCommand({
        agentRuntimeArn,
        qualifier: options.qualifier,
        runtimeSessionId: options.sessionId,
        contentType: 'application/json',
        accept: 'text/event-stream, application/json',
        payload: JSON.stringify(input ?? null),
      })
      const { contentType, response } = await client.send(command, {
        ...(options.abortSignal && { abortSignal: options.abortSignal }),
      })

      if (response && contentType?.startsWith('text/event-stream')) {
        yield* readEvents(response.transformToWebStream()) as AsyncGenerator<InvokeEvent<TApp>>
        return
      }

      const body = (await response?.transformToString()) ?? ''
      yield (body ? parseData(body) : undefined) as InvokeEvent<TApp>
    },
  }
}

async function* readEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let event: string | undefined
  let data: string[] = []

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })

      // a trailing \r may be the first half of a \r\n split across chunks
      const complete = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer
      const lines = complete.split(/\r\n|\r|\n/)
      buffer = buffer.slice(complete.length - lines[lines.length - 1]!.length)

      for (const line of lines.slice(0, -1)) {
        if (line === '') {
          if (event !== undefined || data.length > 0) yield toEvent(event, data)
          event = undefined
          data = []
          continue
        }
        if (line.startsWith(':')) continue
        const colon = line.indexOf(':')
        const field = colon === -1 ? line : line.slice(0, colon)
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
        if (field === 'data') data.push(value)
        if (field === 'event') event = value
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

function toEvent(event: string | undefined, data: string[]): unknown {
  const payload = data.length > 0 ? parseData(data.join('\n')) : undefined
  if (event === 'error') {
    const detail = (payload as { error?: unknown } | undefined)?.error ?? payload
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail), { cause: payload })
  }
  return event ? { event, data: payload } : payload
}

function parseData(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
