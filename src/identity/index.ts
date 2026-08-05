/**
 * AgentCore Identity SDK
 *
 * Provides identity and credential management for AI agents.
 * Supports inbound authentication (SigV4, JWT) and outbound authentication (OAuth2, API keys).
 *
 * @example HOF wrapper usage
 * ```typescript
 * import { withAccessToken } from '@aws/bedrock-agentcore-sdk';
 *
 * const myTool = withAccessToken({
 *   providerName: 'github',
 *   scopes: ['repo'],
 *   authFlow: 'M2M',
 * })(async (input: string, token: string) => {
 *   // Token automatically injected
 * });
 * ```
 */

// Higher-order functions for wrapping tools
export { withAccessToken, withApiKey, withWAT } from './wrappers.js'

// Middleware for automatic WAT propagation on AWS SDK clients
export { withWatPropagation } from './middleware.js'

// All type definitions
export * from './types.js'
