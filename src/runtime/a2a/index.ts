/**
 * A2A protocol support for AgentCore Runtime.
 *
 * Requires the optional peer dependencies `@a2a-js/sdk` and `express`.
 */

export { serveA2A, buildA2AApp, bedrockCallContextBuilder } from './app.js'
export type { ServeA2AOptions, BuildA2AAppOptions } from './app.js'
// A2A executors have a fixed AgentExecutor signature and cannot receive the
// request context as an argument like HTTP invocation handlers do, so the
// ambient accessor is part of this module's public surface.
export { getContext } from '../context.js'
export type { RequestContext } from '../types.js'
export { buildAgentCard, withJsonRpcUrl } from './agent-card.js'
export type { AgentCardParams } from './agent-card.js'
export { extractA2AContext, isForwardableHeader } from './headers.js'
export type { A2ARequestContext, IncomingHeaders } from './headers.js'
export { buildRuntimeUrl } from './runtime-url.js'
