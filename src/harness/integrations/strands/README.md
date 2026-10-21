# AgentCore Harness for Strands (`bedrock-agentcore/experimental/harness/strands`)

`AgentCoreHarnessAgent` adapts a deployed
[AgentCore Harness](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness.html) to the
Strands `InvokableAgent` interface, so it can be invoked directly or composed into a `Graph`.

This integration is experimental and may change before promotion to a stable import path. It requires
`@strands-agents/sdk` 1.5.0 or later.

## Installation

```bash
npm install bedrock-agentcore @strands-agents/sdk
```

## Usage

```typescript
import { randomUUID } from 'node:crypto'
import { AgentCoreHarnessAgent } from 'bedrock-agentcore/experimental/harness/strands'

const agent = new AgentCoreHarnessAgent({
  harnessArn: process.env.AGENTCORE_HARNESS_ARN!,
  runtimeSessionId: randomUUID(),
})

const result = await agent.invoke('Tell me about your local environment.')
console.log(result.toString())
```

Each `invoke()` or `stream()` call sends one text message through `InvokeHarness`. Reuse the same
`runtimeSessionId` to continue the Harness-owned conversation.

## Streaming

`stream()` yields an `AgentCoreHarnessStreamUpdateEvent` for every non-error `InvokeHarness` event,
followed by one `AgentCoreHarnessResultEvent`.

```typescript
for await (const event of agent.stream('Summarize the worktree.')) {
  if (event.type === 'agentCoreHarnessStreamUpdateEvent' && 'contentBlockDelta' in event.event) {
    process.stdout.write(event.event.contentBlockDelta?.delta?.text ?? '')
  }
}
```

## Composition

```typescript
import { Graph } from '@strands-agents/sdk/multiagent'

const graph = new Graph({
  nodes: [localResearcher, harnessAgent],
  edges: [[localResearcher.id, harnessAgent.id]],
})

await graph.invoke('Research and summarize.')
```

## Ownership Boundary

The deployed Harness owns its model, system prompt, tools, skills, memory, limits, and server-side
agent loop. This adapter does not register or execute client-side tools, continue inline functions,
answer interrupts, or override Harness configuration per request.

The following inputs are rejected before a request is made:

| Input or option          | Reason                                                                 |
| ------------------------ | ---------------------------------------------------------------------- |
| Non-text content blocks  | `InvokeHarness` receives text only through this adapter                |
| Interrupt responses      | The Harness owns its loop; there is no client-side interrupt to answer |
| `structuredOutputSchema` | Structured output is not part of the Harness invocation contract       |
| `limits`                 | Execution limits belong to the deployed Harness                        |

A string is sent verbatim, text blocks are joined with newlines, and message history contributes only
its latest user message. Earlier turns already live in the Harness session and are not replayed.

The default data-plane client uses standard AWS configuration resolution with `maxAttempts: 1`.
Provide a pre-built `BedrockAgentCoreClient` through `client` to customize its configuration, but it
must also resolve `maxAttempts` to `1`. Retrying a stateful Harness turn could duplicate work.

An instance supports one invocation at a time. Concurrent calls throw `ConcurrentInvocationError`;
construct one adapter per concurrent conversation.
