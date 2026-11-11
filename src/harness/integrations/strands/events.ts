import type { InvokeHarnessStreamOutput } from '@aws-sdk/client-bedrock-agentcore'
import { StreamEvent, type AgentResult } from '@strands-agents/sdk'

type AgentCoreHarnessEventData = Exclude<
  InvokeHarnessStreamOutput,
  | InvokeHarnessStreamOutput.InternalServerExceptionMember
  | InvokeHarnessStreamOutput.ValidationExceptionMember
  | InvokeHarnessStreamOutput.RuntimeClientErrorMember
>

/**
 * Wraps one raw event from the `InvokeHarness` response stream.
 *
 * @experimental
 */
export class AgentCoreHarnessStreamUpdateEvent extends StreamEvent {
  readonly type = 'agentCoreHarnessStreamUpdateEvent' as const
  readonly event: AgentCoreHarnessEventData

  constructor(event: AgentCoreHarnessEventData) {
    super()
    this.event = event
  }

  toJSON(): Pick<AgentCoreHarnessStreamUpdateEvent, 'type' | 'event'> {
    return { type: this.type, event: this.event }
  }
}

/**
 * Wraps the final result yielded by an AgentCore Harness agent stream.
 *
 * @experimental
 */
export class AgentCoreHarnessResultEvent extends StreamEvent {
  readonly type = 'agentCoreHarnessResultEvent' as const
  readonly result: AgentResult

  constructor(data: { result: AgentResult }) {
    super()
    this.result = data.result
  }

  toJSON(): Pick<AgentCoreHarnessResultEvent, 'type' | 'result'> {
    return { type: this.type, result: this.result }
  }
}

/**
 * Events yielded by {@link AgentCoreHarnessAgent.stream}.
 *
 * @experimental
 */
export type AgentCoreHarnessStreamEvent = AgentCoreHarnessStreamUpdateEvent | AgentCoreHarnessResultEvent
