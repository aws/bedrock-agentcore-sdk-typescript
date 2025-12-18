import { createRequire } from 'module'
import Fastify from 'fastify'

import type { FastifyInstance, FastifyLoggerOptions, FastifyRequest, FastifyReply } from 'fastify'
// Import SSE types to ensure module augmentation is applied
import type {} from '@fastify/sse'
import type { BedrockAgentCoreAppConfig, Handler, RequestContext, HealthCheckResponse } from './types.js'

const require = createRequire(import.meta.url)
const fastifySse = require('@fastify/sse')

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

  /**
   * Creates a new BedrockAgentCoreApp instance.
   *
   * @param handler - The handler function to process invocation requests
   * @param config - Optional configuration for logging, etc.
   */
  constructor(handler: Handler, config?: BedrockAgentCoreAppConfig) {
    this._handler = handler
    this._config = config ?? {}

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
   * Sets up HTTP routes for the server.
   */
  private _setupRoutes(): void {
    // Health check endpoint
    this._app.get('/ping', this._handlePing.bind(this))

    // Invocation endpoint
    this._app.post('/invocations', { sse: true }, this._handleInvocation.bind(this))
  }

  /**
   * Registers Fastify plugins.
   */
  private async _registerPlugins(): Promise<void> {
    // Register SSE plugin
    await this._app.register(fastifySse)
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
    const response: HealthCheckResponse = {
      status: 'Healthy',
      time_of_last_update: new Date().toISOString(),
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
        await this._handleStreamingResponse(reply, result)
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
  private _isAsyncGenerator(value: unknown): value is AsyncGenerator {
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
  private async _handleStreamingResponse(reply: FastifyReply, generator: AsyncGenerator<unknown>): Promise<void> {
    try {
      await reply.sse.keepAlive()
      // Stream data chunks
      for await (const chunk of generator) {
        // Stop if client disconnected
        if (!reply.sse.isConnected) {
          break
        }

        // Send SSE message
        await reply.sse.send({
          data: chunk,
        })
      }

      // Send done event if still connected
      if (reply.sse.isConnected) {
        await reply.sse.send({
          event: 'done',
          data: {},
        })
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

    // Convert headers to plain object
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(request.headers)) {
      if (typeof value === 'string') {
        headers[key] = value
      } else if (Array.isArray(value)) {
        headers[key] = value.join(', ')
      }
    }

    return {
      sessionId,
      headers,
    }
  }
}
