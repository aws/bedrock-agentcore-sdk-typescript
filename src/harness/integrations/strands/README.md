# AgentCore Harness for Strands (`bedrock-agentcore/experimental/harness/strands`)

`AgentCoreHarnessAgent` makes a deployed
[AgentCore Harness](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness.html) a
first-class [Strands](https://strandsagents.com) agent. It implements the same `InvokableAgent`
interface as a local `Agent`, so a Harness drops into `Graph` without special-casing at the call site.

This integration is experimental and its API may change before promotion to a stable import path.

This integration consumes the Strands agent and tool interfaces directly from `@strands-agents/sdk` (>= 1.5.0).

## Installation

```bash
npm install bedrock-agentcore @strands-agents/sdk
```

## What it does

- **Invoke** — `invoke()` starts a turn with one text message and returns an `AgentResult`.
- **Inline functions** — local Strands tools are registered dynamically as Harness `inline_function`
  definitions, merged with the deployed tools, executed client-side, and returned to the same Harness
  session.
- **Human-in-the-loop** — tool lifecycle interventions and tool callback interrupts can pause a local
  callback and resume it from an `InterruptResponseContent`.
- **Stream** — `stream()` yields every non-error Harness event as it arrives, then a final result event.
- **Session continuity** — reuse one `runtimeSessionId` and the Harness continues the conversation
  server-side; no client-side message history is replayed.
- **Typed errors** — AgentCore and in-stream failures are translated to the Strands error types
  (`ModelError`, `ModelThrottledError`, `ContextWindowOverflowError`, `MaxTokensError`) that retry
  strategies and conversation managers already key off.
- **Cancellation** — an `AbortSignal` aborts an active Harness request and returns
  `stopReason: 'cancelled'` with content decoded before the abort. A local callback already in
  progress is cooperatively cancelled, then its result is sent to the Harness before the invocation
  returns.

## Usage

```typescript
import { randomUUID } from 'node:crypto'
import { FunctionTool } from '@strands-agents/sdk'
import { AgentCoreHarnessAgent } from 'bedrock-agentcore/experimental/harness/strands'

const getWeather = new FunctionTool({
  name: 'get_weather',
  description: 'Get the current weather',
  inputSchema: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
  callback: async (input) => {
    const { city } = input as { city: string }
    return { city, temperatureF: 72 }
  },
})

const agent = new AgentCoreHarnessAgent({
  harnessArn: process.env.AGENTCORE_HARNESS_ARN!,
  runtimeSessionId: randomUUID(),
  tools: [getWeather],
})

const result = await agent.invoke('What is the weather in Seattle?')
console.log(result.toString())
```

The adapter translates each local tool's name, description, and input schema into a Harness
`inline_function` definition. The deployed Harness does not need to define the tool in advance. When
local tools are supplied, the adapter calls `GetHarness` once per invocation, merges the deployed and
local tool definitions, and sends the combined list to `InvokeHarness`. A local definition replaces a
deployed tool with the same name. Restrictive deployed allow-lists are extended with the local tool
names. The caller therefore needs permission to get and invoke the Harness.

Callback results may be text or JSON; JSON values are encoded as text in the continuation request for
Harness runtime compatibility. Callback failures and missing local tools are returned to the Harness
as error tool results so its agent loop can decide how to recover.

The local Strands tool schema is authoritative for inline-function input. Validate callback input
inside the local tool when the callback crosses a trust boundary. If cancellation occurs while a
callback is running, `context.agent.cancelSignal` is aborted; callbacks should pass that signal to
cancellable operations. A callback that ignores the signal is allowed to finish so the adapter can
send a matching result and leave the Harness session in a valid state. Any additional inline
functions requested while cancellation is being resolved receive cancellation results without
executing their callbacks.

### Human-in-the-loop callbacks

Pass Strands tool lifecycle intervention handlers through `interventions`. Model and invocation
lifecycle interventions are rejected because they can retry or replace the deployed Harness's
reasoning turn. When a handler or callback requests input, the invocation returns an `AgentResult`
with `stopReason: 'interrupt'`. Resume it on the same agent instance with the corresponding response:

```typescript
import {
  BeforeToolCallEvent,
  FunctionTool,
  InterruptResponseContent,
  InterventionActions,
  InterventionHandler,
} from '@strands-agents/sdk'

class ConfirmDeletion extends InterventionHandler {
  readonly name = 'confirm-deletion'

  override beforeToolCall(event: BeforeToolCallEvent) {
    return InterventionActions.confirm(`Approve ${event.toolUse.name}?`)
  }
}

const deleteRecord = new FunctionTool({
  name: 'delete_record',
  description: 'Delete one record',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
  callback: async (input) => {
    const { id } = input as { id: string }
    await records.delete(id)
    return { deleted: id }
  },
})

const deletionAgent = new AgentCoreHarnessAgent({
  harnessArn: process.env.AGENTCORE_HARNESS_ARN!,
  runtimeSessionId: randomUUID(),
  tools: [deleteRecord],
  interventions: [new ConfirmDeletion()],
})

const interrupted = await deletionAgent.invoke('Delete record 123.')
const result = await deletionAgent.invoke([
  new InterruptResponseContent({
    interruptId: interrupted.interrupts![0]!.id,
    response: 'yes',
  }),
])
```

### Streaming

`stream()` yields `AgentCoreHarnessStreamUpdateEvent` wrapping each non-error `InvokeHarness` event,
so you can render deltas as the Harness produces them, and finishes with an
`AgentCoreHarnessResultEvent`. When local callbacks require continuation requests, raw events from
every request are yielded in arrival order.

```typescript
for await (const event of agent.stream('Summarize the worktree.')) {
  if (event.type === 'agentCoreHarnessStreamUpdateEvent' && 'contentBlockDelta' in event.event) {
    process.stdout.write(event.event.contentBlockDelta?.delta?.text ?? '')
  }
}
```

### Composition

Because the adapter satisfies `InvokableAgent`, a Harness is just another node:

```typescript
import { Graph } from '@strands-agents/sdk/multiagent'

const graph = new Graph({
  nodes: [localResearcher, harnessAgent],
  edges: [[localResearcher.id, harnessAgent.id]],
})

await graph.invoke('Research and summarize.')
```

## Ownership boundary

The deployed Harness owns its **model, system prompt, tools, skills, memory, execution limits, and
server-side agent loop**. Remote tool events such as `server_tool_use` and `mcp_tool_use` stay inside
the Harness and are never dispatched to local callbacks.

When `tools` is supplied, the adapter merges dynamic `inline_function` definitions generated from the
Strands tool specifications with the deployed tool configuration. Strands executes those callbacks
locally. After a callback completes, the adapter sends the assistant tool use and user tool result to
`InvokeHarness` under the same `runtimeSessionId`, allowing the deployed agent loop to continue.

Consequently the following are rejected before any request is made:

| Input / option           | Reason                                                             |
| ------------------------ | ------------------------------------------------------------------ |
| Non-text initial content | `InvokeHarness` receives text-only user input through this adapter |
| Checkpoint resume        | The Harness owns turn state under `runtimeSessionId`               |
| `structuredOutputSchema` | Structured output is not part of the Harness invocation contract   |
| `limits`                 | Execution limits belong to the deployed Harness                    |

Text input is normalized to a single message: a string is used verbatim, multiple text blocks are
joined with newlines, and message-history input uses the **latest user message** only. Earlier turns
already live in the Harness session, so replaying them would duplicate them server-side.

The default AgentCore clients use standard AWS configuration resolution. The data-plane client uses
one request attempt because retrying a stateful Harness turn could duplicate work. Pass pre-built
`client` and `controlClient` instances when you need different client configuration.

One instance serves one invocation at a time. A concurrent `invoke()` or `stream()` throws
`ConcurrentInvocationError`; construct one agent per concurrent conversation.
