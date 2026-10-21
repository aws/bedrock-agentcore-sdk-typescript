import type { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore'

/**
 * Config for an experimental {@link AgentCoreHarnessAgent}.
 *
 * @experimental
 */
export interface AgentCoreHarnessAgentConfig {
  /** ARN of the deployed AgentCore Harness. */
  readonly harnessArn: string

  /** Conversation session ID. Reuse it across calls to continue one Harness conversation. */
  readonly runtimeSessionId: string

  /** Identifier unique to this agent instance; defaults to `"{harnessArn}:{runtimeSessionId}"`. */
  readonly id?: string

  /** Optional name surfaced to Strands multi-agent primitives. */
  readonly name?: string

  /** Optional description surfaced to Strands multi-agent primitives. */
  readonly description?: string

  /** Pre-constructed AgentCore data-plane client configured with `maxAttempts: 1`. */
  readonly client?: BedrockAgentCoreClient
}
