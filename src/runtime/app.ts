import { Buffer } from 'buffer'
import { createRequire } from 'module'
import { randomUUID } from 'crypto'
import Fastify from 'fastify'

import type {
  FastifyInstance,
  FastifyLoggerOptions,
  FastifyRequest,
  FastifyReply,
  FastifyBodyParser,
  FastifyContentTypeParser,
} from 'fastify'
// Import SSE types to ensure module augmentation is applied
import type { SSESource } from '@fastify/sse'
import type { WebSocket } from '@fastify/websocket'
import type {
  BedrockAgentCoreAppParams,
  BedrockAgentCoreAppConfig,
  Handler,
  WebSocketHandler,
  RequestContext,
  HealthCheckResponse,
  AsyncTaskInfo,
  AsyncTaskStatus,
  HealthStatus,
} from './types.js'

const require = createRequire(import.meta.url)
const fastifySse = require('@fastify/sse')
const fastifyWebsocket = require('@fastify/websocket')

/**
 * Fastify-based HTTP server for hosting agents on AWS Bedrock AgentCore Runtime.
 *
 * This class provides an HTTP server that implements the AgentCore Runtime protocol
 * with health check and invocation endpoints. The server runs on port 8080 and
 * handles both JSON responses and Server-Sent Events (SSE) streaming.
 *
 * @example
 * ```typescript
 * const app = new BedrockAgentCoreApp(async (request, context) => {
 *   console.log(`Processing request with session ${context.sessionId}`)
 *   return "Hello from BedrockAgentCore!"
 * })
 *
 * app.run()
 * ```
 */
export class BedrockAgentCoreApp {
  private readonly _app: FastifyInstance
  private readonly _config: BedrockAgentCoreAppConfig
  private readonly _handler: Handler
  private _websocketHandler: WebSocketHandler | undefined
  private readonly _activeTasksMap: Map<number, AsyncTaskInfo> = new Map()
  private _taskCounter: number = 0
  private _pingHandler?: () => HealthStatus | Promise<HealthStatus>
  private _forcedPingStatus?: HealthStatus
  private _lastStatusUpdateTime: number = Date.now()
  private _lastKnownStatus?: HealthStatus

  /**
   * Creates a new BedrockAgentCoreApp instance.
   *
   * @param params - Configuration including handler and optional settings
   */
  constructor(params: BedrockAgentCoreAppParams) {
    this._handler = params.handler
    this._websocketHandler = params.websocketHandler ?? undefined
    this._config = params.config ?? {}

    // Configure Fastify logger based on BedrockAgentCoreAppConfig
    const loggerConfig = this._getLoggerConfig()

    this._app = Fastify({ logger: loggerConfig })
  }

  /**
   * Starts the Fastify server on port 8080.
   */
  run(): void {
    const PORT = 8080

    // Wait for Fastify to be ready (all plugins registered), setup routes, and start the server
    Promise.resolve(this._registerPlugins())
      .then(() => {
        this._setupContentTypeParsers()
        this._setupRoutes()
        return this._app.listen({ port: PORT, host: '0.0.0.0' })
      })
      .then(() => {
        console.log(`BedrockAgentCoreApp server listening on port ${PORT}`)
      })
      .catch((error: Error) => {
        this._app.log.error(error)
        process.exit(1)
      })
  }

  /**
   * Register an async task for health tracking.
   *
   * @param name - Human-readable task name
   * @param metadata - Optional task metadata
   * @returns Task ID for completion tracking
   */
  public addAsyncTask(name: string, metadata?: Record<string, unknown>): number {
    const taskId = ++this._taskCounter
    const taskInfo: AsyncTaskInfo = {
      name,
      startTime: Date.now(),
    }
    if (metadata) {
      taskInfo.metadata = metadata
    }
    this._activeTasksMap.set(taskId, taskInfo)
    return taskId
  }

  /**
   * Mark an async task as complete.
   *
   * @param taskId - Task ID from addAsyncTask
   * @returns True if task was found and removed
   */
  public completeAsyncTask(taskId: number): boolean {
    return this._activeTasksMap.delete(taskId)
  }

  /**
   * Get current ping status based on priority system.
   * Priority: Forced \> Custom Handler \> Automatic
   *
   * @returns Current health status
   */
  public getCurrentPingStatus(): HealthStatus {
    // Priority 1: Forced status
    if (this._forcedPingStatus) {
      return this._forcedPingStatus
    }

    // Priority 2: Custom handler
    if (this._pingHandler) {
      try {
        const result = this._pingHandler()
        // Handle both sync and async handlers
        return result instanceof Promise ? 'Healthy' : result
      } catch {
        this._app.log.warn('Custom ping handler failed, falling back to automatic')
      }
    }

    // Priority 3: Automatic based on active tasks
    const status: HealthStatus = this._activeTasksMap.size > 0 ? 'HealthyBusy' : 'Healthy'

    // Track status changes
    if (!this._lastKnownStatus || this._lastKnownStatus !== status) {
      this._lastKnownStatus = status
      this._lastStatusUpdateTime = Date.now()
    }

    return status
  }

  /**
   * Register a custom ping status handler.
   *
   * @param handler - Function that returns health status
   */
  public ping(handler: () => HealthStatus | Promise<HealthStatus>): void {
    this._pingHandler = handler
  }

  /**
   * Decorator to automatically track async tasks.
   * Status becomes HealthyBusy during execution.
   *
   * @param fn - Async function to wrap
   * @returns Wrapped function with automatic task tracking
   * @throws Error if fn is not an async function
   */
  public asyncTask<T extends (...args: unknown[]) => Promise<unknown>>(fn: T): T {
    // Validate that fn is actually an async function
    if (fn.constructor.name !== 'AsyncFunction') {
      throw new Error('asyncTask can only be applied to async functions')
    }

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this
    const wrapped = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
      const taskId = self.addAsyncTask(fn.name || 'anonymous')
      try {
        return await fn.apply(this, args)
      } finally {
        self.completeAsyncTask(taskId)
      }
    }
    Object.defineProperty(wrapped, 'name', { value: fn.name })
    return wrapped as T
  }

  /**
   * Get information about currently running async tasks.
   *
   * @returns Task status with count and details
   */
  public getAsyncTaskInfo(): AsyncTaskStatus {
    const now = Date.now()
    const runningJobs = Array.from(this._activeTasksMap.values()).map((task) => ({
      name: task.name,
      duration: (now - task.startTime) / 1000, // Convert to seconds
    }))

    return {
      activeCount: this._activeTasksMap.size,
      runningJobs,
    }
  }

  /**
   * Sets up HTTP routes for the server.
   */
  private _setupRoutes(): void {
    // Health check endpoint
    this._app.get('/ping', this._handlePing.bind(this))

    // Invocation endpoint
    this._app.post('/invocations', { sse: true }, this._handleInvocation.bind(this))

    // WebSocket endpoint (only if handler exists)
    if (this._websocketHandler) {
      this._app.get('/ws', { websocket: true }, this._handleWebSocket.bind(this))
    }
  }

  /**
   * Register custom content type parsers using Fastify's native addContentTypeParser.
   */
  private _setupContentTypeParsers(): void {
    this._config.contentTypeParsers?.forEach((parserConfig) => {
      const { contentType, parser, parseAs, bodyLimit } = parserConfig

      if (parseAs === 'stream') {
        // Use FastifyContentTypeParser for stream mode (raw request payload)
        const opts = bodyLimit ? { bodyLimit } : {}
        this._app.addContentTypeParser(contentType, opts, parser as FastifyContentTypeParser)
      } else {
        // Use FastifyBodyParser for string/buffer modes (default to 'string' when parseAs is undefined)
        const opts = {
          parseAs: parseAs || 'string',
          ...(bodyLimit && { bodyLimit }),
        }
        this._app.addContentTypeParser(contentType, opts, parser as FastifyBodyParser<string | Buffer>)
      }
    })
  }

  /**
   * Registers Fastify plugins.
   */
  private async _registerPlugins(): Promise<void> {
    await this._app.register(fastifySse)
    if (this._websocketHandler) {
      await this._app.register(fastifyWebsocket)
    }
  }

  /**
   * Gets the logger configuration based on BedrockAgentCoreAppConfig.
   *
   * @returns Fastify logger configuration
   */
  private _getLoggerConfig(): boolean | FastifyLoggerOptions {
    const loggingConfig = this._config.logging

    // If no logging config provided, use default (enabled with info level)
    if (!loggingConfig) {
      return true
    }

    // If logging is explicitly disabled, return false
    if (loggingConfig?.enabled === false) {
      return false
    }

    // Build logger configuration object
    const loggerConfig: { level: string } = {
      level: loggingConfig.level || 'info',
    }
    return loggerConfig
  }

  /**
   * Handles health check requests.
   *
   * @param request - Fastify request object
   * @param reply - Fastify reply object
   */
  private async _handlePing(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const status = this.getCurrentPingStatus()
    const response: HealthCheckResponse = {
      status,
      time_of_last_update: new Date(this._lastStatusUpdateTime).toISOString(),
    }
    await reply.send(response)
  }

  /**
   * Handles agent invocation requests.
   *
   * @param request - Fastify request object
   * @param reply - Fastify reply object
   */
  private async _handleInvocation(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      // Extract context
      const context = this._extractContext(request)

      // Validate sessionId
      if (!context.sessionId) {
        await reply.status(400).send({
          error: 'Missing sessionId. Provide via x-amzn-bedrock-agentcore-runtime-session-id header or request body.',
        })
        return
      }

      // Invoke handler
      const result = await this._handler(request.body as unknown, context)

      // Check if result is an async generator (streaming response)
      if (this._isAsyncGenerator(result)) {
        if (reply.sse) {
          await this._handleStreamingResponse(reply, result)
        } else {
          await reply.status(406).send({
            error:
              'Streaming response requires Accept: text/event-stream header. Please include this header in your request to receive streaming data.',
          })
        }
      } else {
        // Return JSON response
        await reply.send(result)
      }
    } catch (error) {
      // Handle errors
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      await reply.status(500).send({
        error: errorMessage,
      })
    }
  }

  /**
   * Checks if a value is an async generator.
   *
   * @param value - Value to check
   * @returns True if the value is an async generator
   */
  private _isAsyncGenerator(value: unknown): value is AsyncGenerator<SSESource> {
    return (
      value !== null &&
      value !== undefined &&
      typeof value === 'object' &&
      'next' in value &&
      typeof value.next === 'function' &&
      'return' in value &&
      typeof value.return === 'function' &&
      'throw' in value &&
      typeof value.throw === 'function' &&
      Symbol.asyncIterator in value &&
      typeof value[Symbol.asyncIterator] === 'function'
    )
  }

  /**
   * Handles streaming response using Server-Sent Events (SSE) via Fastify SSE plugin.
   *
   * @param reply - Fastify reply object
   * @param generator - Async generator that yields data chunks
   */
  private async _handleStreamingResponse(reply: FastifyReply, generator: AsyncGenerator<SSESource>): Promise<void> {
    try {
      await reply.sse.keepAlive()
      // Stream data chunks
      for await (const chunk of generator) {
        // Stop if client disconnected
        if (!reply.sse.isConnected) {
          break
        }

        // Send SSE message
        await reply.sse.send(chunk)
      }
    } catch (error) {
      // Send error event if still connected
      if (reply.sse && reply.sse.isConnected) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error'
        await reply.sse.send({
          event: 'error',
          data: { error: errorMessage },
        })
      } else {
        console.error(`Error during streaming SSE events: ${error}`)
        throw new Error('Error during streaming SSE events')
      }
    } finally {
      // Close the SSE connection
      if (reply.sse) {
        reply.sse.close()
      }
    }
  }

  /**
   * Handles WebSocket connections at /ws endpoint.
   *
   * @param connection - Fastify WebSocket connection
   * @param request - Fastify request object
   */
  private async _handleWebSocket(connection: WebSocket, request: FastifyRequest): Promise<void> {
    try {
      // Extract context from WebSocket request
      const context = this._extractContext(request)

      this._app.log.info(`WebSocket connection established for session: ${context.sessionId}`)

      // Call the user's WebSocket handler (guaranteed to exist since route is conditionally registered)
      await this._websocketHandler!(connection, context)
    } catch (error) {
      this._app.log.error(`error=<${error instanceof Error ? error.message : String(error)}> | websocket handler error`)
      try {
        connection.close(1011, 'Internal server error')
      } catch (closeError) {
        this._app.log.error(
          `close_error=<${closeError instanceof Error ? closeError.message : String(closeError)}> | error closing websocket`
        )
      }
    }
  }

  /**
   * Extracts request context from the incoming request.
   *
   * @param request - Fastify request object
   * @returns Request context with sessionId and headers
   */
  private _extractContext(request: FastifyRequest): RequestContext {
    // Extract sessionId from AWS header or body
    const sessionId =
      (request.headers['x-amzn-bedrock-agentcore-runtime-session-id'] as string) ||
      ((request.body as Record<string, unknown>)?.sessionId as string) ||
      ''

    // Extract request ID or generate if missing
    const requestId = (request.headers['x-amzn-bedrock-agentcore-runtime-request-id'] as string) || randomUUID()

    // Extract OAuth2 callback URL
    const oauth2CallbackUrl = request.headers['oauth2callbackurl'] as string | undefined

    // Filter headers to include only Authorization and Custom-* headers
    const filteredHeaders: Record<string, string> = {}
    for (const [key, value] of Object.entries(request.headers)) {
      const lowerKey = key.toLowerCase()
      const stringValue = typeof value === 'string' ? value : Array.isArray(value) ? value.join(', ') : undefined

      if (stringValue) {
        // Include Authorization header
        if (lowerKey === 'authorization') {
          filteredHeaders[key] = stringValue
        }
        // Include Custom-* headers
        else if (lowerKey.startsWith('x-amzn-bedrock-agentcore-runtime-custom-')) {
          filteredHeaders[key] = stringValue
        }
      }
    }

    // Extract workload token from header (if present)
    const workloadAccessToken = request.headers['workloadaccesstoken'] as string | undefined

    return {
      sessionId,
      headers: filteredHeaders,
      workloadAccessToken,
      requestId,
      oauth2CallbackUrl,
    }
  }
}
