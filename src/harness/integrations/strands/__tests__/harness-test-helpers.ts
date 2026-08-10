import {
  BedrockAgentCoreClient,
  InvokeHarnessCommand,
  type InvokeHarnessStreamOutput,
} from '@aws-sdk/client-bedrock-agentcore'
import {
  BedrockAgentCoreControlClient,
  GetHarnessCommand,
  type HarnessTool,
} from '@aws-sdk/client-bedrock-agentcore-control'
import type { JSONValue } from '@strands-agents/sdk'
import { type MockInstance, vi } from 'vitest'
import { AgentCoreHarnessAgent } from '../agent.js'
import type { AgentCoreHarnessStreamUpdateEvent } from '../events.js'
import type { AgentCoreHarnessAgentConfig } from '../types.js'

export const HARNESS_ARN = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/TestHarness-abcdefghij'
export const HARNESS_ID = 'TestHarness-abcdefghij'
export const RUNTIME_SESSION_ID = 'session-id-padded-to-thirty-three'

export type SendMock = MockInstance<BedrockAgentCoreClient['send']>
export type ControlSendMock = MockInstance<BedrockAgentCoreControlClient['send']>
type HarnessEvent = AgentCoreHarnessStreamUpdateEvent['event']

export const harnessEvent = {
  messageStart: (role: 'assistant' | 'user' = 'assistant'): HarnessEvent =>
    ({ messageStart: { role } }) as HarnessEvent,
  textDelta: (text: string): HarnessEvent => ({ contentBlockDelta: { delta: { text } } }) as HarnessEvent,
  reasoningDelta: (reasoningContent: { text?: string; signature?: string }): HarnessEvent =>
    ({ contentBlockDelta: { delta: { reasoningContent } } }) as HarnessEvent,
  toolUseStart: (toolUseId: string, name: string, type: string | null = 'tool_use'): HarnessEvent => {
    const toolUse = { toolUseId, name, ...(type !== null && { type }) }
    return { contentBlockStart: { start: { toolUse } } } as HarnessEvent
  },
  toolUseDelta: (input: string): HarnessEvent =>
    ({ contentBlockDelta: { delta: { toolUse: { input } } } }) as HarnessEvent,
  toolResultStart: (toolUseId: string, status = 'success'): HarnessEvent =>
    ({ contentBlockStart: { start: { toolResult: { toolUseId, status } } } }) as HarnessEvent,
  toolResultDelta: (toolResult: Record<string, unknown>[] | string): HarnessEvent =>
    ({
      contentBlockDelta: {
        delta: { toolResult: typeof toolResult === 'string' ? [{ text: toolResult }] : toolResult },
      },
    }) as unknown as HarnessEvent,
  contentBlockStop: (): HarnessEvent => ({ contentBlockStop: {} }) as HarnessEvent,
  messageStop: (stopReason: string): HarnessEvent => ({ messageStop: { stopReason } }) as HarnessEvent,
  metadata: (usage: Record<string, number>, latencyMs: number): HarnessEvent =>
    ({ metadata: { usage, metrics: { latencyMs } } }) as unknown as HarnessEvent,
}

export async function* harnessStream(
  ...events: InvokeHarnessStreamOutput[]
): AsyncGenerator<InvokeHarnessStreamOutput> {
  yield* events
}

export function textTurn(text: string): AsyncGenerator<InvokeHarnessStreamOutput> {
  return harnessStream(
    harnessEvent.messageStart(),
    harnessEvent.textDelta(text),
    harnessEvent.contentBlockStop(),
    harnessEvent.messageStop('end_turn')
  )
}

export function inlineFunctionTurn(
  ...tools: { toolUseId: string; name: string; input: JSONValue }[]
): AsyncGenerator<InvokeHarnessStreamOutput> {
  const events: InvokeHarnessStreamOutput[] = [harnessEvent.messageStart()]
  for (const tool of tools) {
    events.push(
      harnessEvent.toolUseStart(tool.toolUseId, tool.name),
      harnessEvent.toolUseDelta(JSON.stringify(tool.input)),
      harnessEvent.contentBlockStop()
    )
  }
  events.push(harnessEvent.messageStop('tool_use'))
  return harnessStream(...events)
}

export function createMockClient(...streams: AsyncIterable<InvokeHarnessStreamOutput>[]): {
  client: BedrockAgentCoreClient
  send: SendMock
} {
  const client = new BedrockAgentCoreClient({ region: 'us-east-1' })
  const send = vi.spyOn(client, 'send')
  for (const stream of streams) {
    send.mockResolvedValueOnce({ stream } as never)
  }
  return { client, send }
}

export function commandInput(send: SendMock, index = 0): InvokeHarnessCommand['input'] {
  return (send.mock.calls[index]![0] as InvokeHarnessCommand).input
}

export function createMockControlClient(
  tools: HarnessTool[] = [],
  allowedTools?: string[]
): {
  client: BedrockAgentCoreControlClient
  send: ControlSendMock
} {
  const client = new BedrockAgentCoreControlClient({ region: 'us-east-1' })
  const send = vi.spyOn(client, 'send').mockResolvedValue({ harness: { tools, allowedTools } } as never)
  return { client, send }
}

export function getHarnessInput(send: ControlSendMock, index = 0): GetHarnessCommand['input'] {
  return (send.mock.calls[index]![0] as GetHarnessCommand).input
}

export function createHarnessAgent(config: Partial<AgentCoreHarnessAgentConfig> = {}): AgentCoreHarnessAgent {
  const { controlClient = createMockControlClient().client, ...overrides } = config
  return new AgentCoreHarnessAgent({
    harnessArn: HARNESS_ARN,
    runtimeSessionId: RUNTIME_SESSION_ID,
    controlClient,
    ...overrides,
  })
}

export async function collectGenerator<T, R>(
  generator: AsyncGenerator<T, R, undefined>
): Promise<{ items: T[]; result: R }> {
  const items: T[] = []
  let next = await generator.next()
  while (!next.done) {
    items.push(next.value)
    next = await generator.next()
  }
  return { items, result: next.value }
}
