/**
 * Utility functions for constructing AWS service endpoints.
 */

/**
 * Environment variable for overriding the data plane endpoint.
 */
const ENDPOINT_OVERRIDE_ENV = 'BEDROCK_AGENTCORE_DATA_PLANE_ENDPOINT'

/**
 * Environment variable for overriding the gateway MCP endpoint.
 */
const GATEWAY_ENDPOINT_OVERRIDE_ENV = 'BEDROCK_AGENTCORE_GATEWAY_ENDPOINT'

/**
 * A gateway identifier becomes the first DNS label of the endpoint host, so it is
 * restricted to what a label allows. This rejects an ARN, which is the mistake
 * this validation exists to catch.
 */
const GATEWAY_ID_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/

/**
 * Region names are lowercase alphanumerics and hyphens, such as `us-east-1`.
 * Validated because it is interpolated into a hostname.
 */
const REGION_PATTERN = /^[a-z0-9-]+$/

/**
 * Gets the data plane endpoint for the Bedrock AgentCore service.
 *
 * The endpoint can be overridden using the BEDROCK_AGENTCORE_DATA_PLANE_ENDPOINT
 * environment variable. Otherwise, it follows the standard AWS endpoint pattern.
 *
 * @param region - AWS region (e.g., 'us-west-2', 'us-east-1')
 * @returns Full HTTPS endpoint URL
 *
 * @example
 * ```typescript
 * const endpoint = getDataPlaneEndpoint('us-west-2')
 * // Returns: 'https://bedrock-agentcore.us-west-2.amazonaws.com'
 * ```
 *
 * @example
 * With environment variable override:
 * ```typescript
 * process.env.BEDROCK_AGENTCORE_DATA_PLANE_ENDPOINT = 'https://custom-endpoint.example.com'
 * const endpoint = getDataPlaneEndpoint('us-west-2')
 * // Returns: 'https://custom-endpoint.example.com'
 * ```
 */
export function getDataPlaneEndpoint(region: string): string {
  // Validate region is not empty
  if (!region || region.trim() === '') {
    throw new Error('Region cannot be empty')
  }

  // Check for environment variable override
  const override = process.env[ENDPOINT_OVERRIDE_ENV]
  if (override) {
    return override
  }

  // Return standard AWS endpoint pattern
  return `https://bedrock-agentcore.${region}.amazonaws.com`
}

/**
 * Builds the streamable HTTP MCP endpoint for an AgentCore Gateway.
 *
 * This is the URL an MCP client posts to, and the URL a SigV4 signature for a
 * gateway call is computed over.
 *
 * The endpoint can be overridden using the BEDROCK_AGENTCORE_GATEWAY_ENDPOINT
 * environment variable.
 *
 * @param gatewayId - Gateway identifier, not an ARN (e.g. 'my-gateway-abc123')
 * @param region - AWS region the gateway lives in (e.g. 'us-east-1')
 * @returns Full HTTPS endpoint URL, including the /mcp path
 *
 * @throws Error if the gateway identifier is not a valid DNS label, or if the
 * region is empty or malformed.
 *
 * @example
 * ```typescript
 * const endpoint = getGatewayMcpEndpoint('my-gateway-abc123', 'us-east-1')
 * // Returns: 'https://my-gateway-abc123.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp'
 * ```
 */
export function getGatewayMcpEndpoint(gatewayId: string, region: string): string {
  if (!gatewayId || !GATEWAY_ID_PATTERN.test(gatewayId)) {
    throw new Error(
      `Invalid gateway identifier: '${gatewayId}'. Expected a gateway ID such as 'my-gateway-abc123', not an ARN or URL.`
    )
  }

  if (!region || region.trim() === '') {
    throw new Error('Region cannot be empty')
  }

  if (!REGION_PATTERN.test(region)) {
    throw new Error(`Invalid region: '${region}'. Expected a region such as 'us-east-1'.`)
  }

  // Check for environment variable override
  const override = process.env[GATEWAY_ENDPOINT_OVERRIDE_ENV]
  if (override) {
    return override
  }

  return `https://${gatewayId}.gateway.bedrock-agentcore.${region}.amazonaws.com/mcp`
}
