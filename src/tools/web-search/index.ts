// Main client
export { WebSearchClient, GatewayMcpBackend } from './client.js'

// Types and interfaces
export type { FetchLike, GatewayMcpBackendConfig, WebSearchClientConfig } from './client.js'

export type {
  SearchOptions,
  WebSearchBackend,
  WebSearchResponse,
  WebSearchResult,
  WebSearchToolArguments,
} from './types.js'

// Errors
export { WebSearchError } from './types.js'

// Zod schemas for validation
export { SearchOptionsSchema, SearchQuerySchema } from './types.js'

// Constants
export {
  DEFAULT_TARGET_NAME,
  DEFAULT_TIMEOUT,
  GATEWAY_SIGNING_SERVICE,
  GATEWAY_TOOL_NAME_DELIMITER,
  KNOWN_REGIONS,
  MAX_DOMAIN_FILTER_ENTRIES,
  MAX_MAX_RESULTS,
  MAX_QUERY_LENGTH,
  MCP_PROTOCOL_VERSION,
  MIN_MAX_RESULTS,
  WEB_SEARCH_TOOL_NAME,
} from './types.js'
