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

  /**
   * Workload access token for authenticating with AgentCore Identity.
   * Set by RuntimeApp when WorkloadAccessToken header is present.
   * Used by Identity SDK to fetch OAuth2 tokens and API keys.
   */
  workloadAccessToken?: string | undefined
}

/**
 * Handler function type for processing agent invocations.
 *
 * The handler accepts and returns unknown types to support
 * arbitrary JSON payloads from AgentCore Runtime. The handler can also
 * return an async generator for streaming responses via Server-Sent Events.
 *
 * @param request - The request payload from AgentCore Runtime
 * @param context - Additional context including sessionId and headers
 * @returns Response data (any serializable type) or async generator for streaming
 */
export type Handler = (
  request: unknown,
  context: RequestContext
) => Promise<unknown> | unknown | AsyncGenerator<unknown, void, unknown>

/**
 * Configuration options for BedrockAgentCoreApp.
 */
export interface BedrockAgentCoreAppConfig {
  /**
   * Logging configuration options.
   */
  logging?: {
    enabled?: boolean
    level?: 'debug' | 'info' | 'warn' | 'error'
  }
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
