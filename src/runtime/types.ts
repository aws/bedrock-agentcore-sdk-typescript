import type { AwsCredentialIdentityProvider } from '@aws-sdk/types'
import type { FastifyBodyParser, FastifyContentTypeParser } from 'fastify'
import { Buffer } from 'buffer'
import { z } from 'zod'

// =============================================================================
// BedrockAgentCoreApp Types (HTTP Server)
// =============================================================================

import type { WebSocket } from '@fastify/websocket'
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
   * Filtered to include only Authorization and Custom-* headers.
   */
  headers: Record<string, string>

  /**
   * Workload access token for authenticating with AgentCore Identity.
   * Set by RuntimeApp when WorkloadAccessToken header is present.
   * Used by Identity SDK to fetch OAuth2 tokens and API keys.
   */
  workloadAccessToken?: string | undefined

  /**
   * Request ID for tracing and log correlation.
   * Extracted from X-Amzn-Bedrock-AgentCore-Runtime-Request-Id header
   * or auto-generated if not provided.
   */
  requestId?: string | undefined

  /**
   * OAuth2 callback URL for authentication flows.
   * Extracted from OAuth2CallbackUrl header when present.
   */
  oauth2CallbackUrl?: string | undefined
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
 * WebSocket handler function type for processing WebSocket connections.
 *
 * @param connection - Fastify WebSocket connection object
 * @param context - Request context including sessionId and headers
 */
export type WebSocketHandler = (socket: WebSocket, context: RequestContext) => Promise<void> | void

/**
 * Content type parser configuration using Fastify's native types.
 * @example
 * ```typescript
 * const app = new BedrockAgentCoreApp({
 *   handler: myHandler,
 *   config: {
 *     contentTypeParsers: [
 *       {
 *         contentType: 'application/xml',
 *         parser: (request, body) => parseXML(body as string),
 *         parseAs: 'string'
 *       },
 *       {
 *         contentType: 'application/pdf',
 *         parser: (request, body) => parsePDF(body as Buffer),
 *         parseAs: 'buffer'
 *       },
 *       {
 *         contentType: 'application/large-csv',
 *         parser: (request, payload) => parseStreamingCSV(payload),
 *         // parseAs omitted for stream mode (uses FastifyContentTypeParser)
 *       }
 *     ]
 *   }
 * })
 * ```
 */
export interface ContentTypeParserConfig {
  /**
   * Content type to handle (e.g., 'application/xml', 'text/csv').
   * Can be a string, array of strings, or RegExp.
   */
  contentType: string | string[] | RegExp

  /**
   * Parser function to process the request body.
   * Uses Fastify's native FastifyBodyParser for string/buffer modes,
   * or FastifyContentTypeParser for stream mode.
   */
  parser: FastifyBodyParser<string | Buffer> | FastifyContentTypeParser

  /**
   * How to parse the raw request body before passing to the parser function.
   * - 'string': body is parsed as string (uses FastifyBodyParser<string>)
   * - 'buffer': body is parsed as buffer (uses FastifyBodyParser<Buffer>)
   * - 'stream': body is passed as raw stream (uses FastifyContentTypeParser)
   *
   * Defaults to 'string' when not specified.
   */
  parseAs?: 'string' | 'buffer' | 'stream'

  /**
   * The maximum payload size, in bytes, that the custom parser will accept
   * Defaults to Fastify's global body limit (1MB default)
   */
  bodyLimit?: number
}

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

  /**
   * Custom content type parsers for handling custom content-types.
   * 'application/json' and 'text/plain' are natively supported.
   */
  contentTypeParsers?: ContentTypeParserConfig[]
}

/**
 * Parameters for BedrockAgentCoreApp constructor.
 */
export interface BedrockAgentCoreAppParams {
  /**
   * The handler function to process invocation requests.
   */
  handler: Handler
  /**
   * WebSocket handler for the /ws endpoint.
   */
  websocketHandler?: WebSocketHandler
  /**
   * Additional configuration options.
   */
  config?: BedrockAgentCoreAppConfig
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

/**
 * Information about a tracked async task.
 */
export interface AsyncTaskInfo {
  name: string
  startTime: number
  metadata?: Record<string, unknown>
}

/**
 * Status information about all async tasks.
 */
export interface AsyncTaskStatus {
  activeCount: number
  runningJobs: Array<{
    name: string
    duration: number
  }>
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
 * Expected format: arn:aws:bedrock-agentcore:\{region\}:\{account\}:runtime/\{runtime_id\}
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
   * If provided, adds ?qualifier=\{endpointName\} to the URL.
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
   * If provided, adds ?qualifier=\{endpointName\} to the URL before signing.
   */
  endpointName?: string

  /**
   * Additional query parameters to include in the presigned URL before signing.
   *
   * Example: \{ "customParam": "value", "anotherParam": "value2" \}
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
 * Parameters for generating WebSocket connection with OAuth authentication.
 */
export interface GenerateWsConnectionOAuthParams {
  /**
   * Full runtime ARN.
   *
   * Example: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/my-runtime-abc'
   */
  runtimeArn: string

  /**
   * OAuth bearer token for authentication.
   * Must not be empty.
   */
  bearerToken: string

  /**
   * Optional session ID to use.
   * If not provided, a UUID will be auto-generated.
   */
  sessionId?: string

  /**
   * Optional endpoint name to use as 'qualifier' query parameter.
   * If provided, adds ?qualifier=\{endpointName\} to the URL.
   */
  endpointName?: string
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
