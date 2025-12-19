/**
 * IdentityClient for AgentCore Identity operations
 */

import {
  BedrockAgentCoreClient,
  GetResourceOauth2TokenCommand,
  GetResourceApiKeyCommand,
  GetWorkloadAccessTokenCommand,
  GetWorkloadAccessTokenForJWTCommand,
  GetWorkloadAccessTokenForUserIdCommand,
} from '@aws-sdk/client-bedrock-agentcore'
import {
  BedrockAgentCoreControlClient,
  CreateWorkloadIdentityCommand,
  GetWorkloadIdentityCommand,
  DeleteWorkloadIdentityCommand,
  CreateOauth2CredentialProviderCommand,
  GetOauth2CredentialProviderCommand,
  DeleteOauth2CredentialProviderCommand,
  CreateApiKeyCredentialProviderCommand,
  GetApiKeyCredentialProviderCommand,
  DeleteApiKeyCredentialProviderCommand,
} from '@aws-sdk/client-bedrock-agentcore-control'
import type {
  OAuth2TokenRequest,
  ApiKeyRequest,
  WorkloadIdentity,
  OAuth2ProviderConfig,
  OAuth2Provider,
  ApiKeyProviderConfig,
  ApiKeyProvider,
} from './types.js'

const POLLING_INTERVAL_MS = 5000 // 5 seconds
const POLLING_TIMEOUT_MS = 600000 // 10 minutes

/**
 * Client for interacting with Amazon Bedrock AgentCore Identity service.
 * Provides methods for managing workload identities, credential providers,
 * and retrieving OAuth2 tokens and API keys.
 */
export class IdentityClient {
  private readonly dataPlaneClient: BedrockAgentCoreClient
  private readonly controlPlaneClient: BedrockAgentCoreControlClient

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
    this.controlPlaneClient = new BedrockAgentCoreControlClient({ region: resolvedRegion })
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

  /**
   * Creates a new workload identity in AgentCore Identity directory.
   *
   * @param name - Unique name for the workload identity
   * @param callbackUrls - Optional OAuth2 callback URLs
   * @returns Created workload identity
   */
  async createWorkloadIdentity(name: string, callbackUrls?: string[]): Promise<WorkloadIdentity> {
    const command = new CreateWorkloadIdentityCommand({
      name,
      allowedResourceOauth2ReturnUrls: callbackUrls || [],
    })

    const response = await this.controlPlaneClient.send(command)

    return {
      name: response.name!,
      workloadIdentityArn: response.workloadIdentityArn,
      allowedResourceOauth2ReturnUrls: response.allowedResourceOauth2ReturnUrls,
    }
  }

  /**
   * Retrieves a workload identity from AgentCore Identity directory.
   *
   * @param name - Name of the workload identity
   * @returns Workload identity details
   */
  async getWorkloadIdentity(name: string): Promise<WorkloadIdentity> {
    const command = new GetWorkloadIdentityCommand({ name })

    const response = await this.controlPlaneClient.send(command)

    return {
      name: response.name!,
      workloadIdentityArn: response.workloadIdentityArn,
      allowedResourceOauth2ReturnUrls: response.allowedResourceOauth2ReturnUrls,
    }
  }

  /**
   * Deletes a workload identity from AgentCore Identity directory.
   *
   * @param name - Name of the workload identity to delete
   */
  async deleteWorkloadIdentity(name: string): Promise<void> {
    const command = new DeleteWorkloadIdentityCommand({ name })
    await this.controlPlaneClient.send(command)
  }

  /**
   * Creates a new OAuth2 credential provider.
   *
   * @param config - OAuth2 provider configuration
   * @returns Created OAuth2 provider
   */
  async createOAuth2CredentialProvider(config: OAuth2ProviderConfig): Promise<OAuth2Provider> {
    // Validate that either discoveryUrl or authorizationServerMetadata is provided
    if (!config.discoveryUrl && !config.authorizationServerMetadata) {
      throw new Error('Either discoveryUrl or authorizationServerMetadata must be provided')
    }

    const command = new CreateOauth2CredentialProviderCommand({
      name: config.name,
      credentialProviderVendor: 'CustomOauth2',
      oauth2ProviderConfigInput: {
        customOauth2ProviderConfig: {
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          oauthDiscovery: config.discoveryUrl
            ? { discoveryUrl: config.discoveryUrl }
            : config.authorizationServerMetadata
              ? { authorizationServerMetadata: config.authorizationServerMetadata }
              : undefined,
        },
      },
    })

    const response = await this.controlPlaneClient.send(command)

    return {
      name: response.name!,
      credentialProviderArn: response.credentialProviderArn,
      callbackUrl: response.callbackUrl,
    }
  }

  /**
   * Retrieves an OAuth2 credential provider.
   *
   * @param name - Name of the OAuth2 provider
   * @returns OAuth2 provider details
   */
  async getOAuth2CredentialProvider(name: string): Promise<OAuth2Provider> {
    const command = new GetOauth2CredentialProviderCommand({ name })

    const response = await this.controlPlaneClient.send(command)

    return {
      name: response.name!,
      credentialProviderArn: response.credentialProviderArn,
      callbackUrl: response.callbackUrl,
    }
  }

  /**
   * Deletes an OAuth2 credential provider.
   *
   * @param name - Name of the OAuth2 provider to delete
   */
  async deleteOAuth2CredentialProvider(name: string): Promise<void> {
    const command = new DeleteOauth2CredentialProviderCommand({ name })
    await this.controlPlaneClient.send(command)
  }

  /**
   * Creates a new API key credential provider.
   *
   * @param config - API key provider configuration
   * @returns Created API key provider
   */
  async createApiKeyCredentialProvider(config: ApiKeyProviderConfig): Promise<ApiKeyProvider> {
    const command = new CreateApiKeyCredentialProviderCommand({
      name: config.name,
      apiKey: config.apiKey,
    })

    const response = await this.controlPlaneClient.send(command)

    return {
      name: response.name!,
      credentialProviderArn: response.credentialProviderArn,
    }
  }

  /**
   * Retrieves an API key credential provider.
   *
   * @param name - Name of the API key provider
   * @returns API key provider details
   */
  async getApiKeyCredentialProvider(name: string): Promise<ApiKeyProvider> {
    const command = new GetApiKeyCredentialProviderCommand({ name })

    const response = await this.controlPlaneClient.send(command)

    return {
      name: response.name!,
      credentialProviderArn: response.credentialProviderArn,
    }
  }

  /**
   * Deletes an API key credential provider.
   *
   * @param name - Name of the API key provider to delete
   */
  async deleteApiKeyCredentialProvider(name: string): Promise<void> {
    const command = new DeleteApiKeyCredentialProviderCommand({ name })
    await this.controlPlaneClient.send(command)
  }

  /**
   * Gets a workload access token for a workload identity.
   *
   * @param workloadName - Name of the workload identity
   * @returns Workload access token
   */
  async getWorkloadAccessToken(workloadName: string): Promise<string> {
    const command = new GetWorkloadAccessTokenCommand({ workloadName })
    const response = await this.dataPlaneClient.send(command)

    if (!response.workloadAccessToken) {
      throw new Error(`No workload access token returned for workload: ${workloadName}`)
    }

    return response.workloadAccessToken
  }

  /**
   * Gets a workload access token by exchanging a user JWT token.
   *
   * @param workloadName - Name of the workload identity
   * @param userToken - User JWT token
   * @returns Workload access token
   */
  async getWorkloadAccessTokenForJWT(workloadName: string, userToken: string): Promise<string> {
    const command = new GetWorkloadAccessTokenForJWTCommand({
      workloadName,
      userToken,
    })
    const response = await this.dataPlaneClient.send(command)

    if (!response.workloadAccessToken) {
      throw new Error(`No workload access token returned for workload: ${workloadName}`)
    }

    return response.workloadAccessToken
  }

  /**
   * Gets a workload access token for a specific user ID.
   *
   * @param workloadName - Name of the workload identity
   * @param userId - User ID
   * @returns Workload access token
   */
  async getWorkloadAccessTokenForUserId(workloadName: string, userId: string): Promise<string> {
    const command = new GetWorkloadAccessTokenForUserIdCommand({
      workloadName,
      userId,
    })
    const response = await this.dataPlaneClient.send(command)

    if (!response.workloadAccessToken) {
      throw new Error(`No workload access token returned for workload: ${workloadName}`)
    }

    return response.workloadAccessToken
  }
}
