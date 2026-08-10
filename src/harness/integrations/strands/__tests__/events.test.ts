import { describe, expect, it } from 'vitest'
import { AgentResult, Message, TextBlock } from '@strands-agents/sdk'
import { AgentCoreHarnessResultEvent, AgentCoreHarnessStreamUpdateEvent } from '../events.js'
import { harnessEvent } from './harness-test-helpers.js'

describe('AgentCoreHarnessStreamUpdateEvent', () => {
  it('serializes the raw Harness event', () => {
    const event = harnessEvent.textDelta('hi')

    const streamEvent = new AgentCoreHarnessStreamUpdateEvent(event as AgentCoreHarnessStreamUpdateEvent['event'])

    expect(streamEvent.toJSON()).toStrictEqual({
      type: 'agentCoreHarnessStreamUpdateEvent',
      event,
    })
  })
})

describe('AgentCoreHarnessResultEvent', () => {
  it('serializes the result without a private agent reference', () => {
    const result = new AgentResult({
      stopReason: 'endTurn',
      lastMessage: new Message({ role: 'assistant', content: [new TextBlock('done')] }),
      invocationState: {},
    })

    const resultEvent = new AgentCoreHarnessResultEvent({ result })

    expect(resultEvent.toJSON()).toStrictEqual({ type: 'agentCoreHarnessResultEvent', result })
    expect(resultEvent).not.toHaveProperty('agent')
  })
})
