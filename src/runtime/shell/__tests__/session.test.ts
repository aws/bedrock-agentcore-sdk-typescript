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

  const wsFactory = (_url: string, _protocols?: string[], _options?: import('ws').ClientOptions): WebSocket => {
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
    expect(session.kicked).toBe(false)
    expect(session.exitCode).toBeNull()
  })
})

describe('ShellSession: connect', () => {
  it('reads shellId and sessionId from 101 upgrade headers', async () => {
    const session = new ShellSession(
      makeOpts([], {
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
})

describe('ShellSession: iterator', () => {
  it('yields STDOUT frames in order', async () => {
    const session = new ShellSession(makeOpts([stdoutFrame('hello'), stdoutFrame('world'), closeFrame()]))
    await session.connect()
    const texts: string[] = []
    for await (const f of session) {
      if (f.channel === ShellChannel.STDOUT) texts.push(f.text)
    }
    expect(texts).toEqual(['hello', 'world'])
  })

  it('swallows HEARTBEAT frames — never yields to caller', async () => {
    const session = new ShellSession(makeOpts([heartbeatFrame(), stdoutFrame('after-hb'), closeFrame()]))
    await session.connect()
    const channels: ShellChannel[] = []
    for await (const f of session) channels.push(f.channel)
    expect(channels).not.toContain(ShellChannel.HEARTBEAT)
    expect(channels).toContain(ShellChannel.STDOUT)
  })

  it('stops on CLOSE frame', async () => {
    const session = new ShellSession(makeOpts([stdoutFrame('x'), closeFrame()]))
    await session.connect()
    let count = 0
    for await (const _ of session) count++
    expect(count).toBe(1)
  })

  it('stops on WebSocket close 1000', async () => {
    const session = new ShellSession(makeOpts([stdoutFrame('x')], { closeCode: 1000 }))
    await session.connect()
    let count = 0
    for await (const _ of session) count++
    expect(count).toBe(1)
  })

  it('sets kicked=true on close code 4000', async () => {
    const session = new ShellSession(makeOpts([], { closeCode: 4000 }))
    await session.connect()
    for await (const _ of session) {
      /* drain */
    }
    expect(session.kicked).toBe(true)
  })

  it('stops on close code 1003 without reconnecting and warns', async () => {
    const warnSpy = vi.spyOn(console, 'warn')
    const opts = makeOpts([stdoutFrame('x')], { closeCode: 1003 })
    const session = new ShellSession({ ...opts, reconnectConfig: { maxRetries: 1, baseDelay: 0 }, logger: console })
    await session.connect()
    let count = 0
    for await (const _ of session) count++
    expect(count).toBe(1)
    expect((session as unknown as { _state: { status: string } })._state.status).not.toBe('open')
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('1003'))
    expect((opts.connectFn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
  })

  it('stops cleanly when close() is called mid-iteration', async () => {
    const session = new ShellSession(makeOpts([stdoutFrame('x')]))
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
    const session = new ShellSession(makeOpts([stdoutFrame('x'), exitFrame(0)]))
    await session.connect()
    let midLoopCode: number | null | undefined
    for await (const f of session) {
      if (f.channel === ShellChannel.STDOUT) midLoopCode = session.exitCode
    }
    expect(midLoopCode).toBeNull()
    expect(session.exitCode).toBe(0)
  })

  it('exitCode=0 for clean exit (status=Success)', async () => {
    const session = new ShellSession(makeOpts([exitFrame(0)]))
    await session.connect()
    for await (const _ of session) {
      /* drain */
    }
    expect(session.exitCode).toBe(0)
  })

  it('exitCode reflects non-zero exit', async () => {
    const session = new ShellSession(makeOpts([exitFrame(42)]))
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
    const session = new ShellSession(makeOpts([errFrame]))
    await session.connect()
    for await (const _ of session) {
      /* drain */
    }
    expect(session.exitCode).toBeNull()
  })
})

describe('ShellSession: close()', () => {
  it('transitions to closed state after close()', async () => {
    const session = new ShellSession(makeOpts([]))
    await session.connect()
    await session.close()
    expect((session as unknown as { _state: { status: string } })._state.status).toBe('closed')
  })

  it('is idempotent — calling twice does not throw', async () => {
    const session = new ShellSession(makeOpts([]))
    await session.connect()
    await session.close()
    await expect(session.close()).resolves.toBeUndefined()
  })

  it('send() throws after close()', async () => {
    const session = new ShellSession(makeOpts([]))
    await session.connect()
    await session.close()
    await expect(session.send('hello\n')).rejects.toThrow()
  })
})

describe('ShellSession: disconnect handling', () => {
  // Build a session whose socket we can drive frame-by-frame, with full control over
  // when frames/close arrive — so we can drop the connection while NOT iterating.
  function manualOpts(
    opts: { reconnect?: boolean; onReconnect?: () => void | Promise<void> } = {}
  ): ShellSessionOptions & {
    sockets: MockWs[]
    confirm: () => void
  } {
    const sockets: MockWs[] = []
    const wsFactory = (): WebSocket => {
      const ws = makeMockWs()
      sockets.push(ws)
      return ws as unknown as WebSocket
    }
    const connectFn: ConnectFn = vi.fn(async () => {
      process.nextTick(() => {
        const ws = sockets[sockets.length - 1]!
        ws.emit('upgrade', { headers: {} })
        ws.emit('open')
      })
      return { url: 'wss://test.local/runtimes/x/ws/shells', headers: {} }
    })
    return {
      connectFn,
      _wsFactory: wsFactory,
      reconnectConfig: opts.reconnect
        ? {
            maxRetries: 2,
            baseDelay: 0,
            reconnectWindow: null,
            ...(opts.onReconnect && { onReconnect: opts.onReconnect }),
          }
        : undefined,
      sockets,
      confirm: () => {},
    }
  }

  it('send() after a drop with NO active iterator throws a clean error (not raw ws error)', async () => {
    // Reproduces the reported bug: terminate the socket, never iterate, then send().
    // The old code let send() reach ws.send() on a CLOSED socket → "readyState 3".
    const opts = manualOpts({ reconnect: false })
    const session = new ShellSession(opts)
    await session.connect()

    const ws = opts.sockets[0]!
    ws.readyState = 3 // CLOSED
    ws.emit('close', 1006, Buffer.from('')) // abnormal drop, no reconnectConfig
    await new Promise((r) => process.nextTick(r))

    // Throws a descriptive SDK error, specifically NOT the raw ws "readyState 3" error.
    await expect(session.send('echo hi\n')).rejects.toThrow(/not connected|not open|closed/)
    await expect(session.send('echo hi\n')).rejects.not.toThrow(/readyState 3/)
  })

  it('send() awaits an in-flight reconnect, then sends on the recovered socket', async () => {
    const opts = manualOpts({ reconnect: true })
    const session = new ShellSession(opts)
    await session.connect()

    // Drop the first socket abnormally (1006 → reconnectable). No iterator running.
    const ws0 = opts.sockets[0]!
    ws0.readyState = 3
    ws0.emit('close', 1006, Buffer.from(''))

    // send() should wait for the reconnect to produce socket #2, then write to it.
    await session.send('echo after\n')

    expect(opts.sockets.length).toBe(2)
    const ws1 = opts.sockets[1]!
    expect(ws1.send).toHaveBeenCalled() // wrote to the NEW socket
    await session.close()
  })

  it('keepalive terminates a silently-dead connection after missed pongs', async () => {
    vi.useFakeTimers()
    const opts = manualOpts({ reconnect: false })
    const session = new ShellSession({ ...opts, keepaliveIntervalMs: 1000 })
    await session.connect()
    const ws = opts.sockets[0]!

    // No pong/message ever arrives. First interval pings; by >2× interval it's declared dead.
    await vi.advanceTimersByTimeAsync(1000)
    expect(ws.ping).toHaveBeenCalledTimes(1)
    expect(ws.terminate).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2000) // now past deadAfterMs (2×1000)
    expect(ws.terminate).toHaveBeenCalled()

    await session.close()
    vi.useRealTimers()
  })

  it('a received pong keeps the connection alive (no terminate)', async () => {
    vi.useFakeTimers()
    const opts = manualOpts({ reconnect: false })
    const session = new ShellSession({ ...opts, keepaliveIntervalMs: 1000 })
    await session.connect()
    const ws = opts.sockets[0]!

    // Emit a pong each interval — liveness stays fresh, never declared dead.
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(1000)
      ws.emit('pong')
    }
    expect(ws.terminate).not.toHaveBeenCalled()
    expect(ws.ping.mock.calls.length).toBeGreaterThanOrEqual(3)

    await session.close()
    vi.useRealTimers()
  })

  const drainTick = (n = 8) =>
    (async () => {
      for (let i = 0; i < n; i++) await new Promise((r) => process.nextTick(r))
    })()

  // A socket 'error' (no close code) must NOT pre-empt the authoritative
  // 'close' code. ws emits error-then-close; the terminal 4000 must still set kicked.
  it('error-then-close(4000): terminal code wins, kicked is set (not reconnected)', async () => {
    const opts = manualOpts({ reconnect: true })
    const session = new ShellSession(opts)
    await session.connect()
    await drainTick()

    const ws = opts.sockets[0]!
    ws.readyState = 3
    ws.emit('error', new Error('socket error')) // no closeCode
    await new Promise((r) => process.nextTick(r))
    ws.emit('close', 4000, Buffer.from('replaced by new connection'))
    await drainTick()

    expect(session.kicked).toBe(true)
    // No reconnect attempt was made — only the original socket exists.
    expect(opts.sockets.length).toBe(1)
    await session.close()
  })

  // error-then-close(1003) must not reconnect.
  it('error-then-close(1003): does not reconnect', async () => {
    const opts = manualOpts({ reconnect: true })
    const session = new ShellSession(opts)
    await session.connect()
    await drainTick()

    const ws = opts.sockets[0]!
    ws.readyState = 3
    ws.emit('error', new Error('protocol error'))
    await new Promise((r) => process.nextTick(r))
    ws.emit('close', 1003, Buffer.from('text frames not supported'))
    await drainTick()

    expect(opts.sockets.length).toBe(1) // no reconnect socket created
    await session.close()
  })

  // Regression: same error-then-close(4000) but WITH an active `for await` iterator —
  // the documented primary usage. The 'error' wakes the read loop with a null-code abort
  // BEFORE the authoritative 'close' lands; the iterator must wait for 'close' rather than
  // arming a reconnect on the null code (which would swallow the terminal 4000).
  it('error-then-close(4000) with an active iterator: kicked wins, no reconnect', async () => {
    const opts = manualOpts({ reconnect: true })
    const session = new ShellSession(opts)
    await session.connect()
    const loop = (async () => {
      for await (const _ of session) {
        /* drain */
      }
    })()
    await drainTick()

    const ws = opts.sockets[0]!
    ws.readyState = 3
    ws.emit('error', new Error('socket error')) // no closeCode — wakes the read loop early
    await new Promise((r) => process.nextTick(r))
    ws.emit('close', 4000, Buffer.from('replaced by new connection'))
    await drainTick(20)

    expect(session.kicked).toBe(true)
    expect(opts.sockets.length).toBe(1) // no reconnect socket created
    await session.close()
    await loop
  })

  // Regression: error-then-close(1003) with an active iterator must not reconnect either.
  it('error-then-close(1003) with an active iterator: does not reconnect', async () => {
    const opts = manualOpts({ reconnect: true })
    const session = new ShellSession(opts)
    await session.connect()
    const loop = (async () => {
      for await (const _ of session) {
        /* drain */
      }
    })()
    await drainTick()

    const ws = opts.sockets[0]!
    ws.readyState = 3
    ws.emit('error', new Error('protocol error'))
    await new Promise((r) => process.nextTick(r))
    ws.emit('close', 1003, Buffer.from('text frames not supported'))
    await drainTick(20)

    expect(opts.sockets.length).toBe(1) // no reconnect socket created
    await session.close()
    await loop
  })

  // Regression: error-then-close(1006) with an active iterator SHOULD reconnect exactly
  // once. The close handler arms the attempt and the iterator (resuming after _waitForClose)
  // must JOIN it, not start a duplicate — so exactly one new socket is created.
  it('error-then-close(1006) with an active iterator: reconnects exactly once', async () => {
    const opts = manualOpts({ reconnect: true })
    const session = new ShellSession(opts)
    await session.connect()
    const loop = (async () => {
      for await (const _ of session) {
        /* drain */
      }
    })()
    await drainTick()

    const ws = opts.sockets[0]!
    ws.readyState = 3
    ws.emit('error', new Error('ECONNRESET'))
    await new Promise((r) => process.nextTick(r))
    ws.emit('close', 1006, Buffer.from('abnormal'))
    await drainTick(20)

    expect(opts.sockets.length).toBe(2) // reconnected on a single new socket (no duplicate)
    await session.close()
    await loop
  })

  // an onReconnect callback that calls send() must NOT deadlock.
  it('onReconnect calling send() does not deadlock', async () => {
    let sessionRef: ShellSession
    let sentInCallback = false
    const opts = manualOpts({
      reconnect: true,
      onReconnect: async () => {
        await sessionRef.send('echo replay\n')
        sentInCallback = true
      },
    })
    sessionRef = new ShellSession(opts)
    await sessionRef.connect()
    await drainTick()

    opts.sockets[0]!.readyState = 3
    opts.sockets[0]!.emit('close', 1006, Buffer.from('')) // reconnectable
    await drainTick(20)

    expect(sentInCallback).toBe(true) // would stay false if deadlocked
    expect(opts.sockets.length).toBe(2)
    expect(opts.sockets[1]!.send).toHaveBeenCalled() // replay landed on the new socket
    await sessionRef.close()
  })
})

describe('ShellSession: keepalive', () => {
  it('calls ws.ping() on the interval and stops after close()', async () => {
    vi.useFakeTimers()
    const opts = makeOpts([])
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
    const opts = makeOpts([])
    const session = new ShellSession({ ...opts, keepaliveIntervalMs: 0 })
    await session.connect()

    await vi.advanceTimersByTimeAsync(5000)
    expect(opts.getWs().ping).not.toHaveBeenCalled()

    await session.close()
    vi.useRealTimers()
  })

  it('keepalive timer is stopped when iterator finishes naturally', async () => {
    vi.useFakeTimers()
    const opts = makeOpts([], { closeCode: 1000 })
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
    const session = new ShellSession(makeOpts([]))
    await session.connect()
    await session.close()
    await expect(session.connect()).rejects.toThrow('closed')
  })

  it('throws when called while already connecting/open', async () => {
    const session = new ShellSession(makeOpts([]))
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
          if (thisCallCount === 1) {
            ws.emit('close', 1006, Buffer.from('')) // abnormal → triggers reconnect
          } else {
            ws.emit('message', closeFrame()) // clean close on second call
          }
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

describe('ShellSession: confirmation frame swallowed during iteration', () => {
  it('swallows a confirmation STATUS frame and does not yield it to caller', async () => {
    const session = new ShellSession(makeOpts([confirmationFrame('s'), stdoutFrame('after-conf'), closeFrame()]))
    await session.connect()
    const channels: ShellChannel[] = []
    for await (const f of session) channels.push(f.channel)
    // Only STDOUT should be yielded — confirmation frame is swallowed
    expect(channels).toEqual([ShellChannel.STDOUT])
  })
})

describe('ShellSession: connect ready immediately', () => {
  it('connect resolves without waiting for any inbound frames', async () => {
    // No frames at all — connect should still succeed immediately
    let capturedWs: MockWs | null = null
    const wsFactory = (_url: string): WebSocket => {
      const ws = makeMockWs()
      capturedWs = ws
      return ws as unknown as WebSocket
    }
    const connectFn: ConnectFn = vi.fn(async () => {
      process.nextTick(() => {
        capturedWs!.emit('upgrade', {
          headers: { 'x-amzn-bedrock-agentcore-shell-id': 'instant-shell' },
        })
        capturedWs!.emit('open')
        // No frames emitted at all — connect should still complete
      })
      return { url: 'wss://test.local/runtimes/x/ws/shells', headers: {} }
    })

    const session = new ShellSession({ connectFn, _wsFactory: wsFactory })
    await session.connect()
    expect(session.shellId).toBe('instant-shell')
  })
})

describe('ShellSession: socket closes between the open event and state promotion', () => {
  // 'open' and 'close' land in the same tick, so the socket is dead before the awaited open
  // race resumes _connectWithUpgrade. The close listener ignores closes while the session is
  // still 'connecting', so the promotion step must re-check the socket itself.
  function makeRaceOpts(closeCode: number) {
    const sockets: MockWs[] = []
    const wsFactory = (): WebSocket => {
      const ws = makeMockWs()
      sockets.push(ws)
      return ws as unknown as WebSocket
    }
    const connectFn: ConnectFn = vi.fn(async () => {
      process.nextTick(() => {
        const ws = sockets[sockets.length - 1]!
        ws.emit('upgrade', { headers: {} })
        ws.emit('open')
        ws.readyState = 3 // CLOSED
        ws.emit('close', closeCode, Buffer.from(''))
      })
      return { url: 'wss://test.local/runtimes/x/ws/shells', headers: {} }
    })
    return { connectFn, _wsFactory: wsFactory, sockets }
  }

  it('connect() rejects with the close code instead of resolving with a dead socket', async () => {
    const opts = makeRaceOpts(1006)
    const session = new ShellSession(opts)
    await expect(session.connect()).rejects.toThrow(/1006/)
    expect(opts.sockets[0]!.terminate).toHaveBeenCalled()
  })

  it('leaves the session idle so send() reports not-connected, not a raw readyState error', async () => {
    const session = new ShellSession(makeRaceOpts(1006))
    await expect(session.connect()).rejects.toThrow()
    await expect(session.send('x')).rejects.toThrow(/not connected/)
  })

  it('a reconnect attempt that dies at open is retried by the reconnect loop', async () => {
    const sockets: MockWs[] = []
    const wsFactory = (): WebSocket => {
      const ws = makeMockWs()
      sockets.push(ws)
      return ws as unknown as WebSocket
    }
    let callCount = 0
    const connectFn: ConnectFn = vi.fn(async () => {
      const n = ++callCount
      process.nextTick(() => {
        const ws = sockets[sockets.length - 1]!
        ws.emit('upgrade', { headers: {} })
        ws.emit('open')
        if (n === 1) {
          process.nextTick(() => ws.emit('close', 1006, Buffer.from(''))) // drop → reconnect engages
        } else if (n === 2) {
          ws.readyState = 3 // CLOSED
          ws.emit('close', 1006, Buffer.from('')) // dies in the open→promotion gap
        } else {
          process.nextTick(() => ws.emit('message', closeFrame())) // healthy reattach, then clean close
        }
      })
      return { url: 'wss://test.local/runtimes/x/ws/shells', headers: {} }
    })

    const session = new ShellSession({
      connectFn,
      _wsFactory: wsFactory,
      reconnectConfig: { maxRetries: 3, baseDelay: 0, reconnectWindow: null },
    })
    await session.connect()
    for await (const _ of session) {
      /* drain */
    }
    expect(callCount).toBe(3)
    expect(session.kicked).toBe(false)
  })
})
