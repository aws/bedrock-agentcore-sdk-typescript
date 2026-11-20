import { WARMUP_TYPE_HEADER } from './constants.js'
import { Mutex } from './hooks.js'
import type { HookRoute } from './hooks.js'
import type { WarmupHookConfig, WarmupType } from './types.js'

/**
 * Warmup types, in the order AgentCore Runtime calls them.
 */
export const WARMUP_TYPES: readonly WarmupType[] = ['memory', 'disk']

/**
 * Builds the route that serves the build warmup hook.
 *
 * The route answers 400 for a missing or invalid warmup type header, 200 `skipped` for a type without a handler,
 * 200 `completed` after the handler resolves, and 500 if it rejects. The hook's handler calls never overlap.
 *
 * @param config - Validated warmup hook config
 * @returns The hook route, served as `POST config.path`
 */
export function warmupHookRoute(config: WarmupHookConfig): HookRoute {
  const lock = new Mutex()
  return {
    name: 'warmupHook',
    method: 'POST',
    path: config.path,
    ...(config.port !== undefined && { port: config.port }),
    handler: async (request, reply): Promise<void> => {
      const header = request.headers[WARMUP_TYPE_HEADER]
      const type = parseWarmupType(header)
      if (type === undefined) {
        request.log.warn(`header=<${String(header ?? '')}> | warmup request with invalid warmup type header`)
        await reply
          .status(400)
          .send({ error: `${WARMUP_TYPE_HEADER} must be 'memory' or 'disk', got ${JSON.stringify(header ?? '')}` })
        return
      }

      const handler = config.handlers[type]
      if (handler === undefined) {
        request.log.info(`type=<${type}> | no warmup handler registered, nothing to do`)
        await reply.send({ status: 'ok', type, result: 'skipped' })
        return
      }

      const start = Date.now()
      try {
        await lock.run(handler)
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
 * Parses the warmup type header, ignoring case and surrounding whitespace.
 *
 * @param header - Raw header value
 * @returns The warmup type, or undefined if the header is missing or isn't a warmup type
 */
export function parseWarmupType(header: string | string[] | undefined): WarmupType | undefined {
  if (typeof header !== 'string') {
    return undefined
  }
  const value = header.trim().toLowerCase()
  return WARMUP_TYPES.find((type) => type === value)
}
