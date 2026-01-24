# AgentCore Identity SDK

TypeScript SDK for Amazon Bedrock AgentCore Identity - identity and credential management for AI agents.

## Features

- **OAuth2 Authentication**: Automatic token fetching for external services (M2M and USER_FEDERATION flows)
- **API Key Authentication**: Automatic API key retrieval from secure token vault

## Installation

```bash
npm install bedrock-agentcore
```

## Usage with RuntimeApp

The Identity SDK is designed to work with BedrockAgentCoreApp. The runtime automatically extracts the workload token from request headers and provides it in the context parameter.

### OAuth2 Example

```typescript
import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime'
import { withAccessToken } from 'bedrock-agentcore/identity'

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    process: async (request, context) => {
      const githubTool = withAccessToken({
        workloadIdentityToken: context.workloadAccessToken!,
        providerName: 'github',
        scopes: ['repo'],
        authFlow: 'M2M',
      })(async (query: string, token: string) => {
        // Token is automatically fetched and injected
        return fetch(`https://api.github.com/search/repositories?q=${query}`, {
          headers: { Authorization: `Bearer ${token}` },
        }).then((r) => r.json())
      })

      return await githubTool(request.query)
    },
  },
})

app.run()
```

### API Key Example

```typescript
import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime'
import { withApiKey } from 'bedrock-agentcore/identity'

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    process: async (request, context) => {
      const openaiTool = withApiKey({
        workloadIdentityToken: context.workloadAccessToken!,
        providerName: 'openai',
      })(async (prompt: string, apiKey: string) => {
        // API key is automatically fetched and injected
        return fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: prompt }] }),
        }).then((r) => r.json())
      })

      return await openaiTool(request.prompt)
    },
  },
})

app.run()
```

## Setup

Before using the Identity SDK, you need to create workload identities and credential providers using the AWS SDK:

```bash
npm install @aws-sdk/client-bedrock-agentcore @aws-sdk/client-bedrock-agentcore-control
```

See the [AWS SDK documentation](https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/Welcome.html) for creating workload identities and credential providers.

## API Reference

### Higher-Order Functions

#### withAccessToken(config)

Wraps a function to automatically fetch and inject OAuth2 token.

**Config:**

- `workloadIdentityToken` - Workload access token (from context)
- `providerName` - Name of OAuth2 provider
- `scopes` - OAuth2 scopes to request
- `authFlow` - 'M2M' or 'USER_FEDERATION'
- `onAuthUrl` - Callback for authorization URL (USER_FEDERATION)
- `forceAuthentication` - Force re-authentication
- `callbackUrl` - OAuth2 callback URL
- `customState` - Custom state for validation
- `customParameters` - Custom authorization parameters

#### withApiKey(config)

Wraps a function to automatically fetch and inject API key.

**Config:**

- `workloadIdentityToken` - Workload access token (from context)
- `providerName` - Name of API key provider

## How It Works

### Request Flow

1. **AgentCore Runtime** invokes your agent with WorkloadAccessToken header
2. **BedrockAgentCoreApp** extracts token and adds to context
3. **Your handler** receives context with workloadAccessToken
4. **Identity SDK** uses token to fetch OAuth2 tokens or API keys
5. **Your code** uses credentials to call external services

### Authentication Flows

**Inbound (Agent Receives Request):**

- SigV4: IAM signature → Runtime validates → Provides workload token
- JWT: Bearer token → Runtime validates → Provides workload token

**Outbound (Agent Calls External Service):**

- OAuth2 M2M: Workload token → Client credentials → Access token
- OAuth2 USER_FEDERATION: Workload token → Auth URL → User consent → Access token
- API Key: Workload token → API key retrieval

## Related Documentation

- [AWS AgentCore Identity Documentation](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/identity.html)
- [Control Plane API Reference](https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_Operations.html)
- [Data Plane API Reference](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_Operations.html)
