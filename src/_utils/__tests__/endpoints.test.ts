import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { getDataPlaneEndpoint, getGatewayMcpEndpoint } from '../endpoints.js'

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

describe('getGatewayMcpEndpoint', () => {
  const GATEWAY_OVERRIDE_ENV = 'BEDROCK_AGENTCORE_GATEWAY_ENDPOINT'
  let originalEnvValue: string | undefined

  beforeEach(() => {
    originalEnvValue = process.env[GATEWAY_OVERRIDE_ENV]
    delete process.env[GATEWAY_OVERRIDE_ENV]
  })

  afterEach(() => {
    if (originalEnvValue !== undefined) {
      process.env[GATEWAY_OVERRIDE_ENV] = originalEnvValue
    } else {
      delete process.env[GATEWAY_OVERRIDE_ENV]
    }
  })

  describe('when called with a valid gateway id and region', () => {
    it('builds the streamable HTTP MCP URL', () => {
      expect(getGatewayMcpEndpoint('my-gateway-abc123', 'us-east-1')).toBe(
        'https://my-gateway-abc123.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp'
      )
    })

    it('works in every region web search is offered in', () => {
      expect(getGatewayMcpEndpoint('gw', 'eu-west-1')).toBe(
        'https://gw.gateway.bedrock-agentcore.eu-west-1.amazonaws.com/mcp'
      )
      expect(getGatewayMcpEndpoint('gw', 'ap-northeast-1')).toBe(
        'https://gw.gateway.bedrock-agentcore.ap-northeast-1.amazonaws.com/mcp'
      )
    })

    it('accepts a 63 character gateway id, the DNS label limit', () => {
      const id = 'a'.repeat(63)
      expect(getGatewayMcpEndpoint(id, 'us-east-1')).toContain(`https://${id}.gateway.`)
    })
  })

  describe('when the gateway identifier is not a DNS label', () => {
    it('rejects an ARN, which is the likely mistake', () => {
      expect(() =>
        getGatewayMcpEndpoint('arn:aws:bedrock-agentcore:us-east-1:123456789012:gateway/gw', 'us-east-1')
      ).toThrow(/Invalid gateway identifier/)
    })

    it('rejects a URL', () => {
      expect(() => getGatewayMcpEndpoint('https://gw.example.com', 'us-east-1')).toThrow(/Invalid gateway identifier/)
    })

    it('rejects an empty identifier', () => {
      expect(() => getGatewayMcpEndpoint('', 'us-east-1')).toThrow(/Invalid gateway identifier/)
    })

    it('rejects an identifier with a dot, which would add a host label', () => {
      expect(() => getGatewayMcpEndpoint('gw.evil', 'us-east-1')).toThrow(/Invalid gateway identifier/)
    })

    it('rejects an identifier with a slash, which would change the path', () => {
      expect(() => getGatewayMcpEndpoint('gw/../other', 'us-east-1')).toThrow(/Invalid gateway identifier/)
    })

    it('rejects an identifier that starts or ends with a hyphen', () => {
      expect(() => getGatewayMcpEndpoint('-gw', 'us-east-1')).toThrow(/Invalid gateway identifier/)
      expect(() => getGatewayMcpEndpoint('gw-', 'us-east-1')).toThrow(/Invalid gateway identifier/)
    })

    it('rejects an identifier over the DNS label limit', () => {
      expect(() => getGatewayMcpEndpoint('a'.repeat(64), 'us-east-1')).toThrow(/Invalid gateway identifier/)
    })
  })

  describe('when the region is empty or malformed', () => {
    it('throws for an empty region', () => {
      expect(() => getGatewayMcpEndpoint('gw', '')).toThrow('Region cannot be empty')
    })

    it('throws for a whitespace-only region', () => {
      expect(() => getGatewayMcpEndpoint('gw', '   ')).toThrow('Region cannot be empty')
    })

    it('throws for a region that would inject another host label', () => {
      expect(() => getGatewayMcpEndpoint('gw', 'us-east-1.evil.com')).toThrow(/Invalid region/)
    })

    it('throws for an uppercase region, since hostnames here are lowercase', () => {
      expect(() => getGatewayMcpEndpoint('gw', 'US-EAST-1')).toThrow(/Invalid region/)
    })
  })

  describe('when the environment variable override is set', () => {
    it('returns the override instead of the built URL', () => {
      process.env[GATEWAY_OVERRIDE_ENV] = 'http://localhost:8080/mcp'
      expect(getGatewayMcpEndpoint('gw', 'us-east-1')).toBe('http://localhost:8080/mcp')
    })

    it('still validates its inputs, so a typo is not hidden by an override', () => {
      process.env[GATEWAY_OVERRIDE_ENV] = 'http://localhost:8080/mcp'
      expect(() => getGatewayMcpEndpoint('gw.evil', 'us-east-1')).toThrow(/Invalid gateway identifier/)
    })

    it('falls back to the built URL when the override is an empty string', () => {
      process.env[GATEWAY_OVERRIDE_ENV] = ''
      expect(getGatewayMcpEndpoint('gw', 'us-east-1')).toBe(
        'https://gw.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp'
      )
    })
  })
})
