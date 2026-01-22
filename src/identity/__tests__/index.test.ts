import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { IdentityClient } from '../client.js'
import { withAccessToken, withApiKey } from '../index.js'

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
  it('exports IdentityClient', () => {
    expect(IdentityClient).toBeDefined()
    expect(typeof IdentityClient).toBe('function')
  })

  it('exports withAccessToken', () => {
    expect(withAccessToken).toBeDefined()
    expect(typeof withAccessToken).toBe('function')
  })

  it('exports withApiKey', () => {
    expect(withApiKey).toBeDefined()
    expect(typeof withApiKey).toBe('function')
  })

  it('allows creating IdentityClient instance', () => {
    const client = new IdentityClient()
    expect(client).toBeDefined()
  })
})
