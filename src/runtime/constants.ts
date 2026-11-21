export const IDENTITY_WAT_HEADER = 'x-amz-bedrock-agentcore-identity-wat'

/**
 * Header in which AgentCore Runtime sends the build warmup call type (`memory` or `disk`).
 */
export const WARMUP_TYPE_HEADER = 'x-amzn-bedrock-agentcore-runtime-warmup-type'

/**
 * Host that hook ports bind to; AgentCore Runtime calls hooks on loopback.
 */
export const HOOK_HOST = '127.0.0.1'
