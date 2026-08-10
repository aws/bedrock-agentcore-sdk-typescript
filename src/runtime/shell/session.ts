/**
 * ShellSession — async-iterable interactive PTY WebSocket session.
 *
 * Connects on `connect()` and exposes typed `send()` / `resize()` /
 * `[Symbol.asyncIterator]()` / `close()`.
 *
 * When `reconnectConfig` is provided, transparently reconnects on unexpected disconnects
 * using the same `shellId` so the shell's working directory, environment, background jobs,
 * and up to 256 KB of buffered output are preserved on the server.
 *
 * Reconnect restores the *connection* on its own (it is driven by the socket close event,
 * not by your read loop, and `send()`/`resize()` wait for it). However, on reattach the
 * server replays the buffered output as inbound frames — to receive that replay (and to see
 * `exitCode` set) you must be consuming the session with `for await (const frame of shell)`.
 * A write-only caller that never iterates stays connected across drops but will not observe
 * the replayed output. Keep a `for await` loop running for the life of the session.
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
//   connecting → open              upgrade succeeded
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
    }
  | { status: 'reconnecting' }
  | { status: 'closed' }

/**
 * Async-iterable shell session wrapping a live PTY WebSocket.
 *
 * Read-only observable attributes (updated by the session as events arrive):
 * - `shellId`      — Server-confirmed shell identifier. Preserve to reconnect to the same PTY.
 * - `sessionId`    — Runtime session ID routing to the VM.
 * - `kicked`       — True when another client connected with the same shellId (close 4000).
 *                    Check this after the `for await` loop exits to distinguish a kick from
 *                    a clean shell exit.
 * - `exitCode`     — Shell process exit code. `null` until the shell exits; `0` for a clean
 *                    exit. Check this after the `for await` loop exits alongside `kicked`.
 */
export class ShellSession implements AsyncIterable<ShellFrame> {
  private _shellId: string
  private _sessionId: string
  private _kicked = false
  private _exitCode: number | null = null

  /** Server-confirmed shell identifier. */
  get shellId(): string {
    return this._shellId
  }
  /** Runtime session ID routing to the VM. */
  get sessionId(): string {
    return this._sessionId
  }
  /**
   * True when another client connected with the same shellId (close 4000).
   * Check after the `for await` loop exits to distinguish a kick from a clean exit.
   */
  get kicked(): boolean {
    return this._kicked
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
  /**
   * Set while a reconnect is in flight, cleared when it settles. Shared so that the
   * iterator, the close/dead-detection handler, and send()/resize() all await the same
   * attempt rather than racing or each starting their own. Resolves to the reconnect
   * outcome (true = recovered, false = gave up). This is what makes *connection* recovery
   * iterator-independent — the socket is restored without a `for await` loop. Consuming the
   * replayed output still requires an active iterator (see the class docstring).
   */
  private _reconnectPromise: Promise<boolean> | null = null

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
   *
   * If a reconnect is in flight, this waits for it and sends on the recovered
   * connection. Throws a descriptive `Error` (never the raw `ws` "readyState 3"
   * error) when the session is closed or could not be recovered.
   */
  async send(data: string | Buffer): Promise<void> {
    await this._wsSend(await this._writableSocket(), this.framer.encodeStdin(data))
  }

  /** Send a HEARTBEAT frame (0x05) to the server. */
  async sendHeartbeat(): Promise<void> {
    await this._wsSend(await this._writableSocket(), this.framer.encodeHeartbeat())
  }

  /** Resize the terminal PTY. */
  async resize(width: number, height: number): Promise<void> {
    await this._wsSend(await this._writableSocket(), this.framer.encodeResize(width, height))
  }

  /**
   * Resolve the live socket for a write, healing first if needed. Awaits an in-flight
   * reconnect (transparent recovery) and validates the *real* socket
   * readyState — not just the `_state` flag, which can lag a silently-dropped socket.
   * Throws a descriptive `Error` instead of leaking the raw `ws`
   * "readyState 3 (CLOSED)" error.
   */
  private async _writableSocket(): Promise<WebSocket> {
    // Wait out an in-flight reconnect, looping so back-to-back drops (a fresh reconnect
    // starting while we awaited the previous one) are also awaited rather than throwing a
    // spurious "not connected" mid-recovery. The reconnect passes through 'reconnecting'
    // then 'connecting' before reaching 'open', so we wait whenever a reconnect promise is
    // set AND we are not yet open/closed. Crucially we stop once status is 'open': an
    // onReconnect callback that calls send()/resize() runs after the new socket is promoted
    // to 'open' but before _reconnectPromise settles — gating on 'open' lets it through
    // instead of awaiting its own in-flight promise and deadlocking.
    while (this._reconnectPromise && this._state.status !== 'open' && this._state.status !== 'closed') {
      await this._reconnectPromise
    }
    if (this._isClosed()) throw new Error('ShellSession is closed')
    if (this._state.status !== 'open') {
      throw new Error(`ShellSession is not connected (status: ${this._state.status})`)
    }
    if (this._state.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`ShellSession connection is not open (readyState ${this._state.ws.readyState})`)
    }
    return this._state.ws
  }

  /** Disconnect from the shell session by closing the WebSocket.
   *  The shell process stays alive on the server for the reconnect window, allowing
   *  later reconnection with the same shellId. Unlike the old behavior (which sent 0xFF
   *  to permanently kill the shell), this just detaches the client. */
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
   * client, or reconnect budget exhausted. Check `exitCode` and `kicked`
   * after the loop to distinguish them:
   *
   * ```typescript
   * for await (const frame of shell) { ... }
   * if (shell.kicked) { ... }          // another client took over
   * if (shell.exitCode !== null) { ... } // shell process exited
   * ```
   */
  [Symbol.asyncIterator](): AsyncIterator<ShellFrame> {
    return this._iterate()
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private _startKeepalive(ws: WebSocket, signal: AbortSignal): ReturnType<typeof globalThis.setInterval> | null {
    if (this.keepaliveIntervalMs <= 0) return null

    // SDK clients MUST send a Ping every 30s AND treat "no Pong within ~60s" as a dead
    // connection. ws emits 'pong' for each RFC 6455 Pong received. Without this,
    // a silently-dropped socket reports readyState OPEN for up to ~60s (KARP idle timeout),
    // during which the session would sit stale on a dead connection.
    //
    // Liveness is pong-only by design: a 'message' listener here would (a) double-dispatch
    // on every inbound frame — the read path (`on(ws,'message')` iterator) already consumes
    // them — and (b) mask a write-dead-but-read-alive half-close, since streamed output
    // would keep refreshing the timer while our pings go unanswered. The 'pong' listener is
    // removed when this connection's controller aborts (close or drop) so it never leaks.
    let lastPongAt = Date.now()
    const markAlive = (): void => {
      lastPongAt = Date.now()
    }
    ws.on('pong', markAlive)
    signal.addEventListener('abort', () => ws.removeListener('pong', markAlive), { once: true })
    const deadAfterMs = this.keepaliveIntervalMs * 2 // ~60s with the 30s default

    return globalThis.setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return
      if (Date.now() - lastPongAt > deadAfterMs) {
        // Silent death: pings went unanswered. Terminate so 'close' fires and reconnect
        // engages — instead of leaving the session stale on a dead socket.
        this.log.warn(
          `ShellSession: no Pong within ${deadAfterMs}ms — connection presumed dead, ` +
            `terminating (shellId=${this.shellId})`
        )
        ws.terminate()
        return
      }
      ws.ping()
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

    // A reconnect attempt enters here with status 'reconnecting'; a fresh connect with 'idle'.
    this._closeError = null
    this._kicked = false
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
    // Single iterator for all frame reads after the WebSocket opens.
    const messageIterator = on(ws, 'message', { signal: controller.signal }) as AsyncIterableIterator<unknown[]>

    ws.on('close', (code: number, reason: Buffer) => {
      const err = Object.assign(new Error(`WebSocket closed: ${code} ${reason?.toString() ?? ''}`), { closeCode: code })
      this._closeError = err
      controller.abort(err)
      // Trigger reconnect from the close event itself so recovery does not depend on a
      // `for await` loop being active. Only act on closes for the *current*
      // connection: ignore if we have already moved on (closed, reconnecting, or this
      // socket is no longer the live one). The iterator, if running, joins the same
      // in-flight attempt via _reconnectPromise rather than starting a second one.
      if (this._state.status === 'open' && this._state.ws === ws) {
        void this._ensureReconnect(code).catch(() => {})
      }
    })

    ws.on('error', (err: Error) => {
      controller.abort(err)
      // Do NOT trigger reconnect here. The `ws` library always emits 'close' after 'error'
      // on a connected socket, and that close carries the authoritative close code (the
      // close code drives the reconnect decision). An 'error' has no closeCode, so
      // reconnecting from it (with a null code) would pre-empt a terminal close that must
      // NOT reconnect — e.g. 4000 (kicked) or 1003 (text frames) — by flipping state to
      // 'reconnecting' before the real code arrives. The 'close' handler below owns the
      // decision; this listener exists only so the 'error' event is not unhandled.
      this.log.debug(`ShellSession: WebSocket error (deferring to close, shellId=${this.shellId}): ${String(err)}`)
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

    const keepaliveTimer = this._startKeepalive(ws, controller.signal)
    // Connection is ready immediately after WebSocket opens — shellId comes from 101 header.
    // No longer blocking on the 0x03 confirmation frame.
    this._state = { status: 'open', ws, messageIterator, keepaliveTimer }
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

        let raw: Buffer
        try {
          raw = await this._recvRaw(state.messageIterator)
        } catch (err: unknown) {
          if (this._isClosed()) return

          // A socket 'error' aborts this read before the authoritative 'close' arrives, so
          // the abort error carries no closeCode. Reconnecting on that null code would
          // pre-empt the real code (e.g. 4000 kicked / 1003 text-frames): _ensureReconnect
          // would flip state to 'reconnecting', and the close handler's terminal decision
          // (which guards on status 'open') would then be silently dropped. Wait for the
          // 'close' first — `ws` always emits it after 'error' on a connected socket, and
          // its handler sets _closeError and owns the reconnect decision (spec §7).
          if (this._extractCloseCode(err) === null && this._closeError === null) {
            await this._waitForClose(state.ws)
            if (this._isClosed()) return
          }

          // Start-or-join reconnect with the authoritative close code. The close/error
          // handler for this socket may have already kicked off the attempt
          // (iterator-independent path); either way we await the single shared attempt here
          // rather than duplicating close-code logic.
          const closeCode = this._extractCloseCode(this._closeError ?? err)
          const didReconnect = await this._ensureReconnect(closeCode)
          if (this._isClosed()) return
          if (!didReconnect) return // terminal close, no config, or budget exhausted
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
              // Confirmation frame — silently swallow (not application output).
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

  /**
   * Wait for the socket's authoritative 'close' to land after an 'error' woke the read
   * loop early. The 'close' handler sets `_closeError` (carrying the real close code) and
   * makes the reconnect decision, so this resolves as soon as `_closeError` is populated.
   * Bounded by a short timeout in case 'close' never follows (it always does on a
   * connected `ws`, but we must not hang the iterator on a misbehaving socket).
   */
  private async _waitForClose(ws: WebSocket): Promise<void> {
    if (this._closeError !== null || this._isClosed()) return
    const ac = new AbortController()
    const timer = globalThis.setTimeout(() => ac.abort(), 10_000)
    try {
      await once(ws, 'close', { signal: ac.signal })
    } catch {
      // Timed out or aborted — fall through; caller reconnects with whatever code is set.
    } finally {
      globalThis.clearTimeout(timer)
    }
  }

  /**
   * Decide whether a close code is auto-reconnectable, then start-or-join a reconnect.
   *
   * This is the single entry point for triggering reconnection. It is called from
   * wherever a disconnect is observed — the iterator's read error, the `ws.on('close')`
   * handler (dead-detection / silent drop while no one is iterating), or the keepalive
   * pong-timeout — so restoring the *connection* no longer depends on an active `for await`
   * loop. (Receiving the server's replayed output after reattach still requires iterating;
   * see the class docstring.)
   *
   * Returns a promise that resolves to the reconnect outcome (true = recovered).
   * Returns immediately with `false` for terminal close codes (4000 kicked, 1003 text,
   * 1000 normal) or when no `reconnectConfig` is set. Concurrent callers share one
   * in-flight attempt via `_reconnectPromise`.
   */
  private _ensureReconnect(closeCode: number | null): Promise<boolean> {
    // Join the in-flight attempt while it is still running — that spans both 'reconnecting'
    // (backoff sleep) and 'connecting' (a retry's _connectWithUpgrade in progress). A second
    // observer of the SAME disconnect (e.g. the iterator resuming after _waitForClose, while
    // the close handler already armed the attempt and it has advanced to 'connecting') must
    // join, not start a duplicate attempt. We deliberately do NOT join once status is 'open':
    // a disconnect that arrives after a successful reattach (the window where the new socket
    // is promoted to 'open' but _reconnectPromise has not yet been cleared in .finally) must
    // be processed as a NEW event — otherwise a terminal 4000/1003 on the new socket is
    // swallowed (kicked never set) and a fresh drop arms no new reconnect.
    if (this._reconnectPromise && (this._state.status === 'reconnecting' || this._state.status === 'connecting')) {
      return this._reconnectPromise
    }
    if (this._isClosed()) return Promise.resolve(false)

    // Terminal close codes (never auto-reconnect) and the no-config case all stop the
    // session. Classify once, emit any code-specific warning, then do a SINGLE shared
    // idle transition rather than repeating it per branch.
    //   4000 kicked · 1003 text-frames-unsupported · 1000 normal close · no reconnectConfig
    const terminal = closeCode === 4000 || closeCode === 1003 || closeCode === 1000 || !this.reconnectConfig
    if (terminal) {
      if (closeCode === 4000) {
        this._kicked = true
        this.log.warn(`ShellSession: kicked by new connection (close 4000, shellId=${this.shellId})`)
      } else if (closeCode === 1003) {
        this.log.warn(
          `ShellSession: Server closed with 1003 (text frames not supported). ` +
            `Open a new ShellSession — do not reconnect.`
        )
      } else if (closeCode === 1001 && !this.reconnectConfig) {
        this.log.warn(
          `ShellSession: Server sent 1001 Going Away but no reconnectConfig — ` +
            `stopping. Reconnect with shellId=${this.shellId}`
        )
      }
      if (this._state.status === 'open') this._state = { status: 'idle' }
      return Promise.resolve(false)
    }

    // Reconnectable disconnect — stop keepalive on the dead connection and enter the loop.
    if (closeCode === 1001) {
      this.log.warn(`ShellSession: Server sent 1001 Going Away — reconnecting (shellId=${this.shellId})`)
    }
    if (this._state.status === 'open') this._stopKeepalive(this._state.keepaliveTimer)
    this._state = { status: 'reconnecting' }

    const attempt: Promise<boolean> = this._reconnectWithBackoff(Date.now())
      .then((didReconnect) => {
        if (!didReconnect && !this._isClosed()) {
          this.log.warn(`ShellSession: reconnect exhausted (shellId=${this.shellId})`)
          this._state = { status: 'idle' }
        }
        return didReconnect
      })
      .finally(() => {
        // Only clear if we are still the current attempt — a newer _ensureReconnect may
        // have replaced _reconnectPromise (e.g. a drop right after this one recovered).
        if (this._reconnectPromise === attempt) this._reconnectPromise = null
      })
    this._reconnectPromise = attempt
    return this._reconnectPromise
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
        this.log.info(`ShellSession: Reconnected (shellId=${this.shellId})`)
        if (cfg.onReconnect) {
          try {
            await cfg.onReconnect()
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
