/**
 * Runtime invocation URL construction for the A2A protocol path.
 */

const VALID_REGION_PATTERN = /^[a-z]{2}(-[a-z]+)+-\d+$/

/**
 * Builds the Bedrock AgentCore runtime invocation URL from an agent runtime ARN.
 *
 * A2A JSON-RPC payloads POSTed (SigV4-signed) to this URL are proxied by
 * AgentCore Runtime to the agent container's `POST /` unmodified.
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
  return `https://bedrock-agentcore.${resolved}.amazonaws.com/runtimes/${encodeURIComponent(runtimeArn)}/invocations`
}
