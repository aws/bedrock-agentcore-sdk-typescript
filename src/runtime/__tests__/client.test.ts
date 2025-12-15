import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { RuntimeClient } from '../client.js'
import type { WebSocketConnection } from '../types.js'

// Mock AWS credentials
const mockCredentials = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  sessionToken: 'mock-session-token',
}

const mockCredentialsWithoutToken = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
}

// Mock the credential provider
vi.mock('@aws-sdk/credential-providers', () => ({
  fromNodeProviderChain: vi.fn(() => vi.fn(async () => mockCredentials)),
}))

// Mock crypto.randomUUID to return predictable values
vi.mock('crypto', () => ({
  randomUUID: vi.fn(() => 'test-session-uuid'),
}))

// Mock SignatureV4 from @smithy/signature-v4
vi.mock('@smithy/signature-v4', () => ({
  SignatureV4: vi.fn(function (this: any) {
    this.sign = vi.fn(async (request: any) => ({
      ...request,
      headers: {
        ...request.headers,
        authorization:
          'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20240101/us-west-2/bedrock-agentcore/aws4_request, SignedHeaders=host;x-amz-date, Signature=mock-signature',
        'x-amz-date': '20240101T120000Z',
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

    it('creates client with default region when no config provided', () => {
      const testClient = new RuntimeClient()
      expect(testClient.region).toBe('us-west-2')
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

  describe('parseRuntimeArn', () => {
    const validArn = 'arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/my-runtime-id'

    it('parses valid ARN successfully', () => {
      // Access private method through type assertion
      const parsed = (client as any).parseRuntimeArn(validArn)
      expect(parsed).toEqual({
        region: 'us-west-2',
        accountId: '123456789012',
        runtimeId: 'my-runtime-id',
      })
    })

    it('throws error for invalid ARN format (wrong structure)', () => {
      const invalidArn = 'invalid-arn'
      expect(() => (client as any).parseRuntimeArn(invalidArn)).toThrow('Invalid runtime ARN format')
    })

    it('throws error for wrong service name', () => {
      const wrongService = 'arn:aws:s3:us-west-2:123456789012:runtime/my-runtime-id'
      expect(() => (client as any).parseRuntimeArn(wrongService)).toThrow('Invalid runtime ARN format')
    })

    it('throws error for wrong resource type', () => {
      const wrongResource = 'arn:aws:bedrock-agentcore:us-west-2:123456789012:bucket/my-bucket'
      expect(() => (client as any).parseRuntimeArn(wrongResource)).toThrow('Invalid runtime ARN format')
    })

    it('throws error for missing region', () => {
      const missingRegion = 'arn:aws:bedrock-agentcore::123456789012:runtime/my-runtime-id'
      expect(() => (client as any).parseRuntimeArn(missingRegion)).toThrow()
    })

    it('throws error for missing account ID', () => {
      const missingAccount = 'arn:aws:bedrock-agentcore:us-west-2::runtime/my-runtime-id'
      expect(() => (client as any).parseRuntimeArn(missingAccount)).toThrow()
    })

    it('throws error for missing runtime ID', () => {
      const missingRuntimeId = 'arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/'
      expect(() => (client as any).parseRuntimeArn(missingRuntimeId)).toThrow()
    })
  })

  describe('buildWebSocketUrl', () => {
    const testArn = 'arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/my-runtime-id'

    it('builds URL with no query parameters', () => {
      const url = (client as any).buildWebSocketUrl(testArn)
      expect(url).toMatch(/^wss:\/\/bedrock-agentcore\.us-west-2\.amazonaws\.com\/runtimes\//)
      expect(url).toContain(encodeURIComponent(testArn))
      expect(url).toContain('/ws')
      expect(url).not.toContain('?')
    })

    it('builds URL with endpoint_name (qualifier)', () => {
      const url = (client as any).buildWebSocketUrl(testArn, 'DEFAULT')
      expect(url).toContain('?qualifier=DEFAULT')
    })

    it('builds URL with custom headers', () => {
      const customHeaders = { customParam: 'value1', anotherParam: 'value2' }
      const url = (client as any).buildWebSocketUrl(testArn, undefined, customHeaders)
      expect(url).toContain('?')
      expect(url).toContain('customParam=value1')
      expect(url).toContain('anotherParam=value2')
    })

    it('builds URL with both endpoint_name and custom headers', () => {
      const customHeaders = { customParam: 'value' }
      const url = (client as any).buildWebSocketUrl(testArn, 'DEFAULT', customHeaders)
      expect(url).toContain('?')
      expect(url).toContain('qualifier=DEFAULT')
      expect(url).toContain('customParam=value')
    })

    it('properly encodes runtime ARN in path', () => {
      const url = (client as any).buildWebSocketUrl(testArn)
      const encodedArn = encodeURIComponent(testArn)
      expect(url).toContain(`/runtimes/${encodedArn}/ws`)
    })

    it('uses custom endpoint from environment variable', () => {
      process.env.BEDROCK_AGENTCORE_DATA_PLANE_ENDPOINT = 'https://custom-endpoint.example.com'
      const url = (client as any).buildWebSocketUrl(testArn)
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

    it('includes X-Amz-Security-Token when session token present', async () => {
      const result = await client.generateWsConnection({
        runtimeArn: validArn,
      })

      expect(result.headers['X-Amz-Security-Token']).toBe('mock-session-token')
    })

    it('does NOT include Sec-WebSocket-Key', async () => {
      const result = await client.generateWsConnection({
        runtimeArn: validArn,
      })

      expect(result.headers['Sec-WebSocket-Key']).toBeUndefined()
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

    it('auto-generates session ID when not provided', async () => {
      const url = await client.generatePresignedUrl({
        runtimeArn: validArn,
      })

      expect(url).toContain('X-Amzn-Bedrock-AgentCore-Runtime-Session-Id=test-session-uuid')
    })

    it('uses provided session ID', async () => {
      const url = await client.generatePresignedUrl({
        runtimeArn: validArn,
        sessionId: 'custom-session-id',
      })

      expect(url).toContain('X-Amzn-Bedrock-AgentCore-Runtime-Session-Id=custom-session-id')
    })

    it('includes session ID in query parameters', async () => {
      const url = await client.generatePresignedUrl({
        runtimeArn: validArn,
        sessionId: 'my-session-123',
      })

      expect(url).toContain('X-Amzn-Bedrock-AgentCore-Runtime-Session-Id=my-session-123')
    })

    it('includes endpoint_name as qualifier query parameter', async () => {
      const url = await client.generatePresignedUrl({
        runtimeArn: validArn,
        endpointName: 'DEFAULT',
      })

      expect(url).toContain('qualifier=DEFAULT')
    })

    it('includes custom headers as query parameters', async () => {
      const url = await client.generatePresignedUrl({
        runtimeArn: validArn,
        customHeaders: { customParam: 'value', anotherParam: 'value2' },
      })

      expect(url).toContain('customParam=value')
      expect(url).toContain('anotherParam=value2')
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
})
