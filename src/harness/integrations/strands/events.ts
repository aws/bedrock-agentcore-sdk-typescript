import type { InvokeHarnessStreamOutput } from '@aws-sdk/client-bedrock-agentcore'
import { StreamEvent, type AgentResult } from '@strands-agents/sdk'

type AgentCoreHarnessEventData = Exclude<
  InvokeHarnessStreamOutput,
  | InvokeHarnessStreamOutput.InternalServerExceptionMember
  | InvokeHarnessStreamOutput.ValidationExceptionMember
  | InvokeHarnessStreamOutput.RuntimeClientErrorMember
>

/** Wraps one raw event from the `InvokeHarness` response stream. */
export class AgentCoreHarnessStreamUpdateEvent extends StreamEvent {
  readonly type = 'agentCoreHarnessStreamUpdateEvent' as const
  readonly event: AgentCoreHarnessEventData

  /**
   * Creates a Harness stream update.
   *
   * @param event - Raw non-error event received from `InvokeHarness`
   */
  constructor(event: AgentCoreHarnessEventData) {
    super()
    this.event = event
  }

  /**
   * Serializes the event.
   *
   * @returns Event type and raw Harness event
   */
  toJSON(): Pick<AgentCoreHarnessStreamUpdateEvent, 'type' | 'event'> {
    return { type: this.type, event: this.event }
  }
}

/** Wraps the final result yielded by an AgentCore Harness agent stream. */
export class AgentCoreHarnessResultEvent extends StreamEvent {
  readonly type = 'agentCoreHarnessResultEvent' as const
  readonly result: AgentResult

  /**
   * Creates a final Harness result event.
   *
   * @param data - Completed agent result
   */
  constructor(data: { result: AgentResult }) {
    super()
    this.result = data.result
  }

  /**
   * Serializes the event.
   *
   * @returns Event type and completed result
   */
  toJSON(): Pick<AgentCoreHarnessResultEvent, 'type' | 'result'> {
    return { type: this.type, result: this.result }
  }
}

/** Events yielded by {@link AgentCoreHarnessAgent.stream}. */
export type AgentCoreHarnessStreamEvent = AgentCoreHarnessStreamUpdateEvent | AgentCoreHarnessResultEvent
