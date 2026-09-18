import { describe, it, expect, afterEach, vi } from 'vitest'
import { buildRuntimeUrl } from '../runtime-url.js'

const RUNTIME_ARN = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/my-agent-abc123'
const ENCODED_ARN = 'arn%3Aaws%3Abedrock-agentcore%3Aus-east-1%3A123456789012%3Aruntime%2Fmy-agent-abc123'

describe('buildRuntimeUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('when region is extracted from the ARN', () => {
    it('returns the invocation URL with the ARN percent-encoded', () => {
      // Trailing slash is load-bearing for card discovery — see agentCoreRuntimeUrl.
      expect(buildRuntimeUrl(RUNTIME_ARN)).toBe(
        'https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/' +
          'arn%3Aaws%3Abedrock-agentcore%3Aus-east-1%3A123456789012%3Aruntime%2Fmy-agent-abc123/invocations/'
      )
    })
  })

  describe('when a region override is provided', () => {
    it('uses the override instead of the ARN region', () => {
      expect(buildRuntimeUrl(RUNTIME_ARN, 'eu-central-1')).toContain(
        'https://bedrock-agentcore.eu-central-1.amazonaws.com/'
      )
    })
  })

  describe('when the data plane endpoint is overridden', () => {
    it('builds the URL against the override instead of the standard AWS host', () => {
      vi.stubEnv('BEDROCK_AGENTCORE_DATA_PLANE_ENDPOINT', 'https://custom-endpoint.example.com')

      expect(buildRuntimeUrl(RUNTIME_ARN)).toBe(
        `https://custom-endpoint.example.com/runtimes/${ENCODED_ARN}/invocations/`
      )
    })

    it('does not double the separator when the override ends with a slash', () => {
      vi.stubEnv('BEDROCK_AGENTCORE_DATA_PLANE_ENDPOINT', 'https://custom-endpoint.example.com/')

      expect(buildRuntimeUrl(RUNTIME_ARN)).toBe(
        `https://custom-endpoint.example.com/runtimes/${ENCODED_ARN}/invocations/`
      )
    })
  })

  describe('when no valid region can be determined', () => {
    it('throws for malformed regions and ARNs without a region', () => {
      expect(() => buildRuntimeUrl('arn:aws:bedrock-agentcore')).toThrow(/region/i)
      expect(() => buildRuntimeUrl(RUNTIME_ARN, 'EU-CENTRAL-1')).toThrow(/region/i)
      expect(() => buildRuntimeUrl(RUNTIME_ARN, 'evil.example.com/')).toThrow(/region/i)
    })
  })
})
