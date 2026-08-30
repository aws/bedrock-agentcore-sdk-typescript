/**
 * AgentCore runtime header extraction for the A2A protocol path.
 *
 * AgentCore Runtime injects per-request headers (session id, request id,
 * workload access token, OAuth2 callback URL) into every proxied A2A call.
 * This module extracts them into a typed context and applies the runtime
 * header allowlist to decide which caller headers reach agent code.
 */

import { randomUUID } from 'crypto'

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
   * Workload access token for AgentCore Identity, from the `WorkloadAccessToken` header.
   */
  workloadAccessToken?: string | undefined

  /**
   * OAuth2 callback URL for authentication flows, from the `OAuth2CallbackUrl` header.
   */
  oauth2CallbackUrl?: string | undefined

  /**
   * Forwardable caller headers: `Authorization` plus everything that passes the runtime header allowlist.
   */
  headers: Record<string, string>
}

/**
 * Raw incoming headers as provided by Node.js HTTP servers.
 */
export type IncomingHeaders = Record<string, string | string[] | undefined>

const SESSION_HEADER = 'x-amzn-bedrock-agentcore-runtime-session-id'
const REQUEST_ID_HEADER = 'x-amzn-bedrock-agentcore-runtime-request-id'
const WORKLOAD_TOKEN_HEADER = 'workloadaccesstoken'
const OAUTH2_CALLBACK_HEADER = 'oauth2callbackurl'
const AUTHORIZATION_HEADER = 'authorization'
const CUSTOM_HEADER_PREFIX = 'x-amzn-bedrock-agentcore-runtime-custom-'

/**
 * Headers that must not be forwarded to agent code, from the AgentCore
 * runtime header allowlist docs — the same list the Python SDK ships in
 * `runtime/models.py`. Grouped as in the docs.
 */
const RESTRICTED_HEADERS: ReadonlySet<string> = new Set(
  [
    // Authentication & Authorization
    'Proxy-Authorization',
    'WWW-Authenticate',
    // Content Negotiation
    'Accept',
    'Accept-Charset',
    'Accept-Encoding',
    'Accept-Language',
    'Content-Type',
    'Content-Length',
    'Content-Encoding',
    'Content-Language',
    'Content-Location',
    'Content-Range',
    // Caching
    'Cache-Control',
    'ETag',
    'Expires',
    'If-Match',
    'If-Modified-Since',
    'If-None-Match',
    'If-Range',
    'If-Unmodified-Since',
    'Last-Modified',
    'Pragma',
    'Vary',
    // Connection Management
    'Connection',
    'Keep-Alive',
    'Proxy-Connection',
    'Upgrade',
    // Request Context
    'Host',
    'User-Agent',
    'Referer',
    'From',
    // Range / Transfer
    'Range',
    'Accept-Ranges',
    'Transfer-Encoding',
    'TE',
    'Trailer',
    // Server Information
    'Server',
    'Date',
    'Location',
    'Retry-After',
    // Cookies
    'Set-Cookie',
    'Cookie',
    // Security
    'Content-Security-Policy',
    'Content-Security-Policy-Report-Only',
    'Strict-Transport-Security',
    'X-Content-Type-Options',
    'X-Frame-Options',
    'X-XSS-Protection',
    'Referrer-Policy',
    'Permissions-Policy',
    'Cross-Origin-Embedder-Policy',
    'Cross-Origin-Opener-Policy',
    'Cross-Origin-Resource-Policy',
    // CORS
    'Access-Control-Allow-Origin',
    'Access-Control-Allow-Methods',
    'Access-Control-Allow-Headers',
    'Access-Control-Allow-Credentials',
    'Access-Control-Expose-Headers',
    'Access-Control-Max-Age',
    'Access-Control-Request-Method',
    'Access-Control-Request-Headers',
    'Origin',
    // Client Hints
    'Accept-CH',
    'Accept-CH-Lifetime',
    'DPR',
    'Width',
    'Viewport-Width',
    'Downlink',
    'ECT',
    'RTT',
    'Save-Data',
    // Experimental / Proposed
    'Clear-Site-Data',
    'Feature-Policy',
    'Expect-CT',
    'Public-Key-Pins',
    'Public-Key-Pins-Report-Only',
    // Proxy
    'Via',
    'Forwarded',
    'X-Forwarded-For',
    'X-Forwarded-Host',
    'X-Forwarded-Proto',
    'X-Real-IP',
    'X-Requested-With',
    'X-CSRF-Token',
    // IP Spoofing / URL Manipulation
    'True-Client-IP',
    'X-Client-IP',
    'X-Cluster-Client-IP',
    'X-Originating-IP',
    'X-Source-IP',
    'X-Original-URL',
    'X-Original-Host',
    'X-Rewrite-URL',
    // CDN / Proxy
    'CF-Ray',
    'CF-Connecting-IP',
    'X-Amz-Cf-Id',
    'X-Cache',
    'X-Served-By',
    // HTTP/2 Pseudo Headers
    ':method',
    ':path',
    ':scheme',
    ':authority',
    ':status',
    // Server Push
    'Link',
    // WebSocket
    'Sec-WebSocket-Key',
    'Sec-WebSocket-Accept',
    'Sec-WebSocket-Version',
    'Sec-WebSocket-Protocol',
    'Sec-WebSocket-Extensions',
  ].map((header) => header.toLowerCase())
)

/**
 * Returns whether a header may be forwarded to agent code.
 *
 * Rules from the AgentCore runtime header allowlist docs:
 * - not in the restricted headers list,
 * - does not start with `x-amz-` (reserved for AWS SigV4 signing),
 * - does not start with `x-amzn-` unless it carries the runtime custom header prefix.
 *
 * Trace propagation headers (`traceparent`, `baggage`) pass these rules.
 *
 * @param headerName - Header name in any casing
 * @returns True when the header may be forwarded to agent code
 */
export function isForwardableHeader(headerName: string): boolean {
  const lower = headerName.toLowerCase()
  if (RESTRICTED_HEADERS.has(lower)) {
    return false
  }
  if (lower.startsWith('x-amz-')) {
    return false
  }
  if (lower.startsWith('x-amzn-') && !lower.startsWith(CUSTOM_HEADER_PREFIX)) {
    return false
  }
  return true
}

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
    workloadAccessToken: headerValue(headers[WORKLOAD_TOKEN_HEADER]),
    oauth2CallbackUrl: headerValue(headers[OAUTH2_CALLBACK_HEADER]),
    headers: forwardable,
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(', ') : value
}
