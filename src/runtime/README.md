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
const app = new BedrockAgentCoreApp({ handler })
app.run()
```

The server will start on port 8080 and expose two endpoints:

- `GET /ping` - Health check endpoint
- `POST /invocations` - Handler invocation endpoint

## Handler Function

Your handler receives two parameters:

### Request

The JSON payload from AgentCore Runtime (typed as `unknown` for maximum flexibility).

### Context

An object containing:

- `sessionId` (string): Unique identifier for the session
- `headers` (Record<string, string>): HTTP headers from the incoming request

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

const app = new BedrockAgentCoreApp({ handler: streamingHandler })
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
  handler,
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
  "time_of_last_update": "2024-12-16T21:00:00.000Z"
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

// Handler with full typing
const handler: Handler = async (
  request: unknown, // Accept any JSON payload
  context: RequestContext
): Promise<unknown> => {
  // Your logic here
  return { result: 'success' }
}

const websocketHandler: WebSocketHandler = async (socket, context) => {
  socket.send(JSON.stringify({ connected: true, sessionId: context.sessionId }))
}

const config: BedrockAgentCoreAppConfig = {
  logging: { enabled: true, level: 'info' },
}

const app = new BedrockAgentCoreApp({ handler, websocketHandler, config })
app.run()
```

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
  handler: async (request, context) => {
    return { message: 'HTTP response', sessionId: context.sessionId }
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
  handler: async (request, context) => {
    return {
      echo: request,
      sessionId: context.sessionId,
      timestamp: new Date().toISOString(),
    }
  },
})

app.run()
```

### Data Processing Handler

```typescript
import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime'

const app = new BedrockAgentCoreApp({
  handler: async (request: any, context) => {
    // Type guard for expected structure
    if (!request || typeof request !== 'object' || !('data' in request)) {
      throw new Error('Invalid request format')
    }

    // Process the data
    const processed = processData(request.data)

    return {
      result: processed,
      sessionId: context.sessionId,
    }
  },
})

app.run()
```

### Streaming Analytics Handler

```typescript
import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime'

const app = new BedrockAgentCoreApp({
  handler: async function* (request: any, context) {
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
})

app.run()
```

## License

Apache-2.0
