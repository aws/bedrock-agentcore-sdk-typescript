/**
 * Client for AgentCore Web Search.
 *
 * Web search is reachable today as an AgentCore Gateway connector target, which an
 * agent calls as an MCP tool. This module wraps that so callers get a plain
 * `search()` method and a normalized result type instead of MCP content blocks.
 */

import { fromNodeProviderChain } from '@aws-sdk/credential-providers'
import type { AwsCredentialIdentityProvider } from '@aws-sdk/types'
import { HttpRequest } from '@smithy/protocol-http'
import { SignatureV4 } from '@smithy/signature-v4'
import { Sha256 } from '@aws-crypto/sha256-js'

import { getGatewayMcpEndpoint } from '../../_utils/endpoints.js'
import type {
  SearchOptions,
  WebSearchBackend,
  WebSearchResponse,
  WebSearchResult,
  WebSearchToolArguments,
} from './types.js'
import {
  DEFAULT_TIMEOUT,
  GATEWAY_SIGNING_SERVICE,
  GATEWAY_TOOL_NAME_DELIMITER,
  KNOWN_REGIONS,
  MCP_PROTOCOL_VERSION,
  SearchOptionsSchema,
  SearchQuerySchema,
  WEB_SEARCH_TOOL_NAME,
  WebSearchError,
} from './types.js'

/**
 * Minimal shape of a JSON-RPC reply. The gateway speaks MCP over JSON-RPC 2.0.
 */
interface JsonRpcReply {
  jsonrpc?: string
  id?: number | string
  result?: Record<string, unknown>
  error?: { code?: number; message?: string }
}

/**
 * The `fetch` implementation used to reach the gateway. Injectable so unit tests
 * do not need a network or credentials.
 *
 * @public
 */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

/**
 * Configuration for {@link GatewayMcpBackend}.
 */
export interface GatewayMcpBackendConfig {
  /** The gateway's MCP endpoint URL. */
  endpoint: string
  /** Region to sign for. */
  region: string
  /** Credential provider. Defaults to the Node provider chain. */
  credentialsProvider?: AwsCredentialIdentityProvider | undefined
  /** Fully qualified tool name. Skips discovery when given. */
  toolName?: string | undefined
  /**
   * Target the connector was added under. Used to derive the tool name without a
   * `tools/list` round trip.
   */
  targetName?: string | undefined
  /** Per-request timeout in milliseconds. */
  timeout?: number | undefined
  /** Fetch implementation to use. Defaults to the global fetch. */
  fetchImpl?: FetchLike | undefined
}

/**
 * Configuration for {@link WebSearchClient}.
 */
export interface WebSearchClientConfig {
  /** Region to call. Required unless a gateway ARN or a backend is given. */
  region?: string | undefined
  /** ID of a gateway that has a web search connector target. */
  gatewayId?: string | undefined
  /** ARN of that gateway. The ID and the region are read from it. */
  gatewayArn?: string | undefined
  /** A gateway MCP endpoint URL, if you already have one. */
  gatewayEndpoint?: string | undefined
  /**
   * Name of the connector target. Supplying it avoids a `tools/list` round trip
   * on the first search.
   */
  targetName?: string | undefined
  /** Fully qualified tool name, if you already know it. */
  toolName?: string | undefined
  /** A backend to use as is. Overrides every gateway option. */
  backend?: WebSearchBackend | undefined
  /** Credential provider. Defaults to the Node provider chain. */
  credentialsProvider?: AwsCredentialIdentityProvider | undefined
  /** Per-request timeout in milliseconds. */
  timeout?: number | undefined
  /** Fetch implementation to use. Defaults to the global fetch. */
  fetchImpl?: FetchLike | undefined
}

/**
 * Reaches web search through an AgentCore Gateway target over MCP.
 *
 * Speaks the subset of MCP streamable HTTP that one tool call needs, meaning
 * initialize, the initialized notification, optionally `tools/list`, then
 * `tools/call`, signing each request with SigV4. It is deliberately narrow: it is
 * not a general MCP client and it adds no dependency the SDK does not already have.
 *
 * Both response framings the transport allows are handled, since a gateway may
 * answer a POST with either `application/json` or `text/event-stream`.
 *
 * @public
 */
export class GatewayMcpBackend implements WebSearchBackend {
  private readonly endpoint: string
  private readonly region: string
  private readonly credentialsProvider: AwsCredentialIdentityProvider
  private readonly timeout: number
  private readonly fetchImpl: FetchLike
  private readonly targetName: string | undefined

  private toolName: string | undefined
  private mcpSessionId: string | undefined
  private protocolVersion: string = MCP_PROTOCOL_VERSION
  private requestId = 0
  private initialized = false
  /** In-flight initialize, so concurrent searches share one MCP session. */
  private initializing: Promise<void> | undefined

  constructor(config: GatewayMcpBackendConfig) {
    this.endpoint = config.endpoint
    this.region = config.region
    this.credentialsProvider = config.credentialsProvider ?? fromNodeProviderChain()
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT
    this.fetchImpl = config.fetchImpl ?? ((url, init): Promise<Response> => globalThis.fetch(url, init))
    this.toolName = config.toolName
    this.targetName = config.targetName
  }

  private nextId(): number {
    this.requestId += 1
    return this.requestId
  }

  /**
   * Signs a request body with SigV4 and returns the headers to send.
   *
   * Content-Length is deliberately not signed: fetch sets it itself, and signing a
   * header the runtime then rewrites invalidates the signature.
   */
  private async signedHeaders(body: string, extra: Record<string, string>): Promise<Record<string, string>> {
    const url = new URL(this.endpoint)
    const credentials = await this.credentialsProvider()

    const request = new HttpRequest({
      protocol: url.protocol,
      hostname: url.hostname,
      ...(url.port && { port: Number(url.port) }),
      path: url.pathname,
      method: 'POST',
      body,
      headers: {
        host: url.host,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...extra,
      },
    })

    const signer = new SignatureV4({
      service: GATEWAY_SIGNING_SERVICE,
      region: this.region,
      credentials,
      sha256: Sha256,
    })

    const signed = await signer.sign(request)

    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(signed.headers)) {
      if (typeof value === 'string') {
        headers[key] = value
      }
    }
    return headers
  }

  /**
   * Sends one JSON-RPC message and returns the decoded reply, if there is one.
   *
   * A notification is answered with an empty body, which is a null reply rather
   * than an error.
   */
  private async post(message: Record<string, unknown>): Promise<JsonRpcReply | null> {
    const body = JSON.stringify(message)

    const extra: Record<string, string> = {}
    if (this.mcpSessionId) {
      extra['mcp-session-id'] = this.mcpSessionId
    }
    if (this.initialized) {
      extra['mcp-protocol-version'] = this.protocolVersion
    }

    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      body,
      headers: await this.signedHeaders(body, extra),
      signal: AbortSignal.timeout(this.timeout),
    })

    const sessionId = response.headers.get('mcp-session-id')
    if (sessionId) {
      this.mcpSessionId = sessionId
    }

    const text = await response.text()

    if (!response.ok) {
      throw new WebSearchError(`Web search request failed with HTTP ${response.status}: ${text.slice(0, 500)}`)
    }

    if (!text) {
      return null
    }

    const reply = decodeJsonRpc(response.headers.get('content-type') ?? '', text)
    if (reply === null) {
      return null
    }
    if (reply.error) {
      throw new WebSearchError(`Gateway returned a JSON-RPC error ${reply.error.code}: ${reply.error.message}`)
    }
    return reply
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return
    }
    if (!this.initializing) {
      this.initializing = this.initialize().finally(() => {
        this.initializing = undefined
      })
    }
    return this.initializing
  }

  private async initialize(): Promise<void> {
    const reply = await this.post({
      jsonrpc: '2.0',
      id: this.nextId(),
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'bedrock-agentcore-typescript', version: MCP_PROTOCOL_VERSION },
      },
    })

    if (reply === null) {
      throw new WebSearchError('Gateway did not answer the MCP initialize request')
    }

    const negotiated = reply.result?.protocolVersion
    if (typeof negotiated === 'string' && negotiated) {
      this.protocolVersion = negotiated
    }

    this.initialized = true
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' })
  }

  /**
   * Resolves the fully qualified tool name, discovering it only when it cannot be
   * derived, since a `tools/list` costs a round trip.
   */
  private async ensureToolName(): Promise<string> {
    if (this.toolName) {
      return this.toolName
    }

    if (this.targetName) {
      this.toolName = `${this.targetName}${GATEWAY_TOOL_NAME_DELIMITER}${WEB_SEARCH_TOOL_NAME}`
      return this.toolName
    }

    const suffix = `${GATEWAY_TOOL_NAME_DELIMITER}${WEB_SEARCH_TOOL_NAME}`
    const candidates = (await this.listToolNames()).filter(
      (name) => name === WEB_SEARCH_TOOL_NAME || name.endsWith(suffix)
    )

    const [resolved, ...extra] = candidates
    if (resolved === undefined) {
      throw new WebSearchError(
        `No ${WEB_SEARCH_TOOL_NAME} tool found on ${this.endpoint}. ` +
          'Add a web search connector target to the gateway, or pass targetName.'
      )
    }
    if (extra.length > 0) {
      throw new WebSearchError(
        `Gateway exposes more than one ${WEB_SEARCH_TOOL_NAME} tool (${[...candidates].sort().join(', ')}). ` +
          'Pass targetName to choose one.'
      )
    }

    this.toolName = resolved
    return resolved
  }

  /** Lists every tool the gateway exposes, following pagination. */
  private async listToolNames(): Promise<string[]> {
    const names: string[] = []
    let cursor: string | undefined

    for (;;) {
      const reply = await this.post({
        jsonrpc: '2.0',
        id: this.nextId(),
        method: 'tools/list',
        params: cursor ? { cursor } : {},
      })

      const result = reply?.result ?? {}
      const tools = Array.isArray(result.tools) ? result.tools : []
      for (const tool of tools) {
        if (tool && typeof tool === 'object' && typeof (tool as { name?: unknown }).name === 'string') {
          names.push((tool as { name: string }).name)
        }
      }

      const nextCursor = result.nextCursor
      if (typeof nextCursor !== 'string' || !nextCursor) {
        return names
      }
      cursor = nextCursor
    }
  }

  /**
   * Calls the WebSearch tool and returns the decoded search payload.
   *
   * @param args - The tool's argument object
   * @returns The decoded `{ id, results }` payload
   */
  async search(args: WebSearchToolArguments): Promise<unknown> {
    await this.ensureInitialized()
    const toolName = await this.ensureToolName()

    const reply = await this.post({
      jsonrpc: '2.0',
      id: this.nextId(),
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    })

    if (reply === null) {
      throw new WebSearchError('Gateway did not answer the web search tool call')
    }
    return extractSearchPayload(reply.result ?? {})
  }

  /** Forgets the MCP session so the next search starts a new one. */
  close(): void {
    this.initialized = false
    this.mcpSessionId = undefined
  }
}

/**
 * Client for AgentCore Web Search.
 *
 * Calls are authenticated with SigV4 using ordinary AWS credentials. There is no
 * web search API key. The credentials this client resolves have to be allowed to
 * invoke the gateway, and the gateway's own service role needs
 * `bedrock-agentcore:InvokeGateway` on the gateway ARN plus
 * `bedrock-agentcore:InvokeWebSearch` on the service-owned tool ARN. An
 * AccessDenied on a search is almost always one of those missing.
 *
 * @example
 * ```typescript
 * import { WebSearchClient } from 'bedrock-agentcore/web-search'
 *
 * const client = new WebSearchClient({ region: 'us-east-1', gatewayId: 'my-gateway-abc123' })
 * const response = await client.search('what shipped in node 24', { maxResults: 5 })
 * for (const result of response.results) {
 *   console.log(result.title, result.url)
 * }
 * ```
 *
 * @public
 */
export class WebSearchClient {
  /** The region being used. */
  readonly region: string | undefined
  /** The transport in use. */
  readonly backend: WebSearchBackend

  private readonly ownsBackend: boolean

  constructor(config: WebSearchClientConfig = {}) {
    const { backend, gatewayId, gatewayArn, gatewayEndpoint } = config
    this.ownsBackend = backend === undefined

    if (backend !== undefined) {
      if (gatewayId !== undefined || gatewayArn !== undefined || gatewayEndpoint !== undefined) {
        throw new Error('Pass either backend or one of gatewayId, gatewayArn, gatewayEndpoint, not both')
      }
      this.region = config.region
      this.backend = backend
      return
    }

    const given = (
      [
        ['gatewayId', gatewayId],
        ['gatewayArn', gatewayArn],
        ['gatewayEndpoint', gatewayEndpoint],
      ] as const
    )
      .filter(([, value]) => Boolean(value))
      .map(([name]) => name)

    if (given.length > 1) {
      throw new Error(`Pass only one of gatewayId, gatewayArn or gatewayEndpoint, got ${given.join(', ')}`)
    }

    let resolvedId = gatewayId
    let region = config.region

    if (gatewayArn) {
      const parsed = parseGatewayArn(gatewayArn)
      resolvedId = parsed.gatewayId
      region = region ?? parsed.region
    }

    if (!region) {
      throw new Error('region is required. Pass region, or a gatewayArn to read it from.')
    }

    if (!(KNOWN_REGIONS as readonly string[]).includes(region)) {
      console.warn(
        `Web search is offered in ${KNOWN_REGIONS.join(', ')}. ` +
          `Calling ${region} may fail if the connector is not available there.`
      )
    }

    const endpoint = resolvedId ? getGatewayMcpEndpoint(resolvedId, region) : gatewayEndpoint
    if (!endpoint) {
      throw new Error('One of gatewayId, gatewayArn, gatewayEndpoint or backend is required')
    }

    this.region = region
    this.backend = new GatewayMcpBackend({
      endpoint,
      region,
      credentialsProvider: config.credentialsProvider,
      toolName: config.toolName,
      targetName: config.targetName,
      timeout: config.timeout,
      fetchImpl: config.fetchImpl,
    })
  }

  /**
   * Searches the web.
   *
   * The filter options need connector version 1.2.0 or later on the target. On an
   * earlier version the tool accepts only `query` and `maxResults`.
   *
   * Request filters compose with the target's own domain rules and can never widen
   * them. A domain is dropped if it appears on either exclude list, and returned
   * only if it appears on every include list that is set, so passing
   * `includeDomains` against a target that already has one narrows to the
   * intersection. Two disjoint include lists return zero results and raise no
   * error, so check the target's configuration when a filtered search comes back
   * empty.
   *
   * @param query - What to search for, 200 characters or fewer
   * @param options - Result limit and filters
   * @returns The search results
   *
   * @throws WebSearchError if the call fails or the response cannot be decoded.
   */
  async search(query: string, options: SearchOptions = {}): Promise<WebSearchResponse> {
    const args = buildSearchArguments(query, options)
    return toWebSearchResponse(await this.backend.search(args))
  }

  /** Releases the backend, if this client created it. */
  close(): void {
    if (this.ownsBackend) {
      this.backend.close()
    }
  }
}

/**
 * Validates search inputs and shapes them into the tool's argument object.
 *
 * Empty filter arrays are dropped rather than sent, because an empty include list
 * is not the same request as no include list.
 */
function buildSearchArguments(query: string, options: SearchOptions): WebSearchToolArguments {
  const parsedQuery = SearchQuerySchema.parse(query)
  const parsedOptions = SearchOptionsSchema.parse(options)

  const args: WebSearchToolArguments = { query: parsedQuery }

  if (parsedOptions.maxResults !== undefined) {
    args.maxResults = parsedOptions.maxResults
  }

  const domainFilter: { include?: string[]; exclude?: string[] } = {}
  if (parsedOptions.includeDomains?.length) {
    domainFilter.include = [...parsedOptions.includeDomains]
  }
  if (parsedOptions.excludeDomains?.length) {
    domainFilter.exclude = [...parsedOptions.excludeDomains]
  }

  const publishedDateFilter: { from?: string; to?: string } = {}
  if (parsedOptions.publishedAfter) {
    publishedDateFilter.from = parsedOptions.publishedAfter
  }
  if (parsedOptions.publishedBefore) {
    publishedDateFilter.to = parsedOptions.publishedBefore
  }

  const filters: WebSearchToolArguments['filters'] = {}
  if (Object.keys(domainFilter).length > 0) {
    filters.domainFilter = domainFilter
  }
  if (Object.keys(publishedDateFilter).length > 0) {
    filters.publishedDateFilter = publishedDateFilter
  }
  if (Object.keys(filters).length > 0) {
    args.filters = filters
  }

  return args
}

/**
 * Pulls the search payload out of an MCP `tools/call` result.
 *
 * The connector returns the results as a JSON document inside a text content
 * block, so the text has to be decoded rather than read directly.
 */
function extractSearchPayload(result: Record<string, unknown>): unknown {
  if (result.isError) {
    throw new WebSearchError(`Web search tool reported an error: ${firstText(result) ?? JSON.stringify(result)}`)
  }

  const text = firstText(result)
  if (text === undefined) {
    throw new WebSearchError(`Web search response contained no text content: ${JSON.stringify(result)}`)
  }

  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    throw new WebSearchError(`Could not decode web search response as JSON: ${text.slice(0, 200)}`)
  }

  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new WebSearchError('Expected a JSON object in the web search response')
  }
  return payload
}

/** Returns the first text content block of an MCP result, if any. */
function firstText(result: Record<string, unknown>): string | undefined {
  const content = result.content
  if (!Array.isArray(content)) {
    return undefined
  }
  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      return (block as { text: string }).text
    }
  }
  return undefined
}

/** Normalizes a decoded search payload into the response type callers see. */
function toWebSearchResponse(payload: unknown): WebSearchResponse {
  const record = (payload ?? {}) as Record<string, unknown>
  const rawResults = Array.isArray(record.results) ? record.results : []

  const results: WebSearchResult[] = []
  for (const item of rawResults) {
    if (!item || typeof item !== 'object') {
      continue
    }
    const entry = item as Record<string, unknown>
    const result: WebSearchResult = { text: typeof entry.text === 'string' ? entry.text : '' }
    if (typeof entry.url === 'string') {
      result.url = entry.url
    }
    if (typeof entry.title === 'string') {
      result.title = entry.title
    }
    if (typeof entry.publishedDate === 'string') {
      result.publishedDate = entry.publishedDate
    }
    results.push(result)
  }

  const response: WebSearchResponse = { results }
  if (typeof record.id === 'string') {
    response.searchId = record.id
  }
  return response
}

/**
 * Decodes a JSON-RPC reply from either a JSON body or an SSE stream.
 *
 * Returns null when the body carries no JSON-RPC message, which is what a
 * notification acknowledgement looks like.
 */
function decodeJsonRpc(contentType: string, text: string): JsonRpcReply | null {
  if (contentType.toLowerCase().includes('text/event-stream')) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) {
        continue
      }
      const chunk = line.slice('data:'.length).trim()
      if (!chunk) {
        continue
      }
      try {
        const message = JSON.parse(chunk)
        if (message && typeof message === 'object' && 'jsonrpc' in message) {
          return message as JsonRpcReply
        }
      } catch {
        continue
      }
    }
    return null
  }

  let message: unknown
  try {
    message = JSON.parse(text)
  } catch {
    throw new WebSearchError(`Could not decode gateway response as JSON: ${text.slice(0, 200)}`)
  }
  return message && typeof message === 'object' && !Array.isArray(message) ? (message as JsonRpcReply) : null
}

/** Pulls the gateway ID and region out of a gateway ARN. */
function parseGatewayArn(arn: string): { gatewayId: string; region: string } {
  const parts = arn.split(':')
  const resource = parts[5]
  const region = parts[3]
  if (parts[0] !== 'arn' || region === undefined || resource === undefined || !resource.startsWith('gateway/')) {
    throw new Error(
      `Not a gateway ARN: '${arn}'. Expected 'arn:aws:bedrock-agentcore:<region>:<account>:gateway/<id>'.`
    )
  }
  const gatewayId = resource.slice('gateway/'.length)
  if (!gatewayId) {
    throw new Error(`Gateway ARN carries no gateway ID: '${arn}'`)
  }
  return { gatewayId, region }
}
