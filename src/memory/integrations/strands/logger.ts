/**
 * Module-local logger mirroring the Strands SDK `Logger` convention (debug/info no-op by default,
 * warn/error to console), with an injection hook so callers can route logs through Pino/Winston/etc.
 *
 * Strands exports `configureLogging` and the `Logger` type but not its global `logger` instance, so an
 * external package cannot import that instance. We therefore own a console-backed default here that
 * matches the SDK's shape; if Strands later exposes its instance, this can delegate to it without
 * touching the call sites (`logger.warn(...)`).
 */

export interface Logger {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

const defaultLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
}

let current: Logger = defaultLogger

/** The active logger for this module. */
export const logger: Logger = {
  debug: (...args) => current.debug(...args),
  info: (...args) => current.info(...args),
  warn: (...args) => current.warn(...args),
  error: (...args) => current.error(...args),
}

/** Inject a custom logger for AgentCore memory logging (e.g. to route through the host app's logger). */
export function configureMemoryLogging(customLogger: Logger): void {
  current = customLogger
}
