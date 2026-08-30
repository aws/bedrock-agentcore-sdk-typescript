import type { Server } from 'http'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { TaskState } from '@a2a-js/sdk'
import { AgentEvent, InMemoryTaskStore, ServerCallContext as A2AServerCallContext } from '@a2a-js/sdk/server'
import type { ExecutionEventBus, RequestContext, ServerCallContext, TaskStore } from '@a2a-js/sdk/server'
import type { Task } from '@a2a-js/sdk'

import { buildA2AApp, serveA2A } from '../app.js'
import { buildAgentCard } from '../agent-card.js'
import { getContext } from '../../context.js'
import type { RequestContext as BedrockRequestContext } from '../../types.js'

/**
 * Trivial executor that records the ambient runtime context it observes,
 * then completes immediately.
 */
class RecordingExecutor {
  observed: BedrockRequestContext | undefined
  observedState: Map<string, unknown> | undefined

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    this.observed = getContext()
    this.observedState = requestContext.context.state
    const { taskId, contextId } = requestContext
    eventBus.publish(
      AgentEvent.task({
        id: taskId,
        contextId,
        status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: undefined },
        artifacts: [],
        history: [],
        metadata: undefined,
      })
    )
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: undefined },
        metadata: undefined,
      })
    )
  }

  async cancelTask(): Promise<void> {}
}

function listenPort(server: Server): number {
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return address.port
}

function listenHost(server: Server): string {
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no host')
  return address.address
}

function sendMessageBody(messageId: string) {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'message/send',
    params: {
      message: { kind: 'message', messageId, role: 'user', parts: [{ kind: 'text', text: 'hello' }] },
    },
  })
}

describe('serveA2A', () => {
  const servers: Server[] = []

  async function serve(options: Partial<Parameters<typeof serveA2A>[0]> = {}): Promise<Server> {
    const server = await serveA2A({ executor: new RecordingExecutor(), port: 0, ...options })
    servers.push(server)
    return server
  }

  async function fetchAgentCard(server: Server): Promise<{ supportedInterfaces: { url: string }[] }> {
    const response = await fetch(`http://127.0.0.1:${listenPort(server)}/.well-known/agent-card.json`, {
      headers: { 'A2A-Version': '1.0' },
    })
    return (await response.json()) as { supportedInterfaces: { url: string }[] }
  }

  afterEach(() => {
    while (servers.length > 0) servers.pop()?.close()
    vi.unstubAllEnvs()
  })

  describe('agent card handling', () => {
    it('auto-builds a fallback card advertising the actual listen port', async () => {
      const server = await serve({ port: 3005 })

      const card = (await fetchAgentCard(server)) as {
        name: string
        version: string
        skills: { id: string; tags: string[] }[]
        supportedInterfaces: { url: string }[]
      }
      expect(card.name).toBeTruthy()
      expect(card.supportedInterfaces.map((i) => i.url)).toContain('http://localhost:3005/')
      // Same defaults as the Python SDK's auto-built card
      expect(card.version).toBe('0.1.0')
      expect(card.skills).toEqual([expect.objectContaining({ id: 'main', tags: ['main'] })])
    })

    it('rewrites a provided card URL when AGENTCORE_RUNTIME_URL is set, normalizing the trailing slash', async () => {
      // The platform injects the env value without a trailing slash
      vi.stubEnv('AGENTCORE_RUNTIME_URL', 'https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/arn/invocations')

      const server = await serve({
        agentCard: buildAgentCard({ name: 'provided', description: 'x', url: 'http://stale:9000/' }),
      })

      const card = await fetchAgentCard(server)
      expect(card.supportedInterfaces.map((i) => i.url)).toContain(
        'https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/arn/invocations/'
      )
      expect(card.supportedInterfaces.map((i) => i.url)).not.toContain('http://stale:9000/')
    })
  })

  describe('port and host resolution', () => {
    it('uses the PORT env var when no port option is given', async () => {
      vi.stubEnv('PORT', '0')
      const server = await serveA2A({ executor: new RecordingExecutor() })
      servers.push(server)

      // PORT=0 binds an ephemeral port — anything but 9000 proves the env var was used
      expect(listenPort(server)).toBeGreaterThan(0)
      expect(listenPort(server)).not.toBe(9000)
    })

    it('binds to loopback outside containers and 0.0.0.0 inside', async () => {
      const local = await serve()
      expect(listenHost(local)).toBe('127.0.0.1')

      vi.stubEnv('DOCKER_CONTAINER', '1')
      const container = await serve()
      expect(listenHost(container)).toBe('0.0.0.0')
    })
  })

  describe('ping endpoint', () => {
    async function pingStatus(server: Server): Promise<{ status: string }> {
      const response = await fetch(`http://127.0.0.1:${listenPort(server)}/ping`)
      return (await response.json()) as { status: string }
    }

    it('reports Healthy by default', async () => {
      const server = await serve()
      expect(await pingStatus(server)).toEqual({ status: 'Healthy' })
    })

    it('reports a custom sync or async ping status', async () => {
      const busy = await serve({ pingHandler: () => 'HealthyBusy' })
      expect(await pingStatus(busy)).toEqual({ status: 'HealthyBusy' })

      const asyncBusy = await serve({ pingHandler: async () => 'HealthyBusy' as const })
      expect(await pingStatus(asyncBusy)).toEqual({ status: 'HealthyBusy' })
    })

    it('falls back to Healthy when the ping handler throws', async () => {
      const server = await serve({
        pingHandler: () => {
          throw new Error('handler exploded')
        },
      })
      expect(await pingStatus(server)).toEqual({ status: 'Healthy' })
    })
  })

  describe('context propagation', () => {
    it('exposes the AgentCore runtime headers to the executor via getContext', async () => {
      const executor = new RecordingExecutor()
      const server = await serve({ executor })

      const response = await fetch(`http://127.0.0.1:${listenPort(server)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-amzn-bedrock-agentcore-runtime-session-id': 'sess-e2e',
          'x-amzn-bedrock-agentcore-runtime-request-id': 'req-e2e',
          WorkloadAccessToken: 'token-e2e',
          'x-amzn-bedrock-agentcore-runtime-custom-tenant': 'acme',
        },
        body: sendMessageBody('msg-e2e'),
      })

      expect(response.status).toBe(200)
      expect(executor.observed).toMatchObject({
        sessionId: 'sess-e2e',
        requestId: 'req-e2e',
        workloadAccessToken: 'token-e2e',
      })
      expect(executor.observed?.headers['x-amzn-bedrock-agentcore-runtime-custom-tenant']).toBe('acme')

      // The context carries a usable logger, like on the HTTP protocol path
      const log = executor.observed!.log
      expect(() => log.child({}).debug('quiet')).not.toThrow()
    })

    it('mirrors the oauth2 callback URL into the context', async () => {
      const executor = new RecordingExecutor()
      const server = await serve({ executor })

      const response = await fetch(`http://127.0.0.1:${listenPort(server)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          OAuth2CallbackUrl: 'https://callback.example.com',
        },
        body: sendMessageBody('msg-oauth'),
      })

      expect(response.status).toBe(200)
      expect(executor.observed?.oauth2CallbackUrl).toBe('https://callback.example.com')
    })

    it('mirrors the runtime fields into ServerCallContext.state', async () => {
      const executor = new RecordingExecutor()
      const server = await serve({ executor })

      const response = await fetch(`http://127.0.0.1:${listenPort(server)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-amzn-bedrock-agentcore-runtime-session-id': 'sess-state',
          'x-amzn-bedrock-agentcore-runtime-request-id': 'req-state',
          WorkloadAccessToken: 'token-state',
          OAuth2CallbackUrl: 'https://cb.example.com',
        },
        body: sendMessageBody('msg-state'),
      })

      expect(response.status).toBe(200)
      const state = executor.observedState!
      expect(state.get('sessionId')).toBe('sess-state')
      expect(state.get('requestId')).toBe('req-state')
      expect(state.get('workloadAccessToken')).toBe('token-state')
      expect(state.get('oauth2CallbackUrl')).toBe('https://cb.example.com')
      expect((state.get('headers') as Record<string, string>)['workloadaccesstoken']).toBe('token-state')
    })

    it('uses an injected contextBuilder instead of the default', async () => {
      const executor = new RecordingExecutor()
      const server = await serve({
        executor,
        contextBuilder: (options) =>
          new A2AServerCallContext({
            state: new Map<string, unknown>([
              ['custom', 'yes'],
              ['headers', options.headers],
            ]),
          }),
      })

      const response = await fetch(`http://127.0.0.1:${listenPort(server)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: sendMessageBody('msg-custom-builder'),
      })

      expect(response.status).toBe(200)
      expect(executor.observedState?.get('custom')).toBe('yes')
      expect(executor.observedState?.has('requestId')).toBe(false)
    })
  })

  describe('listen errors', () => {
    it('rejects when the port is already in use', async () => {
      const first = await serve()
      const takenPort = listenPort(first)

      await expect(serveA2A({ executor: new RecordingExecutor(), port: takenPort })).rejects.toThrow(/EADDRINUSE/)
    })
  })

  describe('task store injection', () => {
    it('persists tasks through an injected TaskStore', async () => {
      const saved: Task[] = []
      const inner = new InMemoryTaskStore()
      const recordingStore: TaskStore = {
        async save(task: Task, context: ServerCallContext): Promise<void> {
          saved.push(task)
          return inner.save(task, context)
        },
        load: inner.load.bind(inner),
        list: inner.list.bind(inner),
      }

      const server = await serve({ taskStore: recordingStore })

      const response = await fetch(`http://127.0.0.1:${listenPort(server)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: sendMessageBody('msg-store'),
      })
      expect(response.status).toBe(200)
      expect(saved.length).toBeGreaterThanOrEqual(1)
    })
  })
})

describe('buildA2AApp', () => {
  it('returns an Express app without binding a port', async () => {
    const app = buildA2AApp({
      agentCard: buildAgentCard({ name: 'embedded', description: 'x' }),
      executor: new RecordingExecutor(),
    })

    const server = app.listen(0, '127.0.0.1')
    await new Promise((resolve) => server.once('listening', resolve))
    try {
      const port = (server.address() as { port: number }).port
      const response = await fetch(`http://127.0.0.1:${port}/ping`)
      expect((await response.json()) as { status: string }).toEqual({ status: 'Healthy' })
    } finally {
      server.close()
    }
  })
})
