import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { getDataPlaneEndpoint } from '../endpoints.js'

describe('getDataPlaneEndpoint', () => {
  const ENDPOINT_OVERRIDE_ENV = 'BEDROCK_AGENTCORE_DATA_PLANE_ENDPOINT'
  let originalEnvValue: string | undefined

  beforeEach(() => {
    // Save original env value
    originalEnvValue = process.env[ENDPOINT_OVERRIDE_ENV]
  })

  afterEach(() => {
    // Restore original env value
    if (originalEnvValue !== undefined) {
      process.env[ENDPOINT_OVERRIDE_ENV] = originalEnvValue
    } else {
      delete process.env[ENDPOINT_OVERRIDE_ENV]
    }
  })

  describe('when called with valid region', () => {
    it('returns standard AWS endpoint for us-west-2', () => {
      const endpoint = getDataPlaneEndpoint('us-west-2')
      expect(endpoint).toBe('https://bedrock-agentcore.us-west-2.amazonaws.com')
    })

    it('returns standard AWS endpoint for us-east-1', () => {
      const endpoint = getDataPlaneEndpoint('us-east-1')
      expect(endpoint).toBe('https://bedrock-agentcore.us-east-1.amazonaws.com')
    })

    it('returns standard AWS endpoint for eu-west-1', () => {
      const endpoint = getDataPlaneEndpoint('eu-west-1')
      expect(endpoint).toBe('https://bedrock-agentcore.eu-west-1.amazonaws.com')
    })

    it('returns standard AWS endpoint for ap-southeast-1', () => {
      const endpoint = getDataPlaneEndpoint('ap-southeast-1')
      expect(endpoint).toBe('https://bedrock-agentcore.ap-southeast-1.amazonaws.com')
    })
  })

  describe('when called with empty or invalid region', () => {
    it('throws error for empty string', () => {
      expect(() => getDataPlaneEndpoint('')).toThrow('Region cannot be empty')
    })

    it('throws error for whitespace-only string', () => {
      expect(() => getDataPlaneEndpoint('   ')).toThrow('Region cannot be empty')
    })

    it('throws error for tab-only string', () => {
      expect(() => getDataPlaneEndpoint('\t')).toThrow('Region cannot be empty')
    })

    it('throws error for newline-only string', () => {
      expect(() => getDataPlaneEndpoint('\n')).toThrow('Region cannot be empty')
    })
  })

  describe('when environment variable override is set', () => {
    it('returns override endpoint instead of standard endpoint', () => {
      process.env[ENDPOINT_OVERRIDE_ENV] = 'https://custom-endpoint.example.com'
      const endpoint = getDataPlaneEndpoint('us-west-2')
      expect(endpoint).toBe('https://custom-endpoint.example.com')
    })

    it('returns override endpoint for any region', () => {
      process.env[ENDPOINT_OVERRIDE_ENV] = 'https://override.test.com'
      expect(getDataPlaneEndpoint('us-east-1')).toBe('https://override.test.com')
      expect(getDataPlaneEndpoint('eu-west-1')).toBe('https://override.test.com')
      expect(getDataPlaneEndpoint('ap-southeast-1')).toBe('https://override.test.com')
    })

    it('returns override endpoint with custom port', () => {
      process.env[ENDPOINT_OVERRIDE_ENV] = 'https://localhost:8080'
      const endpoint = getDataPlaneEndpoint('us-west-2')
      expect(endpoint).toBe('https://localhost:8080')
    })

    it('returns override endpoint with path', () => {
      process.env[ENDPOINT_OVERRIDE_ENV] = 'https://api.example.com/bedrock'
      const endpoint = getDataPlaneEndpoint('us-west-2')
      expect(endpoint).toBe('https://api.example.com/bedrock')
    })

    it('falls back to standard endpoint when override is empty string', () => {
      process.env[ENDPOINT_OVERRIDE_ENV] = ''
      const endpoint = getDataPlaneEndpoint('us-west-2')
      expect(endpoint).toBe('https://bedrock-agentcore.us-west-2.amazonaws.com')
    })
  })

  describe('when environment variable is not set', () => {
    it('returns standard endpoint when env var is undefined', () => {
      delete process.env[ENDPOINT_OVERRIDE_ENV]
      const endpoint = getDataPlaneEndpoint('us-west-2')
      expect(endpoint).toBe('https://bedrock-agentcore.us-west-2.amazonaws.com')
    })
  })

  describe('edge cases', () => {
    it('handles region with hyphens correctly', () => {
      const endpoint = getDataPlaneEndpoint('us-gov-west-1')
      expect(endpoint).toBe('https://bedrock-agentcore.us-gov-west-1.amazonaws.com')
    })

    it('handles region with numbers correctly', () => {
      const endpoint = getDataPlaneEndpoint('cn-north-1')
      expect(endpoint).toBe('https://bedrock-agentcore.cn-north-1.amazonaws.com')
    })

    it('preserves region case in endpoint', () => {
      const endpoint = getDataPlaneEndpoint('US-WEST-2')
      expect(endpoint).toBe('https://bedrock-agentcore.US-WEST-2.amazonaws.com')
    })
  })
})
