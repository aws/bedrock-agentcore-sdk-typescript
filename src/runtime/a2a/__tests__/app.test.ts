import type { Server } from 'http'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { TaskState } from '@a2a-js/sdk'
import { AgentEvent, InMemoryTaskStore, ServerCallContext as A2AServerCallContext } from '@a2a-js/sdk/server'
import type { ExecutionEventBus, RequestContext, ServerCallContext, TaskStore } from '@a2a-js/sdk/server'
import type { Task } from '@a2a-js/sdk'

import { buildA2AApp, serveA2A } from '../app.js'
import type { A2ALogger } from '../app.js'
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
    it('uses the A2A_PORT env var when no port option is given', async () => {
      vi.stubEnv('A2A_PORT', '0')
      const server = await serveA2A({ executor: new RecordingExecutor() })
      servers.push(server)

      // A2A_PORT=0 binds an ephemeral port — anything but 9000 proves the env var was used
      expect(listenPort(server)).toBeGreaterThan(0)
      expect(listenPort(server)).not.toBe(9000)
    })

    // Images reused across protocols set PORT to 8080 (HTTP) or 8000 (MCP), so
    // honouring it would bind the A2A server off its contract port.
    it('ignores the generic PORT env var and falls back to the contract port', async () => {
      vi.stubEnv('PORT', '8080')

      // buildA2AApp resolves the same way but advertises the port instead of
      // binding it, so the assertion does not need port 9000 to be free.
      const app = buildA2AApp({ executor: new RecordingExecutor() })
      const server = app.listen(0, '127.0.0.1')
      await new Promise((resolve) => server.once('listening', resolve))
      try {
        const port = (server.address() as { port: number }).port
        const response = await fetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`, {
          headers: { 'A2A-Version': '1.0' },
        })
        const card = (await response.json()) as { supportedInterfaces: { url: string }[] }

        expect(card.supportedInterfaces.map((i) => i.url)).toContain('http://localhost:9000/')
      } finally {
        server.close()
      }
    })

    it('warns when the resolved port is not the contract port', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        await serve({ port: 3006 })
        const message = warn.mock.calls.map((call) => String(call[0])).join('\n')

        expect(message).toContain('port=<3006>')
        expect(message).toContain('contract_port=<9000>')
        expect(message).toContain('424')
      } finally {
        warn.mockRestore()
      }
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

    // withWatPropagation sends the token under this header on outbound Invoke*
    // calls, so it is the shape an A2A agent sees when another agent invokes it.
    it('exposes a workload access token sent as the identity WAT header', async () => {
      const executor = new RecordingExecutor()
      const server = await serve({ executor })

      const response = await fetch(`http://127.0.0.1:${listenPort(server)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-amz-bedrock-agentcore-identity-wat': 'wat-chained',
        },
        body: sendMessageBody('msg-wat'),
      })

      expect(response.status).toBe(200)
      expect(executor.observed?.workloadAccessToken).toBe('wat-chained')
      expect(executor.observedState?.get('workloadAccessToken')).toBe('wat-chained')
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

  describe('logger injection', () => {
    function recordingLogger(): { lines: string[]; logger: A2ALogger } {
      const lines: string[] = []
      const record =
        (level: string) =>
        (...args: unknown[]): void => {
          lines.push(`${level}:${args.map(String).join(' ')}`)
        }
      const logger = {
        level: 'debug',
        fatal: record('fatal'),
        error: record('error'),
        warn: record('warn'),
        info: record('info'),
        debug: record('debug'),
        trace: record('trace'),
        silent: record('silent'),
        child: (): A2ALogger => logger,
      } as A2ALogger
      return { lines, logger }
    }

    it('routes startup and off-contract warnings through an injected logger', async () => {
      const { lines, logger } = recordingLogger()

      await serve({ port: 3007, logger })

      expect(lines.some((line) => line.startsWith('warn:') && line.includes('port=<3007>'))).toBe(true)
      expect(lines.some((line) => line.startsWith('info:') && line.includes('a2a server listening'))).toBe(true)
    })

    it('exposes the injected logger to executors and does not drop debug', async () => {
      const { lines, logger } = recordingLogger()
      const executor = new RecordingExecutor()
      const server = await serve({ executor, logger })

      const response = await fetch(`http://127.0.0.1:${listenPort(server)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: sendMessageBody('msg-logger'),
      })
      expect(response.status).toBe(200)

      executor.observed?.log.debug('executor debug line')
      expect(lines).toContain('debug:executor debug line')
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
