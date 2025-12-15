import { fromNodeProviderChain } from '@aws-sdk/credential-providers'
import type { AwsCredentialIdentityProvider } from '@aws-sdk/types'
import { HttpRequest } from '@smithy/protocol-http'
import { SignatureV4 } from '@smithy/signature-v4'
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
import { RuntimeArnSchema, DEFAULT_REGION, DEFAULT_PRESIGNED_URL_TIMEOUT, MAX_PRESIGNED_URL_TIMEOUT } from './types.js'

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
   */
  constructor(config: RuntimeClientConfig = {}) {
    this.region = config.region ?? process.env.AWS_REGION ?? DEFAULT_REGION
    this.credentialsProvider = config.credentialsProvider ?? fromNodeProviderChain()
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
  private parseRuntimeArn(runtimeArn: string): ParsedRuntimeArn {
    // Validate ARN format using Zod schema
    const validationResult = RuntimeArnSchema.safeParse(runtimeArn)
    if (!validationResult.success) {
      throw new Error(`Invalid runtime ARN format: ${runtimeArn}`)
    }

    // Expected format: arn:aws:bedrock-agentcore:{region}:{account}:runtime/{runtime_id}
    const parts = runtimeArn.split(':')

    if (parts.length !== 6) {
      throw new Error(`Invalid runtime ARN format: ${runtimeArn}`)
    }

    if (parts[0] !== 'arn' || parts[1] !== 'aws' || parts[2] !== 'bedrock-agentcore') {
      throw new Error(`Invalid runtime ARN format: ${runtimeArn}`)
    }

    // Parse the resource part (runtime/{runtime_id})
    const resource = parts[5]
    if (!resource || !resource.startsWith('runtime/')) {
      throw new Error(`Invalid runtime ARN format: ${runtimeArn}`)
    }

    const runtimeId = resource.substring('runtime/'.length)

    // Validate that components are not empty
    const region = parts[3]
    const accountId = parts[4]

    if (!region || !accountId || !runtimeId) {
      throw new Error('ARN components cannot be empty')
    }

    return {
      region,
      accountId,
      runtimeId,
    }
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
  private buildWebSocketUrl(runtimeArn: string, endpointName?: string, customHeaders?: Record<string, string>): string {
    // Get the data plane endpoint
    const endpoint = getDataPlaneEndpoint(this.region)
    const host = endpoint.replace('https://', '')

    // URL-encode the runtime ARN
    const encodedArn = encodeURIComponent(runtimeArn)

    // Build base path
    const path = `/runtimes/${encodedArn}/ws`

    // Build query parameters
    const queryParams: Record<string, string> = {}

    if (endpointName) {
      queryParams.qualifier = endpointName
    }

    if (customHeaders) {
      Object.assign(queryParams, customHeaders)
    }

    // Construct URL
    let wsUrl = `wss://${host}${path}`

    if (Object.keys(queryParams).length > 0) {
      // eslint-disable-next-line no-undef
      const queryString = new URLSearchParams(queryParams).toString()
      wsUrl += `?${queryString}`
    }

    return wsUrl
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
    // Validate ARN
    this.parseRuntimeArn(params.runtimeArn)

    // Auto-generate session ID if not provided
    const sessionId = params.sessionId ?? randomUUID()

    // Build WebSocket URL
    const wsUrl = this.buildWebSocketUrl(params.runtimeArn, params.endpointName)

    // Get AWS credentials
    const credentials = await this.credentialsProvider()
    if (!credentials) {
      throw new Error('No AWS credentials found')
    }

    // Convert wss:// to https:// for signing
    const httpsUrl = wsUrl.replace('wss://', 'https://')
    // eslint-disable-next-line no-undef
    const url = new URL(httpsUrl)

    // Create the request to sign
    const request = new HttpRequest({
      protocol: 'https:',
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        host: url.hostname,
      },
    })

    // Sign the request with SigV4
    const signer = new SignatureV4({
      service: 'bedrock-agentcore',
      region: this.region,
      credentials,
      sha256: Sha256,
    })

    const signedRequest = await signer.sign(request)

    // Build headers for WebSocket connection
    const headers: Record<string, string> = {
      Host: url.hostname,
      Authorization: signedRequest.headers.authorization as string,
      'X-Amz-Date': signedRequest.headers['x-amz-date'] as string,
      'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': sessionId,
    }

    // Add session token if present
    if (credentials.sessionToken) {
      headers['X-Amz-Security-Token'] = credentials.sessionToken
    }

    return {
      url: wsUrl,
      headers,
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
    this.parseRuntimeArn(params.runtimeArn)

    // Auto-generate session ID if not provided
    const sessionId = params.sessionId ?? randomUUID()

    // Add session ID to custom headers (which become query params)
    const customHeaders = { ...params.customHeaders }
    customHeaders['X-Amzn-Bedrock-AgentCore-Runtime-Session-Id'] = sessionId

    // Build WebSocket URL with query parameters
    const wsUrl = this.buildWebSocketUrl(params.runtimeArn, params.endpointName, customHeaders)

    // Convert wss:// to https:// for signing
    const httpsUrl = wsUrl.replace('wss://', 'https://')
    // eslint-disable-next-line no-undef
    const url = new URL(httpsUrl)

    // Get AWS credentials
    const credentials = await this.credentialsProvider()
    if (!credentials) {
      throw new Error('No AWS credentials found')
    }

    // Create the request to sign
    const request = new HttpRequest({
      protocol: 'https:',
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        host: url.hostname,
      },
    })

    // Sign the request with SigV4 (presigned URL style)
    const signer = new SignatureV4({
      service: 'bedrock-agentcore',
      region: this.region,
      credentials,
      sha256: Sha256,
    })

    const signedRequest = await signer.presign(request, { expiresIn: expires })

    // Convert signed URL from https:// back to wss://
    const signedUrl = `${signedRequest.protocol}//${signedRequest.hostname}${signedRequest.path}`
    const presignedWsUrl = signedUrl.replace('https://', 'wss://')

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
    this.parseRuntimeArn(params.runtimeArn)

    // Auto-generate session ID if not provided
    const sessionId = params.sessionId ?? randomUUID()

    // Build WebSocket URL
    const wsUrl = this.buildWebSocketUrl(params.runtimeArn, params.endpointName)

    // Convert wss:// to https:// to get host
    const httpsUrl = wsUrl.replace('wss://', 'https://')
    // eslint-disable-next-line no-undef
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
