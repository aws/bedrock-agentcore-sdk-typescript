import type { FastifyReply, FastifyRequest } from 'fastify'
import type { HookConfig } from './types.js'

/**
 * HTTP methods of the routes the app serves.
 */
export const HTTP_METHODS = ['GET', 'POST'] as const

/**
 * An HTTP method of a route the app serves.
 */
export type HttpMethod = (typeof HTTP_METHODS)[number]

/**
 * A route's method and path, the parts that two routes on one port must not share.
 */
export interface RouteId {
  /**
   * HTTP method of the route.
   */
  method: HttpMethod

  /**
   * Path of the route.
   */
  path: string
}

/**
 * Fastify handler that serves a lifecycle hook.
 */
export type HookRouteHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>

/**
 * A lifecycle hook ready to be registered: its config plus the route's method, name and handler.
 */
export interface HookRoute extends HookConfig, RouteId {
  /**
   * Name of the app prop that configures the hook, used in errors and logs (e.g. `warmupHook`).
   */
  name: string

  /**
   * Handler that serves the hook.
   */
  handler: HookRouteHandler
}

// Mirrors the public API constraints for HttpPostLifecycleHookAction.
const HOOK_PATH_MAX_LENGTH = 32
const HOOK_PATH_PATTERN = /^\/[A-Za-z0-9._~/-]*$/
const HOOK_PORT_MIN = 8000
const HOOK_PORT_MAX = 12000

/**
 * Validates a hook's path and port against the AgentCore Runtime API constraints.
 *
 * @param config - Hook config to validate
 * @param prop - Name of the prop that holds the config, used as the error message prefix
 * @throws Error naming the first rule that `config` breaks
 */
export function validateHookConfig(config: HookConfig, prop: string): void {
  const { path, port } = config
  if (typeof path !== 'string') {
    throw new Error(`${prop}.path must be a string, got ${show(path)}`)
  }
  if (path.length < 1 || path.length > HOOK_PATH_MAX_LENGTH) {
    throw new Error(`${prop}.path must be between 1 and ${HOOK_PATH_MAX_LENGTH} characters, got ${show(path)}`)
  }
  if (!HOOK_PATH_PATTERN.test(path)) {
    throw new Error(
      `${prop}.path must start with '/' and contain only letters, numbers, '.', '_', '~', '/' and '-', got ${show(path)}`
    )
  }
  if (!isCanonicalPath(path)) {
    throw new Error(
      `${prop}.path must be canonical: no trailing '/' (except '/' itself), no '//', ` +
        `and no '.' or '..' segments, got ${show(path)}`
    )
  }
  if (port === undefined) {
    return
  }
  if (!Number.isInteger(port)) {
    throw new Error(`${prop}.port must be an integer, got ${show(port)}`)
  }
  if (port < HOOK_PORT_MIN || port > HOOK_PORT_MAX) {
    throw new Error(`${prop}.port must be between ${HOOK_PORT_MIN} and ${HOOK_PORT_MAX}, got ${show(port)}`)
  }
}

/**
 * Checks whether a path is in canonical form: no trailing `/` (except `/` itself), no `//`, and no `.` or `..` segments.
 *
 * @param path - Path that starts with `/`
 * @returns True if the path is canonical
 */
export function isCanonicalPath(path: string): boolean {
  if (path === '/') {
    return true
  }
  return path
    .slice(1)
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

/**
 * Throws if a route's method and path are already served on its port.
 *
 * @param served - Routes already served on the port
 * @param route - Route to add
 * @param name - Name of the prop that configures the route, used in the error message
 * @throws Error if `served` has a route with the same method and path
 */
export function assertNoRouteConflict(served: readonly RouteId[], route: RouteId, name: string): void {
  if (served.some((other) => other.method === route.method && other.path === route.path)) {
    throw new Error(
      `${name} ${route.method} ${route.path} conflicts with a route already served on its port; pick another path`
    )
  }
}

/**
 * Runs async functions one at a time, in call order.
 */
export class Mutex {
  private _tail: Promise<void> = Promise.resolve()

  /**
   * Runs `fn` after every earlier call has settled.
   *
   * @param fn - Async function to run
   * @returns What `fn` resolves to
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this._tail
    let release!: () => void
    this._tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await fn()
    } finally {
      release()
    }
  }
}

/**
 * Formats a value for an error message.
 *
 * @param value - Value to format
 * @returns The value, quoted if it is a string
 */
function show(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value)
}
