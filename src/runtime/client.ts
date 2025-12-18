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
} from './types.js'
import { DEFAULT_PRESIGNED_URL_TIMEOUT, MAX_PRESIGNED_URL_TIMEOUT } from './types.js'

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

  /**
   * Builds WebSocket URL with query parameters.
   *
   * @param runtimeArn - Full runtime ARN
   * @param endpointName - Optional endpoint name for qualifier param
   * @param customHeaders - Optional custom query parameters
   * @returns WebSocket URL with query parameters
   *
   * @internal
   */
  private _buildWebSocketUrl(
    runtimeArn: string,
    endpointName?: string,
    customHeaders?: Record<string, string>
  ): string {
    // Get the data plane endpoint and build base URL
    const endpoint = getDataPlaneEndpoint(this.region)
    const encodedArn = encodeURIComponent(runtimeArn)
    const url = new URL(`${endpoint}/runtimes/${encodedArn}/ws`)

    // Add query parameters
    if (endpointName) {
      url.searchParams.set('qualifier', endpointName)
    }

    if (customHeaders) {
      Object.entries(customHeaders).forEach(([key, value]) => {
        url.searchParams.set(key, value)
      })
    }

    // Convert to WebSocket URL
    return url.toString().replace('https://', 'wss://')
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

    const credentials = await this.credentialsProvider()
    if (!credentials) {
      throw new Error('No AWS credentials found')
    }

    // Create and sign the request
    const url = new URL(wsUrl.replace('wss://', 'https://'))
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

    // Return WebSocket connection with signed headers + WebSocket upgrade headers
    return {
      url: wsUrl,
      headers: {
        ...signedRequest.headers,
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
    // Validate expires parameter
    const expires = params.expires ?? DEFAULT_PRESIGNED_URL_TIMEOUT
    if (expires > MAX_PRESIGNED_URL_TIMEOUT) {
      throw new Error(`Expiry timeout cannot exceed ${MAX_PRESIGNED_URL_TIMEOUT} seconds, got ${expires}`)
    }

    // Validate ARN
    this._parseRuntimeArn(params.runtimeArn)

    // Auto-generate session ID if not provided
    const sessionId = params.sessionId ?? randomUUID()

    // Build minimal WebSocket URL without any custom parameters
    // This should match the working presigned URL format
    const wsUrl = this._buildWebSocketUrl(params.runtimeArn, params.endpointName, {
      ...params.customHeaders,
      'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': sessionId,
    })

    // Convert wss:// to https:// for signing
    const httpsUrl = wsUrl.replace('wss://', 'https://')

    const url = new URL(httpsUrl)

    // Get AWS credentials
    const credentials = await this.credentialsProvider()
    if (!credentials) {
      throw new Error('No AWS credentials found')
    }

    // Create minimal request to sign - separate path and query for presigned URLs
    const request = new HttpRequest({
      method: 'GET',
      protocol: 'https:',
      hostname: url.hostname,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: {
        host: url.hostname,
      },
    })

    // Sign the request with SigV4 (presigned URL style) following the exact pattern
    const signer = new SignatureV4({
      credentials,
      region: this.region,
      service: 'bedrock-agentcore',
      sha256: Sha256,
    })

    const signedRequest = await signer.presign(request, { expiresIn: expires })

    // Construct the full signed URL with query parameters
    let presignedUrl = `${signedRequest.protocol}//${signedRequest.hostname}${signedRequest.path}`

    // Add the signature query parameters
    if (signedRequest.query) {
      const existingParams = presignedUrl.includes('?') ? '&' : '?'
      const queryString = Object.entries(signedRequest.query)
        .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
        .join('&')
      presignedUrl += existingParams + queryString
    }

    // Convert signed URL from https:// back to wss://
    const presignedWsUrl = presignedUrl.replace('https://', 'wss://')

    return presignedWsUrl
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
    const httpsUrl = wsUrl.replace('wss://', 'https://')
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
