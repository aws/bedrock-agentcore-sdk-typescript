/**
 * Integration tests for AgentCoreHarnessAgent against a deployed AgentCore Harness.
 *
 * Prerequisites:
 * - AGENTCORE_HARNESS_ARN for a READY Harness
 * - AWS credentials and AWS_REGION for the Harness account and region
 *
 * To run: npm run test:integ -- harness-strands
 */

import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  BeforeToolCallEvent,
  FunctionTool,
  InterruptResponseContent,
  InterventionActions,
  InterventionHandler,
} from '@strands-agents/sdk'
import { AgentCoreHarnessAgent } from '../src/harness/integrations/strands/index.js'

const HARNESS_ARN = process.env.AGENTCORE_HARNESS_ARN

class ConfirmInlineFunction extends InterventionHandler {
  readonly name = 'confirm-inline-function'

  override beforeToolCall(event: BeforeToolCallEvent): ReturnType<(typeof InterventionActions)['confirm']> {
    return InterventionActions.confirm(`Approve ${event.toolUse.name}?`)
  }
}

describe.skipIf(!HARNESS_ARN)('AgentCoreHarnessAgent integration', () => {
  it('streams a deployed Harness response and continues its session', async () => {
    const agent = new AgentCoreHarnessAgent({
      harnessArn: HARNESS_ARN!,
      runtimeSessionId: randomUUID(),
    })
    const token = randomUUID()

    const events: string[] = []
    const generator = agent.stream(`Remember this token for my next message: ${token}. Reply only with "stored".`)
    let next = await generator.next()
    while (!next.done) {
      events.push(next.value.type)
      next = await generator.next()
    }
    const first = next.value
    const second = await agent.invoke('What token did I ask you to remember? Reply with only the token.')

    expect(events.at(-1)).toBe('agentCoreHarnessResultEvent')
    expect(events).toContain('agentCoreHarnessStreamUpdateEvent')
    expect(first.stopReason).toBe('endTurn')
    expect(second.stopReason).toBe('endTurn')
    expect(first.toString().length).toBeGreaterThan(0)
    expect(second.toString()).toContain(token)
  }, 120_000)

  it('registers and executes a dynamic inline function after human approval', async () => {
    const token = randomUUID()
    const functionName = `dynamic_echo_${randomUUID().replaceAll('-', '').slice(0, 8)}`
    const callback = vi.fn((input: unknown): string => `CLIENT_CALLBACK:${(input as { text: string }).text}`)
    const agent = new AgentCoreHarnessAgent({
      harnessArn: HARNESS_ARN!,
      runtimeSessionId: randomUUID(),
      tools: [
        new FunctionTool({
          name: functionName,
          description: 'Return text through the client callback',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
            additionalProperties: false,
          },
          callback,
        }),
      ],
      interventions: [new ConfirmInlineFunction()],
    })

    const interrupted = await agent.invoke(
      `Call ${functionName} exactly once with text "${token}", then include its result in your final answer.`
    )

    expect(interrupted).toMatchObject({
      stopReason: 'interrupt',
      interrupts: [{ name: 'confirm-inline-function', reason: `Approve ${functionName}?` }],
    })
    expect(callback).not.toHaveBeenCalled()

    const result = await agent.invoke([
      new InterruptResponseContent({
        interruptId: interrupted.interrupts![0]!.id,
        response: 'yes',
      }),
    ])

    expect(callback).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledWith({ text: token }, expect.anything())
    expect(result.stopReason).toBe('endTurn')
    expect(result.toString()).toContain(token)
  }, 120_000)
})
