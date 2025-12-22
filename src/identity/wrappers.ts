/**
 * Higher-order functions for wrapping tools with automatic credential injection
 */

import { IdentityClient } from './client.js'
import type { OAuth2WrapperConfig, ApiKeyWrapperConfig } from './types.js'

/**
 * Wraps an async function to automatically inject OAuth2 access token.
 *
 * @param config - OAuth2 configuration
 * @returns Function wrapper that injects token as last parameter
 *
 * @example
 * ```typescript
 * const myTool = withAccessToken({
 *   providerName: 'github',
 *   scopes: ['repo'],
 *   authFlow: 'M2M'
 * })(async (input: string, token: string) => {
 *   // Use token to call GitHub API
 * });
 * ```
 */
export function withAccessToken<TArgs extends unknown[], TReturn>(
  config: OAuth2WrapperConfig
): (fn: (...args: [...TArgs, string]) => Promise<TReturn>) => (...args: TArgs) => Promise<TReturn> {
  const client = new IdentityClient()

  return (fn) => {
    return async (...args: TArgs): Promise<TReturn> => {
      const token = await client.getOAuth2Token({
        providerName: config.providerName,
        scopes: config.scopes,
        authFlow: config.authFlow,
        workloadIdentityToken: config.workloadIdentityToken,
        onAuthUrl: config.onAuthUrl,
        forceAuthentication: config.forceAuthentication,
        callbackUrl: config.callbackUrl,
        customState: config.customState,
        customParameters: config.customParameters,
      })

      return fn(...args, token)
    }
  }
}

/**
 * Wraps an async function to automatically inject API key.
 *
 * @param config - API key configuration
 * @returns Function wrapper that injects API key as last parameter
 *
 * @example
 * ```typescript
 * const myTool = withApiKey({
 *   providerName: 'openai'
 * })(async (input: string, apiKey: string) => {
 *   // Use API key to call OpenAI API
 * });
 * ```
 */
export function withApiKey<TArgs extends unknown[], TReturn>(
  config: ApiKeyWrapperConfig
): (fn: (...args: [...TArgs, string]) => Promise<TReturn>) => (...args: TArgs) => Promise<TReturn> {
  const client = new IdentityClient()

  return (fn) => {
    return async (...args: TArgs): Promise<TReturn> => {
      const apiKey = await client.getApiKey({
        providerName: config.providerName,
        workloadIdentityToken: config.workloadIdentityToken,
      })

      return fn(...args, apiKey)
    }
  }
}
