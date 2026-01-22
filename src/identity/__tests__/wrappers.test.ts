import { describe, it, expect, beforeEach, vi } from 'vitest'
import { withAccessToken, withApiKey } from '../wrappers.js'
import { IdentityClient } from '../client.js'
import { runWithContext } from '../../runtime/context.js'
import type { RequestContext } from '../../runtime/types.js'

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

describe('withAccessToken context integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should use workloadIdentityToken from context when not in config', async () => {
    const mockGetOAuth2Token = vi.fn().mockResolvedValue('oauth2-token-from-context')
    vi.spyOn(IdentityClient.prototype, 'getOAuth2Token').mockImplementation(mockGetOAuth2Token)

    const wrapper = withAccessToken({
      // NO workloadIdentityToken in config
      providerName: 'test-provider',
      scopes: ['read'],
      authFlow: 'M2M',
    })

    const context: RequestContext = {
      requestId: 'test-req',
      sessionId: 'test-session',
      workloadAccessToken: 'context-token-value',
      headers: {},
    }

    await runWithContext(context, async () => {
      const tool = wrapper(async (input: string, token: string) => {
        return { input, token }
      })

      const result = await tool('test-input')
      expect(result.token).toBe('oauth2-token-from-context')
    })

    expect(mockGetOAuth2Token).toHaveBeenCalledWith({
      providerName: 'test-provider',
      scopes: ['read'],
      authFlow: 'M2M',
      workloadIdentityToken: 'context-token-value',
      onAuthUrl: undefined,
      forceAuthentication: undefined,
      callbackUrl: undefined,
      customState: undefined,
      customParameters: undefined,
    })
  })

  it('should prioritize config token over context token', async () => {
    const mockGetOAuth2Token = vi.fn().mockResolvedValue('oauth2-token')
    vi.spyOn(IdentityClient.prototype, 'getOAuth2Token').mockImplementation(mockGetOAuth2Token)

    const wrapper = withAccessToken({
      workloadIdentityToken: 'config-token',
      providerName: 'test-provider',
      scopes: ['read'],
      authFlow: 'M2M',
    })

    const context: RequestContext = {
      requestId: 'test-req',
      sessionId: 'test-session',
      workloadAccessToken: 'context-token',
      headers: {},
    }

    await runWithContext(context, async () => {
      const tool = wrapper(async (input: string, token: string) => {
        return { input, token }
      })

      await tool('test-input')
    })

    // Config token should be used, not context token
    expect(mockGetOAuth2Token).toHaveBeenCalledWith({
      providerName: 'test-provider',
      scopes: ['read'],
      authFlow: 'M2M',
      workloadIdentityToken: 'config-token',
      onAuthUrl: undefined,
      forceAuthentication: undefined,
      callbackUrl: undefined,
      customState: undefined,
      customParameters: undefined,
    })
  })

  it('should throw error when no token in config or context', async () => {
    const wrapper = withAccessToken({
      // NO workloadIdentityToken
      providerName: 'test-provider',
      scopes: ['read'],
      authFlow: 'M2M',
    })

    const context: RequestContext = {
      requestId: 'test-req',
      sessionId: 'test-session',
      // NO workloadAccessToken
      headers: {},
    }

    await runWithContext(context, async () => {
      const tool = wrapper(async (_input: string, _token: string) => 'success')

      await expect(tool('test-input')).rejects.toThrow(/workloadIdentityToken.*not provided/i)
    })
  })

  it('should use oauth2CallbackUrl from context when not in config', async () => {
    const mockGetOAuth2Token = vi.fn().mockResolvedValue('oauth2-token')
    vi.spyOn(IdentityClient.prototype, 'getOAuth2Token').mockImplementation(mockGetOAuth2Token)

    const wrapper = withAccessToken({
      workloadIdentityToken: 'test-token',
      providerName: 'test-provider',
      scopes: ['read'],
      authFlow: 'USER_FEDERATION',
      // NO callbackUrl in config
    })

    const context: RequestContext = {
      requestId: 'test-req',
      sessionId: 'test-session',
      workloadAccessToken: 'test-token',
      oauth2CallbackUrl: 'http://localhost:3000/callback',
      headers: {},
    }

    await runWithContext(context, async () => {
      const tool = wrapper(async (_input: string, _token: string) => 'success')
      await tool('test-input')
    })

    expect(mockGetOAuth2Token).toHaveBeenCalledWith({
      providerName: 'test-provider',
      scopes: ['read'],
      authFlow: 'USER_FEDERATION',
      workloadIdentityToken: 'test-token',
      onAuthUrl: undefined,
      forceAuthentication: undefined,
      callbackUrl: 'http://localhost:3000/callback',
      customState: undefined,
      customParameters: undefined,
    })
  })

  it('should prioritize config callbackUrl over context callbackUrl', async () => {
    const mockGetOAuth2Token = vi.fn().mockResolvedValue('oauth2-token')
    vi.spyOn(IdentityClient.prototype, 'getOAuth2Token').mockImplementation(mockGetOAuth2Token)

    const wrapper = withAccessToken({
      workloadIdentityToken: 'test-token',
      providerName: 'test-provider',
      scopes: ['read'],
      authFlow: 'USER_FEDERATION',
      callbackUrl: 'http://config-callback.com',
    })

    const context: RequestContext = {
      requestId: 'test-req',
      sessionId: 'test-session',
      workloadAccessToken: 'test-token',
      oauth2CallbackUrl: 'http://context-callback.com',
      headers: {},
    }

    await runWithContext(context, async () => {
      const tool = wrapper(async (_input: string, _token: string) => 'success')
      await tool('test-input')
    })

    // Config callbackUrl should be used
    expect(mockGetOAuth2Token).toHaveBeenCalledWith({
      providerName: 'test-provider',
      scopes: ['read'],
      authFlow: 'USER_FEDERATION',
      workloadIdentityToken: 'test-token',
      onAuthUrl: undefined,
      forceAuthentication: undefined,
      callbackUrl: 'http://config-callback.com',
      customState: undefined,
      customParameters: undefined,
    })
  })

  it('should work with explicit token even outside context', async () => {
    const mockGetOAuth2Token = vi.fn().mockResolvedValue('oauth2-token')
    vi.spyOn(IdentityClient.prototype, 'getOAuth2Token').mockImplementation(mockGetOAuth2Token)

    const wrapper = withAccessToken({
      workloadIdentityToken: 'explicit-token',
      providerName: 'test-provider',
      scopes: ['read'],
      authFlow: 'M2M',
    })

    // Call WITHOUT runWithContext
    const tool = wrapper(async (input: string, token: string) => {
      return { input, token }
    })

    const result = await tool('test-input')
    expect(result.token).toBe('oauth2-token')

    expect(mockGetOAuth2Token).toHaveBeenCalledWith({
      providerName: 'test-provider',
      scopes: ['read'],
      authFlow: 'M2M',
      workloadIdentityToken: 'explicit-token',
      onAuthUrl: undefined,
      forceAuthentication: undefined,
      callbackUrl: undefined,
      customState: undefined,
      customParameters: undefined,
    })
  })

  it('should throw descriptive error when no token and no context', async () => {
    const wrapper = withAccessToken({
      // NO workloadIdentityToken
      providerName: 'test-provider',
      scopes: ['read'],
      authFlow: 'M2M',
    })

    // Call WITHOUT runWithContext
    const tool = wrapper(async (_input: string, _token: string) => 'success')

    await expect(tool('test-input')).rejects.toThrow(/workloadIdentityToken.*not provided.*no context available/i)
  })

  it('should maintain context isolation across concurrent requests', async () => {
    const mockGetOAuth2Token = vi.fn().mockImplementation(async (request) => {
      // Simulate async delay
      await new Promise((resolve) => setTimeout(resolve, 10))
      return `oauth2-token-${request.workloadIdentityToken}`
    })
    vi.spyOn(IdentityClient.prototype, 'getOAuth2Token').mockImplementation(mockGetOAuth2Token)

    const wrapper = withAccessToken({
      providerName: 'test-provider',
      scopes: ['read'],
      authFlow: 'M2M',
    })

    const context1: RequestContext = {
      requestId: 'req-1',
      sessionId: 'session-1',
      workloadAccessToken: 'token-1',
      headers: {},
    }

    const context2: RequestContext = {
      requestId: 'req-2',
      sessionId: 'session-2',
      workloadAccessToken: 'token-2',
      headers: {},
    }

    // Run concurrently
    const [result1, result2] = await Promise.all([
      runWithContext(context1, async () => {
        const tool = wrapper(async (input: string, token: string) => {
          return { input, token }
        })
        return tool('input-1')
      }),
      runWithContext(context2, async () => {
        const tool = wrapper(async (input: string, token: string) => {
          return { input, token }
        })
        return tool('input-2')
      }),
    ])

    // Each should use its own context token
    expect(result1.token).toBe('oauth2-token-token-1')
    expect(result2.token).toBe('oauth2-token-token-2')
  })
})

describe('withApiKey context integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should use workloadIdentityToken from context when not in config', async () => {
    const mockGetApiKey = vi.fn().mockResolvedValue('api-key-from-context')
    vi.spyOn(IdentityClient.prototype, 'getApiKey').mockImplementation(mockGetApiKey)

    const wrapper = withApiKey({
      // NO workloadIdentityToken
      providerName: 'test-api-provider',
    })

    const context: RequestContext = {
      requestId: 'test-req',
      sessionId: 'test-session',
      workloadAccessToken: 'context-token',
      headers: {},
    }

    await runWithContext(context, async () => {
      const tool = wrapper(async (input: string, apiKey: string) => {
        return { input, apiKey }
      })

      const result = await tool('test-input')
      expect(result.apiKey).toBe('api-key-from-context')
    })

    expect(mockGetApiKey).toHaveBeenCalledWith({
      providerName: 'test-api-provider',
      workloadIdentityToken: 'context-token',
    })
  })

  it('should prioritize config token over context token', async () => {
    const mockGetApiKey = vi.fn().mockResolvedValue('api-key')
    vi.spyOn(IdentityClient.prototype, 'getApiKey').mockImplementation(mockGetApiKey)

    const wrapper = withApiKey({
      workloadIdentityToken: 'config-token',
      providerName: 'test-api-provider',
    })

    const context: RequestContext = {
      requestId: 'test-req',
      sessionId: 'test-session',
      workloadAccessToken: 'context-token',
      headers: {},
    }

    await runWithContext(context, async () => {
      const tool = wrapper(async (input: string, apiKey: string) => {
        return { input, apiKey }
      })

      await tool('test-input')
    })

    // Config token should be used, not context token
    expect(mockGetApiKey).toHaveBeenCalledWith({
      providerName: 'test-api-provider',
      workloadIdentityToken: 'config-token',
    })
  })

  it('should throw error when no token available', async () => {
    const wrapper = withApiKey({
      // NO workloadIdentityToken
      providerName: 'test-api-provider',
    })

    const context: RequestContext = {
      requestId: 'test-req',
      sessionId: 'test-session',
      // NO workloadAccessToken
      headers: {},
    }

    await runWithContext(context, async () => {
      const tool = wrapper(async (_input: string, _apiKey: string) => 'success')

      await expect(tool('test-input')).rejects.toThrow(/workloadIdentityToken.*not provided/i)
    })
  })

  it('should work with explicit token even outside context', async () => {
    const mockGetApiKey = vi.fn().mockResolvedValue('api-key')
    vi.spyOn(IdentityClient.prototype, 'getApiKey').mockImplementation(mockGetApiKey)

    const wrapper = withApiKey({
      workloadIdentityToken: 'explicit-token',
      providerName: 'test-api-provider',
    })

    // Call WITHOUT runWithContext
    const tool = wrapper(async (input: string, apiKey: string) => {
      return { input, apiKey }
    })

    const result = await tool('test-input')
    expect(result.apiKey).toBe('api-key')

    expect(mockGetApiKey).toHaveBeenCalledWith({
      providerName: 'test-api-provider',
      workloadIdentityToken: 'explicit-token',
    })
  })
})
