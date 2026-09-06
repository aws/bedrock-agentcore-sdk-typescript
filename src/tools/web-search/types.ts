/**
 * Types, constants and validation schemas for AgentCore Web Search.
 */

import { z } from 'zod'

/**
 * Name of the MCP tool the web search connector exposes. Fixed by the service.
 */
export const WEB_SEARCH_TOOL_NAME = 'WebSearch'

/**
 * Gateway prefixes every tool it exposes with the name of the target the tool came
 * from, joined by this delimiter, so the agent sees `myTarget___WebSearch`.
 */
export const GATEWAY_TOOL_NAME_DELIMITER = '___'

/**
 * Service name the gateway data plane signs as.
 */
export const GATEWAY_SIGNING_SERVICE = 'bedrock-agentcore'

/**
 * Maximum documented query length, in characters.
 */
export const MAX_QUERY_LENGTH = 200

/**
 * Smallest documented value for maxResults.
 */
export const MIN_MAX_RESULTS = 1

/**
 * Largest documented value for maxResults.
 */
export const MAX_MAX_RESULTS = 25

/**
 * Maximum number of domains accepted by either side of the domain filter.
 */
export const MAX_DOMAIN_FILTER_ENTRIES = 100

/**
 * Regions where the web search connector is offered. Used for a warning only,
 * never to block a call, so a newly added region does not require an SDK release.
 */
export const KNOWN_REGIONS = ['us-east-1', 'eu-west-1', 'ap-northeast-1'] as const

/**
 * MCP protocol version this client offers during initialize. The version the
 * gateway negotiates is what gets used afterwards.
 */
export const MCP_PROTOCOL_VERSION = '2025-06-18'

/**
 * Default per-request timeout in milliseconds.
 */
export const DEFAULT_TIMEOUT = 30_000

/**
 * Raised when a web search call fails.
 */
export class WebSearchError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'WebSearchError'
  }
}

/**
 * A single web search result.
 */
export interface WebSearchResult {
  /** The extracted snippet relevant to the query. Always present. */
  text: string
  /** URL of the source page, when the service reported one. */
  url?: string
  /** Title of the source page, when the service reported one. */
  title?: string
  /** Publication date of the page, as reported by the index. */
  publishedDate?: string
}

/**
 * The results of one web search.
 */
export interface WebSearchResponse {
  /** The results, in the order the service returned them. */
  results: WebSearchResult[]
  /** Service-assigned identifier for the search, when present. */
  searchId?: string
}

/**
 * Optional filters and limits for a single search.
 */
export interface SearchOptions {
  /** How many results to return, 1 to 25. The service default is 10. */
  maxResults?: number | undefined
  /** Restrict results to these domains. A root domain matches its subdomains. */
  includeDomains?: string[] | undefined
  /** Drop results from these domains. */
  excludeDomains?: string[] | undefined
  /** Earliest publication date, ISO-8601 UTC, inclusive. Web results only. */
  publishedAfter?: string | undefined
  /** Latest publication date, ISO-8601 UTC, inclusive. Web results only. */
  publishedBefore?: string | undefined
}

/**
 * Validation schema for the options accepted by a single search. The limits are
 * the documented ones, so a request that cannot succeed fails before it is signed
 * and sent.
 */
export const SearchOptionsSchema = z.object({
  maxResults: z.number().int().min(MIN_MAX_RESULTS).max(MAX_MAX_RESULTS).optional(),
  includeDomains: z.array(z.string().min(1)).max(MAX_DOMAIN_FILTER_ENTRIES).optional(),
  excludeDomains: z.array(z.string().min(1)).max(MAX_DOMAIN_FILTER_ENTRIES).optional(),
  publishedAfter: z.string().min(1).optional(),
  publishedBefore: z.string().min(1).optional(),
})

/**
 * Validation schema for a search query.
 */
export const SearchQuerySchema = z
  .string()
  .max(MAX_QUERY_LENGTH)
  .refine((value) => value.trim().length > 0, { message: 'query must be a non-empty string' })

/**
 * The argument object the WebSearch tool is called with. Shaped by the client from
 * a query plus {@link SearchOptions}.
 */
export interface WebSearchToolArguments {
  query: string
  maxResults?: number
  filters?: {
    domainFilter?: {
      include?: string[]
      exclude?: string[]
    }
    publishedDateFilter?: {
      from?: string
      to?: string
    }
  }
}

/**
 * How a {@link WebSearchClient} reaches web search.
 *
 * A backend takes the tool's argument object and returns the decoded search
 * payload, meaning an object shaped `{ id, results }`. Everything above this
 * interface is transport independent, so a different access path can be added
 * later without changing callers.
 */
export interface WebSearchBackend {
  /** Runs one search and returns the decoded payload. */
  search(args: WebSearchToolArguments): Promise<unknown>
  /** Releases any resources held by the backend. */
  close(): void
}
