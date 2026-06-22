import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore'
import { AgentCoreEventSender } from '../sender.js'
import type { MessageData } from '@strands-agents/sdk'

interface CapturedCommand {
  input: Record<string, unknown>
}

/** A `send` spy: a vitest mock or a plain async fn. Loosely typed so vi.fn() assigns cleanly. */
type SendFn = ((command: CapturedCommand) => Promise<unknown>) | ReturnType<typeof vi.fn>

/** Build a fake BedrockAgentCoreClient whose `send` is the supplied spy. */
function fakeClient(send: SendFn): BedrockAgentCoreClient {
  return { send } as unknown as BedrockAgentCoreClient
}

const userMsg = (text: string): MessageData => ({ role: 'user', content: [{ text }] })
const asstMsg = (text: string): MessageData => ({ role: 'assistant', content: [{ text }] })

// A minimal valid tool-only message (used to assert it is skipped).
const toolOnlyMsg: MessageData = { role: 'user', content: [{ toolUse: { toolUseId: 't1', name: 'noop', input: {} } }] }

function makeSender(
  send: SendFn,
  overrides: Partial<ConstructorParameters<typeof AgentCoreEventSender>[0]> = {}
): AgentCoreEventSender {
  return new AgentCoreEventSender({
    client: fakeClient(send),
    memoryId: 'mem-1',
    actorId: 'actor-1',
    sessionId: 'sess-1',
    runId: 'run-1', // fixed so clientToken assertions are deterministic
    ...overrides,
  })
}

describe('AgentCoreEventSender.sendBatch', () => {
  let sent: CapturedCommand[]
  let send: ReturnType<typeof vi.fn>

  beforeEach(() => {
    sent = []
    send = vi.fn(async (command: CapturedCommand) => {
      sent.push(command)
      return {}
    })
  })

  it('produces one createEvent per user/assistant message with role-tagged payload', async () => {
    const sender = makeSender(send)
    await sender.sendBatch([userMsg('hello'), asstMsg('hi there')])

    expect(send).toHaveBeenCalledTimes(2)
    expect(sent[0]!.input).toMatchObject({
      memoryId: 'mem-1',
      actorId: 'actor-1',
      sessionId: 'sess-1',
      payload: [{ conversational: { role: 'USER', content: { text: 'hello' } } }],
    })
    expect(sent[1]!.input).toMatchObject({
      payload: [{ conversational: { role: 'ASSISTANT', content: { text: 'hi there' } } }],
    })
  })

  it('skips messages with no extractable text (tool-only / empty)', async () => {
    const sender = makeSender(send)
    await sender.sendBatch([toolOnlyMsg, userMsg('real'), { role: 'assistant', content: [{ text: '  ' }] }])
    expect(send).toHaveBeenCalledTimes(1)
    expect(sent[0]!.input).toMatchObject({
      payload: [{ conversational: { role: 'USER', content: { text: 'real' } } }],
    })
  })

  it('sets no clientToken without sequence numbers', async () => {
    const sender = makeSender(send)
    await sender.sendBatch([userMsg('x')])
    expect(sent[0]!.input.clientToken).toBeUndefined()
  })

  it('derives a deterministic clientToken from sequenceNumbers, identical across calls', async () => {
    const sender = makeSender(send)
    await sender.sendBatch([userMsg('x'), asstMsg('y')], [7, 8])
    const firstTokens = sent.map((c) => c.input.clientToken)
    expect(firstTokens).toEqual(['mem-1-actor-1-run-1-7', 'mem-1-actor-1-run-1-8'])

    // Re-fire the same messages/sequence numbers -> identical tokens (re-fire dedups server-side).
    sent = []
    await sender.sendBatch([userMsg('x'), asstMsg('y')], [7, 8])
    expect(sent.map((c) => c.input.clientToken)).toEqual(firstTokens)
  })

  it('gives distinct sequence numbers distinct tokens (no false collapse of identical text)', async () => {
    const sender = makeSender(send)
    await sender.sendBatch([userMsg('ok'), userMsg('ok')], [1, 2])
    expect(sent[0]!.input.clientToken).not.toBe(sent[1]!.input.clientToken)
  })

  it('anchors the clientToken on the run id, not sessionId (survives seq reset on session restore)', async () => {
    // Two senders with the SAME (memoryId, actorId, sessionId) but distinct runs: a restored session
    // replays seq 0.. but the run id differs, so tokens never collide.
    const a = makeSender(send, { runId: 'run-A' })
    const b = makeSender(send, { runId: 'run-B' })
    await a.sendBatch([userMsg('x')], [0])
    await b.sendBatch([userMsg('x')], [0])
    expect(sent[0]!.input.clientToken).toBe('mem-1-actor-1-run-A-0')
    expect(sent[1]!.input.clientToken).toBe('mem-1-actor-1-run-B-0')
  })

  it('defaults runId to a fresh UUID when none is supplied', async () => {
    const sender = new AgentCoreEventSender({
      client: fakeClient(send),
      memoryId: 'mem-1',
      actorId: 'actor-1',
      sessionId: 'sess-1',
    })
    await sender.sendBatch([userMsg('x')], [0])
    // mem-1-actor-1-<uuid>-0 : the run segment is a UUID, not the sessionId.
    const token = sent[0]!.input.clientToken as string
    expect(token).toMatch(/^mem-1-actor-1-[0-9a-f-]{36}-0$/)
    expect(token).not.toContain('sess-1')
  })

  it('maps metadataProvider output to AgentCore {stringValue}, stringifying non-strings', async () => {
    const sender = makeSender(send, {
      metadataProvider: () => ({ source: 'support', priority: 3, tags: ['a', 'b'] }),
    })
    await sender.sendBatch([userMsg('x')])
    expect(sent[0]!.input.metadata).toEqual({
      source: { stringValue: 'support' },
      priority: { stringValue: '3' },
      tags: { stringValue: '["a","b"]' },
    })
  })

  it('throws an AggregateError when a send fails (so the coordinator re-fires the batch)', async () => {
    const alwaysFail = vi.fn(async () => {
      throw new Error('boom')
    })
    const sender = makeSender(alwaysFail)
    await expect(sender.sendBatch([userMsg('doomed')])).rejects.toThrow(AggregateError)
    expect(alwaysFail).toHaveBeenCalledTimes(1) // no internal retry; the coordinator owns retries
  })

  it('sends the whole batch before throwing, and reports every failure', async () => {
    const partial = vi.fn(async (command: CapturedCommand) => {
      const text = (command.input.payload as [{ conversational: { content: { text: string } } }])[0].conversational
        .content.text
      if (text.startsWith('bad')) throw new Error(`nope: ${text}`)
      sent.push(command)
      return {}
    })
    const sender = makeSender(partial)
    const err = await sender.sendBatch([userMsg('good-1'), userMsg('bad-1'), userMsg('bad-2')]).catch((e) => e)
    expect(err).toBeInstanceOf(AggregateError)
    expect((err as AggregateError).errors).toHaveLength(2) // both bad-* surfaced
    expect(partial).toHaveBeenCalledTimes(3) // every message attempted (allSettled, not fail-fast)
    // the good one still went through
    const goodTexts = sent.map(
      (c) => (c.input.payload as [{ conversational: { content: { text: string } } }])[0].conversational.content.text
    )
    expect(goodTexts).toEqual(['good-1'])
  })

  it('resolves without sending anything when no message has extractable text', async () => {
    const sender = makeSender(send)
    await expect(sender.sendBatch([toolOnlyMsg])).resolves.toBeUndefined()
    expect(send).not.toHaveBeenCalled()
  })
})
