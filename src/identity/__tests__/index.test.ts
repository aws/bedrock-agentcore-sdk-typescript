import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { IdentityClient, withAccessToken, withApiKey } from '../index'
import type { OAuth2TokenRequest, ApiKeyRequest, OAuth2WrapperConfig, ApiKeyWrapperConfig } from '../index'

describe('Identity Module Exports', () => {
  let originalRegion: string | undefined

  beforeAll(() => {
    originalRegion = process.env.AWS_REGION
    process.env.AWS_REGION = 'us-west-2'
  })

  afterAll(() => {
    if (originalRegion) {
      process.env.AWS_REGION = originalRegion
    } else {
      delete process.env.AWS_REGION
    }
  })
  it('should export IdentityClient', () => {
    expect(IdentityClient).toBeDefined()
    expect(typeof IdentityClient).toBe('function')
  })

  it('should export withAccessToken', () => {
    expect(withAccessToken).toBeDefined()
    expect(typeof withAccessToken).toBe('function')
  })

  it('should export withApiKey', () => {
    expect(withApiKey).toBeDefined()
    expect(typeof withApiKey).toBe('function')
  })

  it('should export types', () => {
    // Type-only test - if this compiles, types are exported
    const _oauth2Request: OAuth2TokenRequest = {
      providerName: 'test',
      scopes: ['read'],
      authFlow: 'M2M',
      workloadIdentityToken: 'token',
    }

    const _apiKeyRequest: ApiKeyRequest = {
      providerName: 'test',
      workloadIdentityToken: 'token',
    }

    const _oauth2Config: OAuth2WrapperConfig = {
      providerName: 'test',
      scopes: ['read'],
      authFlow: 'M2M',
    }

    const _apiKeyConfig: ApiKeyWrapperConfig = {
      providerName: 'test',
    }

    expect(true).toBe(true)
  })

  it('should allow creating IdentityClient instance', () => {
    const client = new IdentityClient()
    expect(client).toBeDefined()
  })
})
