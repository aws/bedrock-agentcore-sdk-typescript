/**
 * IdentityClient for AgentCore Identity operations
 */

import {
  BedrockAgentCoreClient,
  GetResourceOauth2TokenCommand,
  GetResourceApiKeyCommand,
} from '@aws-sdk/client-bedrock-agentcore'
import type { OAuth2TokenRequest, ApiKeyRequest } from './types.js'

const POLLING_INTERVAL_MS = 5000 // 5 seconds
const POLLING_TIMEOUT_MS = 600000 // 10 minutes

/**
 * Client for interacting with Amazon Bedrock AgentCore Identity service.
 * Provides methods for managing workload identities, credential providers,
 * and retrieving OAuth2 tokens and API keys.
 */
export class IdentityClient {
  private readonly dataPlaneClient: BedrockAgentCoreClient

  /**
   * Creates a new IdentityClient instance
   * @param region - AWS region (defaults to AWS_REGION env var)
   * @throws Error if region cannot be determined
   */
  constructor(region?: string) {
    const resolvedRegion = region || process.env.AWS_REGION

    if (!resolvedRegion) {
      throw new Error('AWS region must be specified either as a parameter or via AWS_REGION environment variable')
    }

    this.dataPlaneClient = new BedrockAgentCoreClient({ region: resolvedRegion })
  }

  /**
   * Retrieves an OAuth2 access token from AgentCore Identity.
   * Handles both M2M (immediate) and USER_FEDERATION (polling) flows.
   *
   * @param request - OAuth2 token request parameters
   * @returns OAuth2 access token
   * @throws Error if token retrieval fails or times out
   */
  async getOAuth2Token(request: OAuth2TokenRequest): Promise<string> {
    const command = new GetResourceOauth2TokenCommand({
      resourceCredentialProviderName: request.providerName,
      scopes: request.scopes,
      oauth2Flow: request.authFlow,
      workloadIdentityToken: request.workloadIdentityToken,
      resourceOauth2ReturnUrl: request.callbackUrl,
      forceAuthentication: request.forceAuthentication,
      sessionUri: request.sessionUri,
      customState: request.customState,
      customParameters: request.customParameters,
    })

    const response = await this.dataPlaneClient.send(command)

    // M2M flow - token returned immediately
    if (response.accessToken) {
      return response.accessToken
    }

    // USER_FEDERATION flow - authorization URL returned
    if (response.authorizationUrl) {
      // Invoke callback if provided
      if (request.onAuthUrl) {
        await request.onAuthUrl(response.authorizationUrl)
      }

      // Poll for token
      return this.pollForToken({
        ...request,
        sessionUri: response.sessionUri,
        forceAuthentication: false,
      })
    }

    throw new Error('Identity service did not return a token or authorization URL')
  }

  /**
   * Polls for OAuth2 token until available or timeout
   */
  private async pollForToken(request: OAuth2TokenRequest): Promise<string> {
    const startTime = Date.now()

    while (Date.now() - startTime < POLLING_TIMEOUT_MS) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, POLLING_INTERVAL_MS))

      const command = new GetResourceOauth2TokenCommand({
        resourceCredentialProviderName: request.providerName,
        scopes: request.scopes,
        oauth2Flow: request.authFlow,
        workloadIdentityToken: request.workloadIdentityToken,
        sessionUri: request.sessionUri,
        resourceOauth2ReturnUrl: request.callbackUrl,
        customState: request.customState,
        customParameters: request.customParameters,
      })

      const response = await this.dataPlaneClient.send(command)

      if (response.accessToken) {
        return response.accessToken
      }
    }

    throw new Error(
      `Polling timed out after ${POLLING_TIMEOUT_MS / 1000} seconds. User may not have completed authorization.`
    )
  }

  /**
   * Retrieves an API key from AgentCore Identity token vault.
   *
   * @param request - API key request parameters
   * @returns API key string
   * @throws Error if API key retrieval fails
   */
  async getApiKey(request: ApiKeyRequest): Promise<string> {
    const command = new GetResourceApiKeyCommand({
      resourceCredentialProviderName: request.providerName,
      workloadIdentityToken: request.workloadIdentityToken,
    })

    const response = await this.dataPlaneClient.send(command)

    if (!response.apiKey) {
      throw new Error(`No API key returned for provider: ${request.providerName}`)
    }

    return response.apiKey
  }
}
