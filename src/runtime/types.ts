import type { RequestHandler } from 'express'

/**
 * Context provided to handler functions for each invocation request.
 */
export interface RequestContext {
  /**
   * Unique identifier for the session making the request.
   */
  sessionId: string

  /**
   * HTTP headers from the incoming request.
   */
  headers: Record<string, string>
}

/**
 * Handler function type for processing agent invocations.
 *
 * The handler accepts and returns any serializable type to support
 * arbitrary JSON payloads from AgentCore Runtime.
 *
 * @param request - The request payload from AgentCore Runtime
 * @param context - Additional context including sessionId and headers
 * @returns Response data (any serializable type)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Handler = (request: any, context: RequestContext) => Promise<any> | any

/**
 * Configuration options for BedrockAgentCoreApp.
 */
export interface AppConfig {
  /**
   * Request timeout in milliseconds.
   */
  timeout?: number

  /**
   * Logging configuration options.
   */
  logging?: {
    enabled?: boolean
    level?: 'debug' | 'info' | 'warn' | 'error'
  }

  /**
   * Additional Express middleware to apply.
   */
  middleware?: RequestHandler[]
}

/**
 * Health status values for the /ping endpoint.
 */
export type HealthStatus = 'Healthy' | 'HealthyBusy'

/**
 * Health check response format.
 */
export interface HealthCheckResponse {
  /**
   * Current health status of the application.
   */
  status: HealthStatus

  /**
   * ISO 8601 timestamp of the last update.
   */
  time_of_last_update: string
}
