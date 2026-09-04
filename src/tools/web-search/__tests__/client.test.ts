import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GatewayMcpBackend, WebSearchClient } from '../client.js'
import type { FetchLike, GatewayMcpBackendConfig } from '../client.js'
import { WebSearchError, type WebSearchBackend, type WebSearchToolArguments } from '../types.js'

const REGION = 'us-east-1'
const GATEWAY_ID = 'my-gateway-abc123'
const ENDPOINT = `https://${GATEWAY_ID}.gateway.bedrock-agentcore.${REGION}.amazonaws.com/mcp`

const CREDENTIALS = async () => ({
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
})

/** Records the arguments it is called with so assertions can look at them. */
class StubBackend implements WebSearchBackend {
  calls: WebSearchToolArguments[] = []
  closed = false
  constructor(private payload: unknown = { id: 'search-1', results: [] }) {}
  async search(args: WebSearchToolArguments): Promise<unknown> {
    this.calls.push(args)
    return this.payload
  }
  close(): void {
    this.closed = true
  }
}

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  })
}

/**
 * Answers an MCP conversation: initialize, the initialized notification, then
 * whatever the test queues for tools/list and tools/call.
 */
function mcpFetch(handlers: { toolsList?: unknown; toolsCall?: unknown; sessionId?: string } = {}): {
  fetchImpl: FetchLike
  requests: Array<{ method: string; body: any; headers: Record<string, string> }>
} {
  const requests: Array<{ method: string; body: any; headers: Record<string, string> }> = []

  const fetchImpl: FetchLike = async (_url, init) => {
    const body = JSON.parse(String(init.body))
    const headers = init.headers as Record<string, string>
    requests.push({ method: body.method, body, headers })

    if (body.method === 'initialize') {
      return jsonResponse(
        { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: {} } },
        { headers: { 'mcp-session-id': handlers.sessionId ?? 'session-abc' } }
      )
    }
    if (body.method === 'notifications/initialized') {
      return new Response('', { status: 202 })
    }
    if (body.method === 'tools/list') {
      return jsonResponse({ jsonrpc: '2.0', id: body.id, result: handlers.toolsList ?? { tools: [] } })
    }
    if (body.method === 'tools/call') {
      return jsonResponse({ jsonrpc: '2.0', id: body.id, result: handlers.toolsCall ?? textResult({ results: [] }) })
    }
    throw new Error(`unexpected method ${body.method}`)
  }

  return { fetchImpl, requests }
}

/** Wraps a search payload the way the connector does, as JSON inside a text block. */
function textResult(payload: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false }
}

function backendFor(overrides: Partial<GatewayMcpBackendConfig> = {}) {
  const { fetchImpl } = mcpFetch()
  return new GatewayMcpBackend({
    endpoint: ENDPOINT,
    region: REGION,
    credentialsProvider: CREDENTIALS,
    fetchImpl,
    targetName: 'amazon-web-search',
    ...overrides,
  })
}

describe('WebSearchClient construction', () => {
  it('builds a gateway endpoint from a gateway id', () => {
    const client = new WebSearchClient({ region: REGION, gatewayId: GATEWAY_ID })
    expect(client.region).toBe(REGION)
    expect(client.backend).toBeInstanceOf(GatewayMcpBackend)
  })

  it('reads the id and region out of a gateway arn', () => {
    const client = new WebSearchClient({
      gatewayArn: `arn:aws:bedrock-agentcore:eu-west-1:123456789012:gateway/${GATEWAY_ID}`,
    })
    expect(client.region).toBe('eu-west-1')
  })

  it('prefers an explicit region over the one in the arn', () => {
    const client = new WebSearchClient({
      region: REGION,
      gatewayArn: `arn:aws:bedrock-agentcore:eu-west-1:123456789012:gateway/${GATEWAY_ID}`,
    })
    expect(client.region).toBe(REGION)
  })

  it('rejects an arn that is not a gateway arn', () => {
    expect(() => new WebSearchClient({ gatewayArn: 'arn:aws:s3:::my-bucket' })).toThrow(/Not a gateway ARN/)
  })

  it('rejects a gateway arn with no id', () => {
    expect(
      () => new WebSearchClient({ gatewayArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:gateway/' })
    ).toThrow(/carries no gateway ID/)
  })

  it('accepts a gateway endpoint directly', () => {
    const client = new WebSearchClient({ region: REGION, gatewayEndpoint: ENDPOINT })
    expect(client.backend).toBeInstanceOf(GatewayMcpBackend)
  })

  it('rejects more than one way of naming the gateway', () => {
    expect(() => new WebSearchClient({ region: REGION, gatewayId: GATEWAY_ID, gatewayEndpoint: ENDPOINT })).toThrow(
      /only one of gatewayId, gatewayArn or gatewayEndpoint/
    )
  })

  it('rejects a backend combined with a gateway option', () => {
    expect(() => new WebSearchClient({ backend: new StubBackend(), gatewayId: GATEWAY_ID })).toThrow(
      /either backend or one of/
    )
  })

  it('requires a region when one cannot be derived', () => {
    expect(() => new WebSearchClient({ gatewayId: GATEWAY_ID })).toThrow(/region is required/)
  })

  it('requires something to talk to', () => {
    expect(() => new WebSearchClient({ region: REGION })).toThrow(/is required/)
  })

  it('warns on a region where web search is not offered, without blocking', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const client = new WebSearchClient({ region: 'us-west-2', gatewayId: GATEWAY_ID })
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]![0]).toContain('us-east-1, eu-west-1, ap-northeast-1')
    expect(client.backend).toBeInstanceOf(GatewayMcpBackend)
    warn.mockRestore()
  })

  it('does not warn on a supported region', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    new WebSearchClient({ region: 'ap-northeast-1', gatewayId: GATEWAY_ID })
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('takes a caller supplied backend as is', () => {
    const backend = new StubBackend()
    const client = new WebSearchClient({ backend })
    expect(client.backend).toBe(backend)
  })
})

describe('search argument shaping', () => {
  let backend: StubBackend
  let client: WebSearchClient

  beforeEach(() => {
    backend = new StubBackend()
    client = new WebSearchClient({ backend })
  })

  it('sends only the query when no options are given', async () => {
    await client.search('what shipped in node 24')
    expect(backend.calls[0]).toEqual({ query: 'what shipped in node 24' })
  })

  it('passes maxResults through', async () => {
    await client.search('q', { maxResults: 5 })
    expect(backend.calls[0]).toEqual({ query: 'q', maxResults: 5 })
  })

  it('nests domain filters under filters.domainFilter', async () => {
    await client.search('q', { includeDomains: ['aws.amazon.com'], excludeDomains: ['example.com'] })
    expect(backend.calls[0]!.filters).toEqual({
      domainFilter: { include: ['aws.amazon.com'], exclude: ['example.com'] },
    })
  })

  it('sends only the side of the domain filter that was given', async () => {
    await client.search('q', { excludeDomains: ['example.com'] })
    expect(backend.calls[0]!.filters).toEqual({ domainFilter: { exclude: ['example.com'] } })
  })

  it('maps the date options onto from and to', async () => {
    await client.search('q', { publishedAfter: '2026-01-01T00:00:00Z', publishedBefore: '2026-06-01T00:00:00Z' })
    expect(backend.calls[0]!.filters).toEqual({
      publishedDateFilter: { from: '2026-01-01T00:00:00Z', to: '2026-06-01T00:00:00Z' },
    })
  })

  it('omits filters entirely when every filter list is empty', async () => {
    await client.search('q', { includeDomains: [], excludeDomains: [] })
    expect(backend.calls[0]).toEqual({ query: 'q' })
  })

  it('rejects an empty query', async () => {
    await expect(client.search('')).rejects.toThrow()
    await expect(client.search('   ')).rejects.toThrow()
    expect(backend.calls).toHaveLength(0)
  })

  it('rejects a query over the documented length limit', async () => {
    await expect(client.search('x'.repeat(201))).rejects.toThrow()
    expect(backend.calls).toHaveLength(0)
  })

  it('accepts a query exactly at the length limit', async () => {
    await client.search('x'.repeat(200))
    expect(backend.calls).toHaveLength(1)
  })

  it('rejects maxResults outside the documented range', async () => {
    await expect(client.search('q', { maxResults: 0 })).rejects.toThrow()
    await expect(client.search('q', { maxResults: 26 })).rejects.toThrow()
    await expect(client.search('q', { maxResults: 1.5 })).rejects.toThrow()
    expect(backend.calls).toHaveLength(0)
  })

  it('accepts both ends of the maxResults range', async () => {
    await client.search('q', { maxResults: 1 })
    await client.search('q', { maxResults: 25 })
    expect(backend.calls).toHaveLength(2)
  })

  it('rejects a domain list over the documented limit', async () => {
    const domains = Array.from({ length: 101 }, (_, i) => `d${i}.example.com`)
    await expect(client.search('q', { includeDomains: domains })).rejects.toThrow()
  })
})

describe('response normalization', () => {
  it('maps a payload onto the response type', async () => {
    const backend = new StubBackend({
      id: 'search-42',
      results: [
        { text: 'snippet', url: 'https://example.com/a', title: 'A', publishedDate: '2026-01-01' },
        { text: 'only text' },
      ],
    })
    const response = await new WebSearchClient({ backend }).search('q')

    expect(response.searchId).toBe('search-42')
    expect(response.results).toEqual([
      { text: 'snippet', url: 'https://example.com/a', title: 'A', publishedDate: '2026-01-01' },
      { text: 'only text' },
    ])
  })

  it('tolerates a payload with no results at all', async () => {
    const response = await new WebSearchClient({ backend: new StubBackend({}) }).search('q')
    expect(response.results).toEqual([])
    expect(response.searchId).toBeUndefined()
  })

  it('skips entries that are not objects and defaults a missing snippet to empty', async () => {
    const backend = new StubBackend({ results: [null, 'nope', { url: 'https://example.com' }] })
    const response = await new WebSearchClient({ backend }).search('q')
    expect(response.results).toEqual([{ text: '', url: 'https://example.com' }])
  })
})

describe('GatewayMcpBackend over MCP', () => {
  it('initializes, derives the tool name from the target, then calls the tool', async () => {
    const { fetchImpl, requests } = mcpFetch({
      toolsCall: textResult({ id: 'search-1', results: [{ text: 'hit' }] }),
    })
    const client = new WebSearchClient({
      region: REGION,
      gatewayId: GATEWAY_ID,
      targetName: 'amazon-web-search',
      credentialsProvider: CREDENTIALS,
      fetchImpl,
    })

    const response = await client.search('q')

    expect(requests.map((r) => r.method)).toEqual(['initialize', 'notifications/initialized', 'tools/call'])
    expect(requests[2]!.body.params.name).toBe('amazon-web-search___WebSearch')
    expect(response.results).toEqual([{ text: 'hit' }])
  })

  it('signs every request with SigV4 for the gateway service', async () => {
    const { fetchImpl, requests } = mcpFetch()
    await backendFor({ fetchImpl }).search({ query: 'q' })

    for (const request of requests) {
      expect(request.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=/)
      expect(request.headers.authorization).toContain(`/${REGION}/bedrock-agentcore/aws4_request`)
      expect(request.headers['x-amz-date']).toBeDefined()
    }
  })

  it('does not sign content-length, which fetch sets itself', async () => {
    const { fetchImpl, requests } = mcpFetch()
    await backendFor({ fetchImpl }).search({ query: 'q' })

    const signedHeaders = /SignedHeaders=([^,]+)/.exec(requests[0]!.headers.authorization ?? '')?.[1] ?? ''
    expect(signedHeaders).not.toContain('content-length')
    expect(signedHeaders).toContain('host')
  })

  it('echoes the MCP session id back on later requests', async () => {
    const { fetchImpl, requests } = mcpFetch({ sessionId: 'session-xyz' })
    await backendFor({ fetchImpl }).search({ query: 'q' })

    expect(requests[0]!.headers['mcp-session-id']).toBeUndefined()
    expect(requests[1]!.headers['mcp-session-id']).toBe('session-xyz')
    expect(requests[2]!.headers['mcp-session-id']).toBe('session-xyz')
  })

  it('sends the negotiated protocol version once initialized', async () => {
    const fetchImpl: FetchLike = async (_url, init) => {
      const body = JSON.parse(String(init.body))
      if (body.method === 'initialize') {
        return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2099-01-01' } })
      }
      if (body.method === 'notifications/initialized') {
        return new Response('', { status: 202 })
      }
      return jsonResponse({ jsonrpc: '2.0', id: body.id, result: textResult({ results: [] }) })
    }
    const seen: Array<string | undefined> = []
    const spy: FetchLike = async (url, init) => {
      seen.push((init.headers as Record<string, string>)['mcp-protocol-version'])
      return fetchImpl(url, init)
    }

    await backendFor({ fetchImpl: spy }).search({ query: 'q' })
    expect(seen).toEqual([undefined, '2099-01-01', '2099-01-01'])
  })

  it('initializes only once across two searches', async () => {
    const { fetchImpl, requests } = mcpFetch()
    const backend = backendFor({ fetchImpl })
    await backend.search({ query: 'a' })
    await backend.search({ query: 'b' })

    expect(requests.filter((r) => r.method === 'initialize')).toHaveLength(1)
    expect(requests.filter((r) => r.method === 'tools/call')).toHaveLength(2)
  })

  it('initializes only once when two searches start concurrently', async () => {
    const { fetchImpl, requests } = mcpFetch()
    const backend = backendFor({ fetchImpl })
    await Promise.all([backend.search({ query: 'a' }), backend.search({ query: 'b' })])

    expect(requests.filter((r) => r.method === 'initialize')).toHaveLength(1)
  })

  it('initializes again after close', async () => {
    const { fetchImpl, requests } = mcpFetch()
    const backend = backendFor({ fetchImpl })
    await backend.search({ query: 'a' })
    backend.close()
    await backend.search({ query: 'b' })

    expect(requests.filter((r) => r.method === 'initialize')).toHaveLength(2)
  })

  it('discovers the tool name over tools/list when no target name is known', async () => {
    const { fetchImpl, requests } = mcpFetch({
      toolsList: { tools: [{ name: 'other___Thing' }, { name: 'search-target___WebSearch' }] },
    })
    const backend = backendFor({ fetchImpl, targetName: undefined })
    await backend.search({ query: 'q' })

    expect(requests.map((r) => r.method)).toContain('tools/list')
    expect(requests.at(-1)?.body.params.name).toBe('search-target___WebSearch')
  })

  it('follows tools/list pagination', async () => {
    let page = 0
    const fetchImpl: FetchLike = async (_url, init) => {
      const body = JSON.parse(String(init.body))
      if (body.method === 'initialize') {
        return jsonResponse({ jsonrpc: '2.0', id: body.id, result: {} })
      }
      if (body.method === 'notifications/initialized') {
        return new Response('', { status: 202 })
      }
      if (body.method === 'tools/list') {
        page += 1
        return page === 1
          ? jsonResponse({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'a' }], nextCursor: 'c1' } })
          : jsonResponse({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'tgt___WebSearch' }] } })
      }
      return jsonResponse({ jsonrpc: '2.0', id: body.id, result: textResult({ results: [] }) })
    }

    await backendFor({ fetchImpl, targetName: undefined }).search({ query: 'q' })
    expect(page).toBe(2)
  })

  it('accepts an unprefixed WebSearch tool name', async () => {
    const { fetchImpl, requests } = mcpFetch({ toolsList: { tools: [{ name: 'WebSearch' }] } })
    await backendFor({ fetchImpl, targetName: undefined }).search({ query: 'q' })
    expect(requests.at(-1)?.body.params.name).toBe('WebSearch')
  })

  it('fails clearly when the gateway exposes no web search tool', async () => {
    const { fetchImpl } = mcpFetch({ toolsList: { tools: [{ name: 'other___Thing' }] } })
    await expect(backendFor({ fetchImpl, targetName: undefined }).search({ query: 'q' })).rejects.toThrow(
      /No WebSearch tool found/
    )
  })

  it('fails clearly when the gateway exposes more than one web search tool', async () => {
    const { fetchImpl } = mcpFetch({ toolsList: { tools: [{ name: 'a___WebSearch' }, { name: 'b___WebSearch' }] } })
    await expect(backendFor({ fetchImpl, targetName: undefined }).search({ query: 'q' })).rejects.toThrow(
      /more than one WebSearch tool \(a___WebSearch, b___WebSearch\)/
    )
  })

  it('skips discovery when the tool name is given', async () => {
    const { fetchImpl, requests } = mcpFetch()
    await backendFor({ fetchImpl, targetName: undefined, toolName: 'tgt___WebSearch' }).search({ query: 'q' })

    expect(requests.map((r) => r.method)).not.toContain('tools/list')
    expect(requests.at(-1)?.body.params.name).toBe('tgt___WebSearch')
  })

  it('decodes a reply framed as server sent events', async () => {
    const fetchImpl: FetchLike = async (_url, init) => {
      const body = JSON.parse(String(init.body))
      if (body.method === 'notifications/initialized') {
        return new Response('', { status: 202 })
      }
      const result = body.method === 'initialize' ? {} : textResult({ results: [{ text: 'sse hit' }] })
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }

    const payload = await backendFor({ fetchImpl }).search({ query: 'q' })
    expect(payload).toEqual({ results: [{ text: 'sse hit' }] })
  })

  it('ignores non-data lines and undecodable data chunks in an SSE body', async () => {
    const fetchImpl: FetchLike = async (_url, init) => {
      const body = JSON.parse(String(init.body))
      if (body.method === 'notifications/initialized') {
        return new Response('', { status: 202 })
      }
      const result = body.method === 'initialize' ? {} : textResult({ results: [] })
      const lines = [
        ': a comment',
        'event: message',
        'data:',
        'data: not json',
        `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}`,
      ]
      return new Response(lines.join('\r\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }

    await expect(backendFor({ fetchImpl }).search({ query: 'q' })).resolves.toEqual({ results: [] })
  })

  it('surfaces an HTTP error with the status and the body', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response('{"message":"User is not authorized to perform bedrock-agentcore:InvokeGateway"}', {
        status: 403,
        headers: { 'content-type': 'application/json' },
      })

    await expect(backendFor({ fetchImpl }).search({ query: 'q' })).rejects.toThrow(
      /failed with HTTP 403:.*InvokeGateway/
    )
  })

  it('surfaces a JSON-RPC error', async () => {
    const fetchImpl: FetchLike = async (_url, init) => {
      const body = JSON.parse(String(init.body))
      return jsonResponse({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } })
    }

    await expect(backendFor({ fetchImpl }).search({ query: 'q' })).rejects.toThrow(
      /JSON-RPC error -32601: Method not found/
    )
  })

  it('fails when initialize is answered with an empty body', async () => {
    const fetchImpl: FetchLike = async () => new Response('', { status: 202 })
    await expect(backendFor({ fetchImpl }).search({ query: 'q' })).rejects.toThrow(
      /did not answer the MCP initialize request/
    )
  })

  it('fails when the tool call is answered with an empty body', async () => {
    const fetchImpl: FetchLike = async (_url, init) => {
      const body = JSON.parse(String(init.body))
      if (body.method === 'initialize') {
        return jsonResponse({ jsonrpc: '2.0', id: body.id, result: {} })
      }
      return new Response('', { status: 202 })
    }
    await expect(backendFor({ fetchImpl }).search({ query: 'q' })).rejects.toThrow(
      /did not answer the web search tool call/
    )
  })

  it('fails when a JSON body is not decodable', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response('not json at all', { status: 200, headers: { 'content-type': 'application/json' } })
    await expect(backendFor({ fetchImpl }).search({ query: 'q' })).rejects.toThrow(
      /Could not decode gateway response as JSON/
    )
  })

  it('reports a tool level error rather than returning empty results', async () => {
    const { fetchImpl } = mcpFetch({
      toolsCall: { isError: true, content: [{ type: 'text', text: 'quota exceeded' }] },
    })
    await expect(backendFor({ fetchImpl }).search({ query: 'q' })).rejects.toThrow(
      /tool reported an error: quota exceeded/
    )
  })

  it('reports a result that carries no text content', async () => {
    const { fetchImpl } = mcpFetch({ toolsCall: { content: [{ type: 'image', data: 'x' }] } })
    await expect(backendFor({ fetchImpl }).search({ query: 'q' })).rejects.toThrow(/no text content/)
  })

  it('reports a text block that is not JSON', async () => {
    const { fetchImpl } = mcpFetch({ toolsCall: { content: [{ type: 'text', text: 'plain prose' }] } })
    await expect(backendFor({ fetchImpl }).search({ query: 'q' })).rejects.toThrow(
      /Could not decode web search response as JSON/
    )
  })

  it('reports a text block whose JSON is not an object', async () => {
    const { fetchImpl } = mcpFetch({ toolsCall: { content: [{ type: 'text', text: '[1,2,3]' }] } })
    await expect(backendFor({ fetchImpl }).search({ query: 'q' })).rejects.toThrow(/Expected a JSON object/)
  })

  it('raises WebSearchError, so callers can catch one type', async () => {
    const fetchImpl: FetchLike = async () => new Response('boom', { status: 500 })
    await expect(backendFor({ fetchImpl }).search({ query: 'q' })).rejects.toBeInstanceOf(WebSearchError)
  })
})

describe('client lifecycle', () => {
  it('closes a backend it created', async () => {
    const { fetchImpl } = mcpFetch()
    const client = new WebSearchClient({
      region: REGION,
      gatewayId: GATEWAY_ID,
      targetName: 'tgt',
      credentialsProvider: CREDENTIALS,
      fetchImpl,
    })
    await client.search('q')
    client.close()
    // A closed backend starts a new MCP session on the next search rather than throwing.
    await expect(client.search('q')).resolves.toBeDefined()
  })

  it('leaves a caller supplied backend alone', () => {
    const backend = new StubBackend()
    new WebSearchClient({ backend }).close()
    expect(backend.closed).toBe(false)
  })
})

describe('timeout', () => {
  let abortSpy: ReturnType<typeof vi.spyOn> | undefined

  afterEach(() => {
    abortSpy?.mockRestore()
    abortSpy = undefined
  })

  it('applies the default timeout to each request', async () => {
    abortSpy = vi.spyOn(AbortSignal, 'timeout')
    const { fetchImpl } = mcpFetch()
    await backendFor({ fetchImpl }).search({ query: 'q' })
    expect(abortSpy).toHaveBeenCalledWith(30_000)
  })

  it('applies a caller supplied timeout', async () => {
    abortSpy = vi.spyOn(AbortSignal, 'timeout')
    const { fetchImpl } = mcpFetch()
    await backendFor({ fetchImpl, timeout: 1234 }).search({ query: 'q' })
    expect(abortSpy).toHaveBeenCalledWith(1234)
  })
})
