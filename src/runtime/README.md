# BedrockAgentCore Runtime

HTTP server infrastructure for hosting agents on AWS Bedrock AgentCore Runtime.

## Overview

The `BedrockAgentCoreApp` class provides an Express-based HTTP server that implements the AWS Bedrock AgentCore Runtime protocol. It handles health checks, agent invocations, and supports both JSON and streaming responses via Server-Sent Events (SSE).

## Installation

```bash
npm install bedrock-agentcore
```

## Basic Usage

```typescript
import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime'

// Define your handler function
const handler = async (request, context) => {
  console.log(`Processing request with session ${context.sessionId}`)
  return {
    message: 'Hello from BedrockAgentCore!',
    timestamp: new Date().toISOString(),
  }
}

// Create and start the server
const app = new BedrockAgentCoreApp({
  invocationHandler: { process: handler },
})
app.run()
```

The server will start on port 8080 and expose two endpoints:

- `GET /ping` - Health check endpoint
- `POST /invocations` - Handler invocation endpoint

## Request Validation with Zod

The runtime supports automatic request validation using Zod schemas. When a schema is provided, the request body is validated before being passed to your handler:

```typescript
import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime'
import { z } from 'zod'

// Define request schema
const requestSchema = z.object({
  message: z.string(),
  userId: z.number().optional(),
  metadata: z.record(z.string()).optional(),
})

const handler = async (request, context) => {
  // request is now typed as { message: string; userId?: number; metadata?: Record<string, string> }
  return {
    echo: request.message,
    sessionId: context.sessionId,
  }
}

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    process: handler,
    requestSchema, // Validates and types the request
  },
})
app.run()
```

### Validation Benefits

- **Type Safety**: Request is automatically typed based on your Zod schema
- **Runtime Validation**: Invalid requests are rejected with 400 status code
- **String Typing**: String schemas keep text-only agent inputs typed as strings

`requestSchema` is optional for compatibility with arbitrary handlers, but no-schema handlers receive the raw request
body and should validate input before forwarding it to an agent framework.

## Handler Function

Your handler receives two parameters:

### Request

The JSON payload from AgentCore Runtime (typed as `unknown` for maximum flexibility).

### Context

An object containing:

- `sessionId` (string): Unique identifier for the session
- `headers` (Record<string, string>): Forwardable HTTP headers (Authorization and Custom-\* headers on this path; the A2A path forwards everything the runtime header allowlist permits)
- `workloadAccessToken` (string | undefined): Workload access token for Identity SDK
- `requestId` (string | undefined): Request ID for tracing and logging (auto-generated if not provided)
- `oauth2CallbackUrl` (string | undefined): OAuth2 callback URL for authentication flows

## Streaming Responses

Handlers can return async generators to stream responses using Server-Sent Events:

```typescript
const streamingHandler = async function* (request, context) {
  // Yield multiple chunks
  yield { event: 'start', sessionId: context.sessionId }

  // Simulate processing
  for (let i = 0; i < 5; i++) {
    yield {
      event: 'progress',
      step: i + 1,
      data: `Processing step ${i + 1}`,
    }
  }

  yield { event: 'complete', result: 'done' }
}

const app = new BedrockAgentCoreApp({
  invocationHandler: { process: streamingHandler },
})
app.run()
```

The server automatically:

- Sets appropriate SSE headers (`Content-Type: text/event-stream`)
- Streams data chunks as `data:` events
- Sends `event: done` when complete
- Sends `event: error` if the stream throws an error
- Stops streaming if the client disconnects

## Configuration

Optional configuration can be passed in the config parameter:

```typescript
const app = new BedrockAgentCoreApp({
  invocationHandler: { process: handler },
  config: {
    logging: {
      enabled: true,
      level: 'debug', // 'debug' | 'info' | 'warn' | 'error'
    },
  },
})
```

### Configuration Options

- `logging`: Logging configuration (Note: logging is not yet implemented, but the configuration is reserved for future use)

## Protocol Details

### Health Check Endpoint

`GET /ping`

Returns:

```json
{
  "status": "Healthy",
  "time_of_last_update": 1734382800
}
```

### Invocation Endpoint

`POST /invocations`

Headers:

- `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id`: Session identifier (required)

Request body:

- Any JSON payload (passed to your handler)

Response:

- JSON response from your handler, OR
- Server-Sent Events stream if handler returns async generator

## Error Handling

The server handles errors gracefully:

- **400 Bad Request**: Missing `sessionId`
- **500 Internal Server Error**: Handler throws an error

For streaming responses, errors are sent as SSE error events:

```
event: error
data: {"error":"Error message"}
```

## TypeScript Support

The package includes full TypeScript definitions:

```typescript
import {
  BedrockAgentCoreApp,
  Handler,
  WebSocketHandler,
  RequestContext,
  BedrockAgentCoreAppConfig,
} from 'bedrock-agentcore/runtime'
import { z } from 'zod'

// Handler with full typing
const requestSchema = z.object({
  message: z.string(),
  userId: z.number(),
})

const handler: Handler<z.infer<typeof requestSchema>> = async (
  request, // Typed as { message: string; userId: number }
  context: RequestContext
): Promise<unknown> => {
  // Your logic here
  return { result: 'success', message: request.message }
}

const websocketHandler: WebSocketHandler = async (socket, context) => {
  socket.send(JSON.stringify({ connected: true, sessionId: context.sessionId }))
}

const config: BedrockAgentCoreAppConfig = {
  logging: { enabled: true, level: 'info' },
}

const app = new BedrockAgentCoreApp({
  invocationHandler: { process: handler, requestSchema },
  websocketHandler,
  config,
})
app.run()
```

## Dynamic Health Check

The `/ping` endpoint returns dynamic health status based on your application's workload:

### Health Status Types

- `Healthy` - No active operations, ready for new work
- `HealthyBusy` - Currently processing operations

### Automatic Task Tracking

Track async operations automatically with the `asyncTask` decorator:

```typescript
const app = new BedrockAgentCoreApp({
  invocationHandler: { process: handler },
})

// Wrap your async function
const processData = app.asyncTask(async (data: string) => {
  // Status automatically becomes HealthyBusy during execution
  await heavyProcessing(data)
  // Status reverts to Healthy when complete
  return result
})

await processData('input')
```

### Manual Task Tracking

For more control, manually register and complete tasks:

```typescript
const app = new BedrockAgentCoreApp({
  invocationHandler: { process: handler },
})

// Register a task
const taskId = app.addAsyncTask('background-job', { priority: 'high' })

// Do work...
await doBackgroundWork()

// Mark as complete
app.completeAsyncTask(taskId)
```

### Custom Health Logic

Implement custom health check logic based on your application's needs:

```typescript
const app = new BedrockAgentCoreApp({
  invocationHandler: { process: handler },
  pingHandler: () => {
    // Check database connection, external dependencies, etc.
    return databaseConnected ? 'Healthy' : 'HealthyBusy'
  },
})

app.run()
```

### Task Introspection

Query active tasks for monitoring and debugging:

```typescript
const status = app.getAsyncTaskInfo()
console.log(`Active tasks: ${status.activeCount}`)

status.runningJobs.forEach((job) => {
  console.log(`  ${job.name}: ${job.duration.toFixed(2)}s`)
})
```

## A2A Protocol Support

Agents that talk to other agents can serve the [A2A protocol](https://a2a-protocol.org/) instead of the HTTP protocol. `serveA2A` implements the AgentCore Runtime A2A container contract — JSON-RPC 2.0 at `POST /`, the agent card at `GET /.well-known/agent-card.json`, and the `GET /ping` health check — around any `@a2a-js/sdk` `AgentExecutor`:

```typescript
import { serveA2A, buildAgentCard } from 'bedrock-agentcore/runtime/a2a'

await serveA2A({
  executor: myExecutor, // an @a2a-js/sdk AgentExecutor
  agentCard: buildAgentCard({
    name: 'research-agent',
    description: 'Deep research specialist',
    skills: [{ id: 'main', name: 'research', description: 'Research a topic' }],
  }),
})
```

A2A support requires the optional peer dependencies:

```bash
npm install bedrock-agentcore @a2a-js/sdk express
```

Defaults mirror the Python SDK's `serve_a2a`: port comes from the `PORT` env var or 9000 (the AgentCore A2A protocol port), the host binds `0.0.0.0` inside containers (detected via `/.dockerenv` or `DOCKER_CONTAINER`) and loopback otherwise, and the agent card is auto-built when omitted. When `AGENTCORE_RUNTIME_URL` is set (deployed on AgentCore), the card's JSONRPC interface URLs are rewritten to the runtime URL so a deployed agent never advertises a stale local address.

### Deploying to AgentCore Runtime

AgentCore Runtime does not create `/.dockerenv` inside the container, so set the container marker explicitly in your Dockerfile — otherwise the server binds loopback, the platform's health checks never reach it, and the runtime fails with opaque startup timeouts:

```dockerfile
ENV DOCKER_CONTAINER=1
```

(The same applies to Podman-built local containers.) Alternatively, pass `host: '0.0.0.0'` to `serveA2A` in code. Deploy the container with `--protocol-configuration '{"serverProtocol": "A2A"}'`; the platform proxies `InvokeAgentRuntime` payloads to `POST /` unmodified and injects the session/request headers described below. Callers reaching the agent card through the runtime endpoint need `bedrock-agentcore:GetAgentCard` in addition to `bedrock-agentcore:InvokeAgentRuntime` in their IAM policy.

### Request context inside A2A executors

AgentCore Runtime injects per-request headers into every proxied A2A call. `serveA2A` extracts them into the same request context used by the HTTP protocol path, so `getContext()` — and everything built on it, including the identity wrappers `withApiKey` and `withAccessToken` — works unchanged inside executors:

```typescript
import { getContext } from 'bedrock-agentcore/runtime/a2a'

class MyExecutor {
  async execute(requestContext, eventBus) {
    const ctx = getContext()
    console.log('Session:', ctx?.sessionId, 'Request:', ctx?.requestId)
    // ctx.workloadAccessToken feeds the identity wrappers automatically
  }
}
```

Forwarded caller headers follow the AgentCore runtime header allowlist (`isForwardableHeader`): `Authorization` and `x-amzn-bedrock-agentcore-runtime-custom-*` pass through, restricted headers and reserved `x-amz-*`/`x-amzn-*` prefixes do not, and trace propagation headers (`traceparent`, `baggage`) are allowed.

The same fields are also mirrored into `ServerCallContext.state` (keys: `headers`, `requestId`, `sessionId`, `workloadAccessToken`, `oauth2CallbackUrl`) for executors that prefer reading `requestContext.context.state`.

### Embedding and customization

- `buildA2AApp(options)` returns the Express app without binding a port, for embedding or socket-less testing.
- `pingHandler` customizes the health status (`'Healthy' | 'HealthyBusy'`); a throwing handler degrades to `Healthy`.
- `taskStore` injects task persistence (defaults to `InMemoryTaskStore`); `contextBuilder` overrides the `ServerCallContext` factory.
- `buildRuntimeUrl(runtimeArn)` constructs the SigV4-signed `InvokeAgentRuntime` URL an A2A client needs to call a deployed agent.

## Client Disconnect Handling

The server automatically detects when clients disconnect and stops processing:

```typescript
const longRunningHandler = async function* (request, context) {
  for (let i = 0; i < 1000; i++) {
    // If client disconnects, iteration stops automatically
    yield { progress: i }
  }
}
```

This prevents wasted resources on disconnected clients.

## WebSocket Support

The server supports WebSocket connections for real-time bidirectional communication:

```typescript
import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime'

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    process: async (request, context) => {
      return { message: 'HTTP response', sessionId: context.sessionId }
    },
  },
  websocketHandler: async (socket, context) => {
    // Send welcome message
    socket.send(
      JSON.stringify({
        type: 'connected',
        sessionId: context.sessionId,
      })
    )

    // Handle incoming messages
    socket.on('message', (message) => {
      const data = JSON.parse(message)
      socket.send(
        JSON.stringify({
          type: 'echo',
          received: data,
          sessionId: context.sessionId,
        })
      )
    })
  },
})

app.run()
```

### WebSocket Endpoint

`GET /ws`

The WebSocket endpoint is only available when a `websocketHandler` is provided. The handler receives:

- `socket`: Fastify WebSocket connection object
- `context`: Same RequestContext as HTTP handlers (sessionId, headers, etc.)

### Session Context

WebSocket connections receive the same session context as HTTP requests:

- Session ID from `x-amzn-bedrock-agentcore-runtime-session-id` header
- Access to request headers
- Workload access token (if present)

### Error Handling

WebSocket errors are automatically handled:

- Connection errors close the socket with code 1011
- Handler errors are logged and the connection is terminated
- Client disconnections are handled gracefully

## AWS Bedrock AgentCore Runtime Integration

When deploying to AWS Bedrock AgentCore Runtime:

1. Your application must listen on port 8080
2. The runtime calls `GET /ping` to check health
3. The runtime calls `POST /invocations` to invoke your agent
4. Session IDs are provided via the `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` header

This package handles all these requirements automatically.

## Examples

### Simple Echo Handler

```typescript
import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime'

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    process: async (request, context) => {
      return {
        echo: request,
        sessionId: context.sessionId,
        timestamp: new Date().toISOString(),
      }
    },
  },
})

app.run()
```

### Data Processing Handler

```typescript
import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime'
import { z } from 'zod'

const requestSchema = z.object({
  data: z.array(z.number()),
})

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    requestSchema,
    process: async (request, context) => {
      // request.data is typed as number[]
      const processed = request.data.map((x) => x * 2)

      return {
        result: processed,
        sessionId: context.sessionId,
      }
    },
  },
})

app.run()
```

### Streaming Analytics Handler

```typescript
import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime'

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    process: async function* (request: any, context) {
      yield { status: 'started', sessionId: context.sessionId }

      // Perform analysis in steps
      const steps = ['load', 'analyze', 'summarize', 'complete']

      for (const step of steps) {
        const result = await performStep(step, request)
        yield {
          step,
          result,
          timestamp: new Date().toISOString(),
        }
      }
    },
  },
})

app.run()
```

## License

Apache-2.0
