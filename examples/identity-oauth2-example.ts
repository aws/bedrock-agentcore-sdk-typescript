/**
 * Example: OAuth2 Authentication with RuntimeApp
 *
 * Shows how to use Identity SDK to fetch OAuth2 tokens for external services.
 * The RuntimeApp provides workloadAccessToken in the context parameter.
 */

import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime'
import { withAccessToken } from 'bedrock-agentcore/identity'

const app = new BedrockAgentCoreApp(async (request: any, context) => {
  if (!context.workloadAccessToken) {
    return { error: 'No workload token available' }
  }

  // Create GitHub tool with OAuth2 authentication
  const searchGithub = withAccessToken({
    workloadIdentityToken: context.workloadAccessToken,
    providerName: 'github-provider',
    scopes: ['repo'],
    authFlow: 'M2M',
  })(async (query: string, token: string) => {
    const response = await fetch(`https://api.github.com/search/repositories?q=${query}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    return response.json()
  })

  return await searchGithub(request.query)
})

app.run()
