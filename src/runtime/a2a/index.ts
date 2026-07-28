/**
 * A2A protocol support for AgentCore Runtime.
 *
 * Requires the optional peer dependencies `@a2a-js/sdk` and `express`.
 */

export { serveA2A, buildA2AApp, bedrockCallContextBuilder } from './app.js'
export type { ServeA2AOptions, BuildA2AAppOptions } from './app.js'
export { buildAgentCard, withJsonRpcUrl } from './agent-card.js'
export type { AgentCardParams } from './agent-card.js'
export { extractA2AContext, isForwardableHeader } from './headers.js'
export type { A2ARequestContext, IncomingHeaders } from './headers.js'
export { buildRuntimeUrl } from './runtime-url.js'
