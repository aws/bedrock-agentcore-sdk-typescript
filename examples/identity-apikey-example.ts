/**
 * Example: API Key Authentication with RuntimeApp
 *
 * Shows how to use Identity SDK to fetch API keys for external services.
 * The RuntimeApp provides workloadAccessToken in the context parameter.
 */

import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime'
import { withApiKey } from 'bedrock-agentcore/identity'

const app = new BedrockAgentCoreApp({
  handler: async (request: any, context) => {
    if (!context.workloadAccessToken) {
      return { error: 'No workload token available' }
    }

    // Create OpenAI tool with API key authentication
    const askOpenAI = withApiKey({
      workloadIdentityToken: context.workloadAccessToken,
      providerName: 'openai-provider',
    })(async (prompt: string, apiKey: string) => {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4',
          messages: [{ role: 'user', content: prompt }],
        }),
      })
      return response.json()
    })

    return await askOpenAI(request.prompt)
  },
})

app.run()
