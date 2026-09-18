import { getDataPlaneEndpoint } from '../../_utils/endpoints.js'

const VALID_REGION_PATTERN = /^[a-z]{2}(-[a-z]+)+-\d+$/

/**
 * Builds the Bedrock AgentCore runtime invocation URL from an agent runtime ARN.
 *
 * A2A JSON-RPC payloads POSTed (SigV4-signed) to this URL are proxied by
 * AgentCore Runtime to the agent container's `POST /` unmodified.
 *
 * The host comes from {@link getDataPlaneEndpoint}, so the
 * `BEDROCK_AGENTCORE_DATA_PLANE_ENDPOINT` override the runtime client honours
 * applies here too.
 *
 * @param runtimeArn - The agent runtime ARN, e.g. `arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/my-agent-abc123`
 * @param region - AWS region override. When omitted, the region is extracted from the ARN.
 * @returns The full invocation URL with the ARN percent-encoded
 * @throws Error when no well-formed AWS region can be determined
 *
 * @example
 * ```typescript
 * const url = buildRuntimeUrl('arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/my-agent-abc123')
 * // 'https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/arn%3Aaws%3A.../invocations'
 * ```
 */
export function buildRuntimeUrl(runtimeArn: string, region?: string): string {
  // ARN format: arn:aws:bedrock-agentcore:<region>:<account>:runtime/<id>
  const resolved = region ?? runtimeArn.split(':')[3]
  if (!resolved || !VALID_REGION_PATTERN.test(resolved)) {
    throw new Error(
      `Invalid AWS region: ${resolved ?? '<none>'} (from arn: ${runtimeArn}). Region must match a pattern like 'us-east-1'.`
    )
  }
  // An overridden endpoint may or may not carry a trailing slash.
  const endpoint = getDataPlaneEndpoint(resolved).replace(/\/$/, '')

  // The trailing slash is load-bearing: A2A clients resolve the well-known
  // agent-card path relative to this URL, and WHATWG URL resolution drops
  // the final segment of a slashless base (…/invocations + ./.well-known/…
  // → …/.well-known/…, a 404).
  return `${endpoint}/runtimes/${encodeURIComponent(runtimeArn)}/invocations/`
}
