import type { AwsCredentialIdentityProvider } from '@aws-sdk/types'

/**
 * Default browser identifier for system browser.
 */
export const DEFAULT_IDENTIFIER = 'aws.browser.v1'

/**
 * Default session name.
 */
export const DEFAULT_SESSION_NAME = 'default'

/**
 * Default session timeout in seconds (1 hour).
 */
export const DEFAULT_TIMEOUT = 3600

/**
 * Default AWS region.
 */
export const DEFAULT_REGION = 'us-west-2'

/**
 * Configuration options for BrowserClient.
 */
export interface BrowserClientConfig {
  /**
   * AWS region where the browser service is deployed.
   * Defaults to process.env.AWS_REGION or 'us-west-2'.
   */
  region?: string

  /**
   * Browser identifier to use for sessions.
   * Defaults to 'aws.browser.v1' for system browser.
   */
  identifier?: string

  /**
   * Optional AWS credentials provider.
   * When omitted, the SDK uses the default Node.js credential provider chain.
   *
   * @example
   * Using Vercel OIDC credentials:
   * ```ts
   * import { vercelOidcAwsCredentials } from '\@vercel/oidc-aws-credentials-provider'
   *
   * const browser = new BrowserClient(\{
   *   region: process.env.AWS_REGION || 'us-west-2',
   *   credentialsProvider: vercelOidcAwsCredentials()
   * \})
   * ```
   */
  credentialsProvider?: AwsCredentialIdentityProvider
}

/**
 * Parameters for starting a browser session.
 */
export interface StartSessionParams {
  /**
   * Optional name for the browser session.
   * If not provided, defaults to 'default'.
   */
  sessionName?: string

  /**
   * Session timeout in seconds.
   * Valid range: 1-28800 seconds (1 second to 8 hours).
   * Defaults to 3600 seconds (1 hour).
   */
  timeout?: number

  /**
   * Viewport dimensions for the browser.
   */
  viewport?: ViewportConfig
}

/**
 * Viewport configuration for browser sessions.
 */
export interface ViewportConfig {
  /**
   * Viewport width in pixels.
   */
  width: number

  /**
   * Viewport height in pixels.
   */
  height: number
}

/**
 * Information about an active browser session.
 */
export interface SessionInfo {
  /**
   * Name of the session.
   */
  sessionName: string

  /**
   * Unique session identifier assigned by AWS.
   */
  sessionId: string

  /**
   * Timestamp when the session was created.
   */
  createdAt: Date

  /**
   * Optional description of the session.
   */
  description?: string
}

/**
 * Parameters for getting browser session details.
 */
export interface GetSessionParams {
  /**
   * Browser identifier.
   * Uses current instance identifier if not provided.
   */
  browserId?: string

  /**
   * Session ID to query.
   * Uses current active session ID if not provided.
   */
  sessionId?: string
}

/**
 * Stream endpoint information for browser sessions.
 */
export interface StreamInfo {
  /**
   * WebSocket endpoint URL for the stream.
   */
  streamEndpoint?: string

  /**
   * Status of the stream.
   */
  streamStatus?: string
}

/**
 * Live view stream information for browser sessions.
 */
export interface LiveViewStreamInfo {
  /**
   * WebSocket endpoint URL for the live view stream.
   */
  streamEndpoint?: string
}

/**
 * Browser session streams for automation and live viewing.
 */
export interface BrowserSessionStreams {
  /**
   * Automation stream for browser control.
   */
  automationStream?: StreamInfo

  /**
   * Live view stream for viewing browser state.
   */
  liveViewStream?: LiveViewStreamInfo
}

/**
 * Detailed session information returned by getSession.
 */
export interface GetSessionResponse {
  /**
   * AWS-assigned session identifier.
   */
  sessionId: string

  /**
   * Browser identifier.
   */
  browserIdentifier: string

  /**
   * Session name.
   */
  name: string

  /**
   * Session status.
   * Common values: 'READY', 'TERMINATED'
   */
  status: string

  /**
   * Timestamp when session was created.
   */
  createdAt: Date

  /**
   * Timestamp when session was last updated.
   */
  lastUpdatedAt: Date

  /**
   * Session timeout in seconds.
   */
  sessionTimeoutSeconds: number

  /**
   * Stream endpoints for browser automation and live viewing.
   */
  streams?: BrowserSessionStreams
}

/**
 * Parameters for listing browser sessions.
 */
export interface ListSessionsParams {
  /**
   * Browser identifier.
   * Uses current instance identifier if not provided.
   */
  browserId?: string

  /**
   * Filter by session status.
   * Common values: 'READY', 'TERMINATED'
   */
  status?: string

  /**
   * Maximum number of results to return (1-100).
   * Defaults to 10
   */
  maxResults?: number

  /**
   * Pagination token for fetching next page of results.
   */
  nextToken?: string
}

/**
 * Summary information for a browser session in list results.
 */
export interface SessionSummary {
  /**
   * AWS-assigned session identifier.
   */
  sessionId: string

  /**
   * Session name.
   */
  name: string

  /**
   * Session status.
   * Common values: 'READY', 'TERMINATED'
   */
  status: string

  /**
   * Timestamp when session was created.
   */
  createdAt: Date

  /**
   * Timestamp when session was last updated.
   */
  lastUpdatedAt: Date
}

/**
 * Response from listing browser sessions.
 */
export interface ListSessionsResponse {
  /**
   * List of session summaries.
   */
  items: SessionSummary[]

  /**
   * Token for fetching next page of results.
   * Present if there are more results available.
   */
  nextToken?: string
}

/**
 * WebSocket connection details for browser automation.
 */
export interface WebSocketConnection {
  /**
   * WebSocket URL (wss://) for connecting to the browser.
   */
  url: string

  /**
   * HTTP headers required for WebSocket authentication.
   * Includes Authorization, X-Amz-Date, and security token headers.
   */
  headers: Record<string, string>
}

/**
 * Session status information.
 */
export interface SessionStatus {
  /**
   * Current status of the session.
   */
  status: 'READY' | 'TERMINATED' | 'TERMINATING'

  /**
   * Timestamp when the session was created.
   */
  createdAt?: Date

  /**
   * Timestamp when the session was last updated.
   */
  updatedAt?: Date
}

/**
 * Result of a browser operation.
 */
export interface BrowserOperationResult {
  /**
   * Whether the operation succeeded.
   */
  success: boolean

  /**
   * Error message if the operation failed.
   */
  error?: string

  /**
   * Additional data returned from the operation.
   */
  data?: unknown
}
