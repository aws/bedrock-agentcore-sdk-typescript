import { describe, it, expect, expectTypeOf, vi, afterEach } from 'vitest'
import { ReadableStream } from 'node:stream/web'
import { TextEncoder } from 'node:util'
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore'
import { z } from 'zod'
import { BedrockAgentCoreApp } from '../app.js'
import { createInvokeClient } from '../invoke-client.js'
import type { InvokeEvent, InvokeInput } from '../invoke-client.js'

const ARN = 'arn:aws:bedrock-agentcore:eu-west-1:123456789012:runtime/agent-abc'
const SESSION = 'session-0123456789-0123456789-0123456789'

const requestSchema = z.object({ prompt: z.string(), temperature: z.number().default(0.5) })

const streamingApp = new BedrockAgentCoreApp({
  invocationHandler: {
    requestSchema,
    process: async function* (request) {
      yield { event: 'delta' as const, data: { text: request.prompt } }
      yield { done: true, temperature: request.temperature }
      yield 'plain\ntext'
    },
  },
})

const jsonApp = new BedrockAgentCoreApp({
  invocationHandler: {
    requestSchema,
    process: async (request) => ({ answer: request.prompt.length }),
  },
})

const untypedApp = new BedrockAgentCoreApp({ invocationHandler: { process: async () => 'ok' } })

const failingApp = new BedrockAgentCoreApp({
  invocationHandler: {
    process: async function* () {
      yield { step: 1 }
      throw new Error('model unavailable')
    },
  },
})

function webStream(chunks: string[], onCancel: () => void = () => undefined): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    pull(controller) {
      const chunk = chunks.shift()
      if (chunk === undefined) controller.close()
      else controller.enqueue(encoder.encode(chunk))
    },
    cancel: onCancel,
  })
}

function mockResponse(contentType: string, chunks: string[], onCancel?: () => void) {
  const send = vi.spyOn(BedrockAgentCoreClient.prototype, 'send').mockImplementation(async () => ({
    contentType,
    response: {
      transformToWebStream: () => webStream(chunks, onCancel),
      transformToString: async () => chunks.join(''),
    },
  }))
  return send
}

async function serve(app: BedrockAgentCoreApp<z.ZodSchema, unknown>, payload: unknown) {
  await app['_registerPlugins']()
  app['_setupContentTypeParsers']()
  app['_setupMainRoutes'](8080)
  const response = await app['_app'].inject({
    method: 'POST',
    url: '/invocations',
    headers: {
      accept: 'text/event-stream, application/json',
      'content-type': 'application/json',
      'x-amzn-bedrock-agentcore-runtime-session-id': SESSION,
    },
    payload: JSON.stringify(payload),
  })
  return { contentType: String(response.headers['content-type']), body: response.body }
}

function chunked(text: string, size: number): string[] {
  return Array.from({ length: Math.ceil(text.length / size) }, (_, i) => text.slice(i * size, (i + 1) * size))
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const event of events) out.push(event)
  return out
}

describe('createInvokeClient', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('types', () => {
    it('infers the request input from requestSchema', () => {
      expectTypeOf<InvokeInput<typeof streamingApp>>().toEqualTypeOf<{ prompt: string; temperature?: number }>()
      expectTypeOf<InvokeInput<typeof untypedApp>>().toBeUnknown()
    })

    it('infers streamed events from what process yields', () => {
      type Event = InvokeEvent<typeof streamingApp>
      expectTypeOf<Extract<Event, { event: 'delta' }>>().toEqualTypeOf<{ event: 'delta'; data: { text: string } }>()
      expectTypeOf<Extract<Event, { done: boolean }>>().toHaveProperty('temperature').toEqualTypeOf<number>()
      expectTypeOf<Extract<Event, string>>().toEqualTypeOf<string>()
    })

    it('infers the single response of a non streaming app', () => {
      expectTypeOf<InvokeEvent<typeof jsonApp>>().toEqualTypeOf<{ answer: number }>()
      expectTypeOf<InvokeEvent<typeof untypedApp>>().toEqualTypeOf<string>()
    })

    it('rejects input that does not match the schema', () => {
      const agent = createInvokeClient<typeof streamingApp>({ agentRuntimeArn: ARN })
      expectTypeOf(agent.invoke).parameter(0).toEqualTypeOf<{ prompt: string; temperature?: number }>()
      // @ts-expect-error prompt must be a string
      void agent.invoke({ prompt: 1 })
    })
  })

  describe('invoke', () => {
    it('round trips every event the app streams', async () => {
      const { contentType, body } = await serve(streamingApp, { prompt: 'hi' })
      mockResponse(contentType, chunked(body, 7))

      const agent = createInvokeClient<typeof streamingApp>({ agentRuntimeArn: ARN })
      const events = await collect(agent.invoke({ prompt: 'hi' }, { sessionId: SESSION }))

      expect(events).toEqual([
        { event: 'delta', data: { text: 'hi' } },
        { done: true, temperature: 0.5 },
        'plain\ntext',
      ])
    })

    it('yields a plain text response as a string', async () => {
      const { contentType, body } = await serve(untypedApp, null)
      mockResponse(contentType, [body])

      const agent = createInvokeClient<typeof untypedApp>({ agentRuntimeArn: ARN })

      expect(await collect(agent.invoke(undefined))).toEqual(['ok'])
    })

    it('yields the single response of a non streaming app', async () => {
      const { contentType, body } = await serve(jsonApp, { prompt: 'hello' })
      mockResponse(contentType, [body])

      const agent = createInvokeClient<typeof jsonApp>({ agentRuntimeArn: ARN })

      expect(await collect(agent.invoke({ prompt: 'hello' }))).toEqual([{ answer: 5 }])
    })

    it('sends the payload through InvokeAgentRuntimeCommand in the ARN region', async () => {
      const send = mockResponse('application/json', ['{}'])
      const abortSignal = AbortSignal.timeout(60_000)

      const agent = createInvokeClient<typeof jsonApp>({ agentRuntimeArn: ARN })
      await collect(agent.invoke({ prompt: 'hi' }, { sessionId: SESSION, qualifier: 'prod', abortSignal }))

      const [command, options] = send.mock.calls[0]! as unknown as [
        InvokeAgentRuntimeCommand,
        { abortSignal: AbortSignal },
      ]
      expect(command).toBeInstanceOf(InvokeAgentRuntimeCommand)
      expect(command.input).toMatchObject({
        agentRuntimeArn: ARN,
        runtimeSessionId: SESSION,
        qualifier: 'prod',
        accept: 'text/event-stream, application/json',
        payload: '{"prompt":"hi"}',
      })
      expect(options.abortSignal).toBe(abortSignal)
      const client = send.mock.contexts[0] as BedrockAgentCoreClient
      expect(await client.config.region()).toBe('eu-west-1')
    })

    it('throws the error event the app sends after streaming starts', async () => {
      const { contentType, body } = await serve(failingApp, {})
      mockResponse(contentType, [body])

      const agent = createInvokeClient<typeof failingApp>({ agentRuntimeArn: ARN })
      const events: unknown[] = []

      await expect(async () => {
        for await (const event of agent.invoke(undefined)) events.push(event)
      }).rejects.toThrow('model unavailable')
      expect(events).toEqual([{ step: 1 }])
    })

    it('throws a plain text error event with its text', async () => {
      mockResponse('text/event-stream', ['data: 1\n\n', 'event: error\ndata: boom\n\n'])

      const agent = createInvokeClient<typeof untypedApp>({ agentRuntimeArn: ARN })

      await expect(collect(agent.invoke(undefined))).rejects.toThrow(/^boom$/)
    })

    it('parses CRLF frames split across chunks and skips comments', async () => {
      mockResponse('text/event-stream', [
        ': heartbeat\r',
        '\n\r',
        '\ndata: {"a":',
        '1}\r',
        '\n\r',
        '\nevent: end\r\n\r\n',
        'data\n\n',
      ])

      const agent = createInvokeClient<typeof untypedApp>({ agentRuntimeArn: ARN })

      expect(await collect(agent.invoke(undefined))).toEqual([{ a: 1 }, { event: 'end', data: undefined }, ''])
    })

    it('cancels the response stream when the caller stops early', async () => {
      const onCancel = vi.fn()
      mockResponse('text/event-stream', ['data: 1\n\n', 'data: 2\n\n'], onCancel)

      const agent = createInvokeClient<typeof untypedApp>({ agentRuntimeArn: ARN })
      for await (const event of agent.invoke(undefined)) {
        expect(event).toBe(1)
        break
      }

      expect(onCancel).toHaveBeenCalled()
    })

    it('rejects an invalid runtime ARN', () => {
      expect(() => createInvokeClient({ agentRuntimeArn: 'not-an-arn' })).toThrow('Invalid runtime ARN format')
    })
  })
})
