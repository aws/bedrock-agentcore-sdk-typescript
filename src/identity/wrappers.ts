/**
 * Higher-order functions for wrapping tools with automatic credential injection
 */

import { IdentityClient } from './client.js'
import type { OAuth2WrapperConfig, ApiKeyWrapperConfig } from './types.js'

/**
 * Helper type to extract all parameters except the last one (the token/apiKey)
 */
type InitParams<T extends unknown[]> = T extends [...infer Init, unknown] ? Init : never

/**
 * Wraps an async function to automatically inject OAuth2 access token.
 * The token is injected as the last parameter of the wrapped function.
 *
 * @param config - OAuth2 configuration
 * @returns Function wrapper that injects token as last parameter
 *
 * @example
 * ```typescript
 * const myTool = withAccessToken({
 *   workloadIdentityToken: token,
 *   providerName: 'github',
 *   scopes: ['repo'],
 *   authFlow: 'M2M'
 * })(async (input: string, token: string) => {
 *   // Use token to call GitHub API
 *   return { result: input };
 * });
 *
 * await myTool('hello'); // token injected automatically
 * ```
 */
export function withAccessToken(config: OAuth2WrapperConfig) {
  const client = new IdentityClient()

  return <TParams extends [...unknown[], string], TReturn>(
    fn: (...args: TParams) => Promise<TReturn>
  ): ((...args: InitParams<TParams>) => Promise<TReturn>) => {
    return async (...args: InitParams<TParams>): Promise<TReturn> => {
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

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return fn(...([...args, token] as any))
    }
  }
}

/**
 * Wraps an async function to automatically inject API key.
 * The API key is injected as the last parameter of the wrapped function.
 *
 * @param config - API key configuration
 * @returns Function wrapper that injects API key as last parameter
 *
 * @example
 * ```typescript
 * const myTool = withApiKey({
 *   workloadIdentityToken: token,
 *   providerName: 'openai'
 * })(async (input: string, apiKey: string) => {
 *   // Use API key to call OpenAI API
 *   return { result: input };
 * });
 *
 * await myTool('hello'); // apiKey injected automatically
 * ```
 */
export function withApiKey(config: ApiKeyWrapperConfig) {
  const client = new IdentityClient()

  return <TParams extends [...unknown[], string], TReturn>(
    fn: (...args: TParams) => Promise<TReturn>
  ): ((...args: InitParams<TParams>) => Promise<TReturn>) => {
    return async (...args: InitParams<TParams>): Promise<TReturn> => {
      const apiKey = await client.getApiKey({
        providerName: config.providerName,
        workloadIdentityToken: config.workloadIdentityToken,
      })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return fn(...([...args, apiKey] as any))
    }
  }
}
