/**
 * Minimal logger interface — compatible with `console`, pino, winston, and
 * any other logger that exposes `debug / info / warn` methods.
 *
 * Pass an instance to `openShell` or `ShellSessionOptions` to receive
 * diagnostic output from `ShellSession`. When omitted, all logging is silent.
 *
 * @example opt in with console:
 * ```typescript
 * const shell = await client.openShell({ runtimeArn, logger: console })
 * ```
 * @example opt in with pino:
 * ```typescript
 * const shell = await client.openShell({ runtimeArn, logger: pinoInstance })
 * ```
 */
export interface Logger {
  debug: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
}

/** Silent logger used as the default — no output unless the caller opts in. */
export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
}

/** Reconnection configuration for ShellSession. */

export const DEFAULT_MAX_RETRIES = 5
export const DEFAULT_BASE_DELAY = 1000 // ms
export const DEFAULT_MAX_DELAY = 15000 // ms
export const DEFAULT_RECONNECT_WINDOW = 900_000 // ms — ~15 min, matches server-side KARP idle timeout
export const DEFAULT_OUTER_LOOP_DELAY = 30_000 // ms
export const DEFAULT_KEEPALIVE_INTERVAL = 30_000 // ms — KARP idle timeout is ~60s; ping every 30s

/**
 * Configuration for automatic reconnection on WebSocket disconnect.
 *
 * When provided to `openShell`, `ShellSession` will automatically reconnect
 * using the same `shellId` so the shell's working directory, environment, background jobs,
 * and up to 256 KB of buffered output are preserved.
 *
 * @example
 * ```typescript
 * const config: ReconnectConfig = {
 *   maxRetries: 5,
 *   reconnectWindow: null, // unlimited
 *   onReconnect: async () => {
 *     console.log('Reconnected to shell')
 *   }
 * }
 * const shell = await client.openShell(runtimeArn, { reconnectConfig: config })
 * ```
 */
export interface ReconnectConfig {
  /**
   * Maximum reconnect attempts per inner loop before pausing. Defaults to 5.
   */
  maxRetries?: number

  /**
   * Initial backoff delay in milliseconds. Doubles on each attempt up to maxDelay. Defaults to 1000.
   */
  baseDelay?: number

  /**
   * Upper bound on backoff delay in milliseconds. Defaults to 15000.
   */
  maxDelay?: number

  /**
   * Total milliseconds to keep retrying after a disconnect before giving up.
   * Set to null to retry indefinitely. Defaults to 900000 (~15 min).
   */
  reconnectWindow?: number | null

  /**
   * Milliseconds to wait between inner loop exhaustion and next outer retry cycle. Defaults to 30000.
   */
  outerLoopDelay?: number

  /**
   * Optional callback invoked after each successful reconnect.
   */
  onReconnect?: () => void | Promise<void>
}
