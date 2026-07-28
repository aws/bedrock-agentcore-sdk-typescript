/**
 * A2A agent card construction with AgentCore Runtime URL resolution.
 */

import { duplicateInterfacesForLegacy } from '@a2a-js/sdk/compat/v0_3'
import type { AgentCard, AgentSkill } from '@a2a-js/sdk'

const AGENTCORE_RUNTIME_URL_ENV = 'AGENTCORE_RUNTIME_URL'

/**
 * Returns the AGENTCORE_RUNTIME_URL env value with a trailing slash, or
 * undefined when the variable is unset.
 *
 * The platform injects the value without a trailing slash, but A2A clients
 * resolve the well-known agent-card path relative to the advertised URL —
 * and WHATWG URL resolution drops the final path segment of a slashless
 * base, breaking card discovery. Values passed explicitly by callers are
 * not normalized.
 */
export function agentCoreRuntimeUrl(): string | undefined {
  const url = process.env[AGENTCORE_RUNTIME_URL_ENV]
  if (!url) {
    return undefined
  }
  return url.endsWith('/') ? url : `${url}/`
}

/**
 * Parameters for building an A2A agent card.
 */
export interface AgentCardParams {
  /**
   * Human-readable agent name.
   */
  name: string

  /**
   * Short description of what the agent does.
   */
  description: string

  /**
   * Card version string, defaults to '1.0.0'.
   */
  version?: string

  /**
   * Skills advertised on the card; id, name, and description are required, remaining fields default to empty.
   */
  skills?: Array<Pick<AgentSkill, 'id' | 'name' | 'description'> & Partial<AgentSkill>>

  /**
   * Base URL where the agent is reachable; defaults to the AGENTCORE_RUNTIME_URL env var, then localhost.
   */
  url?: string

  /**
   * Port used for the localhost fallback URL, defaults to 9000.
   */
  port?: number
}

/**
 * Builds an A2A v1.0 AgentCard with a legacy v0.3 interface mirror.
 *
 * The service URL resolution order is: explicit `url` param, the
 * `AGENTCORE_RUNTIME_URL` environment variable (set when deployed on
 * AgentCore Runtime), then `http://localhost:{port}/`. Both a v1.0 and a
 * v0.3 JSONRPC interface are declared because AgentCore's documented A2A
 * shape and the Python A2A ecosystem still speak v0.3, while `@a2a-js/sdk`
 * v1 clients use the v1.0 methods — the server's legacy compat layer
 * routes both.
 *
 * @param params - Name, description, and optional skills/url/port
 * @returns A complete AgentCard
 */
export function buildAgentCard(params: AgentCardParams): AgentCard {
  const url = params.url ?? agentCoreRuntimeUrl() ?? `http://localhost:${params.port ?? 9000}/`

  return {
    name: params.name,
    description: params.description,
    version: params.version ?? '1.0.0',
    supportedInterfaces: duplicateInterfacesForLegacy(
      [{ url, protocolBinding: 'JSONRPC', tenant: '', protocolVersion: '1.0' }],
      ['JSONRPC']
    ),
    provider: undefined,
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extensions: [],
      extendedAgentCard: false,
    },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: (params.skills ?? []).map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      tags: skill.tags ?? [],
      examples: skill.examples ?? [],
      inputModes: skill.inputModes ?? [],
      outputModes: skill.outputModes ?? [],
      securityRequirements: skill.securityRequirements ?? [],
    })),
    signatures: [],
    iconUrl: undefined,
  }
}

/**
 * Returns a copy of `card` with every JSONRPC interface pointing at `url`,
 * appending one if the card has none.
 *
 * Used by {@link serveA2A} so a caller-provided card never advertises a
 * stale URL when `AGENTCORE_RUNTIME_URL` is set. The runtime invocation URL
 * serves both protocol versions, so all JSONRPC interfaces (v1.0 and the
 * v0.3 legacy mirror) get the same value.
 *
 * @param card - The agent card to rewrite
 * @param url - The URL to set on all JSONRPC interfaces
 * @returns A new AgentCard with updated interfaces
 */
export function withJsonRpcUrl(card: AgentCard, url: string): AgentCard {
  const hasJsonRpc = card.supportedInterfaces.some((i) => i.protocolBinding === 'JSONRPC')
  const supportedInterfaces = hasJsonRpc
    ? card.supportedInterfaces.map((i) => (i.protocolBinding === 'JSONRPC' ? { ...i, url } : i))
    : [...card.supportedInterfaces, { url, protocolBinding: 'JSONRPC', tenant: '', protocolVersion: '1.0' }]
  return { ...card, supportedInterfaces }
}
