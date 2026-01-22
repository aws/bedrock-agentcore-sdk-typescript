/**
 * Utility functions for constructing AWS service endpoints.
 */

/**
 * Environment variable for overriding the data plane endpoint.
 */
const ENDPOINT_OVERRIDE_ENV = 'BEDROCK_AGENTCORE_DATA_PLANE_ENDPOINT'

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
