/**
 * Type definitions for AgentCore Identity SDK
 */

/**
 * Request parameters for retrieving an OAuth2 access token
 */
export interface OAuth2TokenRequest {
  /** Name of the credential provider */
  providerName: string
  /** OAuth2 scopes to request */
  scopes: string[]
  /** Authentication flow type */
  authFlow: 'M2M' | 'USER_FEDERATION'
  /** Workload identity token for authentication */
  workloadIdentityToken: string
  /** OAuth2 callback URL (must be pre-registered) */
  callbackUrl?: string | undefined
  /** Force re-authentication even if token exists in vault */
  forceAuthentication?: boolean | undefined
  /** Session URI for polling subsequent requests */
  sessionUri?: string | undefined
  /** Custom state for callback validation */
  customState?: string | undefined
  /** Custom parameters for authorization request */
  customParameters?: Record<string, string> | undefined
  /** Callback invoked when authorization URL is returned */
  onAuthUrl?: ((url: string) => void | Promise<void>) | undefined
}

/**
 * Request parameters for retrieving an API key
 */
export interface ApiKeyRequest {
  /** Name of the credential provider */
  providerName: string
  /** Workload identity token for authentication */
  workloadIdentityToken: string
}

/**
 * Configuration for withAccessToken HOF wrapper
 */
export interface OAuth2WrapperConfig {
  /**
   * Workload identity token for authentication.
   * Optional - if not provided, automatically falls back to context.workloadAccessToken
   * when called within a request handler. If neither is available, an error is thrown.
   */
  workloadIdentityToken?: string | undefined
  /** Name of the credential provider */
  providerName: string
  /** OAuth2 scopes to request */
  scopes: string[]
  /** Authentication flow type */
  authFlow: 'M2M' | 'USER_FEDERATION'
  /** Callback invoked when authorization URL is returned */
  onAuthUrl?: ((url: string) => void | Promise<void>) | undefined
  /** Force re-authentication even if token exists in vault */
  forceAuthentication?: boolean | undefined
  /**
   * OAuth2 callback URL (must be pre-registered).
   * Optional - if not provided, automatically falls back to context.oauth2CallbackUrl
   * when called within a request handler.
   */
  callbackUrl?: string | undefined
  /** Custom state for callback validation */
  customState?: string | undefined
  /** Custom parameters for authorization request */
  customParameters?: Record<string, string> | undefined
}

/**
 * Configuration for withApiKey HOF wrapper
 */
export interface ApiKeyWrapperConfig {
  /**
   * Workload identity token for authentication.
   * Optional - if not provided, automatically falls back to context.workloadAccessToken
   * when called within a request handler. If neither is available, an error is thrown.
   */
  workloadIdentityToken?: string | undefined
  /** Name of the credential provider */
  providerName: string
}
