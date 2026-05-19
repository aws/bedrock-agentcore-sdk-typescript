/**
 * Integration test: Assert user content (prompt, agent response) is NOT present in OTEL spans.
 *
 * COE Finding: User prompts and agent responses must never leak into exported
 * OTEL span attributes, events, or resource attributes.
 *
 * NOTE: Currently the TS SDK does not emit OTEL spans, so these tests pass
 * trivially with 0 spans. When OTEL is added, these tests will catch any
 * accidental inclusion of user content in spans.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import request from 'supertest'
import WebSocket from 'ws'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import * as api from '@opentelemetry/api'
import { BedrockAgentCoreApp } from '../src/runtime/app.js'
import type { InvocationHandler } from '../src/runtime/types.js'

const SENTINEL_PROMPT = 'SENSITIVE_USER_PROMPT_a1b2c3d4e5'
const SENTINEL_RESPONSE = 'SENSITIVE_AGENT_RESPONSE_f6g7h8i9j0'

function assertNoSentinelInSpans(spans: ReadonlyArray<any>, sentinels: string[]): void {
  for (const span of spans) {
    for (const sentinel of sentinels) {
      expect(span.name).not.toContain(sentinel)

      for (const [key, value] of Object.entries(span.attributes || {})) {
        const serialized = typeof value === 'string' ? value : JSON.stringify(value)
        expect(key).not.toContain(sentinel)
        expect(serialized).not.toContain(sentinel)
      }

      for (const event of span.events || []) {
        expect((event as any).name).not.toContain(sentinel)
        for (const [key, value] of Object.entries((event as any).attributes || {})) {
          const serialized = typeof value === 'string' ? value : JSON.stringify(value)
          expect(key).not.toContain(sentinel)
          expect(serialized).not.toContain(sentinel)
        }
      }

      const resource = span.resource?.attributes || {}
      for (const [key, value] of Object.entries(resource)) {
        const serialized = typeof value === 'string' ? value : JSON.stringify(value)
        expect(key).not.toContain(sentinel)
        expect(serialized).not.toContain(sentinel)
      }
    }
  }
}

describe('OTEL spans must not contain user content', () => {
  let exporter: InMemorySpanExporter
  let provider: NodeTracerProvider

  beforeEach(() => {
    exporter = new InMemorySpanExporter()
    provider = new NodeTracerProvider()
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter))
    api.trace.setGlobalTracerProvider(provider)
  })

  afterEach(async () => {
    await provider.shutdown()
    api.trace.disable()
    exporter.reset()
  })

  describe('sync invocation', () => {
    let app: BedrockAgentCoreApp
    let fastify: any

    beforeEach(async () => {
      const handler: InvocationHandler = async (req, _context) => {
        return { response: SENTINEL_RESPONSE, echo: (req as any).prompt }
      }

      app = new BedrockAgentCoreApp({ invocationHandler: { process: handler } })
      fastify = (app as any)._app
      await (app as any)._registerPlugins()
      ;(app as any)._setupRoutes()
      await fastify.ready()
    })

    afterEach(async () => {
      await fastify.close()
    })

    it('does not leak user content into spans', async () => {
      await request(fastify.server)
        .post('/invocations')
        .set('x-amzn-bedrock-agentcore-runtime-session-id', 'test-session')
        .send({ prompt: SENTINEL_PROMPT })
        .expect(200)

      await provider.forceFlush()
      const spans = exporter.getFinishedSpans()
      assertNoSentinelInSpans(spans, [SENTINEL_PROMPT, SENTINEL_RESPONSE])
    })
  })

  describe('streaming invocation', () => {
    let app: BedrockAgentCoreApp
    let fastify: any

    beforeEach(async () => {
      const handler: InvocationHandler = async function* (req, _context) {
        yield { data: `chunk: ${SENTINEL_RESPONSE}` }
        yield { data: `echo: ${(req as any).prompt}` }
      }

      app = new BedrockAgentCoreApp({ invocationHandler: { process: handler } })
      fastify = (app as any)._app
      await (app as any)._registerPlugins()
      ;(app as any)._setupRoutes()
      await fastify.ready()
    })

    afterEach(async () => {
      await fastify.close()
    })

    it('does not leak user content into spans', async () => {
      await request(fastify.server)
        .post('/invocations')
        .set('x-amzn-bedrock-agentcore-runtime-session-id', 'test-session')
        .set('accept', 'text/event-stream')
        .send({ prompt: SENTINEL_PROMPT })
        .expect(200)

      await provider.forceFlush()
      const spans = exporter.getFinishedSpans()
      assertNoSentinelInSpans(spans, [SENTINEL_PROMPT, SENTINEL_RESPONSE])
    })
  })

  describe('websocket invocation', () => {
    let app: BedrockAgentCoreApp
    let fastify: any

    beforeEach(async () => {
      const handler: InvocationHandler = async (req, _context) => {
        return { response: SENTINEL_RESPONSE, echo: (req as any).prompt }
      }

      app = new BedrockAgentCoreApp({
        invocationHandler: { process: handler },
        websocketHandler: async (connection: any, _context) => {
          connection.send(JSON.stringify({ type: 'connected' }))
          connection.on('message', (data: Buffer) => {
            const parsed = JSON.parse(data.toString())
            connection.send(JSON.stringify({ response: SENTINEL_RESPONSE, echo: parsed.prompt }))
          })
        },
      })
      fastify = (app as any)._app
      await (app as any)._registerPlugins()
      ;(app as any)._setupRoutes()
      await fastify.listen({ port: 0, host: '127.0.0.1' })
    })

    afterEach(async () => {
      await fastify.close()
    })

    it('does not leak user content into spans', async () => {
      const port = fastify.server.address().port

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(
          `ws://127.0.0.1:${port}/ws`,
          { headers: { 'x-amzn-bedrock-agentcore-runtime-session-id': 'test-session' } },
        )

        ws.on('open', () => {
          ws.send(JSON.stringify({ prompt: SENTINEL_PROMPT }))
        })

        let messageCount = 0
        ws.on('message', () => {
          messageCount++
          if (messageCount >= 2) {
            ws.close()
          }
        })

        ws.on('close', () => resolve())
        ws.on('error', reject)
      })

      await provider.forceFlush()
      const spans = exporter.getFinishedSpans()
      assertNoSentinelInSpans(spans, [SENTINEL_PROMPT, SENTINEL_RESPONSE])
    })
  })
})
