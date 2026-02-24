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

  /**
   * Proxy configuration for the browser session.
   */
  proxyConfiguration?: ProxyConfiguration

  /**
   * Browser extensions to load in the session.
   */
  extensions?: BrowserExtension[]

  /**
   * Profile configuration for the browser session.
   */
  profileConfiguration?: ProfileConfiguration
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
 * Basic authentication credentials stored in AWS Secrets Manager.
 */
export interface BasicAuth {
  /**
   * ARN of the Secrets Manager secret containing proxy credentials.
   */
  secretArn: string
}

/**
 * Credentials for proxy server authentication.
 */
export interface ProxyCredentials {
  /**
   * Basic authentication credentials.
   */
  basicAuth?: BasicAuth
}

/**
 * External proxy server configuration.
 */
export interface ExternalProxy {
  /**
   * Proxy server hostname.
   */
  server: string

  /**
   * Proxy server port.
   */
  port: number

  /**
   * Domain patterns to route through this proxy.
   * Uses leading dot notation (e.g., '.example.com').
   */
  domainPatterns?: string[]

  /**
   * Credentials for proxy authentication.
   */
  credentials?: ProxyCredentials
}

/**
 * Individual proxy entry wrapping an external proxy configuration.
 */
export interface ProxyEntry {
  /**
   * External proxy server configuration.
   */
  externalProxy: ExternalProxy
}

/**
 * Domains that bypass all proxy rules.
 */
export interface BypassConfig {
  /**
   * Domain patterns that should bypass the proxy.
   */
  domainPatterns: string[]
}

/**
 * Proxy configuration for routing browser traffic through external proxy servers.
 * Maximum 5 proxies per session, 100 domain patterns per proxy, 100 bypass patterns.
 */
export interface ProxyConfiguration {
  /**
   * List of proxy entries to apply.
   */
  proxies: ProxyEntry[]

  /**
   * Domains that bypass all proxy rules.
   */
  bypass?: BypassConfig
}

/**
 * S3 location for resources.
 */
export interface S3Location {
  /**
   * S3 bucket name containing the resource.
   */
  bucket: string

  /**
   * S3 prefix/key to the resource file.
   */
  prefix: string

  /**
   * Optional S3 version ID.
   */
  versionId?: string
}

/**
 * Resource location (union type for S3).
 */
export interface ResourceLocation {
  /**
   * S3 location of the resource.
   */
  s3: S3Location
}

/**
 * Browser extension configuration.
 */
export interface BrowserExtension {
  /**
   * Location of the extension.
   */
  location: ResourceLocation
}

/**
 * Profile configuration for persisting browser state across sessions.
 */
export interface ProfileConfiguration {
  /**
   * Identifier for the browser profile.
   */
  profileIdentifier: string
}

/**
 * Complete session configuration combining all optional session parameters.
 *
 * Convenience type for bundling proxy, extensions, profile, and viewport
 * configuration into a single object.
 *
 * @example
 * ```typescript
 * const config: SessionConfiguration = {
 *   viewport: { width: 1920, height: 1080 },
 *   proxyConfiguration: { proxies: [{ externalProxy: { server: 'proxy.example.com', port: 8080 } }] },
 *   extensions: [{ location: { s3: { bucket: 'my-bucket', prefix: 'ext.zip' } } }],
 *   profileConfiguration: { profileIdentifier: 'my-profile-id' },
 * }
 *
 * await browser.startSession({ sessionName: 'my-session', ...config })
 * ```
 */
export interface SessionConfiguration {
  viewport?: ViewportConfig
  proxyConfiguration?: ProxyConfiguration
  extensions?: BrowserExtension[]
  profileConfiguration?: ProfileConfiguration
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
 * Parameters for updating the browser automation stream.
 */
export interface UpdateStreamParams {
  /**
   * Browser identifier.
   * Uses current instance identifier if not provided.
   */
  browserId?: string

  /**
   * Session ID.
   * Uses current active session ID if not provided.
   */
  sessionId?: string

  /**
   * New stream status for the automation stream.
   * 'ENABLED' to enable the stream, 'DISABLED' to disable it.
   */
  streamStatus: 'ENABLED' | 'DISABLED'
}

/**
 * Response from updating a browser stream.
 */
export interface UpdateStreamResponse {
  /**
   * Stream endpoint URL.
   */
  streamEndpoint?: string

  /**
   * Updated stream status.
   */
  streamStatus?: string
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
