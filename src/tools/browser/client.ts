import {
  BedrockAgentCoreClient,
  StartBrowserSessionCommand,
  type StartBrowserSessionCommandInput,
  StopBrowserSessionCommand,
  GetBrowserSessionCommand,
  ListBrowserSessionsCommand,
  UpdateBrowserStreamCommand,
} from '@aws-sdk/client-bedrock-agentcore'
import { fromNodeProviderChain } from '@aws-sdk/credential-providers'
import type { AwsCredentialIdentityProvider } from '@aws-sdk/types'
import { HttpRequest } from '@smithy/protocol-http'
import { SignatureV4 } from '@smithy/signature-v4'
import { Sha256 } from '@aws-crypto/sha256-js'
import type {
  BrowserClientConfig,
  SessionInfo,
  StartSessionParams,
  WebSocketConnection,
  GetSessionParams,
  GetSessionResponse,
  ListSessionsParams,
  ListSessionsResponse,
  SessionSummary,
  UpdateStreamParams,
  UpdateStreamResponse,
  BrowserSessionStreams,
} from './types.js'
import { DEFAULT_IDENTIFIER, DEFAULT_SESSION_NAME, DEFAULT_TIMEOUT, DEFAULT_REGION } from './types.js'

/**
 * Base client for AWS Bedrock AgentCore Browser service.
 *
 * Provides core AWS SDK operations for browser session management and WebSocket connectivity.
 * This client handles session lifecycle and authentication but does not include browser
 * automation methods. Use PlaywrightBrowser for full browser automation capabilities.
 *
 * @example
 * ```typescript
 * const browser = new Browser({ region: 'us-east-1' })
 *
 * // Start a session
 * const session = await browser.startSession({ sessionName: 'my-session' })
 *
 * // Get WebSocket URL for custom browser integration
 * const wsConnection = await browser.generateWebSocketUrl()
 *
 * // Stop the session
 * await browser.stopSession()
 * ```
 */
export class Browser {
  readonly region: string
  readonly identifier: string

  protected _client: BedrockAgentCoreClient
  protected _session: SessionInfo | null = null
  private _credentialsProvider: AwsCredentialIdentityProvider | undefined = undefined

  /**
   * Creates a new BrowserClient instance.
   *
   * @param config - Configuration options for the client
   */
  constructor(config: BrowserClientConfig) {
    this.region = config.region ?? process.env.AWS_REGION ?? DEFAULT_REGION
    this.identifier = config.identifier ?? DEFAULT_IDENTIFIER
    this._credentialsProvider = config.credentialsProvider

    this._client = new BedrockAgentCoreClient({
      region: this.region,
      ...(this._credentialsProvider && { credentials: this._credentialsProvider }),
    })
  }

  // ===========================
  // Session Management
  // ===========================

  /**
   * Starts a new browser session.
   *
   * @param params - Optional parameters for session configuration
   * @returns Information about the started session
   *
   * @throws Error if a session is already active
   */
  async startSession(params?: StartSessionParams): Promise<SessionInfo> {
    if (this._session) {
      throw new Error('Session already active. Call stopSession() first.')
    }

    const sessionName = params?.sessionName ?? DEFAULT_SESSION_NAME
    const sessionTimeoutSeconds = params?.timeout ?? DEFAULT_TIMEOUT

    // Prepare command input
    // Our SDK types (ProxyEntry, BypassConfig, ProfileConfiguration) are convenience wrappers
    // over the tagged-union shapes in @aws-sdk/client-bedrock-agentcore (Proxy, ProxyBypass,
    // BrowserProfileConfiguration). The wire format is identical, so the assertion is safe.
    const input = {
      browserIdentifier: this.identifier,
      name: sessionName,
      sessionTimeoutSeconds: sessionTimeoutSeconds,
      viewPort: params?.viewport
        ? {
            width: params.viewport.width,
            height: params.viewport.height,
          }
        : undefined,
      ...(params?.proxyConfiguration && { proxyConfiguration: params.proxyConfiguration }),
      ...(params?.extensions && { extensions: params.extensions }),
      ...(params?.profileConfiguration && { profileConfiguration: params.profileConfiguration }),
    } as StartBrowserSessionCommandInput

    // Start the session
    const command = new StartBrowserSessionCommand(input)
    const response = await this._client.send(command)

    // Store session info
    const sessionInfo: SessionInfo = {
      sessionName,
      sessionId: response.sessionId!,
      createdAt: response.createdAt ?? new Date(),
    }

    this._session = sessionInfo

    return sessionInfo
  }

  /**
   * Stops the active browser session.
   *
   * @throws Error if no session is active
   */
  async stopSession(): Promise<void> {
    if (!this._session) {
      // Silently succeed if no session (idempotent)
      return
    }

    // Stop the AWS session
    const command = new StopBrowserSessionCommand({
      browserIdentifier: this.identifier,
      sessionId: this._session.sessionId,
    })

    await this._client.send(command)

    // Clear session state
    this._session = null
  }

  /**
   * Get detailed information about a browser session.
   *
   * @param params - Optional parameters specifying which session to query
   * @returns Detailed session information
   *
   * @example
   * ```typescript
   * // Get current active session details
   * const sessionInfo = await browser.getSession()
   * console.log(`Session status: ${sessionInfo.status}`)
   *
   * // Get details for a specific session
   * const sessionInfo = await browser.getSession({
   *   sessionId: 'specific-session-id'
   * })
   * ```
   */
  async getSession(params?: GetSessionParams): Promise<GetSessionResponse> {
    const browserId = params?.browserId ?? this.identifier
    const sessionId = params?.sessionId ?? this._session?.sessionId

    if (!browserId || !sessionId) {
      throw new Error(
        'Browser ID and Session ID must be provided or available from current session. ' +
          'Start a session first or provide explicit IDs.'
      )
    }

    const command = new GetBrowserSessionCommand({
      browserIdentifier: browserId,
      sessionId,
    })

    const response = await this._client.send(command)

    // Parse streams if present - using type extension for fields not in SDK types yet
    const responseWithExtras = response as typeof response & {
      lastUpdatedAt?: Date
      streams?: {
        automationStream?: {
          streamEndpoint?: string
          streamStatus?: string
        }
        liveViewStream?: {
          streamEndpoint?: string
        }
      }
    }

    const responseData: GetSessionResponse = {
      sessionId: response.sessionId!,
      browserIdentifier: response.browserIdentifier!,
      name: response.name!,
      status: response.status ?? 'UNKNOWN',
      createdAt: response.createdAt!,
      lastUpdatedAt: responseWithExtras.lastUpdatedAt ?? response.createdAt!,
      sessionTimeoutSeconds: response.sessionTimeoutSeconds!,
    }

    // Add streams if present
    if (responseWithExtras.streams) {
      const streams: BrowserSessionStreams = {}

      const autoStream = responseWithExtras.streams.automationStream
      if (autoStream?.streamEndpoint) {
        const streamInfo: import('./types.js').StreamInfo = {
          streamEndpoint: autoStream.streamEndpoint,
        }
        if (autoStream.streamStatus) {
          streamInfo.streamStatus = autoStream.streamStatus
        }
        streams.automationStream = streamInfo
      }

      const liveStream = responseWithExtras.streams.liveViewStream
      if (liveStream?.streamEndpoint) {
        streams.liveViewStream = {
          streamEndpoint: liveStream.streamEndpoint,
        }
      }

      responseData.streams = streams
    }

    return responseData
  }

  /**
   * List browser sessions for this browser.
   *
   * @param params - Optional filtering and pagination parameters
   * @returns List of session summaries with optional pagination token
   *
   * @example
   * ```typescript
   * // List all active sessions
   * const response = await browser.listSessions({ status: 'READY' })
   * for (const session of response.items) {
   *   console.log(`Session ${session.sessionId}: ${session.status}`)
   * }
   *
   * // Paginate through results
   * let response = await browser.listSessions({ maxResults: 10 })
   * while (response.nextToken) {
   *   response = await browser.listSessions({
   *     maxResults: 10,
   *     nextToken: response.nextToken
   *   })
   * }
   * ```
   */
  async listSessions(params?: ListSessionsParams): Promise<ListSessionsResponse> {
    const browserId = params?.browserId ?? this.identifier

    if (!browserId) {
      throw new Error('Browser ID must be provided or available from configuration')
    }

    const command = new ListBrowserSessionsCommand({
      browserIdentifier: browserId,
      ...(params?.status && {
        status: params.status as unknown as import('@aws-sdk/client-bedrock-agentcore').BrowserSessionStatus,
      }),
      ...(params?.maxResults && { maxResults: params.maxResults }),
      ...(params?.nextToken && { nextToken: params.nextToken }),
    })

    const response = await this._client.send(command)

    const items: SessionSummary[] =
      response.items?.map((item) => ({
        sessionId: item.sessionId!,
        name: item.name!,
        status: item.status ?? 'UNKNOWN',
        createdAt: item.createdAt!,
        lastUpdatedAt: item.lastUpdatedAt!,
      })) ?? []

    return {
      items,
      ...(response.nextToken && { nextToken: response.nextToken }),
    }
  }

  /**
   * Update the browser automation stream status.
   *
   * @param params - Stream update parameters
   * @returns Updated stream information
   *
   * @example
   * ```typescript
   * // Enable automation stream
   * const result = await browser.updateBrowserStream({
   *   streamStatus: 'ENABLED'
   * })
   *
   * // Disable automation stream
   * await browser.updateBrowserStream({
   *   streamStatus: 'DISABLED'
   * })
   * ```
   */
  async updateBrowserStream(params: UpdateStreamParams): Promise<UpdateStreamResponse> {
    const browserId = params.browserId ?? this.identifier
    const sessionId = params.sessionId ?? this._session?.sessionId

    if (!browserId || !sessionId) {
      throw new Error(
        'Browser ID and Session ID must be provided or available from current session. ' +
          'Start a session first or provide explicit IDs.'
      )
    }

    const command = new UpdateBrowserStreamCommand({
      browserIdentifier: browserId,
      sessionId,
      streamUpdate: {
        automationStreamUpdate: {
          streamStatus: params.streamStatus,
        },
      },
    })

    const response = await this._client.send(command)

    // Extract the updated stream information from the response
    const automationStream = response.streams?.automationStream
    const result: UpdateStreamResponse = {}

    if (automationStream?.streamEndpoint) {
      result.streamEndpoint = automationStream.streamEndpoint
    }
    if (automationStream?.streamStatus) {
      result.streamStatus = automationStream.streamStatus
    }

    return result
  }

  /**
   * Generates a WebSocket URL and authentication headers for browser automation.
   * Uses AWS Signature Version 4 to sign the WebSocket connection request.
   *
   * @returns WebSocket connection details with URL and authentication headers
   *
   * @throws Error if no session is active
   */
  async generateWebSocketUrl(): Promise<WebSocketConnection> {
    if (!this._session) {
      throw new Error('No active session. Call startSession() first.')
    }

    // Construct WebSocket URL
    const host = `bedrock-agentcore.${this.region}.amazonaws.com`
    const path = `/browser-streams/${this.identifier}/sessions/${this._session.sessionId}/automation`
    const wsUrl = `wss://${host}${path}`

    // Obtain AWS credentials for SigV4 signing of WebSocket connection
    // Use provided credentials or fall back to default chain
    const credentialsProvider = this._credentialsProvider ?? fromNodeProviderChain()
    const credentials = await credentialsProvider()

    // Create HTTP request for signing
    const request = new HttpRequest({
      protocol: 'wss:',
      hostname: host,
      path,
      method: 'GET',
      headers: {
        host,
      },
    })

    // Sign the request using SigV4
    const signer = new SignatureV4({
      service: 'bedrock-agentcore',
      region: this.region,
      credentials,
      sha256: Sha256,
    })

    const signedRequest = await signer.sign(request)

    // Extract headers for WebSocket connection
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(signedRequest.headers)) {
      if (typeof value === 'string') {
        headers[key] = value
      }
    }

    return {
      url: wsUrl,
      headers,
    }
  }
}
