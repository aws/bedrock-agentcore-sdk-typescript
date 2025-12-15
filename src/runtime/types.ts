import type { AwsCredentialIdentityProvider } from '@aws-sdk/types'
import { z } from 'zod'

// =============================================================================
// BedrockAgentCoreApp Types (HTTP Server)
// =============================================================================

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

// =============================================================================
// RuntimeClient Types (WebSocket Client)
// =============================================================================

/**
 * Default presigned URL timeout in seconds (5 minutes).
 */
export const DEFAULT_PRESIGNED_URL_TIMEOUT = 300

/**
 * Maximum presigned URL timeout in seconds (5 minutes).
 */
export const MAX_PRESIGNED_URL_TIMEOUT = 300

/**
 * Default AWS region.
 */
export const DEFAULT_REGION = 'us-west-2'

/**
 * Zod schema for validating runtime ARN format.
 *
 * Expected format: arn:aws:bedrock-agentcore:{region}:{account}:runtime/{runtime_id}
 */
export const RuntimeArnSchema = z
  .string()
  .regex(
    /^arn:aws:bedrock-agentcore:[^:]+:[^:]+:runtime\/.+$/,
    'Invalid runtime ARN format. Expected: arn:aws:bedrock-agentcore:{region}:{account}:runtime/{runtime_id}'
  )

/**
 * Parsed components of a runtime ARN.
 */
export interface ParsedRuntimeArn {
  /**
   * AWS region where the runtime is located.
   */
  region: string

  /**
   * AWS account ID that owns the runtime.
   */
  accountId: string

  /**
   * Unique identifier for the runtime.
   */
  runtimeId: string
}

/**
 * Configuration options for RuntimeClient.
 */
export interface RuntimeClientConfig {
  /**
   * AWS region where the runtime service is deployed.
   * Defaults to process.env.AWS_REGION or 'us-west-2'.
   */
  region?: string

  /**
   * Optional AWS credentials provider.
   * When omitted, the SDK uses the default Node.js credential provider chain.
   *
   * @example
   * Using custom credentials:
   * ```ts
   * import { fromIni } from '@aws-sdk/credential-providers'
   *
   * const client = new RuntimeClient({
   *   region: 'us-west-2',
   *   credentialsProvider: fromIni({ profile: 'my-profile' })
   * })
   * ```
   */
  credentialsProvider?: AwsCredentialIdentityProvider
}

/**
 * Parameters for generating WebSocket connection credentials.
 */
export interface GenerateWsConnectionParams {
  /**
   * Full runtime ARN.
   *
   * Example: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/my-runtime-abc'
   */
  runtimeArn: string

  /**
   * Optional session ID to use.
   * If not provided, a UUID will be auto-generated.
   */
  sessionId?: string

  /**
   * Optional endpoint name to use as 'qualifier' query parameter.
   * If provided, adds ?qualifier={endpointName} to the URL.
   */
  endpointName?: string
}

/**
 * Parameters for generating presigned WebSocket URL.
 */
export interface GeneratePresignedUrlParams {
  /**
   * Full runtime ARN.
   *
   * Example: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/my-runtime-abc'
   */
  runtimeArn: string

  /**
   * Optional session ID to use.
   * If not provided, a UUID will be auto-generated.
   */
  sessionId?: string

  /**
   * Optional endpoint name to use as 'qualifier' query parameter.
   * If provided, adds ?qualifier={endpointName} to the URL before signing.
   */
  endpointName?: string

  /**
   * Additional query parameters to include in the presigned URL before signing.
   *
   * Example: { "customParam": "value", "anotherParam": "value2" }
   */
  customHeaders?: Record<string, string>

  /**
   * Seconds until URL expires.
   * Must be between 1 and 300 seconds.
   * Defaults to 300 seconds (5 minutes).
   */
  expires?: number
}

/**
 * WebSocket connection details with URL and authentication headers.
 */
export interface WebSocketConnection {
  /**
   * WebSocket URL (wss://) with query parameters.
   */
  url: string

  /**
   * Authentication headers for WebSocket connection.
   * Includes SigV4 signature and session information.
   */
  headers: Record<string, string>
}
