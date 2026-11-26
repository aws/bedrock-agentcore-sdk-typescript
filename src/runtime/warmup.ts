import { WARMUP_TYPE_HEADER } from './constants.js'
import { Mutex } from './hooks.js'
import type { HookRoute } from './hooks.js'
import type { WarmupHandler, WarmupHookConfig, WarmupType } from './types.js'

/**
 * Warmup types, in the order AgentCore Runtime calls them.
 */
export const WARMUP_TYPES: readonly WarmupType[] = ['memory', 'disk']

const GENERATOR_FUNCTION_NAMES = ['GeneratorFunction', 'AsyncGeneratorFunction']

/**
 * Builds the route that serves the build warmup hook.
 *
 * The route answers 400 for a missing or empty warmup type header, 200 `skipped` for a type without a handler,
 * 200 `completed` after the handler resolves, and 500 if it rejects or returns an iterator. A header value that
 * isn't a known warmup type is answered 200 `skipped`, with the trimmed, lower-cased value as `type`, so a type
 * added later doesn't fail the create or update. The hook's handler calls never overlap.
 *
 * @param config - Validated warmup hook config
 * @returns The hook route, served as `POST config.path`
 * @throws Error if `handlers` isn't an object, has a key other than `memory` or `disk`, or has a value that isn't a
 * function, or if a handler is a generator function, whose body would never run
 */
export function warmupHookRoute(config: WarmupHookConfig): HookRoute {
  validateWarmupHandlers(config.handlers)
  for (const type of WARMUP_TYPES) {
    const handler = config.handlers[type]
    if (handler !== undefined && isGeneratorFunction(handler)) {
      throw new Error(`warmupHook.handlers.${type} is a generator function: its body would never run; remove the yield`)
    }
  }

  const lock = new Mutex()
  return {
    name: 'warmupHook',
    method: 'POST',
    path: config.path,
    ...(config.port !== undefined && { port: config.port }),
    handler: async (request, reply): Promise<void> => {
      const value = normalizeWarmupTypeHeader(request.headers[WARMUP_TYPE_HEADER])
      if (value === '') {
        request.log.warn('warmup request with a missing or empty warmup type header')
        await reply.status(400).send({ error: `${WARMUP_TYPE_HEADER} header is missing or empty` })
        return
      }
      if (!isWarmupType(value)) {
        request.log.info(`Warmup (${value}): unknown type, nothing to do`)
        await reply.send({ status: 'ok', type: value, result: 'skipped' })
        return
      }
      const type = value

      const handler = config.handlers[type]
      if (handler === undefined) {
        request.log.info(`type=<${type}> | no warmup handler registered, nothing to do`)
        await reply.send({ status: 'ok', type, result: 'skipped' })
        return
      }

      const start = Date.now()
      try {
        const result: unknown = await lock.run(handler)
        if (isIterator(result)) {
          throw new Error('warmup handler returned an iterator; its body would never run')
        }
      } catch (error) {
        request.log.error({ err: error }, `type=<${type}>, duration_ms=<${Date.now() - start}> | warmup failed`)
        await reply.status(500).send({ error: error instanceof Error ? error.message : String(error), type })
        return
      }
      request.log.info(`type=<${type}>, duration_ms=<${Date.now() - start}> | warmup completed`)
      await reply.send({ status: 'ok', type, result: 'completed' })
    },
  }
}

/**
 * Normalizes the warmup type header: trimmed and lower-cased.
 *
 * @param header - Raw header value
 * @returns The normalized value, or an empty string if the header is missing
 */
export function normalizeWarmupTypeHeader(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header.join(', ') : (header ?? '')
  return value.trim().toLowerCase()
}

/**
 * Checks whether a normalized header value is a known warmup type.
 *
 * @param value - Normalized header value
 * @returns True if the value is `memory` or `disk`
 */
export function isWarmupType(value: string): value is WarmupType {
  return WARMUP_TYPES.some((type) => type === value)
}

/**
 * Checks that `handlers` is a plain object whose keys are warmup types and whose values are functions, so a typo
 * in the config fails at construction instead of silently skipping the handler.
 *
 * @param handlers - Configured handlers
 * @throws Error naming the first key or value that is wrong
 */
function validateWarmupHandlers(handlers: unknown): void {
  if (typeof handlers !== 'object' || handlers === null || Array.isArray(handlers)) {
    throw new Error(`warmupHook.handlers must be an object, got ${String(handlers)}`)
  }
  for (const [key, value] of Object.entries(handlers)) {
    if (!isWarmupType(key)) {
      throw new Error(`warmupHook.handlers has an unknown key ${JSON.stringify(key)}; expected memory or disk`)
    }
    if (typeof value !== 'function') {
      throw new Error(`warmupHook.handlers.${key} must be a function`)
    }
  }
}

/**
 * Checks whether a handler is a generator function, whose body only runs when the returned iterator is consumed.
 *
 * @param handler - Configured warmup handler
 * @returns True for `function*` and `async function*`
 */
function isGeneratorFunction(handler: WarmupHandler): boolean {
  return GENERATOR_FUNCTION_NAMES.includes(handler.constructor.name)
}

/**
 * Checks whether a handler result is a sync or async iterator, such as the one a generator function returns.
 *
 * @param value - What the handler resolved to
 * @returns True for an object with a `Symbol.iterator` or `Symbol.asyncIterator` method
 */
function isIterator(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as { [Symbol.iterator]?: unknown; [Symbol.asyncIterator]?: unknown }
  return typeof candidate[Symbol.iterator] === 'function' || typeof candidate[Symbol.asyncIterator] === 'function'
}
