/**
 * Experimental Strands integration for invoking a deployed AgentCore Harness.
 *
 * This API is subject to breaking changes before promotion to a stable import path.
 *
 * @experimental
 */

export { AgentCoreHarnessAgent } from './agent.js'

export type { AgentCoreHarnessAgentConfig } from './types.js'
export type {
  AgentCoreHarnessResultEvent,
  AgentCoreHarnessStreamEvent,
  AgentCoreHarnessStreamUpdateEvent,
} from './events.js'
