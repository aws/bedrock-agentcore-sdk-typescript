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
 * Response from GetResourceOAuth2Token API
 */
export interface OAuth2TokenResponse {
  /** OAuth2 access token (returned for M2M or after polling) */
  accessToken?: string
  /** Authorization URL for user consent (USER_FEDERATION flow) */
  authorizationUrl?: string
  /** Session URI for polling */
  sessionUri?: string
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
 * Response from GetResourceApiKey API
 */
export interface ApiKeyResponse {
  /** API key value */
  apiKey: string
}

/**
 * Configuration for withAccessToken HOF wrapper
 */
export interface OAuth2WrapperConfig {
  /** Workload identity token for authentication */
  workloadIdentityToken: string
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
  /** OAuth2 callback URL (must be pre-registered) */
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
  /** Workload identity token for authentication */
  workloadIdentityToken: string
  /** Name of the credential provider */
  providerName: string
}

/**
 * Workload identity resource
 */
export interface WorkloadIdentity {
  /** Unique name of the workload identity */
  name: string
  /** ARN of the workload identity */
  workloadIdentityArn?: string | undefined
  /** Allowed OAuth2 callback URLs */
  allowedResourceOauth2ReturnUrls?: string[] | undefined
}

/**
 * OAuth2 credential provider resource
 */
export interface OAuth2Provider {
  /** Unique name of the provider */
  name: string
  /** ARN of the provider */
  credentialProviderArn?: string | undefined
  /** OAuth2 callback URL for this provider */
  callbackUrl?: string | undefined
}

/**
 * Authorization server metadata for OAuth2 providers
 */
export interface AuthorizationServerMetadata {
  /** Issuer URL */
  issuer: string
  /** Authorization endpoint URL */
  authorizationEndpoint: string
  /** Token endpoint URL */
  tokenEndpoint: string
}

/**
 * Configuration for creating an OAuth2 credential provider
 */
export type OAuth2ProviderConfig = {
  /** Unique name for the provider */
  name: string
  /** Client ID from OAuth2 provider */
  clientId: string
  /** Client secret from OAuth2 provider */
  clientSecret: string
} & (
  | { /** Discovery URL for OIDC providers like Google, Cognito */ discoveryUrl: string }
  | {
      /** Authorization server metadata for providers like GitHub */ authorizationServerMetadata: AuthorizationServerMetadata
    }
)

/**
 * API key credential provider resource
 */
export interface ApiKeyProvider {
  /** Unique name of the provider */
  name: string
  /** ARN of the provider */
  credentialProviderArn?: string | undefined
}

/**
 * Configuration for creating an API key credential provider
 */
export interface ApiKeyProviderConfig {
  /** Unique name for the provider */
  name: string
  /** API key value */
  apiKey: string
  /** Optional headers to include with API key */
  headers?: Record<string, string>
}
