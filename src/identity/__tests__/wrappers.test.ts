import { describe, it, expect, beforeEach, vi } from 'vitest'
import { withAccessToken, withApiKey } from '../wrappers.js'
import { IdentityClient } from '../client.js'

vi.mock('../client.js')

describe('withAccessToken', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('injects OAuth2 token as last parameter', async () => {
    const mockGetOAuth2Token = vi.fn().mockResolvedValue('oauth2-token-123')
    vi.spyOn(IdentityClient.prototype, 'getOAuth2Token').mockImplementation(mockGetOAuth2Token)

    const wrappedFn = withAccessToken({
      workloadIdentityToken: 'workload-token',
      providerName: 'github',
      scopes: ['repo'],
      authFlow: 'M2M',
    })(async (input: string, token: string) => {
      return { input, token }
    })

    const result = await wrappedFn('test-input')

    expect(result.input).toBe('test-input')
    expect(result.token).toBe('oauth2-token-123')
    expect(mockGetOAuth2Token).toHaveBeenCalledWith({
      providerName: 'github',
      scopes: ['repo'],
      authFlow: 'M2M',
      workloadIdentityToken: 'workload-token',
      onAuthUrl: undefined,
      forceAuthentication: undefined,
      callbackUrl: undefined,
      customState: undefined,
      customParameters: undefined,
    })
  })

  it('throws error if workload token not provided', async () => {
    const wrappedFn = withAccessToken({
      // No workloadIdentityToken provided and no context available
      providerName: 'github',
      scopes: ['repo'],
      authFlow: 'M2M',
    })(async (input: string, token: string) => {
      return { input, token }
    })

    // Should fail with context error when no token and no context
    await expect(wrappedFn('test')).rejects.toThrow('workloadIdentityToken not provided and no context available')
  })

  it('passes all configuration options to getOAuth2Token', async () => {
    const mockGetOAuth2Token = vi.fn().mockResolvedValue('oauth2-token')
    vi.spyOn(IdentityClient.prototype, 'getOAuth2Token').mockImplementation(mockGetOAuth2Token)

    const onAuthUrl = vi.fn()
    const wrappedFn = withAccessToken({
      workloadIdentityToken: 'workload-token',
      providerName: 'github',
      scopes: ['repo', 'user'],
      authFlow: 'USER_FEDERATION',
      onAuthUrl,
      forceAuthentication: true,
      callbackUrl: 'https://callback.example.com',
      customState: 'state-123',
      customParameters: { param1: 'value1' },
    })(async (input: string, token: string) => {
      return token
    })

    await wrappedFn('test')

    expect(mockGetOAuth2Token).toHaveBeenCalledWith({
      providerName: 'github',
      scopes: ['repo', 'user'],
      authFlow: 'USER_FEDERATION',
      workloadIdentityToken: 'workload-token',
      onAuthUrl,
      forceAuthentication: true,
      callbackUrl: 'https://callback.example.com',
      customState: 'state-123',
      customParameters: { param1: 'value1' },
    })
  })

  it('preserves function parameter types', async () => {
    vi.spyOn(IdentityClient.prototype, 'getOAuth2Token').mockResolvedValue('token')

    const wrappedFn = withAccessToken({
      workloadIdentityToken: 'workload-token',
      providerName: 'test',
      scopes: ['read'],
      authFlow: 'M2M',
    })(async (num: number, str: string, token: string) => {
      return { num, str, token }
    })

    const result = await wrappedFn(42, 'hello')

    expect(result.num).toBe(42)
    expect(result.str).toBe('hello')
    expect(result.token).toBe('token')
  })
})

describe('withApiKey', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('injects API key as last parameter', async () => {
    const mockGetApiKey = vi.fn().mockResolvedValue('api-key-123')
    vi.spyOn(IdentityClient.prototype, 'getApiKey').mockImplementation(mockGetApiKey)

    const wrappedFn = withApiKey({
      workloadIdentityToken: 'workload-token',
      providerName: 'openai',
    })(async (input: string, apiKey: string) => {
      return { input, apiKey }
    })

    const result = await wrappedFn('test-input')

    expect(result.input).toBe('test-input')
    expect(result.apiKey).toBe('api-key-123')
    expect(mockGetApiKey).toHaveBeenCalledWith({
      providerName: 'openai',
      workloadIdentityToken: 'workload-token',
    })
  })

  it('throws error if no API key returned', async () => {
    const mockGetApiKey = vi.fn().mockRejectedValue(new Error('No API key returned for provider: openai'))
    vi.spyOn(IdentityClient.prototype, 'getApiKey').mockImplementation(mockGetApiKey)

    const wrappedFn = withApiKey({
      workloadIdentityToken: 'workload-token',
      providerName: 'openai',
    })(async (input: string, apiKey: string) => {
      return { input, apiKey }
    })

    await expect(wrappedFn('test')).rejects.toThrow('No API key returned for provider: openai')
  })

  it('throws error if workload token not provided', async () => {
    const wrappedFn = withApiKey({
      // No workloadIdentityToken provided and no context available
      providerName: 'openai',
    })(async (input: string, apiKey: string) => {
      return { input, apiKey }
    })

    // Should fail with context error when no token and no context
    await expect(wrappedFn('test')).rejects.toThrow('workloadIdentityToken not provided and no context available')
  })

  it('preserves function parameter types', async () => {
    vi.spyOn(IdentityClient.prototype, 'getApiKey').mockResolvedValue('api-key')

    const wrappedFn = withApiKey({
      workloadIdentityToken: 'workload-token',
      providerName: 'openai',
    })(async (num: number, str: string, apiKey: string) => {
      return { num, str, apiKey }
    })

    const result = await wrappedFn(42, 'hello')

    expect(result.num).toBe(42)
    expect(result.str).toBe('hello')
    expect(result.apiKey).toBe('api-key')
  })
})
