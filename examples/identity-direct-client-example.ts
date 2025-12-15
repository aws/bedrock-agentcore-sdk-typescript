/**
 * Example: Direct IdentityClient Usage
 *
 * Shows how to use IdentityClient directly without wrappers.
 * Useful for setup, testing, or when you need more control.
 */

import { IdentityClient } from 'bedrock-agentcore/identity'

async function main() {
  const identity = new IdentityClient('us-west-2')

  // 1. Create a workload identity
  console.log('Creating workload identity...')
  const workloadIdentity = await identity.createWorkloadIdentity('my-agent', ['https://myapp.com/oauth/callback'])
  console.log('Created:', workloadIdentity.name)

  // 2. Create OAuth2 credential provider
  console.log('\nCreating OAuth2 provider...')
  const oauth2Provider = await identity.createOAuth2CredentialProvider({
    name: 'github',
    clientId: 'your-github-client-id',
    clientSecret: 'your-github-client-secret',
    discoveryUrl: 'https://github.com/.well-known/openid-configuration',
  })
  console.log('Created provider:', oauth2Provider.name)
  console.log('Callback URL:', oauth2Provider.callbackUrl)

  // 3. Create API key credential provider
  console.log('\nCreating API key provider...')
  const apiKeyProvider = await identity.createApiKeyCredentialProvider({
    name: 'openai',
    apiKey: 'sk-your-openai-api-key',
  })
  console.log('Created provider:', apiKeyProvider.name)

  // 4. Get workload access token (for testing)
  console.log('\nGetting workload access token...')
  const workloadToken = await identity.getWorkloadAccessTokenForUserId('my-agent', 'test-user-123')
  console.log('Token:', workloadToken.substring(0, 30) + '...')

  // 5. Get OAuth2 token
  console.log('\nGetting OAuth2 token...')
  const oauth2Token = await identity.getOAuth2Token({
    workloadIdentityToken: workloadToken,
    providerName: 'github',
    scopes: ['repo'],
    authFlow: 'M2M',
  })
  console.log('OAuth2 token:', oauth2Token.substring(0, 30) + '...')

  // 6. Get API key
  console.log('\nGetting API key...')
  const apiKey = await identity.getApiKey({
    workloadIdentityToken: workloadToken,
    providerName: 'openai',
  })
  console.log('API key:', apiKey.substring(0, 10) + '...')

  // 7. Use credentials to call external APIs
  console.log('\nCredentials ready for use!')

  // Cleanup
  console.log('\nCleaning up...')
  await identity.deleteOAuth2CredentialProvider('github')
  await identity.deleteApiKeyCredentialProvider('openai')
  await identity.deleteWorkloadIdentity('my-agent')
  console.log('Done!')
}

main().catch(console.error)
