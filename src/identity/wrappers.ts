/**
 * Higher-order functions for wrapping tools with automatic credential injection
 */

import { IdentityClient } from './client.js'
import type { OAuth2WrapperConfig, ApiKeyWrapperConfig } from './types.js'
import { getContext } from '../runtime/context.js'

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
      // Get context and fallback to it if config doesn't provide token
      const context = getContext()
      const workloadToken = config.workloadIdentityToken ?? context?.workloadAccessToken

      if (!workloadToken) {
        throw new Error(
          'workloadIdentityToken not provided and no context available. ' +
            'Either pass workloadIdentityToken in config or call from within a request handler.'
        )
      }

      const token = await client.getOAuth2Token({
        providerName: config.providerName,
        scopes: config.scopes,
        resources: config.resources,
        audiences: config.audiences,
        authFlow: config.authFlow,
        workloadIdentityToken: workloadToken,
        onAuthUrl: config.onAuthUrl,
        forceAuthentication: config.forceAuthentication,
        callbackUrl: config.callbackUrl ?? context?.oauth2CallbackUrl,
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
      // Get context and fallback to it if config doesn't provide token
      const context = getContext()
      const workloadToken = config.workloadIdentityToken ?? context?.workloadAccessToken

      if (!workloadToken) {
        throw new Error(
          'workloadIdentityToken not provided and no context available. ' +
            'Either pass workloadIdentityToken in config or call from within a request handler.'
        )
      }

      const apiKey = await client.getApiKey({
        providerName: config.providerName,
        workloadIdentityToken: workloadToken,
      })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return fn(...([...args, apiKey] as any))
    }
  }
}

/**
 * Wraps an async function to automatically inject the Workload Access Token (WAT).
 * The WAT is read from the current request context and injected as the last parameter.
 *
 *
 * @param fn - Async function whose last parameter receives the WAT
 * @returns Wrapped function that injects the WAT automatically
 *
 * @example
 * ```typescript
 * const callGateway = withWAT(async (query: string, wat: string) => {
 *   return fetch('https://gateway.example.com/mcp', {
 *     headers: { 'X-Amz-Bedrock-AgentCore-Identity-WAT': wat }
 *   })
 * })
 *
 * // Inside a request handler — wat injected from context
 * await callGateway('what is the weather?')
 * ```
 */
export function withWAT<TParams extends unknown[], TReturn>(
  fn: (...args: [...TParams, string]) => Promise<TReturn>
): (...args: TParams) => Promise<TReturn> {
  return async (...args: TParams): Promise<TReturn> => {
    const context = getContext()
    const wat = context?.workloadAccessToken
    if (!wat) {
      throw new Error('No workload access token in context. Ensure the agent is running on AgentCore Runtime.')
    }
    return fn(...args, wat)
  }
}
