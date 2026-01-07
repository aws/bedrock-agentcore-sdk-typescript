# AgentCore Identity SDK

TypeScript SDK for Amazon Bedrock AgentCore Identity - identity and credential management for AI agents.

## Features

- **OAuth2 Authentication**: Fetch OAuth2 tokens for external services (M2M and USER_FEDERATION flows)
- **API Key Authentication**: Retrieve API keys from secure token vault
- **Workload Identity Management**: Create, read, and delete agent identities
- **Credential Provider Management**: Manage OAuth2 and API key providers
- **Runtime Integration**: Works with BedrockAgentCoreApp for automatic token handling

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

const app = new BedrockAgentCoreApp({ handler: async (request, context) => {
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
})

app.run()
```

### API Key Example

```typescript
import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime'
import { withApiKey } from 'bedrock-agentcore/identity'

const app = new BedrockAgentCoreApp({ handler: async (request, context) => {
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
})

app.run()
```

## Direct Client Usage

For advanced use cases, you can use IdentityClient directly:

```typescript
import { IdentityClient } from 'bedrock-agentcore/identity'

const identity = new IdentityClient('us-west-2')

// Get OAuth2 token
const token = await identity.getOAuth2Token({
  workloadIdentityToken: 'your-workload-token',
  providerName: 'github',
  scopes: ['repo'],
  authFlow: 'M2M',
})

// Get API key
const apiKey = await identity.getApiKey({
  workloadIdentityToken: 'your-workload-token',
  providerName: 'openai',
})
```

## Setup

Before using the Identity SDK, you need to:

1. **Create a workload identity**
2. **Create credential providers** (OAuth2 or API key)
3. **Configure IAM permissions** for token vault access

### Create Workload Identity

```typescript
const identity = new IdentityClient('us-west-2')

const workloadIdentity = await identity.createWorkloadIdentity('my-agent', ['https://myapp.com/oauth/callback'])
```

### Create OAuth2 Provider

```typescript
const provider = await identity.createOAuth2CredentialProvider({
  name: 'github',
  clientId: 'your-client-id',
  clientSecret: 'your-client-secret',
  discoveryUrl: 'https://github.com/.well-known/openid-configuration',
})
```

### Create API Key Provider

```typescript
const provider = await identity.createApiKeyCredentialProvider({
  name: 'openai',
  apiKey: 'sk-your-api-key',
})
```

## API Reference

### IdentityClient

#### Runtime Operations

- `getOAuth2Token(request)` - Fetch OAuth2 access token
- `getApiKey(request)` - Fetch API key
- `getWorkloadAccessToken(workloadName)` - Get workload token (base)
- `getWorkloadAccessTokenForJWT(workloadName, userToken)` - Exchange JWT for workload token
- `getWorkloadAccessTokenForUserId(workloadName, userId)` - Get token for user ID

#### Workload Identity CRUD

- `createWorkloadIdentity(name, callbackUrls?)` - Create identity
- `getWorkloadIdentity(name)` - Get identity details
- `deleteWorkloadIdentity(name)` - Delete identity

#### OAuth2 Provider CRUD

- `createOAuth2CredentialProvider(config)` - Create OAuth2 provider
- `getOAuth2CredentialProvider(name)` - Get provider details
- `deleteOAuth2CredentialProvider(name)` - Delete provider

#### API Key Provider CRUD

- `createApiKeyCredentialProvider(config)` - Create API key provider
- `getApiKeyCredentialProvider(name)` - Get provider details
- `deleteApiKeyCredentialProvider(name)` - Delete provider

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
