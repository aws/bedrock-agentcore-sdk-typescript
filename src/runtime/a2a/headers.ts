/**
 * AgentCore runtime header extraction for the A2A protocol path.
 *
 * AgentCore Runtime injects per-request headers (session id, request id,
 * workload access token, OAuth2 callback URL) into every proxied A2A call.
 * This module extracts them into a typed context and applies the runtime
 * header allowlist to decide which caller headers reach agent code.
 */

import { randomUUID } from 'crypto'

import { IDENTITY_WAT_HEADER } from '../constants.js'
import { headerValue, isForwardableHeader } from '../headers.js'
import type { IncomingHeaders } from '../headers.js'

/**
 * Request context extracted from AgentCore-injected A2A headers.
 */
export interface A2ARequestContext {
  /**
   * Session identifier from `x-amzn-bedrock-agentcore-runtime-session-id`, empty when absent.
   */
  sessionId: string

  /**
   * Request ID from `x-amzn-bedrock-agentcore-runtime-request-id`, auto-generated when absent.
   */
  requestId: string

  /**
   * Workload access token for AgentCore Identity, from the `x-amz-bedrock-agentcore-identity-wat` header, falling back to `WorkloadAccessToken`.
   */
  workloadAccessToken?: string | undefined

  /**
   * OAuth2 callback URL for authentication flows, from the `OAuth2CallbackUrl` header.
   */
  oauth2CallbackUrl?: string | undefined

  /**
   * Forwardable caller headers: `Authorization`, the identity WAT header, plus everything that passes the runtime header allowlist.
   */
  headers: Record<string, string>
}

const SESSION_HEADER = 'x-amzn-bedrock-agentcore-runtime-session-id'
const REQUEST_ID_HEADER = 'x-amzn-bedrock-agentcore-runtime-request-id'
const WORKLOAD_TOKEN_HEADER = 'workloadaccesstoken'
const OAUTH2_CALLBACK_HEADER = 'oauth2callbackurl'
const AUTHORIZATION_HEADER = 'authorization'

/**
 * Extracts the AgentCore request context from raw A2A request headers.
 *
 * The context-bearing headers (session id, request id, workload access
 * token, OAuth2 callback URL) land in typed fields; the `headers` map keeps
 * `Authorization` plus every header that passes {@link isForwardableHeader}.
 *
 * @param headers - Raw incoming request headers
 * @returns The extracted request context
 */
export function extractA2AContext(headers: IncomingHeaders): A2ARequestContext {
  const forwardable: Record<string, string> = {}
  for (const [key, raw] of Object.entries(headers)) {
    const value = headerValue(raw)
    if (value === undefined) {
      continue
    }
    const lower = key.toLowerCase()
    if (lower === AUTHORIZATION_HEADER || isForwardableHeader(lower)) {
      forwardable[key] = value
    }
  }

  return {
    sessionId: headerValue(headers[SESSION_HEADER]) ?? '',
    requestId: headerValue(headers[REQUEST_ID_HEADER]) ?? randomUUID(),
    // AgentCore injects the token as WorkloadAccessToken, but an agent invoked
    // by another agent receives it under the identity header that
    // withWatPropagation sets. Same precedence as the HTTP protocol path.
    workloadAccessToken: headerValue(headers[IDENTITY_WAT_HEADER]) || headerValue(headers[WORKLOAD_TOKEN_HEADER]),
    oauth2CallbackUrl: headerValue(headers[OAUTH2_CALLBACK_HEADER]),
    headers: forwardable,
  }
}
