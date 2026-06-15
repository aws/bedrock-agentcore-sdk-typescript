import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore'
import { AgentCoreEventSender } from '../sender.js'
import { logger } from '../logger.js'
import type { MessageData } from '../_strands-memory-types.js'
import type { DroppedEventInfo } from '../types.js'

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

function makeSender(
  send: SendFn,
  overrides: Partial<ConstructorParameters<typeof AgentCoreEventSender>[0]> = {}
): AgentCoreEventSender {
  return new AgentCoreEventSender({
    client: fakeClient(send),
    memoryId: 'mem-1',
    actorId: 'actor-1',
    sessionId: 'sess-1',
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
    await sender.sendBatch([
      { role: 'user', content: [{ toolUse: {} }] },
      userMsg('real'),
      { role: 'assistant', content: [{ text: '  ' }] },
    ])
    expect(send).toHaveBeenCalledTimes(1)
    expect(sent[0]!.input).toMatchObject({
      payload: [{ conversational: { role: 'USER', content: { text: 'real' } } }],
    })
  })

  it('sets no clientToken in v1 (no seq)', async () => {
    const sender = makeSender(send)
    await sender.sendBatch([userMsg('x')])
    expect(sent[0]!.input.clientToken).toBeUndefined()
  })

  it('derives a deterministic clientToken from sequenceNumbers, identical across calls', async () => {
    const sender = makeSender(send)
    await sender.sendBatch([userMsg('x'), asstMsg('y')], [7, 8])
    const firstTokens = sent.map((c) => c.input.clientToken)
    expect(firstTokens).toEqual(['mem-1-actor-1-sess-1-7', 'mem-1-actor-1-sess-1-8'])

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

  it('spreads metadataProvider output into the event metadata', async () => {
    const sender = makeSender(send, {
      metadataProvider: () => ({ source: { stringValue: 'support' } }),
    })
    await sender.sendBatch([userMsg('x')])
    expect(sent[0]!.input.metadata).toEqual({ source: { stringValue: 'support' } })
  })

  it('retries a failed send exactly once, then succeeds', async () => {
    let calls = 0
    const flaky = vi.fn(async (command: CapturedCommand) => {
      calls++
      if (calls === 1) throw new Error('transient')
      sent.push(command)
      return {}
    })
    const dropped: DroppedEventInfo[] = []
    const sender = makeSender(flaky, { writeOptions: { onDropped: (d) => dropped.push(d) } })
    await sender.sendBatch([userMsg('retry-me')])
    expect(flaky).toHaveBeenCalledTimes(2) // original + one retry
    expect(dropped).toHaveLength(0)
  })

  it('drops an event after the single retry also fails (reports retry-failed, never throws)', async () => {
    const alwaysFail = vi.fn(async () => {
      throw new Error('boom')
    })
    const dropped: DroppedEventInfo[] = []
    const sender = makeSender(alwaysFail, { writeOptions: { onDropped: (d) => dropped.push(d) } })
    await expect(sender.sendBatch([userMsg('doomed')])).resolves.toBeUndefined()
    expect(alwaysFail).toHaveBeenCalledTimes(2)
    expect(dropped).toEqual([{ reason: 'retry-failed', text: 'doomed', cause: expect.any(Error) }])
  })

  it('drops on timeout when a send hangs past sendTimeoutMs', async () => {
    vi.useFakeTimers()
    const hang = vi.fn(() => new Promise<unknown>(() => {})) // never resolves
    const dropped: DroppedEventInfo[] = []
    const sender = makeSender(hang as never, {
      writeOptions: { sendTimeoutMs: 50, onDropped: (d) => dropped.push(d) },
    })
    const promise = sender.sendBatch([userMsg('slow')])
    // original send hangs -> timeout fires -> retry hangs -> timeout fires
    await vi.advanceTimersByTimeAsync(50)
    await vi.advanceTimersByTimeAsync(50)
    await promise
    vi.useRealTimers()
    expect(dropped.some((d) => d.reason === 'timeout')).toBe(true)
  })

  it('never lets a throwing onDropped callback break the write path', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const alwaysFail = vi.fn(async () => {
      throw new Error('boom')
    })
    const sender = makeSender(alwaysFail, {
      writeOptions: {
        onDropped: () => {
          throw new Error('callback blew up')
        },
      },
    })
    await expect(sender.sendBatch([userMsg('x')])).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('isolates a failing send from others in the batch (allSettled)', async () => {
    const partial = vi.fn(async (command: CapturedCommand) => {
      const text = (command.input.payload as [{ conversational: { content: { text: string } } }])[0].conversational
        .content.text
      if (text === 'bad') throw new Error('nope')
      sent.push(command)
      return {}
    })
    const dropped: DroppedEventInfo[] = []
    const sender = makeSender(partial, { writeOptions: { onDropped: (d) => dropped.push(d) } })
    await sender.sendBatch([userMsg('good-1'), userMsg('bad'), userMsg('good-2')])
    // good-1 + good-2 land on first pass; bad fails twice -> dropped
    const goodTexts = sent.map(
      (c) => (c.input.payload as [{ conversational: { content: { text: string } } }])[0].conversational.content.text
    )
    expect(goodTexts).toEqual(expect.arrayContaining(['good-1', 'good-2']))
    expect(dropped).toEqual([{ reason: 'retry-failed', text: 'bad', cause: expect.any(Error) }])
  })
})
