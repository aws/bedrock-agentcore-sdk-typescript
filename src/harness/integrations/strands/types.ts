import type { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore'
import type { BedrockAgentCoreControlClient } from '@aws-sdk/client-bedrock-agentcore-control'
import type { InterventionHandler, ToolList } from '@strands-agents/sdk'

/**
 * Config for an {@link AgentCoreHarnessAgent}.
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

  /** Pre-constructed AgentCore data-plane client. */
  readonly client?: BedrockAgentCoreClient

  /** Pre-constructed AgentCore control-plane client used to load deployed Harness tools. */
  readonly controlClient?: BedrockAgentCoreControlClient

  /**
   * Local Strands tools translated into dynamic Harness inline functions and executed client-side.
   * They are merged with the deployed Harness tools for each invocation.
   */
  readonly tools?: ToolList

  /** Tool lifecycle intervention handlers applied to local inline-function callbacks. */
  readonly interventions?: InterventionHandler[]
}
