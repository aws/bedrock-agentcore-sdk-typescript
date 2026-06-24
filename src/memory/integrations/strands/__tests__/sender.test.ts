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

  /** The conversational turns from a captured CreateEvent payload. */
  const turnsOf = (c: CapturedCommand) =>
    (c.input.payload as { conversational: { role: string; content: { text: string } } }[]).map((p) => ({
      role: p.conversational.role,
      text: p.conversational.content.text,
    }))

  it('packs a whole batch into ONE createEvent with role-tagged turns in order', async () => {
    const sender = makeSender(send)
    await sender.sendBatch([userMsg('hello'), asstMsg('hi there'), userMsg('again')])

    expect(send).toHaveBeenCalledTimes(1) // one call for the whole batch, not three
    expect(sent[0]!.input).toMatchObject({ memoryId: 'mem-1', actorId: 'actor-1', sessionId: 'sess-1' })
    expect(turnsOf(sent[0]!)).toEqual([
      { role: 'USER', text: 'hello' },
      { role: 'ASSISTANT', text: 'hi there' },
      { role: 'USER', text: 'again' },
    ])
  })

  it('splits into ceil(n / maxTurnsPerEvent) events when the batch exceeds the cap', async () => {
    const sender = makeSender(send, { maxTurnsPerEvent: 2 })
    await sender.sendBatch([userMsg('a'), userMsg('b'), userMsg('c'), userMsg('d'), userMsg('e')])
    expect(send).toHaveBeenCalledTimes(3) // 2 + 2 + 1
    expect(turnsOf(sent[0]!).map((t) => t.text)).toEqual(['a', 'b'])
    expect(turnsOf(sent[1]!).map((t) => t.text)).toEqual(['c', 'd'])
    expect(turnsOf(sent[2]!).map((t) => t.text)).toEqual(['e'])
  })

  it('skips messages with no extractable text (tool-only / empty) before batching', async () => {
    const sender = makeSender(send)
    await sender.sendBatch([toolOnlyMsg, userMsg('real'), { role: 'assistant', content: [{ text: '  ' }] }])
    expect(send).toHaveBeenCalledTimes(1)
    expect(turnsOf(sent[0]!)).toEqual([{ role: 'USER', text: 'real' }])
  })

  it('sets no clientToken without sequence numbers', async () => {
    const sender = makeSender(send)
    await sender.sendBatch([userMsg('x'), userMsg('y')])
    expect(sent[0]!.input.clientToken).toBeUndefined()
  })

  it('derives one deterministic seq-range clientToken per event, identical across a re-fire', async () => {
    const sender = makeSender(send)
    await sender.sendBatch([userMsg('x'), asstMsg('y'), userMsg('z')], [7, 8, 9])
    expect(send).toHaveBeenCalledTimes(1)
    // token spans [firstSeq, lastSeq] of the event
    expect(sent[0]!.input.clientToken).toBe('mem-1-actor-1-run-1-7-9')

    // Re-fire the same batch -> identical token (coordinator re-fire dedups server-side).
    sent = []
    await sender.sendBatch([userMsg('x'), asstMsg('y'), userMsg('z')], [7, 8, 9])
    expect(sent[0]!.input.clientToken).toBe('mem-1-actor-1-run-1-7-9')
  })

  it('gives each chunk its own seq-range token', async () => {
    const sender = makeSender(send, { maxTurnsPerEvent: 2 })
    await sender.sendBatch([userMsg('a'), userMsg('b'), userMsg('c')], [1, 2, 3])
    expect(sent.map((c) => c.input.clientToken)).toEqual(['mem-1-actor-1-run-1-1-2', 'mem-1-actor-1-run-1-3-3'])
  })

  it('anchors the clientToken on the run id, not sessionId (survives seq reset on session restore)', async () => {
    // Two senders with the SAME (memoryId, actorId, sessionId) but distinct runs: a restored session
    // replays seq 0.. but the run id differs, so tokens never collide.
    const a = makeSender(send, { runId: 'run-A' })
    const b = makeSender(send, { runId: 'run-B' })
    await a.sendBatch([userMsg('x')], [0])
    await b.sendBatch([userMsg('x')], [0])
    expect(sent[0]!.input.clientToken).toBe('mem-1-actor-1-run-A-0-0')
    expect(sent[1]!.input.clientToken).toBe('mem-1-actor-1-run-B-0-0')
  })

  it('defaults runId to a fresh UUID when none is supplied', async () => {
    const sender = new AgentCoreEventSender({
      client: fakeClient(send),
      memoryId: 'mem-1',
      actorId: 'actor-1',
      sessionId: 'sess-1',
    })
    await sender.sendBatch([userMsg('x')], [0])
    // mem-1-actor-1-<uuid>-0-0 : the run segment is a UUID, not the sessionId.
    const token = sent[0]!.input.clientToken as string
    expect(token).toMatch(/^mem-1-actor-1-[0-9a-f-]{36}-0-0$/)
    expect(token).not.toContain('sess-1')
  })

  it('omits the token when any covered sequence number is missing', async () => {
    const sender = makeSender(send)
    await sender.sendBatch([userMsg('x'), userMsg('y')], [7]) // second seq undefined
    expect(sent[0]!.input.clientToken).toBeUndefined()
  })

  it('starts a new event when per-message metadata changes (event metadata is per-event)', async () => {
    const sender = makeSender(send, {
      metadataProvider: (m) => ({ topic: m.content[0] && 'text' in m.content[0] ? m.content[0].text : '' }),
    })
    // Two distinct metadata signatures -> two events, even under the size cap.
    await sender.sendBatch([userMsg('alpha'), userMsg('beta')])
    expect(send).toHaveBeenCalledTimes(2)
    expect(sent[0]!.input.metadata).toEqual({ topic: { stringValue: 'alpha' } })
    expect(sent[1]!.input.metadata).toEqual({ topic: { stringValue: 'beta' } })
  })

  it('maps constant metadata to {stringValue} and shares it across the batched event', async () => {
    const sender = makeSender(send, {
      // Values must match AgentCore's metadata charset ([a-zA-Z0-9 ._:/=+@-]); numbers stringify cleanly.
      metadataProvider: () => ({ source: 'support', priority: 3 }),
    })
    await sender.sendBatch([userMsg('x'), userMsg('y')])
    expect(send).toHaveBeenCalledTimes(1) // constant metadata -> single event
    expect(sent[0]!.input.metadata).toEqual({
      source: { stringValue: 'support' },
      priority: { stringValue: '3' },
    })
  })

  it('throws a clear error for metadata values outside AgentCore’s allowed charset (before createEvent)', async () => {
    // A stringified array/object contains []{}"," which the service rejects; so do punctuation chars.
    for (const bad of [{ tags: ['a', 'b'] }, { note: 'billing,refund' }, { q: 'why?' }]) {
      const sender = makeSender(send, { metadataProvider: () => bad })
      await expect(sender.sendBatch([userMsg('x')])).rejects.toThrow(/characters AgentCore rejects/)
    }
    expect(send).not.toHaveBeenCalled() // fails before any createEvent
  })

  it('throws an AggregateError when an event fails (so the coordinator re-fires the batch)', async () => {
    const alwaysFail = vi.fn(async () => {
      throw new Error('boom')
    })
    const sender = makeSender(alwaysFail)
    await expect(sender.sendBatch([userMsg('doomed')])).rejects.toThrow(AggregateError)
    expect(alwaysFail).toHaveBeenCalledTimes(1) // no internal retry; the coordinator owns retries
  })

  it('attempts every event before throwing, and reports every failed event', async () => {
    const partial = vi.fn(async (command: CapturedCommand) => {
      const first = turnsOf(command)[0]!.text
      if (first.startsWith('bad')) throw new Error(`nope: ${first}`)
      sent.push(command)
      return {}
    })
    // cap 1 -> one event per message, so we can fail specific ones
    const sender = makeSender(partial, { maxTurnsPerEvent: 1 })
    const err = await sender.sendBatch([userMsg('good-1'), userMsg('bad-1'), userMsg('bad-2')]).catch((e) => e)
    expect(err).toBeInstanceOf(AggregateError)
    expect((err as AggregateError).errors).toHaveLength(2) // both bad-* surfaced
    expect(partial).toHaveBeenCalledTimes(3) // every event attempted (allSettled, not fail-fast)
    expect(turnsOf(sent[0]!)[0]!.text).toBe('good-1') // the good one still went through
  })

  it('resolves without sending anything when no message has extractable text', async () => {
    const sender = makeSender(send)
    await expect(sender.sendBatch([toolOnlyMsg])).resolves.toBeUndefined()
    expect(send).not.toHaveBeenCalled()
  })

  it('rejects a non-positive maxTurnsPerEvent at construction', () => {
    expect(() => makeSender(send, { maxTurnsPerEvent: 0 })).toThrow(/maxTurnsPerEvent must be a positive integer/)
  })
})
