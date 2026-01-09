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

    it('should initialize data plane client', () => {
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
})
