import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { IdentityClient } from '../client.js'

describe('IdentityClient', () => {
  let originalEnv: string | undefined

  beforeEach(() => {
    originalEnv = process.env.AWS_REGION
    process.env.AWS_REGION = 'us-west-2' // Set default for tests
  })

  afterEach(() => {
    if (originalEnv) {
      process.env.AWS_REGION = originalEnv
    } else {
      delete process.env.AWS_REGION
    }
  })

  describe('constructor', () => {
    it('should initialize with custom region', () => {
      const client = new IdentityClient('us-east-1')
      expect(client).toBeDefined()
    })

    it('should use AWS_REGION environment variable when no region provided', () => {
      process.env.AWS_REGION = 'eu-west-1'
      const client = new IdentityClient()
      expect(client).toBeDefined()
    })

    it('should throw error when no region or env var', () => {
      delete process.env.AWS_REGION
      expect(() => new IdentityClient()).toThrow(
        'AWS region must be specified either as a parameter or via AWS_REGION environment variable'
      )
    })

    it('should initialize both data plane and control plane clients', () => {
      process.env.AWS_REGION = 'us-west-2'
      const client = new IdentityClient()
      expect(client).toBeDefined()
    })
  })

  describe('getOAuth2Token', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('should return access token immediately for M2M flow', async () => {
      const client = new IdentityClient()
      const mockSend = vi.fn().mockResolvedValue({ accessToken: 'mock-m2m-token' })
      ;(client as any).dataPlaneClient.send = mockSend

      const token = await client.getOAuth2Token({
        providerName: 'test-provider',
        scopes: ['read'],
        authFlow: 'M2M',
        workloadIdentityToken: 'workload-token',
      })

      expect(token).toBe('mock-m2m-token')
      expect(mockSend).toHaveBeenCalledTimes(1)
    })

    it('should invoke onAuthUrl callback for USER_FEDERATION flow', async () => {
      const client = new IdentityClient()
      const onAuthUrl = vi.fn()

      const mockSend = vi
        .fn()
        .mockResolvedValueOnce({ authorizationUrl: 'https://auth.example.com', sessionUri: 'session-123' })
        .mockResolvedValueOnce({ accessToken: 'mock-token' })
      ;(client as any).dataPlaneClient.send = mockSend

      const tokenPromise = client.getOAuth2Token({
        providerName: 'test-provider',
        scopes: ['read'],
        authFlow: 'USER_FEDERATION',
        workloadIdentityToken: 'workload-token',
        onAuthUrl,
      })

      await vi.advanceTimersByTimeAsync(5000)
      const token = await tokenPromise

      expect(onAuthUrl).toHaveBeenCalledWith('https://auth.example.com')
      expect(token).toBe('mock-token')
      expect(mockSend).toHaveBeenCalledTimes(2)
    })

    it('should poll multiple times until token is available', async () => {
      const client = new IdentityClient()

      const mockSend = vi
        .fn()
        .mockResolvedValueOnce({ authorizationUrl: 'https://auth.example.com', sessionUri: 'session-123' })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ accessToken: 'mock-token' })
      ;(client as any).dataPlaneClient.send = mockSend

      const tokenPromise = client.getOAuth2Token({
        providerName: 'test-provider',
        scopes: ['read'],
        authFlow: 'USER_FEDERATION',
        workloadIdentityToken: 'workload-token',
      })

      await vi.advanceTimersByTimeAsync(10000)
      const token = await tokenPromise

      expect(token).toBe('mock-token')
      expect(mockSend).toHaveBeenCalledTimes(3)
    })

    it('should timeout if user does not complete auth', async () => {
      const client = new IdentityClient()

      const mockSend = vi
        .fn()
        .mockResolvedValueOnce({ authorizationUrl: 'https://auth.example.com', sessionUri: 'session-123' })
        .mockResolvedValue({})
      ;(client as any).dataPlaneClient.send = mockSend

      const tokenPromise = client.getOAuth2Token({
        providerName: 'test-provider',
        scopes: ['read'],
        authFlow: 'USER_FEDERATION',
        workloadIdentityToken: 'workload-token',
      })

      const advancePromise = vi.advanceTimersByTimeAsync(600000)

      await expect(tokenPromise).rejects.toThrow('Polling timed out after 600 seconds')
      await advancePromise
    })

    it('should throw error if neither token nor auth URL returned', async () => {
      const client = new IdentityClient()
      const mockSend = vi.fn().mockResolvedValue({})
      ;(client as any).dataPlaneClient.send = mockSend

      await expect(
        client.getOAuth2Token({
          providerName: 'test-provider',
          scopes: ['read'],
          authFlow: 'M2M',
          workloadIdentityToken: 'workload-token',
        })
      ).rejects.toThrow('Identity service did not return a token or authorization URL')
    })

    it('should handle API errors', async () => {
      const client = new IdentityClient()
      const mockSend = vi.fn().mockRejectedValue(new Error('API Error'))
      ;(client as any).dataPlaneClient.send = mockSend

      await expect(
        client.getOAuth2Token({
          providerName: 'test-provider',
          scopes: ['read'],
          authFlow: 'M2M',
          workloadIdentityToken: 'workload-token',
        })
      ).rejects.toThrow('API Error')
    })
  })

  describe('getApiKey', () => {
    it('should return API key successfully', async () => {
      const client = new IdentityClient()
      const mockSend = vi.fn().mockResolvedValue({ apiKey: 'mock-api-key-123' })
      ;(client as any).dataPlaneClient.send = mockSend

      const apiKey = await client.getApiKey({
        providerName: 'openai-provider',
        workloadIdentityToken: 'workload-token',
      })

      expect(apiKey).toBe('mock-api-key-123')
      expect(mockSend).toHaveBeenCalledTimes(1)
    })

    it('should throw error if no API key returned', async () => {
      const client = new IdentityClient()
      const mockSend = vi.fn().mockResolvedValue({})
      ;(client as any).dataPlaneClient.send = mockSend

      await expect(
        client.getApiKey({
          providerName: 'openai-provider',
          workloadIdentityToken: 'workload-token',
        })
      ).rejects.toThrow('No API key returned for provider: openai-provider')
    })

    it('should handle API errors', async () => {
      const client = new IdentityClient()
      const mockSend = vi.fn().mockRejectedValue(new Error('API Error'))
      ;(client as any).dataPlaneClient.send = mockSend

      await expect(
        client.getApiKey({
          providerName: 'openai-provider',
          workloadIdentityToken: 'workload-token',
        })
      ).rejects.toThrow('API Error')
    })
  })

  describe('Workload Identity CRUD', () => {
    it('should create workload identity without callback URLs', async () => {
      const client = new IdentityClient()
      const mockSend = vi.fn().mockResolvedValue({
        name: 'test-identity',
        workloadIdentityArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789:workload-identity/test-identity',
        allowedResourceOauth2ReturnUrls: [],
      })
      ;(client as any).controlPlaneClient.send = mockSend

      const identity = await client.createWorkloadIdentity('test-identity')

      expect(identity.name).toBe('test-identity')
      expect(identity.workloadIdentityArn).toBeDefined()
      expect(mockSend).toHaveBeenCalledTimes(1)
    })

    it('should create workload identity with callback URLs', async () => {
      const client = new IdentityClient()
      const callbackUrls = ['https://example.com/callback']
      const mockSend = vi.fn().mockResolvedValue({
        name: 'test-identity',
        workloadIdentityArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789:workload-identity/test-identity',
        allowedResourceOauth2ReturnUrls: callbackUrls,
      })
      ;(client as any).controlPlaneClient.send = mockSend

      const identity = await client.createWorkloadIdentity('test-identity', callbackUrls)

      expect(identity.name).toBe('test-identity')
      expect(identity.allowedResourceOauth2ReturnUrls).toEqual(callbackUrls)
      expect(mockSend).toHaveBeenCalledTimes(1)
    })

    it('should get workload identity', async () => {
      const client = new IdentityClient()
      const mockSend = vi.fn().mockResolvedValue({
        name: 'test-identity',
        workloadIdentityArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789:workload-identity/test-identity',
        allowedResourceOauth2ReturnUrls: [],
      })
      ;(client as any).controlPlaneClient.send = mockSend

      const identity = await client.getWorkloadIdentity('test-identity')

      expect(identity.name).toBe('test-identity')
      expect(identity.workloadIdentityArn).toBeDefined()
      expect(mockSend).toHaveBeenCalledTimes(1)
    })

    it('should delete workload identity', async () => {
      const client = new IdentityClient()
      const mockSend = vi.fn().mockResolvedValue({})
      ;(client as any).controlPlaneClient.send = mockSend

      await client.deleteWorkloadIdentity('test-identity')

      expect(mockSend).toHaveBeenCalledTimes(1)
    })

    it('should handle errors in workload identity operations', async () => {
      const client = new IdentityClient()
      const mockSend = vi.fn().mockRejectedValue(new Error('Identity not found'))
      ;(client as any).controlPlaneClient.send = mockSend

      await expect(client.getWorkloadIdentity('nonexistent')).rejects.toThrow('Identity not found')
    })
  })

  describe('OAuth2 Provider CRUD', () => {
    it('should create OAuth2 provider with discoveryUrl', async () => {
      const client = new IdentityClient()
      const mockSend = vi.fn().mockResolvedValue({
        name: 'test-oauth2-provider',
        credentialProviderArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789:oauth2-provider/test',
        callbackUrl: 'https://callback.example.com',
      })
      ;(client as any).controlPlaneClient.send = mockSend

      const provider = await client.createOAuth2CredentialProvider({
        name: 'test-oauth2-provider',
        clientId: 'client-123',
        clientSecret: 'secret-456',
        discoveryUrl: 'https://auth.example.com/.well-known/openid-configuration',
      })

      expect(provider.name).toBe('test-oauth2-provider')
      expect(provider.callbackUrl).toBeDefined()
      expect(mockSend).toHaveBeenCalledTimes(1)
    })

    it('should create OAuth2 provider with authorizationServerMetadata', async () => {
      const client = new IdentityClient()
      const mockSend = vi.fn().mockResolvedValue({
        name: 'test-oauth2-provider-github',
        credentialProviderArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789:oauth2-provider/test',
        callbackUrl: 'https://callback.example.com',
      })
      ;(client as any).controlPlaneClient.send = mockSend

      const provider = await client.createOAuth2CredentialProvider({
        name: 'test-oauth2-provider-github',
        clientId: 'client-456',
        clientSecret: 'secret-789',
        authorizationServerMetadata: {
          issuer: 'https://github.com',
          authorizationEndpoint: 'https://github.com/login/oauth/authorize',
          tokenEndpoint: 'https://github.com/login/oauth/access_token',
        },
      })

      expect(provider.name).toBe('test-oauth2-provider-github')
      expect(provider.callbackUrl).toBeDefined()
      expect(mockSend).toHaveBeenCalledTimes(1)
    })

    it('should get OAuth2 provider', async () => {
      const client = new IdentityClient()
      const mockSend = vi.fn().mockResolvedValue({
        name: 'test-oauth2-provider',
        credentialProviderArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789:oauth2-provider/test',
        callbackUrl: 'https://callback.example.com',
      })
      ;(client as any).controlPlaneClient.send = mockSend

      const provider = await client.getOAuth2CredentialProvider('test-oauth2-provider')

      expect(provider.name).toBe('test-oauth2-provider')
      expect(provider.callbackUrl).toBeDefined()
      expect(mockSend).toHaveBeenCalledTimes(1)
    })

    it('should delete OAuth2 provider', async () => {
      const client = new IdentityClient()
      const mockSend = vi.fn().mockResolvedValue({})
      ;(client as any).controlPlaneClient.send = mockSend

      await client.deleteOAuth2CredentialProvider('test-oauth2-provider')

      expect(mockSend).toHaveBeenCalledTimes(1)
    })

    it('should handle errors in OAuth2 provider operations', async () => {
      const client = new IdentityClient()
      const mockSend = vi.fn().mockRejectedValue(new Error('Provider not found'))
      ;(client as any).controlPlaneClient.send = mockSend

      await expect(client.getOAuth2CredentialProvider('nonexistent')).rejects.toThrow('Provider not found')
    })
  })

  describe('API Key Provider CRUD', () => {
    it('should create API key provider', async () => {
      const client = new IdentityClient()
      const mockSend = vi.fn().mockResolvedValue({
        name: 'test-apikey-provider',
        credentialProviderArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789:apikey-provider/test',
      })
      ;(client as any).controlPlaneClient.send = mockSend

      const provider = await client.createApiKeyCredentialProvider({
        name: 'test-apikey-provider',
        apiKey: 'sk-test-key-123',
      })

      expect(provider.name).toBe('test-apikey-provider')
      expect(provider.credentialProviderArn).toBeDefined()
      expect(mockSend).toHaveBeenCalledTimes(1)
    })

    it('should get API key provider', async () => {
      const client = new IdentityClient()
      const mockSend = vi.fn().mockResolvedValue({
        name: 'test-apikey-provider',
        credentialProviderArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789:apikey-provider/test',
      })
      ;(client as any).controlPlaneClient.send = mockSend

      const provider = await client.getApiKeyCredentialProvider('test-apikey-provider')

      expect(provider.name).toBe('test-apikey-provider')
      expect(provider.credentialProviderArn).toBeDefined()
      expect(mockSend).toHaveBeenCalledTimes(1)
    })

    it('should delete API key provider', async () => {
      const client = new IdentityClient()
      const mockSend = vi.fn().mockResolvedValue({})
      ;(client as any).controlPlaneClient.send = mockSend

      await client.deleteApiKeyCredentialProvider('test-apikey-provider')

      expect(mockSend).toHaveBeenCalledTimes(1)
    })

    it('should handle errors in API key provider operations', async () => {
      const client = new IdentityClient()
      const mockSend = vi.fn().mockRejectedValue(new Error('Provider not found'))
      ;(client as any).controlPlaneClient.send = mockSend

      await expect(client.getApiKeyCredentialProvider('nonexistent')).rejects.toThrow('Provider not found')
    })
  })

  describe('Workload Access Token', () => {
    it('should get workload access token', async () => {
      const client = new IdentityClient()
      const mockSend = vi.fn().mockResolvedValue({
        workloadAccessToken: 'workload-token-123',
      })
      ;(client as any).dataPlaneClient.send = mockSend

      const token = await client.getWorkloadAccessToken('test-workload')

      expect(token).toBe('workload-token-123')
      expect(mockSend).toHaveBeenCalledTimes(1)
    })

    it('should get workload access token for JWT', async () => {
      const client = new IdentityClient()
      const mockSend = vi.fn().mockResolvedValue({
        workloadAccessToken: 'workload-token-from-jwt',
      })
      ;(client as any).dataPlaneClient.send = mockSend

      const token = await client.getWorkloadAccessTokenForJWT('test-workload', 'user-jwt-token')

      expect(token).toBe('workload-token-from-jwt')
      expect(mockSend).toHaveBeenCalledTimes(1)
    })

    it('should get workload access token for user ID', async () => {
      const client = new IdentityClient()
      const mockSend = vi.fn().mockResolvedValue({
        workloadAccessToken: 'workload-token-for-user',
      })
      ;(client as any).dataPlaneClient.send = mockSend

      const token = await client.getWorkloadAccessTokenForUserId('test-workload', 'user-123')

      expect(token).toBe('workload-token-for-user')
      expect(mockSend).toHaveBeenCalledTimes(1)
    })

    it('should throw error if no workload token returned', async () => {
      const client = new IdentityClient()
      const mockSend = vi.fn().mockResolvedValue({})
      ;(client as any).dataPlaneClient.send = mockSend

      await expect(client.getWorkloadAccessToken('test-workload')).rejects.toThrow('No workload access token returned')
    })
  })
})
