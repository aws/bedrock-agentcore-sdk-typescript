import express, { type Express, type Request, type Response } from 'express'
import type { AppConfig, Handler, RequestContext, HealthCheckResponse } from './types.js'

/**
 * Express-based HTTP server for hosting agents on AWS Bedrock AgentCore Runtime.
 *
 * This class provides an HTTP server that implements the AgentCore Runtime protocol
 * with health check and invocation endpoints. The server runs on port 8080 and
 * handles both JSON responses and Server-Sent Events (SSE) streaming.
 *
 * @example
 * ```typescript
 * const app = new BedrockAgentCoreApp()
 *
 * const entrypoint = async (request, context) => {
 *   console.log(`Processing request with session ${context.sessionId}`)
 *   return "Hello from BedrockAgentCore!"
 * }
 *
 * app.setEntrypoint(entrypoint)
 * app.run()
 * ```
 */
export class BedrockAgentCoreApp {
  private readonly _app: Express
  private readonly _config: AppConfig
  private _handler: Handler | null = null

  /**
   * Creates a new BedrockAgentCoreApp instance.
   *
   * @param config - Optional configuration for timeout, logging, and middleware
   */
  constructor(config?: AppConfig) {
    this._config = config ?? {}
    this._app = express()

    // Add JSON body parser middleware
    this._app.use(express.json())

    // Apply custom middleware if provided
    if (this._config.middleware) {
      for (const middleware of this._config.middleware) {
        this._app.use(middleware)
      }
    }

    // Set up routes
    this._setupRoutes()
  }

  /**
   * Registers the handler function that will be invoked for each request.
   *
   * @param handler - The handler function to process invocation requests
   */
  setEntrypoint(handler: Handler): void {
    this._handler = handler
  }

  /**
   * Starts the Express server on port 8080.
   */
  run(): void {
    const PORT = 8080
    this._app.listen(PORT, () => {
      console.log(`BedrockAgentCoreApp server listening on port ${PORT}`)
    })
  }

  /**
   * Sets up HTTP routes for the server.
   */
  private _setupRoutes(): void {
    // Health check endpoint
    this._app.get('/ping', this._handlePing.bind(this))

    // Invocation endpoint
    this._app.post('/invocations', this._handleInvocation.bind(this))
  }

  /**
   * Handles health check requests.
   *
   * @param req - Express request object
   * @param res - Express response object
   */
  private _handlePing(req: Request, res: Response): void {
    const response: HealthCheckResponse = {
      status: 'Healthy',
      time_of_last_update: new Date().toISOString(),
    }
    res.json(response)
  }

  /**
   * Handles agent invocation requests.
   *
   * @param req - Express request object
   * @param res - Express response object
   */
  private async _handleInvocation(req: Request, res: Response): Promise<void> {
    try {
      // Validate handler is set
      if (!this._handler) {
        res.status(500).json({
          error: 'No handler configured. Call setEntrypoint() before starting the server.',
        })
        return
      }

      // Extract context
      const context = this._extractContext(req)

      // Validate sessionId
      if (!context.sessionId) {
        res.status(400).json({
          error: 'Missing sessionId. Provide via x-amzn-bedrock-agentcore-runtime-session-id header or request body.',
        })
        return
      }

      // Invoke handler
      const result = await this._handler(req.body, context)

      // Check if result is an async generator (streaming response)
      if (this._isAsyncGenerator(result)) {
        await this._handleStreamingResponse(res, result)
      } else {
        // Return JSON response
        res.json(result)
      }
    } catch (error) {
      // Handle errors
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      res.status(500).json({
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _isAsyncGenerator(value: any): value is AsyncGenerator {
    return (
      value &&
      typeof value === 'object' &&
      typeof value.next === 'function' &&
      typeof value[Symbol.asyncIterator] === 'function'
    )
  }

  /**
   * Handles streaming response using Server-Sent Events (SSE).
   *
   * @param res - Express response object
   * @param generator - Async generator that yields data chunks
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async _handleStreamingResponse(res: Response, generator: AsyncGenerator<any>): Promise<void> {
    // Set headers for Server-Sent Events
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')

    // Track client disconnect
    let clientDisconnected = false
    const onClose = (): void => {
      clientDisconnected = true
    }
    res.on('close', onClose)

    // Helper to write only if client still connected
    const writeIfConnected = (data: string): boolean => {
      if (!clientDisconnected) {
        res.write(data)
        return true
      }
      return false
    }

    try {
      // Stream data chunks
      for await (const chunk of generator) {
        // Stop if client disconnected
        if (clientDisconnected) {
          break
        }

        const data = JSON.stringify(chunk)
        writeIfConnected(`data: ${data}\n\n`)
      }

      // Send done event if still connected
      writeIfConnected('event: done\ndata: {}\n\n')
    } catch (error) {
      // Send error event if still connected
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      writeIfConnected(`event: error\ndata: ${JSON.stringify({ error: errorMessage })}\n\n`)
    } finally {
      // Clean up event listener
      res.off('close', onClose)

      // End response if not already closed
      if (!res.writableEnded) {
        res.end()
      }
    }
  }

  /**
   * Extracts request context from the incoming request.
   *
   * @param req - Express request object
   * @returns Request context with sessionId and headers
   */
  private _extractContext(req: Request): RequestContext {
    // Extract sessionId from AWS header or body
    const sessionId =
      (req.headers['x-amzn-bedrock-agentcore-runtime-session-id'] as string) || req.body?.sessionId || ''

    // Convert headers to plain object
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(req.headers)) {
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
