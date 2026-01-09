/**
 * Example: Direct IdentityClient Usage
 *
 * Shows how to use IdentityClient for OAuth2 and API key retrieval.
 * For CRUD operations (creating identities and providers), use AWS SDK directly.
 */

import { IdentityClient } from 'bedrock-agentcore/identity'
import { BedrockAgentCoreClient, GetWorkloadAccessTokenForUserIdCommand } from '@aws-sdk/client-bedrock-agentcore'
import {
  BedrockAgentCoreControlClient,
  CreateWorkloadIdentityCommand,
  CreateOauth2CredentialProviderCommand,
  CreateApiKeyCredentialProviderCommand,
  DeleteOauth2CredentialProviderCommand,
  DeleteApiKeyCredentialProviderCommand,
  DeleteWorkloadIdentityCommand,
} from '@aws-sdk/client-bedrock-agentcore-control'

async function main() {
  const region = 'us-west-2'
  const identity = new IdentityClient(region)
  const dataPlane = new BedrockAgentCoreClient({ region })
  const controlPlane = new BedrockAgentCoreControlClient({ region })

  // 1. Create a workload identity using AWS SDK
  console.log('Creating workload identity...')
  const createIdentityCommand = new CreateWorkloadIdentityCommand({
    name: 'my-agent',
    allowedResourceOauth2ReturnUrls: ['https://myapp.com/oauth/callback'],
  })
  const workloadIdentity = await controlPlane.send(createIdentityCommand)
  console.log('Created:', workloadIdentity.name)

  // 2. Create OAuth2 credential provider using AWS SDK
  console.log('\nCreating OAuth2 provider...')
  const createOAuth2Command = new CreateOauth2CredentialProviderCommand({
    name: 'github',
    credentialProviderVendor: 'CustomOauth2',
    oauth2ProviderConfigInput: {
      customOauth2ProviderConfig: {
        clientId: 'your-github-client-id',
        clientSecret: 'your-github-client-secret',
        oauthDiscovery: {
          authorizationServerMetadata: {
            issuer: 'https://github.com',
            authorizationEndpoint: 'https://github.com/login/oauth/authorize',
            tokenEndpoint: 'https://github.com/login/oauth/access_token',
          },
        },
      },
    },
  })
  const oauth2Provider = await controlPlane.send(createOAuth2Command)
  console.log('Created provider:', oauth2Provider.name)
  console.log('Callback URL:', oauth2Provider.callbackUrl)

  // 3. Create API key credential provider using AWS SDK
  console.log('\nCreating API key provider...')
  const createApiKeyCommand = new CreateApiKeyCredentialProviderCommand({
    name: 'openai',
    apiKey: 'sk-your-openai-api-key',
  })
  const apiKeyProvider = await controlPlane.send(createApiKeyCommand)
  console.log('Created provider:', apiKeyProvider.name)

  // 4. Get workload access token using AWS SDK
  console.log('\nGetting workload access token...')
  const getTokenCommand = new GetWorkloadAccessTokenForUserIdCommand({
    workloadName: 'my-agent',
    userId: 'test-user-123',
  })
  const tokenResponse = await dataPlane.send(getTokenCommand)
  const workloadToken = tokenResponse.workloadAccessToken!
  console.log('Token:', workloadToken.substring(0, 30) + '...')

  // 5. Get OAuth2 token using IdentityClient (has polling logic)
  console.log('\nGetting OAuth2 token...')
  const oauth2Token = await identity.getOAuth2Token({
    workloadIdentityToken: workloadToken,
    providerName: 'github',
    scopes: ['repo'],
    authFlow: 'M2M',
  })
  console.log('OAuth2 token:', oauth2Token.substring(0, 30) + '...')

  // 6. Get API key using IdentityClient
  console.log('\nGetting API key...')
  const apiKey = await identity.getApiKey({
    workloadIdentityToken: workloadToken,
    providerName: 'openai',
  })
  console.log('API key:', apiKey.substring(0, 10) + '...')

  // 7. Use credentials to call external APIs
  console.log('\nCredentials ready for use!')

  // Cleanup using AWS SDK
  console.log('\nCleaning up...')
  await controlPlane.send(new DeleteOauth2CredentialProviderCommand({ name: 'github' }))
  await controlPlane.send(new DeleteApiKeyCredentialProviderCommand({ name: 'openai' }))
  await controlPlane.send(new DeleteWorkloadIdentityCommand({ name: 'my-agent' }))
  console.log('Done!')
}

main().catch(console.error)
