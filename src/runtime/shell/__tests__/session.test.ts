import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { ShellSession } from '../session.js'
import { ShellChannel } from '../protocol.js'
import type { ConnectFn, ShellSessionOptions } from '../session.js'
import type WebSocket from 'ws'

// ── Mock WebSocket factory ────────────────────────────────────────────────────
// Instead of mocking the `ws` module, we inject a fake WebSocket via the
// _wsFactory option on ShellSessionOptions. No module mocking required.

type MockWs = EventEmitter & {
  send: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  terminate: ReturnType<typeof vi.fn>
  ping: ReturnType<typeof vi.fn>
  readyState: number
}

const WS_OPEN = 1

function makeMockWs(): MockWs {
  const ws = new EventEmitter() as MockWs
  ws.send = vi.fn((...args: unknown[]) => {
    const cb = args[args.length - 1]
    if (typeof cb === 'function') (cb as () => void)()
  })
  ws.close = vi.fn()
  ws.terminate = vi.fn()
  ws.ping = vi.fn()
  ws.readyState = WS_OPEN
  return ws
}

// ── Frame helpers ─────────────────────────────────────────────────────────────

function statusFrame(payload: Record<string, unknown>): Buffer {
  return Buffer.concat([Buffer.from([ShellChannel.STATUS]), Buffer.from(JSON.stringify(payload))])
}
function stdoutFrame(text: string): Buffer {
  return Buffer.concat([Buffer.from([ShellChannel.STDOUT]), Buffer.from(text)])
}
function confirmationFrame(shellId = 'server-shell', reconnected = false): Buffer {
  return statusFrame({
    kind: 'Status',
    apiVersion: 'v1',
    metadata: { shellId: shellId, reconnected },
    status: 'Success',
  })
}
function exitFrame(code = 0): Buffer {
  if (code === 0) return statusFrame({ kind: 'Status', apiVersion: 'v1', metadata: {}, status: 'Success' })
  return statusFrame({
    kind: 'Status',
    apiVersion: 'v1',
    metadata: {},
    status: 'Failure',
    reason: 'NonZeroExitCode',
    details: { causes: [{ reason: 'ExitCode', message: String(code) }] },
  })
}
function closeFrame(): Buffer {
  return Buffer.from([ShellChannel.CLOSE])
}
function heartbeatFrame(): Buffer {
  return Buffer.from([ShellChannel.HEARTBEAT])
}

/**
 * Build a ShellSessionOptions that feeds `frames` through a mock WebSocket.
 * The wsFactory creates a MockWs EventEmitter, emits upgrade → open → frames → close
 * all via process.nextTick so listeners are registered before events fire.
 */
function makeOpts(
  frames: Buffer[],
  opts: {
    closeCode?: number
    headers?: Record<string, string>
    connectFn?: ConnectFn
  } = {}
): ShellSessionOptions & { getWs: () => MockWs } {
  let capturedWs: MockWs | null = null

  const wsFactory = (_url: string, _protocols?: string[], _options?: Record<string, unknown>): WebSocket => {
    const ws = makeMockWs()
    capturedWs = ws
    return ws as unknown as WebSocket
  }

  const connectFn: ConnectFn =
    opts.connectFn ??
    vi.fn(async (_shellId: string, _sessionId: string) => {
      process.nextTick(() => {
        const ws = capturedWs!
        ws.emit('upgrade', { headers: opts.headers ?? {} })
        ws.emit('open')
        let idx = 0
        function emitNext() {
          if (idx < frames.length) {
            ws.emit('message', frames[idx++])
            process.nextTick(emitNext)
          } else {
            process.nextTick(() => ws.emit('close', opts.closeCode ?? 1000, Buffer.from('')))
          }
        }
        process.nextTick(emitNext)
      })
      return { url: 'wss://test.local/runtimes/x/ws/shells', headers: {} }
    })

  return {
    connectFn,
    _wsFactory: wsFactory,
    getWs: () => {
      if (!capturedWs) throw new Error('WebSocket not yet created')
      return capturedWs
    },
  }
}

// Suppress console output in unit tests to avoid noise.
// Tests that assert on specific console calls use vi.spyOn(console, ...) directly.
beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ShellSession: construction', () => {
  it('auto-generates shellId and sessionId when omitted', () => {
    const session = new ShellSession(makeOpts([]))
    expect(session.shellId).toBeTruthy()
    expect(session.sessionId).toBeTruthy()
  })

  it('uses provided shellId and sessionId', () => {
    const session = new ShellSession({ ...makeOpts([]), shellId: 'my-shell', sessionId: 'my-session' })
    expect(session.shellId).toBe('my-shell')
    expect(session.sessionId).toBe('my-session')
  })

  it('throws for empty string shellId', () => {
    expect(() => new ShellSession({ ...makeOpts([]), shellId: '' })).toThrow()
  })

  it('initial attributes are correct', () => {
    const session = new ShellSession(makeOpts([]))
    expect(session.reconnected).toBe(false)
    expect(session.kicked).toBe(false)
    expect(session.bytesDropped).toBe(0)
    expect(session.exitCode).toBeNull()
  })
})

describe('ShellSession: connect', () => {
  it('reads shellId and reconnected=false from STATUS confirmation frame', async () => {
    const session = new ShellSession(makeOpts([confirmationFrame('srv-shell', false)]))
    await session.connect()
    expect(session.shellId).toBe('srv-shell')
    expect(session.reconnected).toBe(false)
  })

  it('sets reconnected=true from STATUS frame', async () => {
    const session = new ShellSession(makeOpts([confirmationFrame('s', true)]))
    await session.connect()
    expect(session.reconnected).toBe(true)
  })

  it('reads shellId and sessionId from 101 upgrade headers', async () => {
    const session = new ShellSession(
      makeOpts([confirmationFrame('hdr-shell')], {
        headers: {
          'x-amzn-bedrock-agentcore-shell-id': 'hdr-shell',
          'x-amzn-bedrock-agentcore-runtime-session-id': 'hdr-session',
        },
      })
    )
    await session.connect()
    expect(session.shellId).toBe('hdr-shell')
    expect(session.sessionId).toBe('hdr-session')
  })

  it('stashes non-STATUS frames received before confirmation', async () => {
    const session = new ShellSession(makeOpts([stdoutFrame('early'), confirmationFrame('s')]))
    await session.connect()
    const frames = []
    for await (const f of session) {
      frames.push(f)
      if (frames.length === 1) break
    }
    expect(frames[0]!.channel).toBe(ShellChannel.STDOUT)
    expect(frames[0]!.text).toBe('early')
  })

  it('proceeds with warning when STATUS confirmation times out', async () => {
    const warnSpy = vi.spyOn(console, 'warn')

    let capturedWs: MockWs | null = null
    const wsFactory = (_url: string): WebSocket => {
      const ws = makeMockWs()
      capturedWs = ws
      return ws as unknown as WebSocket
    }
    const connectFn: ConnectFn = vi.fn(async (_shellId, _sessionId) => {
      process.nextTick(() => {
        capturedWs!.emit('upgrade', { headers: {} })
        capturedWs!.emit('open')
        // No frames emitted — metadata timeout fires after DEFAULT_METADATA_TIMEOUT ms
      })
      return { url: 'wss://test.local/runtimes/x/ws/shells', headers: {} }
    })

    const session = new ShellSession({ connectFn, _wsFactory: wsFactory, logger: console })
    // AbortSignal.timeout() uses real timers — no fake timers needed, just await with real timeout
    await session.connect()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('imed out'))
  }, 15_000)
})

describe('ShellSession: iterator', () => {
  it('yields STDOUT frames in order', async () => {
    const session = new ShellSession(
      makeOpts([confirmationFrame('s'), stdoutFrame('hello'), stdoutFrame('world'), closeFrame()])
    )
    await session.connect()
    const texts: string[] = []
    for await (const f of session) {
      if (f.channel === ShellChannel.STDOUT) texts.push(f.text)
    }
    expect(texts).toEqual(['hello', 'world'])
  })

  it('swallows HEARTBEAT frames — never yields to caller', async () => {
    const session = new ShellSession(
      makeOpts([confirmationFrame('s'), heartbeatFrame(), stdoutFrame('after-hb'), closeFrame()])
    )
    await session.connect()
    const channels: ShellChannel[] = []
    for await (const f of session) channels.push(f.channel)
    expect(channels).not.toContain(ShellChannel.HEARTBEAT)
    expect(channels).toContain(ShellChannel.STDOUT)
  })

  it('stops on CLOSE frame', async () => {
    const session = new ShellSession(makeOpts([confirmationFrame('s'), stdoutFrame('x'), closeFrame()]))
    await session.connect()
    let count = 0
    for await (const _ of session) count++
    expect(count).toBe(1)
  })

  it('stops on WebSocket close 1000', async () => {
    const session = new ShellSession(makeOpts([confirmationFrame('s'), stdoutFrame('x')], { closeCode: 1000 }))
    await session.connect()
    let count = 0
    for await (const _ of session) count++
    expect(count).toBe(1)
  })

  it('sets kicked=true on close code 4000', async () => {
    const session = new ShellSession(makeOpts([confirmationFrame('s')], { closeCode: 4000 }))
    await session.connect()
    for await (const _ of session) {
      /* drain */
    }
    expect(session.kicked).toBe(true)
  })

  it('stops on close code 1003 without reconnecting and warns', async () => {
    const warnSpy = vi.spyOn(console, 'warn')
    // reconnectConfig is present so that if 1003 incorrectly fell through to the
    // reconnect path it would trigger a retry; we assert it does not.
    const opts = makeOpts([confirmationFrame('s'), stdoutFrame('x')], { closeCode: 1003 })
    const session = new ShellSession({ ...opts, reconnectConfig: { maxRetries: 1, baseDelay: 0 }, logger: console })
    await session.connect()
    let count = 0
    for await (const _ of session) count++
    expect(count).toBe(1)
    expect((session as unknown as { _state: { status: string } })._state.status).not.toBe('open')
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('1003'))
    // connectFn called exactly once — reconnect loop was not entered
    expect((opts.connectFn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
  })

  it('stops cleanly when close() is called mid-iteration', async () => {
    const session = new ShellSession(makeOpts([confirmationFrame('s'), stdoutFrame('x')]))
    await session.connect()
    let count = 0
    for await (const _ of session) {
      count++
      await session.close()
    }
    expect(count).toBe(1)
    expect((session as unknown as { _state: { status: string } })._state.status).toBe('closed')
  })
})

describe('ShellSession: exitCode', () => {
  it('is null during STDOUT frames, set after termination STATUS', async () => {
    const session = new ShellSession(makeOpts([confirmationFrame('s'), stdoutFrame('x'), exitFrame(0)]))
    await session.connect()
    let midLoopCode: number | null | undefined
    for await (const f of session) {
      if (f.channel === ShellChannel.STDOUT) midLoopCode = session.exitCode
    }
    expect(midLoopCode).toBeNull()
    expect(session.exitCode).toBe(0)
  })

  it('exitCode=0 for clean exit (status=Success)', async () => {
    const session = new ShellSession(makeOpts([confirmationFrame('s'), exitFrame(0)]))
    await session.connect()
    for await (const _ of session) {
      /* drain */
    }
    expect(session.exitCode).toBe(0)
  })

  it('exitCode reflects non-zero exit', async () => {
    const session = new ShellSession(makeOpts([confirmationFrame('s'), exitFrame(42)]))
    await session.connect()
    for await (const _ of session) {
      /* drain */
    }
    expect(session.exitCode).toBe(42)
  })

  it('exitCode is null for platform error with no ExitCode cause', async () => {
    const errFrame = statusFrame({
      kind: 'Status',
      apiVersion: 'v1',
      metadata: {},
      status: 'Failure',
      reason: 'InternalError',
      code: 500,
    })
    const session = new ShellSession(makeOpts([confirmationFrame('s'), errFrame]))
    await session.connect()
    for await (const _ of session) {
      /* drain */
    }
    expect(session.exitCode).toBeNull()
  })

  it('exitCode set via pending-frames drain path', async () => {
    // STDOUT arrives before STATUS confirmation → gets stashed; exitCode set when STATUS drained
    const session = new ShellSession(makeOpts([stdoutFrame('stashed'), confirmationFrame('s'), exitFrame(5)]))
    await session.connect()
    const channels: ShellChannel[] = []
    for await (const f of session) channels.push(f.channel)
    expect(session.exitCode).toBe(5)
    expect(channels[0]).toBe(ShellChannel.STDOUT) // pending frame drained first
  })
})

describe('ShellSession: bytesDropped', () => {
  it('set from second confirmation frame with bytesDropped field', async () => {
    const secondConf = statusFrame({
      kind: 'Status',
      apiVersion: 'v1',
      metadata: { shellId: 's', reconnected: true, bytesDropped: 512 },
      status: 'Success',
    })
    const session = new ShellSession(
      makeOpts([confirmationFrame('s'), stdoutFrame('output'), secondConf, closeFrame()])
    )
    await session.connect()
    const channels: ShellChannel[] = []
    for await (const f of session) channels.push(f.channel)
    expect(session.bytesDropped).toBe(512)
    expect(channels).toEqual([ShellChannel.STDOUT]) // second confirmation swallowed
  })

  it('stays 0 when no ring-buffer overflow', async () => {
    const session = new ShellSession(makeOpts([confirmationFrame('s'), closeFrame()]))
    await session.connect()
    for await (const _ of session) {
      /* drain */
    }
    expect(session.bytesDropped).toBe(0)
  })
})

describe('ShellSession: close()', () => {
  it('transitions to closed state after close()', async () => {
    const session = new ShellSession(makeOpts([confirmationFrame('s')]))
    await session.connect()
    await session.close()
    expect((session as unknown as { _state: { status: string } })._state.status).toBe('closed')
  })

  it('is idempotent — calling twice does not throw', async () => {
    const session = new ShellSession(makeOpts([confirmationFrame('s')]))
    await session.connect()
    await session.close()
    await expect(session.close()).resolves.toBeUndefined()
  })

  it('send() throws after close()', async () => {
    const session = new ShellSession(makeOpts([confirmationFrame('s')]))
    await session.connect()
    await session.close()
    await expect(session.send('hello\n')).rejects.toThrow()
  })
})

describe('ShellSession: keepalive', () => {
  it('calls ws.ping() on the interval and stops after close()', async () => {
    vi.useFakeTimers()
    const opts = makeOpts([confirmationFrame('s')])
    const session = new ShellSession({ ...opts, keepaliveIntervalMs: 1000 })
    await session.connect()

    const ws = opts.getWs()
    expect(ws.ping).not.toHaveBeenCalled()

    // Advance past one keepalive interval — ping should fire
    await vi.advanceTimersByTimeAsync(1000)
    expect(ws.ping).toHaveBeenCalledTimes(1)

    // Advance again — ping fires again
    await vi.advanceTimersByTimeAsync(1000)
    expect(ws.ping).toHaveBeenCalledTimes(2)

    // close() stops the keepalive timer
    await session.close()
    await vi.advanceTimersByTimeAsync(2000)
    expect(ws.ping).toHaveBeenCalledTimes(2) // no more pings after close

    vi.useRealTimers()
  })

  it('keepalive disabled when keepaliveIntervalMs=0', async () => {
    vi.useFakeTimers()
    const opts = makeOpts([confirmationFrame('s')])
    const session = new ShellSession({ ...opts, keepaliveIntervalMs: 0 })
    await session.connect()

    await vi.advanceTimersByTimeAsync(5000)
    expect(opts.getWs().ping).not.toHaveBeenCalled()

    await session.close()
    vi.useRealTimers()
  })

  it('keepalive timer is stopped when iterator finishes naturally', async () => {
    vi.useFakeTimers()
    const opts = makeOpts([confirmationFrame('s')], { closeCode: 1000 })
    const session = new ShellSession({ ...opts, keepaliveIntervalMs: 500 })
    await session.connect()

    for await (const _ of session) {
      /* drain */
    }

    const callsBefore = opts.getWs().ping.mock.calls.length
    await vi.advanceTimersByTimeAsync(2000)
    // No additional pings after iterator ends
    expect(opts.getWs().ping.mock.calls.length).toBe(callsBefore)

    vi.useRealTimers()
  })
})

describe('ShellSession: connect() state guards', () => {
  it('throws when called on an already-closed session', async () => {
    const session = new ShellSession(makeOpts([confirmationFrame('s')]))
    await session.connect()
    await session.close()
    await expect(session.connect()).rejects.toThrow('closed')
  })

  it('throws when called while already connecting/open', async () => {
    const session = new ShellSession(makeOpts([confirmationFrame('s')]))
    await session.connect()
    await expect(session.connect()).rejects.toThrow('idle')
  })

  it('throws after close() fires mid-flight', async () => {
    // connectFn suspends so we can race close() during the await
    let resolveConnect!: () => void
    const connectFn: ConnectFn = vi.fn(async () => {
      await new Promise<void>((res) => {
        resolveConnect = res
      })
      return { url: 'wss://test.local/runtimes/x/ws/shells', headers: {} }
    })
    const session = new ShellSession({ connectFn, _wsFactory: makeOpts([]).getWs as never })
    const connectP = session.connect()
    await session.close()
    resolveConnect()
    await expect(connectP).rejects.toThrow('closed')
  })
})

describe('ShellSession: HEARTBEAT in pendingFrames', () => {
  it('does not yield a HEARTBEAT that arrived before STATUS confirmation', async () => {
    // HEARTBEAT arrives before the confirmation STATUS — it ends up in pendingFrames.
    // The pendingFrames drain must filter it out just like the main loop does.
    const session = new ShellSession(
      makeOpts([heartbeatFrame(), confirmationFrame('s'), stdoutFrame('hi'), closeFrame()])
    )
    await session.connect()
    const channels: ShellChannel[] = []
    for await (const f of session) channels.push(f.channel)
    expect(channels).not.toContain(ShellChannel.HEARTBEAT)
    expect(channels).toContain(ShellChannel.STDOUT)
  })
})

describe('ShellSession: reconnectWindow null = unlimited', () => {
  it('does not expire and reconnects when reconnectWindow is null', async () => {
    let callCount = 0
    let capturedWs: MockWs | null = null

    const wsFactory = (_url: string): WebSocket => {
      const ws = makeMockWs()
      capturedWs = ws
      return ws as unknown as WebSocket
    }

    const connectFn: ConnectFn = vi.fn(async (_shellId, _sessionId) => {
      const thisCallCount = ++callCount
      process.nextTick(() => {
        const ws = capturedWs!
        ws.emit('upgrade', { headers: {} })
        ws.emit('open')
        process.nextTick(() => {
          ws.emit('message', confirmationFrame('s'))
          process.nextTick(() => {
            if (thisCallCount === 1) {
              ws.emit('close', 1006, Buffer.from('')) // abnormal → triggers reconnect
            } else {
              ws.emit('message', closeFrame()) // clean close on second call
            }
          })
        })
      })
      return { url: 'wss://test.local/runtimes/x/ws/shells', headers: {} }
    })

    const session = new ShellSession({
      connectFn,
      _wsFactory: wsFactory,
      reconnectConfig: { maxRetries: 1, baseDelay: 0, reconnectWindow: null },
    })

    await session.connect()
    for await (const _ of session) {
      /* drain */
    }
    expect(callCount).toBeGreaterThanOrEqual(2)
  })
})
