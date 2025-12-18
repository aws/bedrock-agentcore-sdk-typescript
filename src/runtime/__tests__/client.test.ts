import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { RuntimeClient } from '../client.js'
import type { WebSocketConnection } from '../types.js'

// Mock AWS credentials
const mockCredentials = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  sessionToken: 'mock-session-token',
}

// Mock the credential provider
vi.mock('@aws-sdk/credential-provider-node', () => ({
  defaultProvider: vi.fn(() => vi.fn(async () => mockCredentials)),
}))

// Mock crypto.randomUUID and randomBytes to return predictable values
vi.mock('crypto', () => ({
  randomUUID: vi.fn(() => 'test-session-uuid'),
  randomBytes: vi.fn((size: number) => Buffer.from('a'.repeat(size))),
}))

// Mock SignatureV4 from @aws-sdk/signature-v4
vi.mock('@aws-sdk/signature-v4', () => ({
  SignatureV4: vi.fn(function (this: any) {
    this.sign = vi.fn(async (request: any) => ({
      ...request,
      headers: {
        ...request.headers,
        Authorization:
          'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20240101/us-west-2/bedrock-agentcore/aws4_request, SignedHeaders=host;x-amz-date, Signature=mock-signature',
        'X-Amz-Date': '20240101T120000Z',
        'X-Amz-Security-Token': mockCredentials.sessionToken,
        Host: request.headers.host,
      },
    }))
    this.presign = vi.fn(async (request: any, options: any) => {
      const url = new URL(`${request.protocol}//${request.hostname}${request.path}`)
      url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256')
      url.searchParams.set('X-Amz-Credential', 'AKIAIOSFODNN7EXAMPLE/20240101/us-west-2/bedrock-agentcore/aws4_request')
      url.searchParams.set('X-Amz-Date', '20240101T120000Z')
      url.searchParams.set('X-Amz-Expires', String(options.expiresIn))
      url.searchParams.set('X-Amz-SignedHeaders', 'host')
      url.searchParams.set('X-Amz-Signature', 'mock-presigned-signature')
      if (mockCredentials.sessionToken) {
        url.searchParams.set('X-Amz-Security-Token', mockCredentials.sessionToken)
      }

      return {
        protocol: request.protocol,
        hostname: request.hostname,
        path: url.pathname + url.search,
        query: Object.fromEntries(url.searchParams.entries()),
      }
    })
    return this
  }),
}))

describe('RuntimeClient', () => {
  let client: RuntimeClient

  beforeEach(() => {
    client = new RuntimeClient({ region: 'us-west-2' })
    vi.clearAllMocks()
  })

  afterEach(() => {
    delete process.env.AWS_REGION
    delete process.env.BEDROCK_AGENTCORE_DATA_PLANE_ENDPOINT
  })

  describe('constructor', () => {
    it('creates client with provided region', () => {
      const testClient = new RuntimeClient({ region: 'us-east-1' })
      expect(testClient.region).toBe('us-east-1')
    })

    it('creates client with default region from environment', () => {
      process.env.AWS_REGION = 'eu-west-1'
      const testClient = new RuntimeClient({})
      expect(testClient.region).toBe('eu-west-1')
    })

    it('throws error when no region provided', () => {
      delete process.env.AWS_REGION
      expect(() => new RuntimeClient()).toThrow(
        'Region must be provided via config.region or AWS_REGION environment variable'
      )
    })

    it('creates client with custom credentials provider', () => {
      const customProvider = vi.fn(async () => mockCredentials)
      const testClient = new RuntimeClient({
        region: 'us-west-2',
        credentialsProvider: customProvider,
      })
      expect(testClient.region).toBe('us-west-2')
    })
  })

  describe('_parseRuntimeArn', () => {
    const validArn = 'arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/my-runtime-id'

    it('parses valid ARN successfully', () => {
      // Access private method through type assertion
      const parsed = (client as any)._parseRuntimeArn(validArn)
      expect(parsed).toEqual({
        region: 'us-west-2',
        accountId: '123456789012',
        runtimeId: 'my-runtime-id',
      })
    })

    it('throws error for invalid ARN format (wrong structure)', () => {
      const invalidArn = 'invalid-arn'
      expect(() => (client as any)._parseRuntimeArn(invalidArn)).toThrow('Invalid runtime ARN format')
    })

    it('throws error for wrong service name', () => {
      const wrongService = 'arn:aws:s3:us-west-2:123456789012:runtime/my-runtime-id'
      expect(() => (client as any)._parseRuntimeArn(wrongService)).toThrow('Invalid runtime ARN format')
    })

    it('throws error for wrong resource type', () => {
      const wrongResource = 'arn:aws:bedrock-agentcore:us-west-2:123456789012:bucket/my-bucket'
      expect(() => (client as any)._parseRuntimeArn(wrongResource)).toThrow('Invalid runtime ARN format')
    })

    it('throws error for missing region', () => {
      const missingRegion = 'arn:aws:bedrock-agentcore::123456789012:runtime/my-runtime-id'
      expect(() => (client as any)._parseRuntimeArn(missingRegion)).toThrow()
    })

    it('throws error for missing account ID', () => {
      const missingAccount = 'arn:aws:bedrock-agentcore:us-west-2::runtime/my-runtime-id'
      expect(() => (client as any)._parseRuntimeArn(missingAccount)).toThrow()
    })

    it('throws error for missing runtime ID', () => {
      const missingRuntimeId = 'arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/'
      expect(() => (client as any)._parseRuntimeArn(missingRuntimeId)).toThrow()
    })
  })

  describe('_buildWebSocketUrl', () => {
    const testArn = 'arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/my-runtime-id'

    it('builds URL with no query parameters', () => {
      const url = (client as any)._buildWebSocketUrl(testArn)
      expect(url).toMatch(/^wss:\/\/bedrock-agentcore\.us-west-2\.amazonaws\.com\/runtimes\//)
      expect(url).toContain(encodeURIComponent(testArn))
      expect(url).toContain('/ws')
      expect(url).not.toContain('?')
    })

    it('builds URL with endpoint_name (qualifier)', () => {
      const url = (client as any)._buildWebSocketUrl(testArn, 'DEFAULT')
      expect(url).toContain('?qualifier=DEFAULT')
    })

    it('builds URL with custom headers', () => {
      const customHeaders = { customParam: 'value1', anotherParam: 'value2' }
      const url = (client as any)._buildWebSocketUrl(testArn, undefined, customHeaders)
      expect(url).toContain('?')
      expect(url).toContain('customParam=value1')
      expect(url).toContain('anotherParam=value2')
    })

    it('builds URL with both endpoint_name and custom headers', () => {
      const customHeaders = { customParam: 'value' }
      const url = (client as any)._buildWebSocketUrl(testArn, 'DEFAULT', customHeaders)
      expect(url).toContain('?')
      expect(url).toContain('qualifier=DEFAULT')
      expect(url).toContain('customParam=value')
    })

    it('properly encodes runtime ARN in path', () => {
      const url = (client as any)._buildWebSocketUrl(testArn)
      const encodedArn = encodeURIComponent(testArn)
      expect(url).toContain(`/runtimes/${encodedArn}/ws`)
    })

    it('uses custom endpoint from environment variable', () => {
      process.env.BEDROCK_AGENTCORE_DATA_PLANE_ENDPOINT = 'https://custom-endpoint.example.com'
      const url = (client as any)._buildWebSocketUrl(testArn)
      expect(url).toContain('wss://custom-endpoint.example.com/runtimes/')
    })
  })

  describe('generateWsConnection', () => {
    const validArn = 'arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/my-runtime-id'

    it('generates URL and headers with valid ARN', async () => {
      const result: WebSocketConnection = await client.generateWsConnection({
        runtimeArn: validArn,
      })

      expect(result.url).toMatch(/^wss:\/\//)
      expect(result.url).toContain('bedrock-agentcore.us-west-2.amazonaws.com')
      expect(result.headers).toBeDefined()
      expect(result.headers.Host).toBe('bedrock-agentcore.us-west-2.amazonaws.com')
      expect(result.headers.Authorization).toContain('AWS4-HMAC-SHA256')
      expect(result.headers['X-Amz-Date']).toBeDefined()
      expect(result.headers['X-Amzn-Bedrock-AgentCore-Runtime-Session-Id']).toBeDefined()
    })

    it('auto-generates session ID when not provided', async () => {
      const result = await client.generateWsConnection({
        runtimeArn: validArn,
      })

      expect(result.headers['X-Amzn-Bedrock-AgentCore-Runtime-Session-Id']).toBe('test-session-uuid')
    })

    it('uses provided session ID', async () => {
      const result = await client.generateWsConnection({
        runtimeArn: validArn,
        sessionId: 'custom-session-id',
      })

      expect(result.headers['X-Amzn-Bedrock-AgentCore-Runtime-Session-Id']).toBe('custom-session-id')
    })

    it('includes endpoint_name as qualifier query parameter', async () => {
      const result = await client.generateWsConnection({
        runtimeArn: validArn,
        endpointName: 'DEFAULT',
      })

      expect(result.url).toContain('?qualifier=DEFAULT')
    })

    it('includes required SigV4 headers', async () => {
      const result = await client.generateWsConnection({
        runtimeArn: validArn,
      })

      expect(result.headers.Host).toBeDefined()
      expect(result.headers.Authorization).toBeDefined()
      expect(result.headers['X-Amz-Date']).toBeDefined()
    })

    it('includes WebSocket upgrade headers', async () => {
      const result = await client.generateWsConnection({
        runtimeArn: validArn,
      })

      expect(result.headers.Connection).toBe('Upgrade')
      expect(result.headers.Upgrade).toBe('websocket')
      expect(result.headers['Sec-WebSocket-Version']).toBe('13')
    })

    it('includes X-Amz-Security-Token when session token present', async () => {
      const result = await client.generateWsConnection({
        runtimeArn: validArn,
      })

      expect(result.headers['X-Amz-Security-Token']).toBe('mock-session-token')
    })

    it('includes Sec-WebSocket-Key', async () => {
      const result = await client.generateWsConnection({
        runtimeArn: validArn,
      })

      expect(result.headers['Sec-WebSocket-Key']).toBeDefined()
    })

    it('throws error for invalid ARN', async () => {
      await expect(
        client.generateWsConnection({
          runtimeArn: 'invalid-arn',
        })
      ).rejects.toThrow('Invalid runtime ARN format')
    })
  })

  describe('generatePresignedUrl', () => {
    const validArn = 'arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/my-runtime-id'

    it('generates presigned URL with valid ARN', async () => {
      const url = await client.generatePresignedUrl({
        runtimeArn: validArn,
      })

      expect(url).toMatch(/^wss:\/\//)
      expect(url).toContain('bedrock-agentcore.us-west-2.amazonaws.com')
      expect(url).toContain('X-Amz-Algorithm')
      expect(url).toContain('X-Amz-Credential')
      expect(url).toContain('X-Amz-Date')
      expect(url).toContain('X-Amz-Expires')
      expect(url).toContain('X-Amz-Signature')
    })

    it('generates presigned URL without session ID in query params', async () => {
      const url = await client.generatePresignedUrl({
        runtimeArn: validArn,
      })

      // Session ID is not included in presigned URLs based on current implementation
      expect(url).not.toContain('X-Amzn-Bedrock-AgentCore-Runtime-Session-Id')
    })

    it('generates presigned URL without custom session ID in query params', async () => {
      const url = await client.generatePresignedUrl({
        runtimeArn: validArn,
        sessionId: 'custom-session-id',
      })

      // Session ID is not included in presigned URLs based on current implementation
      expect(url).not.toContain('X-Amzn-Bedrock-AgentCore-Runtime-Session-Id')
    })

    it('generates presigned URL without session ID in query parameters', async () => {
      const url = await client.generatePresignedUrl({
        runtimeArn: validArn,
        sessionId: 'my-session-123',
      })

      // Session ID is not included in presigned URLs based on current implementation
      expect(url).not.toContain('X-Amzn-Bedrock-AgentCore-Runtime-Session-Id')
    })

    it('generates presigned URL without endpoint qualifier', async () => {
      const url = await client.generatePresignedUrl({
        runtimeArn: validArn,
        endpointName: 'DEFAULT',
      })

      // Endpoint name is not included in presigned URLs based on current implementation
      expect(url).not.toContain('qualifier=DEFAULT')
    })

    it('generates presigned URL without custom headers', async () => {
      const url = await client.generatePresignedUrl({
        runtimeArn: validArn,
        customHeaders: { customParam: 'value', anotherParam: 'value2' },
      })

      // Custom headers are not included in presigned URLs based on current implementation
      expect(url).not.toContain('customParam=value')
      expect(url).not.toContain('anotherParam=value2')
    })

    it('respects expires parameter (default 300)', async () => {
      const url = await client.generatePresignedUrl({
        runtimeArn: validArn,
      })

      expect(url).toContain('X-Amz-Expires=300')
    })

    it('respects custom expires parameter', async () => {
      const url = await client.generatePresignedUrl({
        runtimeArn: validArn,
        expires: 180,
      })

      expect(url).toContain('X-Amz-Expires=180')
    })

    it('throws error when expires exceeds MAX (300 seconds)', async () => {
      await expect(
        client.generatePresignedUrl({
          runtimeArn: validArn,
          expires: 301,
        })
      ).rejects.toThrow('Expiry timeout cannot exceed 300 seconds, got 301')
    })

    it('throws error for invalid ARN', async () => {
      await expect(
        client.generatePresignedUrl({
          runtimeArn: 'invalid-arn',
        })
      ).rejects.toThrow('Invalid runtime ARN format')
    })

    it('returns wss:// URL (not https://)', async () => {
      const url = await client.generatePresignedUrl({
        runtimeArn: validArn,
      })

      expect(url).toMatch(/^wss:\/\//)
      expect(url).not.toMatch(/^https:\/\//)
    })

    it('includes session token in query parameters when present', async () => {
      const url = await client.generatePresignedUrl({
        runtimeArn: validArn,
      })

      expect(url).toContain('X-Amz-Security-Token=mock-session-token')
    })
  })

  describe('generateWsConnectionOAuth', () => {
    const validArn = 'arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/my-runtime-id'
    const validToken = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.mock-token'

    it('generates URL and headers with valid ARN and token', async () => {
      const result: WebSocketConnection = await client.generateWsConnectionOAuth({
        runtimeArn: validArn,
        bearerToken: validToken,
      })

      expect(result.url).toMatch(/^wss:\/\//)
      expect(result.url).toContain('bedrock-agentcore.us-west-2.amazonaws.com')
      expect(result.headers).toBeDefined()
      expect(result.headers.Authorization).toBe(`Bearer ${validToken}`)
      expect(result.headers.Host).toBe('bedrock-agentcore.us-west-2.amazonaws.com')
      expect(result.headers['X-Amzn-Bedrock-AgentCore-Runtime-Session-Id']).toBeDefined()
      expect(result.headers.Connection).toBe('Upgrade')
      expect(result.headers.Upgrade).toBe('websocket')
      expect(result.headers['Sec-WebSocket-Key']).toBeDefined()
      expect(result.headers['Sec-WebSocket-Version']).toBe('13')
      expect(result.headers['User-Agent']).toBe('OAuth-WebSocket-Client/1.0')
    })

    it('auto-generates session ID when not provided', async () => {
      const result = await client.generateWsConnectionOAuth({
        runtimeArn: validArn,
        bearerToken: validToken,
      })

      expect(result.headers['X-Amzn-Bedrock-AgentCore-Runtime-Session-Id']).toBe('test-session-uuid')
    })

    it('uses provided session ID', async () => {
      const result = await client.generateWsConnectionOAuth({
        runtimeArn: validArn,
        bearerToken: validToken,
        sessionId: 'custom-oauth-session',
      })

      expect(result.headers['X-Amzn-Bedrock-AgentCore-Runtime-Session-Id']).toBe('custom-oauth-session')
    })

    it('includes endpoint_name as qualifier query parameter', async () => {
      const result = await client.generateWsConnectionOAuth({
        runtimeArn: validArn,
        bearerToken: validToken,
        endpointName: 'DEFAULT',
      })

      expect(result.url).toContain('?qualifier=DEFAULT')
    })

    it('includes Sec-WebSocket-Key header', async () => {
      const result = await client.generateWsConnectionOAuth({
        runtimeArn: validArn,
        bearerToken: validToken,
      })

      expect(result.headers['Sec-WebSocket-Key']).toBeDefined()
      expect(result.headers['Sec-WebSocket-Key']).toMatch(/^[A-Za-z0-9+/=]+$/)
    })

    it('throws error for empty bearer token', async () => {
      await expect(
        client.generateWsConnectionOAuth({
          runtimeArn: validArn,
          bearerToken: '',
        })
      ).rejects.toThrow('Bearer token cannot be empty')
    })

    it('throws error for invalid ARN', async () => {
      await expect(
        client.generateWsConnectionOAuth({
          runtimeArn: 'invalid-arn',
          bearerToken: validToken,
        })
      ).rejects.toThrow('Invalid runtime ARN format')
    })

    it('does NOT require AWS credentials', async () => {
      // This test verifies that generateWsConnectionOAuth doesn't call credentialsProvider
      // by ensuring it succeeds even if credentials are unavailable
      const result = await client.generateWsConnectionOAuth({
        runtimeArn: validArn,
        bearerToken: validToken,
      })

      expect(result).toBeDefined()
      expect(result.headers.Authorization).toBe(`Bearer ${validToken}`)
      // Verify no X-Amz-Date or AWS signature headers
      expect(result.headers['X-Amz-Date']).toBeUndefined()
      expect(result.headers['X-Amz-Security-Token']).toBeUndefined()
    })

    it('includes all required WebSocket upgrade headers', async () => {
      const result = await client.generateWsConnectionOAuth({
        runtimeArn: validArn,
        bearerToken: validToken,
      })

      expect(result.headers.Host).toBeDefined()
      expect(result.headers.Connection).toBe('Upgrade')
      expect(result.headers.Upgrade).toBe('websocket')
      expect(result.headers['Sec-WebSocket-Key']).toBeDefined()
      expect(result.headers['Sec-WebSocket-Version']).toBe('13')
    })
  })
})
