import { AsyncLocalStorage } from 'async_hooks'
import type { RequestContext } from './types.js'

/**
 * AsyncLocalStorage instance for storing request-scoped context.
 * This provides thread-safe, automatic context propagation across async operations.
 *
 * This is private to prevent misuse - all context operations should go through
 * getContext() and runWithContext() to maintain proper isolation guarantees.
 *
 * Note: Requires Node.js - Uses AsyncLocalStorage from 'async_hooks' module.
 */
const requestContextStorage = new AsyncLocalStorage<RequestContext>()

/**
 * Get the current request context.
 *
 * @returns The RequestContext if called within a request scope (inside runWithContext),
 *          undefined otherwise (e.g., during app initialization or outside request handlers)
 *
 * @example
 * ```typescript
 * import { getContext } from 'bedrock-agentcore/context'
 *
 * const handler = async (request, context) => {
 *   const ctx = getContext()
 *   console.log('Request ID:', ctx?.requestId)
 *   console.log('Session ID:', ctx?.sessionId)
 * }
 * ```
 */
export function getContext(): RequestContext | undefined {
  return requestContextStorage.getStore()
}

/**
 * Run a function within a request context scope.
 * The context will be available via getContext() throughout the entire async call chain.
 *
 * This function is internal to the runtime module and should not be used directly by customers.
 * It is automatically called by BedrockAgentCoreApp to set up context for each request.
 *
 * @param context - The request context to make available
 * @param fn - The function to execute within the context scope
 * @returns The return value of the function
 * @internal
 */
export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return requestContextStorage.run(context, fn)
}

// Note: runWithContext is exported for use within the runtime module (app.ts)
// but should not be re-exported from the public API (index.ts)
