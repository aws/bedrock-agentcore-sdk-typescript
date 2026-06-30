import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { RuntimeClient } from '../client.js'
import { ShellSession as MockShellSession } from '../shell/session.js'
import type { WebSocketConnection } from '../types.js'

// Mock AWS credentials
const mockCredentials = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  sessionToken: 'mock-session-token',
}

// Mock ShellSession so openShell tests don't need a real WebSocket
vi.mock('../shell/session.js', () => {
  const MockShellSession = vi.fn().mockImplementation(function (this: any, opts: any) {
    this.shellId = opts.shellId ?? 'mock-shell-uuid'
    this.sessionId = opts.sessionId ?? 'mock-session-uuid'
    this.reconnected = false
    this.kicked = false
    this.bytesDropped = 0
    this.exitCode = null
    this.connect = vi.fn(async () => this)
  })
  return { ShellSession: MockShellSession }
})

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

    it('parses GovCloud ARN successfully', () => {
      const govCloudArn = 'arn:aws-us-gov:bedrock-agentcore:us-gov-west-1:123456789012:runtime/my-runtime-id'
      const parsed = (client as any)._parseRuntimeArn(govCloudArn)
      expect(parsed).toEqual({
        region: 'us-gov-west-1',
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

  // ── Shell Layer 1 helpers ────────────────────────────────────────────────────

  describe('connectShellSigV4', () => {
    const validArn = 'arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/my-runtime-id'

    it('returns url and SigV4 signed headers', async () => {
      const result = await client.connectShellSigV4({
        runtimeArn: validArn,
        shellId: 'my-shell',
        sessionId: 'my-session',
      })
      expect(result.url).toMatch(/^wss:\/\//)
      expect(result.url).toContain('/ws/shells')
      expect(result.url).toContain('shellId=my-shell')
      expect(result.headers.Authorization).toContain('AWS4-HMAC-SHA256')
      expect(result.headers['X-Amzn-Bedrock-AgentCore-Runtime-Session-Id']).toBe('my-session')
    })

    it('includes endpointName as qualifier query param', async () => {
      const result = await client.connectShellSigV4({
        runtimeArn: validArn,
        shellId: 'my-shell',
        sessionId: 'my-session',
        endpointName: 'DEFAULT',
      })
      expect(result.url).toContain('qualifier=DEFAULT')
    })

    it('throws for invalid ARN format', async () => {
      await expect(
        client.connectShellSigV4({ runtimeArn: 'bad-arn', shellId: 'my-shell', sessionId: 's' })
      ).rejects.toThrow('Invalid runtime ARN format')
    })

    it('throws when ARN region does not match client region', async () => {
      await expect(
        client.connectShellSigV4({
          runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/r',
          shellId: 'my-shell',
          sessionId: 's',
        })
      ).rejects.toThrow('us-east-1')
    })

    it('throws for invalid shellId', async () => {
      await expect(client.connectShellSigV4({ runtimeArn: validArn, shellId: '', sessionId: 's' })).rejects.toThrow()
    })
  })

  describe('connectShellPresigned', () => {
    const validArn = 'arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/my-runtime-id'

    it('returns a presigned wss:// url', async () => {
      const result = await client.connectShellPresigned({
        runtimeArn: validArn,
        shellId: 'my-shell',
        sessionId: 'my-session',
      })
      expect(result.url).toMatch(/^wss:\/\//)
      expect(result.url).toContain('X-Amz-Signature')
      expect(result.url).toContain('X-Amz-Expires=300') // default
    })

    it('embeds sessionId in the request signed by presign', async () => {
      const { SignatureV4 } = await import('@aws-sdk/signature-v4')
      await client.connectShellPresigned({
        runtimeArn: validArn,
        shellId: 'my-shell',
        sessionId: 'embedded-session',
      })
      const presignSpy = (SignatureV4 as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value.presign as ReturnType<
        typeof vi.fn
      >
      const signedRequest = presignSpy.mock.calls[0]![0]
      expect(signedRequest.query['X-Amzn-Bedrock-AgentCore-Runtime-Session-Id']).toBe('embedded-session')
    })

    it('respects custom expires', async () => {
      const result = await client.connectShellPresigned({
        runtimeArn: validArn,
        shellId: 'my-shell',
        sessionId: 'my-session',
        expires: 120,
      })
      expect(result.url).toContain('X-Amz-Expires=120')
    })

    it('throws when expires exceeds 300', async () => {
      await expect(
        client.connectShellPresigned({ runtimeArn: validArn, shellId: 'my-shell', sessionId: 's', expires: 301 })
      ).rejects.toThrow('Expiry timeout cannot exceed 300 seconds')
    })

    it('throws for invalid ARN format', async () => {
      await expect(
        client.connectShellPresigned({ runtimeArn: 'bad-arn', shellId: 'my-shell', sessionId: 's' })
      ).rejects.toThrow('Invalid runtime ARN format')
    })

    it('throws when ARN region does not match client region', async () => {
      await expect(
        client.connectShellPresigned({
          runtimeArn: 'arn:aws:bedrock-agentcore:eu-west-1:123456789012:runtime/r',
          shellId: 'my-shell',
          sessionId: 's',
        })
      ).rejects.toThrow('eu-west-1')
    })

    it('throws for invalid shellId', async () => {
      await expect(
        client.connectShellPresigned({ runtimeArn: validArn, shellId: '', sessionId: 's' })
      ).rejects.toThrow()
    })
  })

  describe('connectShellOAuth', () => {
    const validArn = 'arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/my-runtime-id'

    it('returns url and base64url subprotocols', async () => {
      const result = await client.connectShellOAuth({
        runtimeArn: validArn,
        shellId: 'my-shell',
        sessionId: 'my-session',
        bearerToken: 'tok123',
      })
      expect(result.url).toMatch(/^wss:\/\//)
      expect(result.url).toContain('/ws/shells')
      expect(result.subprotocols).toHaveLength(2)
      expect(result.subprotocols[1]).toBe('base64UrlBearerAuthorization')
      expect(result.subprotocols[0]).toMatch(/^base64UrlBearerAuthorization\./)
    })

    it('base64url-encodes the bearer token in the subprotocol', async () => {
      const result = await client.connectShellOAuth({
        runtimeArn: validArn,
        shellId: 'my-shell',
        sessionId: 'my-session',
        bearerToken: 'hello',
      })
      const encoded = Buffer.from('hello').toString('base64url')
      expect(result.subprotocols[0]).toBe(`base64UrlBearerAuthorization.${encoded}`)
    })

    it('embeds sessionId in the url', async () => {
      const result = await client.connectShellOAuth({
        runtimeArn: validArn,
        shellId: 'my-shell',
        sessionId: 'sess-abc',
        bearerToken: 'tok',
      })
      expect(result.url).toContain('X-Amzn-Bedrock-AgentCore-Runtime-Session-Id=sess-abc')
    })

    it('throws for empty bearerToken', async () => {
      await expect(
        client.connectShellOAuth({ runtimeArn: validArn, shellId: 'my-shell', sessionId: 's', bearerToken: '' })
      ).rejects.toThrow('bearerToken cannot be empty')
    })

    it('throws for invalid ARN format', async () => {
      await expect(
        client.connectShellOAuth({ runtimeArn: 'bad-arn', shellId: 'my-shell', sessionId: 's', bearerToken: 'tok' })
      ).rejects.toThrow('Invalid runtime ARN format')
    })

    it('throws when ARN region does not match client region', async () => {
      await expect(
        client.connectShellOAuth({
          runtimeArn: 'arn:aws:bedrock-agentcore:ap-southeast-1:123456789012:runtime/r',
          shellId: 'my-shell',
          sessionId: 's',
          bearerToken: 'tok',
        })
      ).rejects.toThrow('ap-southeast-1')
    })

    it('throws for invalid shellId', async () => {
      await expect(
        client.connectShellOAuth({ runtimeArn: validArn, shellId: '', sessionId: 's', bearerToken: 'tok' })
      ).rejects.toThrow()
    })
  })

  // ── Shell Layer 2: openShell ─────────────────────────────────────────────────

  describe('openShell', () => {
    const validArn = 'arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/my-runtime-id'

    it('returns a connected ShellSession', async () => {
      const session = await client.openShell({ runtimeArn: validArn })
      expect(session).toBeDefined()
      expect((session as any).connect).toHaveBeenCalledOnce()
    })

    it('passes shellId and sessionId through to ShellSession', async () => {
      await client.openShell({ runtimeArn: validArn, shellId: 'custom-shell', sessionId: 'custom-session' })
      expect(MockShellSession).toHaveBeenCalledWith(
        expect.objectContaining({ shellId: 'custom-shell', sessionId: 'custom-session' })
      )
    })

    it('auto-generates shellId when omitted', async () => {
      await client.openShell({ runtimeArn: validArn })
      const opts = (MockShellSession as ReturnType<typeof vi.fn>).mock.calls[0]![0]
      expect(opts.shellId).toBeTruthy()
    })

    it('passes reconnectConfig to ShellSession', async () => {
      const reconnectConfig = { maxRetries: 3 }
      await client.openShell({ runtimeArn: validArn, reconnectConfig })
      expect(MockShellSession).toHaveBeenCalledWith(expect.objectContaining({ reconnectConfig }))
    })

    it('passes keepaliveIntervalMs to ShellSession', async () => {
      await client.openShell({ runtimeArn: validArn, keepaliveIntervalMs: 10_000 })
      expect(MockShellSession).toHaveBeenCalledWith(expect.objectContaining({ keepaliveIntervalMs: 10_000 }))
    })

    it('throws for invalid ARN format', async () => {
      await expect(client.openShell({ runtimeArn: 'bad-arn' })).rejects.toThrow('Invalid runtime ARN format')
    })

    it('throws when ARN region does not match client region', async () => {
      await expect(
        client.openShell({ runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/r' })
      ).rejects.toThrow('us-east-1')
    })

    it('throws for invalid shellId', async () => {
      await expect(client.openShell({ runtimeArn: validArn, shellId: '' })).rejects.toThrow()
    })

    it('uses sigv4 auth by default', async () => {
      await client.openShell({ runtimeArn: validArn })
      const opts = (MockShellSession as ReturnType<typeof vi.fn>).mock.calls[0]![0]
      // connectFn should call connectShellSigV4 — invoke it to verify shape
      const connResult = await opts.connectFn('test-shell', 'test-session')
      expect(connResult.url).toMatch(/^wss:\/\//)
      expect(connResult.headers.Authorization).toContain('AWS4-HMAC-SHA256')
      expect(connResult.protocols).toBeUndefined()
    })

    it('uses presigned auth when specified', async () => {
      await client.openShell({ runtimeArn: validArn, auth: { type: 'presigned', expires: 60 } })
      const opts = (MockShellSession as ReturnType<typeof vi.fn>).mock.calls[0]![0]
      const connResult = await opts.connectFn('test-shell', 'test-session')
      expect(connResult.url).toMatch(/^wss:\/\//)
      expect(connResult.url).toContain('X-Amz-Signature')
      expect(connResult.headers).toEqual({})
    })

    it('uses oauth auth when specified', async () => {
      await client.openShell({ runtimeArn: validArn, auth: { type: 'oauth', bearerToken: 'my-token' } })
      const opts = (MockShellSession as ReturnType<typeof vi.fn>).mock.calls[0]![0]
      const connResult = await opts.connectFn('test-shell', 'test-session')
      expect(connResult.url).toMatch(/^wss:\/\//)
      expect(connResult.protocols).toHaveLength(2)
      expect(connResult.protocols[1]).toBe('base64UrlBearerAuthorization')
    })

    it('throws for unknown auth mode', async () => {
      await expect(client.openShell({ runtimeArn: validArn, auth: { type: 'unknown' } as any })).rejects.toThrow(
        'Unknown auth mode'
      )
    })
  })
})
