import { Buffer } from 'buffer'
import { defaultProvider } from '@aws-sdk/credential-provider-node'
import type { AwsCredentialIdentityProvider } from '@aws-sdk/types'
import { HttpRequest } from '@aws-sdk/protocol-http'
import { SignatureV4 } from '@aws-sdk/signature-v4'
import { Sha256 } from '@aws-crypto/sha256-js'
import { randomUUID, randomBytes } from 'crypto'
import { getDataPlaneEndpoint } from '../_utils/endpoints.js'
import type {
  RuntimeClientConfig,
  GenerateWsConnectionParams,
  GeneratePresignedUrlParams,
  GenerateWsConnectionOAuthParams,
  WebSocketConnection,
  ParsedRuntimeArn,
  OpenShellParams,
  ConnectShellSigV4Params,
  ConnectShellPresignedParams,
  ConnectShellOAuthParams,
  ShellConnectionSigV4,
  ShellConnectionPresigned,
  ShellConnectionOAuth,
} from './types.js'
import { DEFAULT_PRESIGNED_URL_TIMEOUT, MAX_PRESIGNED_URL_TIMEOUT } from './types.js'
import { ShellSession } from './shell/session.js'
import { validateShellId } from './shell/validation.js'

/**
 * Client for generating WebSocket authentication for AgentCore Runtime.
 *
 * This client provides authentication credentials for WebSocket connections
 * to AgentCore Runtime endpoints, allowing applications to establish
 * bidirectional streaming connections with agent runtimes.
 *
 * The client is stateless and does not manage session lifecycle. Each method
 * call is independent and takes the runtime ARN as a parameter.
 *
 * @example
 * ```typescript
 * const client = new RuntimeClient({ region: 'us-west-2' })
 *
 * // Generate WebSocket connection with SigV4 headers
 * const { url, headers } = await client.generateWsConnection({
 *   runtimeArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/my-runtime',
 *   endpointName: 'DEFAULT'
 * })
 *
 * // Generate presigned WebSocket URL
 * const presignedUrl = await client.generatePresignedUrl({
 *   runtimeArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/my-runtime',
 *   expires: 300
 * })
 * ```
 */
export class RuntimeClient {
  readonly region: string
  private readonly credentialsProvider: AwsCredentialIdentityProvider

  /**
   * Creates a new RuntimeClient instance.
   *
   * @param config - Configuration options for the client
   * @throws Error if region is not provided via config or AWS_REGION environment variable
   */
  constructor(config: RuntimeClientConfig = {}) {
    const region = config.region ?? process.env.AWS_REGION
    if (!region || !region.trim()) {
      throw new Error('Region must be provided via config.region or AWS_REGION environment variable')
    }
    this.region = region
    this.credentialsProvider = config.credentialsProvider ?? defaultProvider()
  }

  /**
   * Parses runtime ARN and extracts components.
   *
   * @param runtimeArn - Full runtime ARN
   * @returns Parsed ARN components
   * @throws Error if ARN format is invalid
   *
   * @internal
   */
  private _parseAndValidateRegion(runtimeArn: string): ParsedRuntimeArn {
    const parsed = this._parseRuntimeArn(runtimeArn)
    if (parsed.region !== this.region) {
      throw new Error(
        `ARN region ${parsed.region} does not match client region ${this.region}. ` +
          `Create a client for the same region as the runtime ARN, or use the ARN's region.`
      )
    }
    return parsed
  }

  private _parseRuntimeArn(runtimeArn: string): ParsedRuntimeArn {
    const arnRegex = /^arn:aws:bedrock-agentcore:([^:]+):([^:]+):runtime\/(.+)$/
    const match = runtimeArn.match(arnRegex)

    if (!match) {
      throw new Error(`Invalid runtime ARN format: ${runtimeArn}`)
    }

    const [, region, accountId, runtimeId] = match

    if (!region || !accountId || !runtimeId) {
      throw new Error('ARN components cannot be empty')
    }

    return { region, accountId, runtimeId }
  }

  /** @internal */
  private _buildWsUrl(path: string, queryParams?: Record<string, string>): string {
    const endpoint = getDataPlaneEndpoint(this.region)
    const url = new URL(`${endpoint}${path}`)
    if (queryParams) {
      Object.entries(queryParams).forEach(([k, v]) => url.searchParams.set(k, v))
    }
    return url.toString().replace(/^https:\/\//, 'wss://')
  }

  /** @internal */
  private _buildWebSocketUrl(
    runtimeArn: string,
    endpointName?: string,
    customHeaders?: Record<string, string>
  ): string {
    const encodedArn = encodeURIComponent(runtimeArn)
    return this._buildWsUrl(`/runtimes/${encodedArn}/ws`, {
      ...(endpointName ? { qualifier: endpointName } : {}),
      ...customHeaders,
    })
  }

  /**
   * Generates WebSocket URL and SigV4 signed headers for runtime connection.
   *
   * This method creates authentication credentials for establishing a WebSocket
   * connection to an AgentCore Runtime. The returned headers include AWS SigV4
   * signature for authentication.
   *
   * @param params - Parameters for generating the connection
   * @returns WebSocket URL and authentication headers
   *
   * @throws Error if runtime ARN format is invalid
   * @throws Error if AWS credentials are not available
   *
   * @example
   * ```typescript
   * const client = new RuntimeClient({ region: 'us-west-2' })
   *
   * // With auto-generated session ID
   * const { url, headers } = await client.generateWsConnection({
   *   runtimeArn: 'arn:aws:bedrock-agentcore:us-west-2:123:runtime/my-runtime'
   * })
   *
   * // With custom session ID and endpoint
   * const connection = await client.generateWsConnection({
   *   runtimeArn: 'arn:aws:bedrock-agentcore:us-west-2:123:runtime/my-runtime',
   *   sessionId: 'my-session-123',
   *   endpointName: 'DEFAULT'
   * })
   * ```
   */
  async generateWsConnection(params: GenerateWsConnectionParams): Promise<WebSocketConnection> {
    this._parseRuntimeArn(params.runtimeArn)
    const sessionId = params.sessionId ?? randomUUID()
    const wsUrl = this._buildWebSocketUrl(params.runtimeArn, params.endpointName)
    const signedHeaders = await this._sigV4SignWsUrl(wsUrl, sessionId)
    return {
      url: wsUrl,
      headers: {
        ...signedHeaders,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        'User-Agent': 'AgentCoreRuntimeClient/1.0',
      },
    }
  }

  /**
   * Generates a presigned WebSocket URL for runtime connection.
   *
   * Presigned URLs include authentication in query parameters, allowing
   * frontend clients to connect without managing AWS credentials.
   *
   * @param params - Parameters for generating the presigned URL
   * @returns Presigned WebSocket URL with authentication in query parameters
   *
   * @throws Error if expires exceeds maximum (300 seconds)
   * @throws Error if runtime ARN format is invalid
   * @throws Error if AWS credentials are not available
   *
   * @example
   * ```typescript
   * const client = new RuntimeClient({ region: 'us-west-2' })
   *
   * // Basic presigned URL
   * const url = await client.generatePresignedUrl({
   *   runtimeArn: 'arn:aws:bedrock-agentcore:us-west-2:123:runtime/my-runtime'
   * })
   *
   * // With custom parameters
   * const url = await client.generatePresignedUrl({
   *   runtimeArn: 'arn:aws:bedrock-agentcore:us-west-2:123:runtime/my-runtime',
   *   sessionId: 'my-session-123',
   *   endpointName: 'DEFAULT',
   *   customHeaders: { 'custom-param': 'value' },
   *   expires: 300
   * })
   * ```
   */
  async generatePresignedUrl(params: GeneratePresignedUrlParams): Promise<string> {
    const expires = params.expires ?? DEFAULT_PRESIGNED_URL_TIMEOUT
    if (expires > MAX_PRESIGNED_URL_TIMEOUT) {
      throw new Error(`Expiry timeout cannot exceed ${MAX_PRESIGNED_URL_TIMEOUT} seconds, got ${expires}`)
    }
    this._parseRuntimeArn(params.runtimeArn)
    const sessionId = params.sessionId ?? randomUUID()
    const wsUrl = this._buildWebSocketUrl(params.runtimeArn, params.endpointName, {
      ...params.customHeaders,
      'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': sessionId,
    })
    return this._presignWsUrl(wsUrl, expires)
  }

  /** @internal */
  private _buildShellUrl(runtimeArn: string, shellId: string, endpointName?: string): string {
    const encodedArn = encodeURIComponent(runtimeArn)
    return this._buildWsUrl(`/runtimes/${encodedArn}/ws/shells`, {
      shellId,
      ...(endpointName ? { qualifier: endpointName } : {}),
    })
  }

  /** Sign a wss:// URL with SigV4 headers, including the session ID. @internal */
  private async _sigV4SignWsUrl(wsUrl: string, sessionId: string): Promise<Record<string, string>> {
    const url = new URL(wsUrl.replace(/^wss:\/\//, 'https://'))
    const credentials = await this.credentialsProvider()
    if (!credentials) throw new Error('No AWS credentials found')
    const signedRequest = await new SignatureV4({
      credentials,
      region: this.region,
      service: 'bedrock-agentcore',
      sha256: Sha256,
    }).sign(
      new HttpRequest({
        protocol: 'https:',
        hostname: url.hostname,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        method: 'GET',
        headers: {
          host: url.hostname,
          'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': sessionId,
        },
      })
    )
    return signedRequest.headers as Record<string, string>
  }

  /** Presign a wss:// URL, embedding auth in query params. @internal */
  private async _presignWsUrl(wsUrl: string, expires: number): Promise<string> {
    const url = new URL(wsUrl.replace(/^wss:\/\//, 'https://'))
    const credentials = await this.credentialsProvider()
    if (!credentials) throw new Error('No AWS credentials found')
    const signed = await new SignatureV4({
      credentials,
      region: this.region,
      service: 'bedrock-agentcore',
      sha256: Sha256,
    }).presign(
      new HttpRequest({
        method: 'GET',
        protocol: 'https:',
        hostname: url.hostname,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        headers: { host: url.hostname },
      }),
      { expiresIn: expires }
    )
    let presignedUrl = `${signed.protocol}//${signed.hostname}${signed.path}`
    if (signed.query) {
      const qs = Object.entries(signed.query)
        .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
        .join('&')
      presignedUrl += (presignedUrl.includes('?') ? '&' : '?') + qs
    }
    return presignedUrl.replace(/^https:\/\//, 'wss://')
  }

  /**
   * Generate a SigV4-signed WebSocket URL and headers for a shell connection.
   * Low-level helper — use `openShell` for a fully managed session.
   *
   * @example
   * ```typescript
   * const { url, headers } = await client.connectShellSigV4({ runtimeArn, shellId, sessionId })
   * const ws = new WebSocket(url, { headers })
   * ```
   */
  async connectShellSigV4(params: ConnectShellSigV4Params): Promise<ShellConnectionSigV4> {
    validateShellId(params.shellId)
    this._parseAndValidateRegion(params.runtimeArn)
    const wsUrl = this._buildShellUrl(params.runtimeArn, params.shellId, params.endpointName)
    const headers = await this._sigV4SignWsUrl(wsUrl, params.sessionId)
    return { url: wsUrl, headers }
  }

  /**
   * Generate a presigned WebSocket URL for a shell connection. Auth is embedded
   * in the query string — suitable for browser clients or short-lived tokens.
   * Low-level helper — use `openShell` for a fully managed session.
   *
   * @example
   * ```typescript
   * const { url } = await client.connectShellPresigned({ runtimeArn, shellId, sessionId, expires: 120 })
   * const ws = new WebSocket(url)
   * ```
   */
  async connectShellPresigned(params: ConnectShellPresignedParams): Promise<ShellConnectionPresigned> {
    validateShellId(params.shellId)
    const expires = params.expires ?? DEFAULT_PRESIGNED_URL_TIMEOUT
    if (expires > MAX_PRESIGNED_URL_TIMEOUT) {
      throw new Error(`Expiry timeout cannot exceed ${MAX_PRESIGNED_URL_TIMEOUT} seconds, got ${expires}`)
    }
    this._parseAndValidateRegion(params.runtimeArn)
    const wsUrl = this._buildShellUrl(params.runtimeArn, params.shellId, params.endpointName)
    const urlWithSession = new URL(wsUrl)
    urlWithSession.searchParams.set('X-Amzn-Bedrock-AgentCore-Runtime-Session-Id', params.sessionId)
    return { url: await this._presignWsUrl(urlWithSession.toString(), expires) }
  }

  /**
   * Generate a WebSocket URL and OAuth subprotocols for a shell connection.
   * Low-level helper — use `openShell` for a fully managed session.
   *
   * @example
   * ```typescript
   * const { url, subprotocols } = await client.connectShellOAuth({ runtimeArn, shellId, sessionId, bearerToken })
   * const ws = new WebSocket(url, subprotocols)
   * ```
   */
  async connectShellOAuth(params: ConnectShellOAuthParams): Promise<ShellConnectionOAuth> {
    validateShellId(params.shellId)
    if (!params.bearerToken) throw new Error('bearerToken cannot be empty')
    this._parseAndValidateRegion(params.runtimeArn)
    const encoded = Buffer.from(params.bearerToken).toString('base64url')
    if (encoded.length > 4096) {
      throw new Error(
        `bearerToken too large to embed in Sec-WebSocket-Protocol (${encoded.length} chars encoded, max 4096)`
      )
    }
    const wsUrl = this._buildShellUrl(params.runtimeArn, params.shellId, params.endpointName)
    const url = new URL(wsUrl)
    url.searchParams.set('X-Amzn-Bedrock-AgentCore-Runtime-Session-Id', params.sessionId)
    return {
      url: url.toString(),
      subprotocols: [`base64UrlBearerAuthorization.${encoded}`, 'base64UrlBearerAuthorization'],
    }
  }

  /**
   * Open a fully managed interactive PTY shell session on an agent VM.
   *
   * Returns a connected `ShellSession` — an async iterable that yields `ShellFrame`
   * objects. Call `close()` when done, or use `try/finally`.
   *
   * For lower-level control (custom WebSocket handling, browser relay), use the
   * `connectShellSigV4`, `connectShellPresigned`, or `connectShellOAuth` helpers
   * directly with `ShellFramer`.
   *
   * @example
   * ```typescript
   * const shell = await client.openShell({ runtimeArn })
   * try {
   *   await shell.send('echo hello\n')
   *   for await (const frame of shell) {
   *     if (frame.channel === ShellChannel.STDOUT) process.stdout.write(frame.text)
   *   }
   * } finally {
   *   await shell.close()
   * }
   * ```
   *
   * @example Auto-reconnect:
   * ```typescript
   * const shell = await client.openShell({
   *   runtimeArn,
   *   shellId: 'debug',
   *   reconnectConfig: { maxRetries: 5, onReconnect: (r) => console.log('reconnected:', r) }
   * })
   * ```
   */
  async openShell(params: OpenShellParams): Promise<ShellSession> {
    this._parseAndValidateRegion(params.runtimeArn)
    if (params.shellId != null) validateShellId(params.shellId)

    // Generate stable IDs once — reused on every reconnect attempt.
    const shellId = params.shellId ?? randomUUID()
    const sessionId = params.sessionId ?? randomUUID()
    const auth = params.auth ?? 'sigv4'

    let connectFn: (
      shellId: string,
      sessionId: string
    ) => Promise<{ url: string; headers: Record<string, string>; protocols?: string[] }>

    if (auth === 'sigv4') {
      connectFn = async (
        sid: string,
        currentSessionId: string
      ): Promise<{ url: string; headers: Record<string, string>; protocols?: string[] }> => {
        const { url, headers } = await this.connectShellSigV4({
          runtimeArn: params.runtimeArn,
          shellId: sid,
          sessionId: currentSessionId,
          endpointName: params.endpointName,
        })
        return { url, headers }
      }
    } else if (typeof auth === 'object' && auth.type === 'presigned') {
      connectFn = async (
        sid: string,
        currentSessionId: string
      ): Promise<{ url: string; headers: Record<string, string>; protocols?: string[] }> => {
        const { url } = await this.connectShellPresigned({
          runtimeArn: params.runtimeArn,
          shellId: sid,
          sessionId: currentSessionId,
          endpointName: params.endpointName,
          expires: auth.expires,
        })
        return { url, headers: {} }
      }
    } else if (typeof auth === 'object' && auth.type === 'oauth') {
      connectFn = async (
        sid: string,
        currentSessionId: string
      ): Promise<{ url: string; headers: Record<string, string>; protocols?: string[] }> => {
        const { url, subprotocols } = await this.connectShellOAuth({
          runtimeArn: params.runtimeArn,
          shellId: sid,
          sessionId: currentSessionId,
          endpointName: params.endpointName,
          bearerToken: auth.bearerToken,
        })
        return { url, headers: {}, protocols: subprotocols }
      }
    } else {
      throw new Error(`Unknown auth mode: ${JSON.stringify(auth)}`)
    }

    const session = new ShellSession({
      connectFn,
      shellId,
      sessionId,
      reconnectConfig: params.reconnectConfig,
      keepaliveIntervalMs: params.keepaliveIntervalMs,
      logger: params.logger,
    })
    return session.connect()
  }

  /**
   * Generates WebSocket URL and OAuth headers for runtime connection.
   *
   * This method uses OAuth bearer token authentication instead of AWS SigV4.
   * Suitable for scenarios where OAuth tokens are used for authentication.
   * Does NOT require AWS credentials.
   *
   * @param params - Parameters for generating the connection
   * @returns WebSocket URL and OAuth authentication headers
   *
   * @throws Error if bearer token is empty
   * @throws Error if runtime ARN format is invalid
   *
   * @example
   * ```typescript
   * const client = new RuntimeClient({ region: 'us-west-2' })
   *
   * // With OAuth bearer token
   * const { url, headers } = await client.generateWsConnectionOAuth({
   *   runtimeArn: 'arn:aws:bedrock-agentcore:us-west-2:123:runtime/my-runtime',
   *   bearerToken: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...',
   *   endpointName: 'DEFAULT'
   * })
   *
   * // Use with WebSocket client
   * const ws = new WebSocket(url, { headers })
   * ```
   */
  async generateWsConnectionOAuth(params: GenerateWsConnectionOAuthParams): Promise<WebSocketConnection> {
    // Validate bearer token
    if (!params.bearerToken) {
      throw new Error('Bearer token cannot be empty')
    }

    // Validate ARN
    this._parseRuntimeArn(params.runtimeArn)

    // Auto-generate session ID if not provided
    const sessionId = params.sessionId ?? randomUUID()

    // Build WebSocket URL
    const wsUrl = this._buildWebSocketUrl(params.runtimeArn, params.endpointName)

    // Convert wss:// to https:// to get host
    const httpsUrl = wsUrl.replace(/^wss:\/\//, 'https://')
    const url = new URL(httpsUrl)

    // Generate WebSocket key (required for OAuth connections)
    const wsKey = randomBytes(16).toString('base64')

    // Build OAuth headers
    const headers: Record<string, string> = {
      Authorization: `Bearer ${params.bearerToken}`,
      'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': sessionId,
      Host: url.hostname,
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Key': wsKey,
      'Sec-WebSocket-Version': '13',
      'User-Agent': 'OAuth-WebSocket-Client/1.0',
    }

    return {
      url: wsUrl,
      headers,
    }
  }
}
