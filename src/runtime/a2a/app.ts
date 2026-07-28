/**
 * A2A protocol server for AWS Bedrock AgentCore Runtime.
 *
 * Implements the AgentCore Runtime A2A container contract around the
 * `@a2a-js/sdk` Express handlers:
 *
 * - JSON-RPC 2.0 endpoint at `POST /`
 * - Agent card at `GET /.well-known/agent-card.json`
 * - Health check at `GET /ping`
 *
 * AgentCore Runtime's A2A path is a transparent proxy: `InvokeAgentRuntime`
 * payloads pass through to `POST /` unmodified, so there is no envelope to
 * unwrap. The AgentCore-injected headers (session id, request id, workload
 * access token, OAuth2 callback URL) are propagated into the same request
 * context used by the HTTP protocol path, so identity wrappers such as
 * `withApiKey` work unchanged inside A2A executors.
 */

import { existsSync } from 'fs'
import type { Server } from 'http'
import express from 'express'
import type { Express, NextFunction, Request, Response } from 'express'
import { DefaultRequestHandler, InMemoryTaskStore, ServerCallContext, STATE_HEADERS_KEY } from '@a2a-js/sdk/server'
import type { AgentExecutor, ServerCallContextBuilder, TaskStore } from '@a2a-js/sdk/server'
import type { AgentCard } from '@a2a-js/sdk'
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express'
import type { FastifyBaseLogger } from 'fastify'

import { agentCoreRuntimeUrl, buildAgentCard, withJsonRpcUrl } from './agent-card.js'
import { extractA2AContext } from './headers.js'
import { getContext, runWithContext } from '../context.js'
import type { HealthStatus, RequestContext } from '../types.js'

/**
 * Options for {@link serveA2A} and {@link buildA2AApp}.
 */
export interface ServeA2AOptions {
  /**
   * Executor implementing the agent logic against the `@a2a-js/sdk` AgentExecutor interface.
   */
  executor: AgentExecutor

  /**
   * Agent card to serve; auto-built when omitted, URL-rewritten to AGENTCORE_RUNTIME_URL when that env var is set.
   */
  agentCard?: AgentCard

  /**
   * Port to serve on; defaults to the PORT env var, or 9000 (the AgentCore A2A protocol port) when unset.
   */
  port?: number

  /**
   * Host to bind; defaults to 0.0.0.0 inside containers (detected via /.dockerenv or DOCKER_CONTAINER) and 127.0.0.1 otherwise.
   */
  host?: string

  /**
   * Custom health reporter for `GET /ping`; falls back to 'Healthy' when it throws. Defaults to always-'Healthy'.
   */
  pingHandler?: () => HealthStatus | Promise<HealthStatus>

  /**
   * Task persistence; defaults to a per-server InMemoryTaskStore.
   */
  taskStore?: TaskStore

  /**
   * ServerCallContext factory for the JSON-RPC handler; defaults to {@link bedrockCallContextBuilder}.
   */
  contextBuilder?: ServerCallContextBuilder
}

/**
 * Options accepted by {@link buildA2AApp} — everything except the listen socket settings.
 */
export type BuildA2AAppOptions = Omit<ServeA2AOptions, 'host'>

/**
 * Starts an A2A server implementing the AgentCore Runtime contract.
 *
 * Builds the Express app via {@link buildA2AApp} and listens on the
 * resolved host and port (see {@link ServeA2AOptions} for the defaults).
 *
 * @param options - Executor plus optional card, port, host, ping handler, task store, and context builder
 * @returns The listening HTTP server
 *
 * @example
 * ```typescript
 * import { serveA2A } from 'bedrock-agentcore/runtime/a2a'
 *
 * await serveA2A({ executor: myExecutor })
 * ```
 */
export async function serveA2A(options: ServeA2AOptions): Promise<Server> {
  const port = resolvePort(options.port)
  // Bind all interfaces only where the container contract needs it; on a
  // developer machine an A2A agent has no business listening externally.
  const inContainer = existsSync('/.dockerenv') || Boolean(process.env.DOCKER_CONTAINER)
  const host = options.host ?? (inContainer ? '0.0.0.0' : '127.0.0.1')
  const agentCard = resolveAgentCard(options.agentCard, port)

  const app = buildA2AApp({ ...options, agentCard, port })

  return new Promise((resolve, reject) => {
    // Express 5 invokes the listen callback with the error on bind failure
    // (e.g. EADDRINUSE) instead of emitting an unhandled 'error' event.
    const server = app.listen(port, host, (error?: Error) => {
      if (error) {
        reject(error)
        return
      }
      console.log(`agent=<${agentCard.name}>, host=<${host}>, port=<${port}> | a2a server listening`)
      resolve(server)
    })
  })
}

/**
 * Assembles the Express app implementing the AgentCore Runtime A2A
 * contract without binding a port.
 *
 * Use this directly for embedding in an existing server or for socket-less
 * testing; use {@link serveA2A} to also listen.
 *
 * @param options - Executor plus optional card, port, ping handler, task store, and context builder
 * @returns An Express application serving the A2A contract
 */
export function buildA2AApp(options: BuildA2AAppOptions): Express {
  const agentCard = resolveAgentCard(options.agentCard, resolvePort(options.port))

  const requestHandler = new DefaultRequestHandler(
    agentCard,
    options.taskStore ?? new InMemoryTaskStore(),
    options.executor
  )

  const app = express()

  // AgentCore Runtime health contract: 200 + {"status": "Healthy"} (or
  // "HealthyBusy" to shed new work). A failing custom handler degrades to
  // Healthy rather than failing the probe — a broken reporter shouldn't get
  // the container killed.
  app.get('/ping', async (_req: Request, res: Response): Promise<void> => {
    let status: HealthStatus
    try {
      status = (await options.pingHandler?.()) ?? 'Healthy'
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(
        `agent=<${agentCard.name}>, error=<${message}> | custom ping handler failed, falling back to Healthy`
      )
      status = 'Healthy'
    }
    res.json({ status })
  })

  app.use(
    '/.well-known/agent-card.json',
    agentCardHandler({
      agentCardProvider: requestHandler,
      // AgentCore's documented card shape still speaks A2A v0.3; the compat
      // layer serves both versions.
      legacyCompat: { enabled: true },
    })
  )

  // Propagate the AgentCore-injected headers into the same request context
  // used by the HTTP protocol path, so getContext() — and everything built
  // on it, like the identity wrappers — works inside A2A executors.
  app.use('/', (req: Request, _res: Response, next: NextFunction): void => {
    if (req.method !== 'POST') {
      next()
      return
    }
    const context: RequestContext = { ...extractA2AContext(req.headers), log: consoleLogger() }
    runWithContext(context, next)
  })

  app.use(
    jsonRpcHandler({
      requestHandler,
      // Authentication (SigV4/OAuth) is terminated by AgentCore Runtime in
      // front of the container; inside, requests are trusted.
      userBuilder: UserBuilder.noAuthentication,
      contextBuilder: options.contextBuilder ?? bedrockCallContextBuilder,
      legacyCompat: { enabled: true },
    })
  )

  return app
}

/**
 * A ServerCallContextBuilder that mirrors the AgentCore runtime headers
 * into `ServerCallContext.state`, so executors can read them from
 * `requestContext.context.state` without relying on the ambient request
 * context.
 *
 * State keys: `headers`, `requestId`, and — when present — `sessionId`,
 * `workloadAccessToken`, and `oauth2CallbackUrl`.
 *
 * @param options - Header and identity data provided by the JSON-RPC handler
 * @returns A ServerCallContext carrying the Bedrock fields in its state map
 */
export const bedrockCallContextBuilder: ServerCallContextBuilder = (options) => {
  // Reuse the ambient context established by the middleware when present,
  // keeping generated request ids consistent across both surfaces.
  const bedrock = getContext() ?? { ...extractA2AContext(options.headers), log: consoleLogger() }

  const state = new Map<string, unknown>()
  state.set(STATE_HEADERS_KEY, options.headers)
  state.set('requestId', bedrock.requestId)
  if (bedrock.sessionId) {
    state.set('sessionId', bedrock.sessionId)
  }
  if (bedrock.workloadAccessToken !== undefined) {
    state.set('workloadAccessToken', bedrock.workloadAccessToken)
  }
  if (bedrock.oauth2CallbackUrl !== undefined) {
    state.set('oauth2CallbackUrl', bedrock.oauth2CallbackUrl)
  }

  return new ServerCallContext({
    ...(options.extensions !== undefined && { requestedExtensions: options.extensions }),
    ...(options.user !== undefined && { user: options.user }),
    ...(options.tenant !== undefined && { tenant: options.tenant }),
    ...(options.requestedVersion !== undefined && { requestedVersion: options.requestedVersion }),
    state,
  })
}

function resolveAgentCard(provided: AgentCard | undefined, port: number): AgentCard {
  const runtimeUrl = agentCoreRuntimeUrl()
  if (!provided) {
    // The generic fallback card advertises the actual listen port;
    // AGENTCORE_RUNTIME_URL takes precedence inside buildAgentCard. Name,
    // description, version, and skill match the Python SDK's auto-built card.
    return buildAgentCard({
      name: 'agent',
      description: 'A Bedrock AgentCore agent',
      version: '0.1.0',
      skills: [{ id: 'main', name: 'agent', description: 'A Bedrock AgentCore agent', tags: ['main'] }],
      port,
    })
  }
  return runtimeUrl ? withJsonRpcUrl(provided, runtimeUrl) : provided
}

function resolvePort(port: number | undefined): number {
  return port ?? Number(process.env.PORT ?? 9000)
}

function noop(): void {}

// Console-backed logger satisfying the RequestContext.log contract. The A2A
// path has no Fastify request logger, so debug/trace are silent and
// warn/error go to the console — enough for executors that log through the
// context, without pulling a logging dependency into the A2A path.
const consoleLog = {
  level: 'info',
  fatal: console.error.bind(console),
  error: console.error.bind(console),
  warn: console.warn.bind(console),
  info: console.info.bind(console),
  debug: noop,
  trace: noop,
  silent: noop,
  child(): FastifyBaseLogger {
    return consoleLog
  },
} as unknown as FastifyBaseLogger

function consoleLogger(): FastifyBaseLogger {
  return consoleLog
}
