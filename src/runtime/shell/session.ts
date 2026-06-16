/**
 * ShellSession — async-iterable interactive PTY WebSocket session.
 *
 * Connects on `connect()`, reads the initial STATUS confirmation frame, and exposes
 * typed `send()` / `resize()` / `[Symbol.asyncIterator]()` / `close()`.
 *
 * When `reconnectConfig` is provided, transparently reconnects on unexpected disconnects
 * using the same `shellId` so the shell's working directory, environment, background jobs,
 * and up to 256 KB of buffered output are preserved.
 *
 * @example
 * ```typescript
 * const shell = await client.openShell({ runtimeArn })
 * try {
 *   await shell.send('cat /etc/os-release\n')
 *   for await (const frame of shell) {
 *     if (frame.channel === ShellChannel.STDOUT) process.stdout.write(frame.text)
 *   }
 * } finally {
 *   await shell.close()
 * }
 * ```
 */

import WebSocket from 'ws'
import type { RawData, ClientOptions } from 'ws'
import type { IncomingMessage } from 'http'
import { once, on } from 'events'
import { randomUUID } from 'crypto'
import { Buffer } from 'buffer'
import { ShellFramer, ShellChannel, type ShellFrame } from './protocol.js'
import { validateShellId } from './validation.js'
import {
  DEFAULT_BASE_DELAY,
  DEFAULT_KEEPALIVE_INTERVAL,
  DEFAULT_MAX_DELAY,
  DEFAULT_MAX_RETRIES,
  DEFAULT_METADATA_TIMEOUT,
  DEFAULT_OUTER_LOOP_DELAY,
  DEFAULT_RECONNECT_WINDOW,
  noopLogger,
  type Logger,
  type ReconnectConfig,
} from './config.js'

/** Header names in the 101 Switching Protocols response (lowercase per HTTP/1.1). */
const SESSION_HEADER = 'x-amzn-bedrock-agentcore-runtime-session-id'
const SHELL_ID_HEADER = 'x-amzn-bedrock-agentcore-shell-id'

/**
 * Callback that produces connection params for a new WebSocket.
 * Receives the current `shellId` and `sessionId` so both can be embedded in the
 * signed URL/headers. Both values are server-confirmed and may differ from the
 * values originally passed to `openShell` after the first connection.
 */
export type ConnectFn = (
  shellId: string,
  sessionId: string
) => Promise<{
  url: string
  headers: Record<string, string>
  /** WebSocket subprotocols — used by OAuth auth (base64UrlBearerAuthorization). */
  protocols?: string[]
}>

/** Options for constructing a ShellSession. */
export interface ShellSessionOptions {
  connectFn: ConnectFn
  shellId?: string | undefined
  sessionId?: string | undefined
  reconnectConfig?: ReconnectConfig | undefined
  /**
   * Interval in milliseconds between RFC 6455 Ping frames sent to keep the connection
   * alive through the KARP proxy (~60s idle timeout). Defaults to 30000ms.
   * Set to 0 to disable keepalive (e.g. when the caller manages pings externally).
   */
  keepaliveIntervalMs?: number | undefined
  /**
   * Optional logger for diagnostic output. When omitted, all logging is silent.
   * Pass `console` to enable, or any object implementing `{ debug, info, warn }`.
   */
  logger?: Logger | undefined
  /**
   * Optional WebSocket factory for testing — overrides `new WebSocket(...)`.
   * @internal
   */
  _wsFactory?: ((url: string, protocols?: string[], options?: ClientOptions) => WebSocket) | undefined
}

// ── Session state machine ─────────────────────────────────────────────────────
//
// Transitions:
//   idle → connecting              connect() called
//   connecting → open              upgrade + metadata handshake succeeded
//   connecting → closed            close() called during upgrade
//   connecting → (throws)          upgrade failed; caller retries or surfaces error
//   open → reconnecting            WS dropped; _iterate catches the error
//   open → closed                  close() called
//   reconnecting → connecting      backoff sleep done; _runInnerRetryLoop retries
//   reconnecting → closed          close() called, or reconnect budget exhausted
//
// _abortController is kept as a class field (not inside the union) because it must
// be accessible from close() in both 'connecting' and 'open' states — it is created
// partway through _connectWithUpgrade() before the open state is established.
// _sessionController is session-lifetime and never goes into the union.

type SessionState =
  | { status: 'idle' }
  | { status: 'connecting'; ws: WebSocket | null }
  | {
      status: 'open'
      ws: WebSocket
      messageIterator: AsyncIterableIterator<unknown[]>
      keepaliveTimer: ReturnType<typeof globalThis.setInterval> | null
      pendingFrames: ShellFrame[]
    }
  | { status: 'reconnecting' }
  | { status: 'closed' }

/**
 * Async-iterable shell session wrapping a live PTY WebSocket.
 *
 * Read-only observable attributes (updated by the session as events arrive):
 * - `shellId`      — Server-confirmed shell identifier. Preserve to reconnect to the same PTY.
 * - `sessionId`    — Runtime session ID routing to the VM.
 * - `reconnected`  — True when the most recent connect reattached an existing PTY.
 * - `kicked`       — True when another client connected with the same shellId (close 4000).
 *                    Check this after the `for await` loop exits to distinguish a kick from
 *                    a clean shell exit.
 * - `bytesDropped` — PTY ring-buffer bytes lost during the most recent disconnect, as
 *                    reported by the server in the reconnect confirmation frame.
 *                    Zero if no overflow occurred or on a fresh connection.
 * - `exitCode`     — Shell process exit code. `null` until the shell exits; `0` for a clean
 *                    exit. Check this after the `for await` loop exits alongside `kicked`.
 */
export class ShellSession implements AsyncIterable<ShellFrame> {
  private _shellId: string
  private _sessionId: string
  private _reconnected = false
  private _kicked = false
  private _bytesDropped = 0
  private _exitCode: number | null = null

  /** Server-confirmed shell identifier. */
  get shellId(): string {
    return this._shellId
  }
  /** Runtime session ID routing to the VM. */
  get sessionId(): string {
    return this._sessionId
  }
  /** True when the most recent connect reattached an existing PTY. */
  get reconnected(): boolean {
    return this._reconnected
  }
  /**
   * True when another client connected with the same shellId (close 4000).
   * Check after the `for await` loop exits to distinguish a kick from a clean exit.
   */
  get kicked(): boolean {
    return this._kicked
  }
  /**
   * PTY ring-buffer bytes lost during the most recent disconnect.
   * Zero when no overflow occurred or on a fresh connection.
   */
  get bytesDropped(): number {
    return this._bytesDropped
  }
  /**
   * Shell process exit code. `null` until the shell exits; `0` for a clean exit.
   * Check after the `for await` loop exits alongside `kicked`.
   */
  get exitCode(): number | null {
    return this._exitCode
  }

  private readonly connectFn: ConnectFn
  private readonly reconnectConfig: ReconnectConfig | undefined
  private readonly keepaliveIntervalMs: number
  private readonly log: Logger
  private readonly framer = new ShellFramer()
  private readonly _wsFactory: (url: string, protocols?: string[], options?: ClientOptions) => WebSocket
  private _state: SessionState = { status: 'idle' }
  private _abortController: AbortController | null = null
  private readonly _sessionController = new AbortController()
  private _closeError: (Error & { closeCode?: number }) | null = null

  constructor(opts: ShellSessionOptions) {
    this.connectFn = opts.connectFn
    if (opts.shellId != null) validateShellId(opts.shellId)
    this._shellId = opts.shellId ?? randomUUID()
    this._sessionId = opts.sessionId ?? randomUUID()
    this.reconnectConfig = opts.reconnectConfig
    this.keepaliveIntervalMs = opts.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL
    this.log = opts.logger ?? noopLogger
    this._wsFactory =
      opts._wsFactory ??
      ((url: string, protocols?: string[], options?: ClientOptions): WebSocket =>
        protocols?.length ? new WebSocket(url, protocols, options) : new WebSocket(url, options))
  }

  /** Connect and read the initial STATUS metadata frame. */
  async connect(): Promise<this> {
    if (this._state.status === 'closed') throw new Error('ShellSession is closed')
    if (this._state.status !== 'idle') {
      throw new Error(`ShellSession.connect() requires idle state (current: ${this._state.status})`)
    }
    await this._connectWithUpgrade()
    // _connectWithUpgrade returns void (not throw) when close() fires mid-flight.
    if (this._isClosed()) throw new Error('ShellSession was closed during connect()')
    return this
  }

  /**
   * Send text or raw bytes to the shell's stdin.
   * Pass a string for text commands; pass a Buffer for binary/escape sequences.
   */
  async send(data: string | Buffer): Promise<void> {
    if (this._state.status !== 'open') throw new Error('ShellSession is not connected')
    await this._wsSend(this._state.ws, this.framer.encodeStdin(data))
  }

  /** Send a HEARTBEAT frame (0x05) to the server. */
  async sendHeartbeat(): Promise<void> {
    if (this._state.status !== 'open') throw new Error('ShellSession is not connected')
    await this._wsSend(this._state.ws, this.framer.encodeHeartbeat())
  }

  /** Resize the terminal PTY. */
  async resize(width: number, height: number): Promise<void> {
    if (this._state.status !== 'open') throw new Error('ShellSession is not connected')
    await this._wsSend(this._state.ws, this.framer.encodeResize(width, height))
  }

  /** Send a CLOSE frame (0xFF) to permanently kill the shell, then close the WebSocket.
   *  The server kills the shell process (SIGHUP → SIGKILL) and responds with its own [0xFF].
   *  Unlike dropping the WebSocket (which detaches and allows reconnection), this is permanent. */
  async close(): Promise<void> {
    const prev = this._state
    if (prev.status === 'closed') {
      this.log.debug(`ShellSession: close() called on already-closed session (shellId=${this.shellId})`)
      return
    }
    // Atomic transition — any concurrent code checks _state.status === 'closed'.
    this._state = { status: 'closed' }
    // Abort per-connection iterator (unblocks any suspended _recvRaw) and reconnect sleeps.
    this._abortController?.abort()
    this._sessionController.abort()
    if (prev.status === 'connecting' && prev.ws !== null) {
      // Terminate any in-progress TLS handshake — the socket is unreachable from
      // the _connectWithUpgrade local, so close() must kill it here.
      try {
        prev.ws.terminate()
      } catch (err) {
        this.log.debug(`ShellSession: ws.terminate() threw during connecting (shellId=${this.shellId}): ${String(err)}`)
      }
    } else if (prev.status === 'open') {
      this._stopKeepalive(prev.keepaliveTimer)
      // ws.send() throws synchronously if the socket is already closing/closed.
      // Swallow it — the intent is best-effort notification, not guaranteed delivery.
      try {
        prev.ws.send(this.framer.encodeClose())
      } catch (err) {
        this.log.debug(
          `ShellSession: CLOSE frame not sent — socket already closing/closed (shellId=${this.shellId}): ${String(err)}`
        )
      }
      try {
        prev.ws.close()
      } catch (err) {
        this.log.debug(`ShellSession: ws.close() threw (shellId=${this.shellId}): ${String(err)}`)
      }
    }
  }

  /**
   * Forcibly terminates the underlying WebSocket without a clean handshake.
   * Useful in tests to simulate an abrupt network drop and trigger the reconnect path.
   * Has no effect if the session is not currently open.
   * @internal
   */
  _terminateConnection(): void {
    if (this._state.status === 'open') this._state.ws.terminate()
  }

  /**
   * Async iterator — yields inbound ShellFrames, reconnecting on drop if configured.
   *
   * The loop exits silently (no throw) in three cases: shell exit, kicked by a new
   * client, or reconnect budget exhausted. Check `exitCode`, `kicked`, and
   * `bytesDropped` after the loop to distinguish them:
   *
   * ```typescript
   * for await (const frame of shell) { ... }
   * if (shell.kicked) { ... }          // another client took over
   * if (shell.exitCode !== null) { ... } // shell process exited
   * if (shell.bytesDropped > 0) { ... } // ring-buffer overflow on reconnect
   * ```
   */
  [Symbol.asyncIterator](): AsyncIterator<ShellFrame> {
    return this._iterate()
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private _startKeepalive(ws: WebSocket): ReturnType<typeof globalThis.setInterval> | null {
    if (this.keepaliveIntervalMs <= 0) return null
    return globalThis.setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping()
    }, this.keepaliveIntervalMs)
  }

  private _stopKeepalive(timer: ReturnType<typeof globalThis.setInterval> | null): void {
    if (timer !== null) globalThis.clearInterval(timer)
  }

  private _wsSend(ws: WebSocket, data: Buffer): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      ws.send(data, (err?: Error) => (err ? reject(err) : resolve()))
    })
  }

  /** Open WebSocket, capture 101 upgrade headers, then read metadata frame. */
  private async _connectWithUpgrade(): Promise<void> {
    // Guard must be the very first check — any state mutation below would violate the
    // closed invariant if close() has already fired.
    if (this._isClosed()) return
    // Abort any previous per-connection iterator before creating a new one.
    this._abortController?.abort()

    this._closeError = null
    this._reconnected = false
    this._kicked = false
    this._bytesDropped = 0
    this._exitCode = null
    this._state = { status: 'connecting', ws: null }

    let connectResult: { url: string; headers: Record<string, string>; protocols?: string[] }
    try {
      connectResult = await this.connectFn(this.shellId, this.sessionId)
    } catch (err) {
      // connectFn threw before any WebSocket was created — reset to idle so the
      // state doesn't stay 'connecting' across the backoff sleep between retries.
      if (!this._isClosed()) this._state = { status: 'idle' }
      throw err
    }
    // close() may have fired while connectFn was suspended — bail out before
    // creating a new WebSocket so the session doesn't revive after an explicit close.
    if (this._isClosed()) return

    const ws = this._wsFactory(connectResult.url, connectResult.protocols, { headers: connectResult.headers })
    // close() may have fired in the gap between wsFactory() and this state update —
    // terminate the socket and bail out instead of re-registering in 'connecting'.
    if (this._isClosed()) {
      ws.terminate()
      return
    }
    // Register ws in the connecting state so close() can terminate the socket
    // during the TLS handshake, before the open race resolves.
    this._state = { status: 'connecting', ws }

    // Capture controller in a local variable so each WebSocket's handlers close over
    // their own controller — not this._abortController, which is replaced on reconnect.
    this._abortController = new AbortController()
    const controller = this._abortController
    // Single iterator used for both the STATUS handshake and subsequent frame reads.
    // On the timeout path, one frame may be lost (the abandoned .next() from the
    // Promise.race in _readMetadataFrame consumes it), but that is a degraded scenario.
    // Using two independent iterators would cause every pre-STATUS frame to be yielded
    // twice (once via pendingFrames, once via the independent listener queue).
    const messageIterator = on(ws, 'message', { signal: controller.signal }) as AsyncIterableIterator<unknown[]>

    ws.on('close', (code: number, reason: Buffer) => {
      const err = Object.assign(new Error(`WebSocket closed: ${code} ${reason?.toString() ?? ''}`), { closeCode: code })
      this._closeError = err
      controller.abort(err)
    })

    ws.on('error', (err: Error) => {
      controller.abort(err)
    })

    // Capture shellId/sessionId from 101 upgrade response headers before open fires.
    ws.once('upgrade', (response: IncomingMessage) => {
      const resHeaders = response.headers
      const hShellId = resHeaders[SHELL_ID_HEADER]
      const hSessionId = resHeaders[SESSION_HEADER]
      if (typeof hShellId === 'string') this._shellId = hShellId
      if (typeof hSessionId === 'string') this._sessionId = hSessionId
    })

    // Race open against unexpected-response (non-101) and pre-open close.
    // events.once(ws, 'open') rejects automatically if 'error' fires first.
    // AbortController cleans up the two losing once() listeners immediately after the race settles.
    const openRaceAc = new AbortController()
    try {
      await Promise.race([
        once(ws, 'open', { signal: openRaceAc.signal }),
        once(ws, 'unexpected-response', { signal: openRaceAc.signal }).then((args: unknown[]) => {
          const res = args[1] as IncomingMessage
          res.resume()
          throw new Error(`Server rejected WebSocket connection: HTTP ${res.statusCode ?? 0}`)
        }),
        once(ws, 'close', { signal: openRaceAc.signal }).then((args: unknown[]) => {
          const [code, reason] = args as [number, Buffer]
          throw new Error(`WebSocket closed before open: ${code} ${reason?.toString() ?? ''}`)
        }),
      ])
    } catch (err) {
      ws.terminate()
      if (!this._isClosed()) this._state = { status: 'idle' }
      this.log.debug(`ShellSession: WebSocket upgrade failed (shellId=${this.shellId}): ${String(err)}`)
      throw err
    } finally {
      openRaceAc.abort()
    }

    let pendingFrames: ShellFrame[]
    try {
      pendingFrames = await this._readMetadataFrame(messageIterator)
    } catch (err) {
      // Server closed before sending STATUS, or close() fired during handshake.
      ws.terminate()
      if (!this._isClosed()) this._state = { status: 'idle' }
      throw err
    }

    // close() may have fired during _readMetadataFrame — terminate and bail out.
    if (this._isClosed()) {
      ws.terminate()
      return
    }

    const keepaliveTimer = this._startKeepalive(ws)
    // Atomic promotion: all connection objects become available together.
    this._state = { status: 'open', ws, messageIterator, keepaliveTimer, pendingFrames }
  }

  /** Receive one raw binary message from the WebSocket. */
  private async _recvRaw(messageIterator: AsyncIterableIterator<unknown[]>): Promise<Buffer> {
    try {
      const { value, done } = await messageIterator.next()
      if (done) throw this._closeError ?? new Error('WebSocket closed')
      const [data] = value as [RawData]
      if (Buffer.isBuffer(data)) return data
      if (Array.isArray(data)) return Buffer.concat(data as Buffer[])
      return Buffer.from(data as ArrayBuffer)
    } catch (err) {
      throw this._closeError ?? err
    }
  }

  /**
   * Consume frames until a STATUS confirmation is found, stashing others in pendingFrames.
   * Returns the accumulated pending frames to be stored in the 'open' state.
   */
  private async _readMetadataFrame(messageIterator: AsyncIterableIterator<unknown[]>): Promise<ShellFrame[]> {
    // Use an explicit AbortController so the timer can be cancelled as soon as
    // STATUS arrives — AbortSignal.timeout() creates a timer that outlives the
    // fast-path read and accumulates orphan wakeups on rapid reconnects.
    const timeoutAc = new AbortController()
    const timer = globalThis.setTimeout(() => timeoutAc.abort(new Error('timeout')), DEFAULT_METADATA_TIMEOUT)
    const timeoutP = new Promise<never>((_, rej) =>
      timeoutAc.signal.addEventListener('abort', () => rej(timeoutAc.signal.reason as Error), { once: true })
    )

    const pendingFrames: ShellFrame[] = []

    try {
      while (true) {
        let raw: Buffer
        try {
          raw = await Promise.race([this._recvRaw(messageIterator), timeoutP])
        } catch (err: unknown) {
          if (timeoutAc.signal.aborted) {
            // If the WebSocket also closed concurrently (race between the 10s timer
            // and a server close event), prefer the real close error — promoting a
            // dead messageIterator to 'open' would mislead callers and lose the cause.
            if (this._closeError !== null) throw this._closeError
            this.log.warn(`ShellSession: Timed out waiting for STATUS confirmation (shellId=${this.shellId})`)
            return pendingFrames
          }
          throw err
        }

        const frame = this.framer.decode(raw)

        if (frame.channel === ShellChannel.STATUS) {
          try {
            const meta = (frame.json()['metadata'] ?? {}) as Record<string, unknown>
            if (meta['shellId']) {
              // Confirmation frame — update shellId and we're done.
              this._shellId = String(meta['shellId'])
              this._reconnected = Boolean(meta['reconnected'])
              return pendingFrames
            }
          } catch (err) {
            this.log.debug(
              `ShellSession: malformed STATUS frame, proceeding with client-generated shellId=${this.shellId}: ${String(err)}`
            )
            return pendingFrames
          }
          // No shellId → termination frame (shell died before confirmation).
          // Stash it so _iterate can set exitCode and return cleanly.
          this.log.debug(`ShellSession: termination STATUS received before confirmation (shellId=${this.shellId})`)
          pendingFrames.push(frame)
          return pendingFrames
        }

        pendingFrames.push(frame)
      }
    } finally {
      globalThis.clearTimeout(timer)
    }
  }

  private _isConfirmationStatus(status: Record<string, unknown>): boolean {
    const meta = status['metadata'] as Record<string, unknown> | undefined
    return Boolean(meta?.['shellId'])
  }

  private _isTerminationStatus(status: Record<string, unknown>): boolean {
    if (this._isConfirmationStatus(status)) return false
    return status['status'] === 'Success' || status['status'] === 'Failure'
  }

  private _parseExitCode(status: Record<string, unknown>): number | null {
    if (status['status'] === 'Success') return 0
    const details = status['details'] as Record<string, unknown> | undefined
    const causes = details?.['causes'] as Array<Record<string, unknown>> | undefined
    for (const cause of causes ?? []) {
      if (cause['reason'] === 'ExitCode') {
        const n = parseInt(String(cause['message']), 10)
        if (!isNaN(n)) return n
      }
    }
    // Platform error with no ExitCode cause — return null so callers can
    // distinguish "exited cleanly" (0) from "no exit code available" (null).
    return null
  }

  private async *_iterate(): AsyncGenerator<ShellFrame> {
    // Hoisted outside the loop so the finally block can reference the last known
    // open state's keepaliveTimer even after _state has been transitioned away.
    let state: Extract<SessionState, { status: 'open' }> | undefined
    try {
      while (true) {
        if (this._state.status !== 'open') return

        // Capture state snapshot before awaiting — close() may transition state
        // concurrently while the generator is suspended at a yield or await point.
        state = this._state

        // Drain frames buffered during the metadata handshake first.
        while (state.pendingFrames.length > 0) {
          if (this._isClosed()) return
          const frame = state.pendingFrames.shift()!
          // HEARTBEAT — server echo of client keepalive, not application data.
          if (frame.channel === ShellChannel.HEARTBEAT) continue
          if (frame.channel === ShellChannel.CLOSE) {
            this._state = { status: 'idle' }
            this.log.debug(`ShellSession: CLOSE frame received in pending queue (shellId=${this.shellId})`)
            return
          }
          if (frame.channel === ShellChannel.STATUS) {
            try {
              const s = frame.json()
              if (this._isTerminationStatus(s)) {
                this._exitCode = this._parseExitCode(s)
                this._state = { status: 'idle' }
                yield frame
                return
              }
            } catch (err) {
              this.log.debug(
                `ShellSession: malformed STATUS frame in pending queue (shellId=${this.shellId}): ${String(err)}`
              )
            }
          }
          yield frame
        }

        if (this._state.status !== 'open') return

        let raw: Buffer
        try {
          raw = await this._recvRaw(state.messageIterator)
        } catch (err: unknown) {
          if (this._isClosed()) return

          const closeCode = this._extractCloseCode(err)

          if (closeCode === 4000) {
            this._state = { status: 'idle' }
            this._kicked = true
            this.log.warn(`ShellSession: kicked by new connection (close 4000, shellId=${this.shellId})`)
            return
          }

          // 1003 Unsupported Data — server terminated for text frames; do NOT reconnect.
          if (closeCode === 1003) {
            this._state = { status: 'idle' }
            this.log.warn(
              `ShellSession: Server closed with 1003 (text frames not supported). ` +
                `Open a new ShellSession — do not reconnect.`
            )
            return
          }

          // 1000 Normal Closure — shell exited or graceful shutdown.
          if (closeCode === 1000) {
            this._state = { status: 'idle' }
            return
          }

          if (!this.reconnectConfig) {
            if (closeCode === 1001) {
              this.log.warn(
                `ShellSession: Server sent 1001 Going Away but no reconnectConfig — ` +
                  `stopping. Reconnect with shellId=${this.shellId}`
              )
            }
            this._state = { status: 'idle' }
            return
          }

          // Unexpected disconnect — enter reconnect loop.
          if (closeCode === 1001) {
            this.log.warn(
              `ShellSession: Server sent 1001 Going Away — entering reconnect loop (shellId=${this.shellId})`
            )
          }
          // Stop this connection's timer before `state` is overwritten by `continue`.
          // The finally block only sees the last captured `state`, so timers from
          // intermediate reconnect cycles would leak if not stopped here.
          this._stopKeepalive(state.keepaliveTimer)
          this._state = { status: 'reconnecting' }

          const didReconnect = await this._reconnectWithBackoff(Date.now())
          if (!didReconnect) {
            this.log.warn(`ShellSession: reconnect exhausted, stopping iteration (shellId=${this.shellId})`)
            if (!this._isClosed()) this._state = { status: 'idle' }
            return
          }
          continue
        }

        const frame = this.framer.decode(raw)

        if (frame.channel === ShellChannel.CLOSE) {
          this._state = { status: 'idle' }
          this.log.debug(`ShellSession: CLOSE frame received (shellId=${this.shellId})`)
          return
        }

        // HEARTBEAT — server echo of client keepalive, not application data.
        if (frame.channel === ShellChannel.HEARTBEAT) continue

        if (frame.channel === ShellChannel.STATUS) {
          try {
            const s = frame.json()
            if (this._isConfirmationStatus(s)) {
              // Post-reconnect second confirmation — check for ring-buffer overflow.
              const meta = s['metadata'] as Record<string, unknown> | undefined
              const dropped = meta?.['bytesDropped']
              if (typeof dropped === 'number' && dropped > 0) {
                this._bytesDropped += dropped
                this.log.warn(
                  `ShellSession: ${dropped} bytes of PTY output lost during disconnect ` +
                    `(ring buffer overflow, shellId=${this.shellId})`
                )
              }
              continue
            }
            if (this._isTerminationStatus(s)) {
              this._exitCode = this._parseExitCode(s)
              this._state = { status: 'idle' }
              yield frame
              return
            }
          } catch (err) {
            this.log.debug(`ShellSession: malformed STATUS frame (shellId=${this.shellId}): ${String(err)}`)
          }
        }

        yield frame
      }
    } finally {
      // Safety net: stop keepalive if close() fires while the generator is suspended
      // at a yield point — close() transitions to 'closed' but state.keepaliveTimer
      // was captured before that transition, so it still holds the live timer handle.
      this._stopKeepalive(state?.keepaliveTimer ?? null)
    }
  }

  /** Returns true when close() has been called. Used after await points to guard
   *  against close() firing while the method was suspended. A method call prevents
   *  TypeScript from narrowing away 'closed' comparisons after state assignments. */
  private _isClosed(): boolean {
    return this._state.status === 'closed'
  }

  private _extractCloseCode(err: unknown): number | null {
    if (err !== null && typeof err === 'object' && 'closeCode' in err) {
      return (err as { closeCode: number }).closeCode
    }
    return null
  }

  // ── Two-loop exponential backoff reconnect (mirrors Python SDK) ────────────

  private async _reconnectWithBackoff(startTime: number): Promise<boolean> {
    const cfg = this.reconnectConfig!
    // reconnectWindow: null means unlimited; undefined falls back to default.
    const window = cfg.reconnectWindow !== undefined ? cfg.reconnectWindow : DEFAULT_RECONNECT_WINDOW

    while (true) {
      if (window !== null) {
        const elapsed = Date.now() - startTime
        if (elapsed >= window) {
          this.log.warn(
            `ShellSession: Reconnection window of ${window}ms expired after ${elapsed}ms ` + `(shellId=${this.shellId})`
          )
          return false
        }
      }

      const success = await this._runInnerRetryLoop(cfg, startTime, window)
      if (success) return true

      let outerDelay = cfg.outerLoopDelay ?? DEFAULT_OUTER_LOOP_DELAY
      // Cap outer sleep to remaining window so we don't overshoot a short window
      // by up to outerDelay ms (e.g. a 5s window with 30s outerDelay would overshoot
      // by 25s waiting for a retry that the window check will immediately reject).
      if (window !== null) {
        const remaining = window - (Date.now() - startTime)
        outerDelay = Math.min(outerDelay, Math.max(0, remaining))
      }
      this.log.info(
        `ShellSession: Inner loop exhausted, waiting ${outerDelay}ms before next outer retry ` +
          `(shellId=${this.shellId})`
      )
      await _sleep(outerDelay, this._sessionController.signal)
      if (this._isClosed()) return false
    }
  }

  private async _runInnerRetryLoop(cfg: ReconnectConfig, startTime: number, window: number | null): Promise<boolean> {
    const maxRetries = cfg.maxRetries ?? DEFAULT_MAX_RETRIES
    const baseDelay = cfg.baseDelay ?? DEFAULT_BASE_DELAY
    const maxDelay = cfg.maxDelay ?? DEFAULT_MAX_DELAY

    let attempt = 0
    while (attempt < maxRetries) {
      attempt++

      if (window !== null && Date.now() - startTime >= window) return false

      // Attempt first — no pre-attempt sleep. Sleep only after failure so that
      // transient disconnects reconnect immediately on the first try.
      this.log.info(`ShellSession: Reconnect attempt ${attempt}/${maxRetries} (shellId=${this.shellId})`)
      try {
        await this._connectWithUpgrade()
        // close() may have fired while connectFn was awaiting — _connectWithUpgrade returns void
        // rather than throwing in that case, so guard here before claiming a successful reconnect.
        if (this._isClosed()) return false
        this.log.info(`ShellSession: Reconnected (reconnected=${this.reconnected}, shellId=${this.shellId})`)
        if (cfg.onReconnect) {
          try {
            await cfg.onReconnect(this.reconnected)
          } catch (err) {
            this.log.warn(`ShellSession: onReconnect callback threw (shellId=${this.shellId}): ${String(err)}`)
          }
        }
        return true
      } catch (err: unknown) {
        this.log.warn(`ShellSession: Reconnect attempt ${attempt} failed: ${String(err)} (shellId=${this.shellId})`)
      }

      if (this._isClosed()) return false
      // Re-check window after a slow _connectWithUpgrade so the backoff sleep
      // doesn't fire after the window has already expired mid-attempt.
      if (window !== null && Date.now() - startTime >= window) return false

      // Exponential backoff with ±25% jitter to avoid thundering herd on
      // simultaneous reconnects from multiple clients.
      // Use _sessionController.signal (only aborted by close()) — not
      // _abortController, which is already aborted by the WS close event.
      const base = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay)
      const jitter = base * 0.25 * (Math.random() * 2 - 1)
      const delay = base + jitter
      this.log.info(`ShellSession: Waiting ${Math.round(delay)}ms before next attempt (shellId=${this.shellId})`)
      await _sleep(delay, this._sessionController.signal)
      if (this._isClosed()) return false
    }
    return false
  }
}

function _sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = globalThis.setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        globalThis.clearTimeout(timer)
        resolve()
      },
      { once: true }
    )
  })
}
