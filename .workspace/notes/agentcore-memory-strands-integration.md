# AgentCore Memory Strands Integration in TS

**POC:** @hkobew
**Last Updated:** March 23rd

## Glossary

- **AC:** AgentCore
- **TS:** TypeScript
- **LTM:** Long Term Memory

## Background

Today, the AC Python SDK provides an integration with Strands that allows customers to connect their Strands agents to AC Memory. Specifically, the integration provides three key pieces of functionality:

- **Persistence:** allows conversations to be restored from a previous state, including both the state of the agent and the messages.
- **LTM memory extraction:** extracts insights and preferences from agent conversations.
- **LTM memory injection:** injects relevant insights and preferences from previous conversations into the current agent context.

We want to support a similar experience in the TS SDK.

## Current Gaps

The primary gap is that there is currently no support for memory in the AC TS SDK, nor an integration with Strands. However, there are also some gaps in the original Python implementation that are important to consider before we build a new version for TS:

- **Tightly Coupled:** the handling of persistence, memory extraction, and memory injection are all implemented together in a way that makes it difficult for customers to pull out the features they want from the integration. This has led to some customers who only want a subset of the features, dropping the integration altogether to build their own (example with Expedia).
- **Excessive API Calls:** the original implementation makes significant service requests on each turn to handle the messages, agent state updates, and retrieving memory records. While there have been significant improvements here, such as batching API calls when possible (see https://github.com/aws/bedrock-agentcore-sdk-python/pull/298), there are still some gaps. For example, the batching is turned off by default and does not allow granular configuration, such as separate batch size per event type, deduplication strategy, or more control over when we flush the batch.
- **Strands TypeScript Transcript Support:** The Python SDK integration builds on Strands' transcript-based session management, where messages are persisted individually as they come in. However, the Strands TS SDK instead uses a snapshot based approach that captures a point-in-time representation of the agent state and context to allow for more reliable recovery. There is a design to bring transcript support to TS, but the implementation work has not been planned yet.

## Proposed Path Forward

The original approach is powerful, but its lacking in flexibility and extensibility. To address these concerns, we can decouple the persistence from the memory extraction and injection. This allows customers to configure which pieces of AC Memory they want to leverage with their Strands agents, and how they want them to be integrated. We want to empower the customer to choose the functionality that makes sense for the agent they are building, rather than being forced to accept our functionality as an "all or nothing" decision. Decoupling also allows the development team to ship new features independently without modifying existing functionality, reducing the risk and scope of each change.

### Memory Injection and Extraction

At a lower level, this will leverage Strands Plugins to register hooks for memory extraction and injection. The plugin will configure and manage the batching of the API calls, the metadata attached to messages, and the setup of the hooks. Specifically, we can use `MessageAddedEvent` and be careful to ensure that the storing of messages in AC memory happens before the retrieval of LTM to avoid storing the extracted insights back into memory events. We can also expose a `metadataProvider` interface to allow the customer to configure the metadata on a message by message basis. Another key characteristic to call out is that we want to batch by default, on both a timeout and buffer size.

Example interface with a plugin:

```typescript
// Injection only (with S3 persistence)
const agent1 = new Agent({
  sessionManager: new SessionManager({
    storage: { snapshot: new S3Storage({ bucket: 'my-sessions' }) },
  }),
  plugins: [
    new AgentCoreMemoryPlugin({
      memoryId: 'mem-1', actorId: 'user-1', sessionId: 'session-1',
      // Namespace paths match those configured on the memory resource's strategies
      injectContext: { '/facts/{actorId}/': { topK: 5, relevance_score: 0.5 } },
    }),
  ],
});

// Extraction with defaults (with local persistence)
const agent2 = new Agent({
  sessionManager: new SessionManager({
    storage: { snapshot: new FileStorage('/tmp/sessions') },
  }),
  plugins: [
    new AgentCoreMemoryPlugin({
      memoryId: 'mem-1', actorId: 'user-1', sessionId: 'session-2',
      storeMessages: {},
    }),
  ],
});

// Extraction with custom batching + injection + custom metadata
const agent3 = new Agent({
  sessionManager: new SessionManager({
    storage: { snapshot: new S3Storage({ bucket: 'my-sessions' }) },
  }),
  plugins: [
    new AgentCoreMemoryPlugin({
      memoryId: 'mem-1', actorId: 'user-1', sessionId: 'session-3',
      storeMessages: { batchSize: 10 },
      injectContext: { '/facts/{actorId}/': { topK: 5 } },
      metadataProvider: (message) => ({
        source: { stringValue: 'support-agent' },
        environment: { stringValue: 'production' },
      }),
    }),
  ],
});
```

### Session Persistence

Additionally, we recommend deprioritizing support for session persistence through AgentCore Memory. Today, we store the agent state as an event in AgentCore memory as a blob, which while supported, is not a natural use-case of AgentCore Memory:

- blob (non-conversational) events are not leveraged in LTM extraction today.
- storing the data as events in AgentCore is up to 50x more expensive on write operations than S3
  - $0.25 per 1000 new events: https://aws.amazon.com/bedrock/agentcore/pricing/
  - $0.005 per 1000 requests: https://aws.amazon.com/s3/pricing/
- not natively supported by Strands TS SDK. We would need to build a custom SnapshotStorage implementation.

This allows customers to leverage the memory extraction and retrieval through AgentCore alongside a purpose built storage solution of their choice for session persistence. Strands already natively supports S3 and the local file system. If, in the future, the memory service leverages blob events as part of the LTM extraction, it may make sense to vend this functionality to customers as part of a custom Snapshot storage implementation.

## Extensions

### Multi-Agent Support

When we talk about multi-agent support, we could be referring to:

- a "parent" agent invoking subagents as part of a single conversation.
- sharing memory across multiple agents in separate conversations.

For subagents within a conversation, lets say a customer wants to leverage extraction and/or injection on their subagents as well as their parent agent. Strands Plugins are not automatically propagated to subagents when invoked as a tool, meaning we will need a new Plugin for the subagent. Its then up to the customer if they want their subagent within the same actorId namespace, or if they'd like to use metadata to distinguish the two.

For example:

```typescript
const basePlugin = new AgentCoreMemoryPlugin({
  memoryId: 'mem-1', actorId: 'user-1', sessionId: 'session-1',
});

// Option A: separate actors (events scoped per agent, separate extraction namespaces)
const parent = new Agent({
  plugins: [basePlugin.withActor('orchestrator')],
});
const subagent = new Agent({
  plugins: [basePlugin.withActor('researcher')],
});

// Option B: same actor, distinguish via metadata (shared event stream, filterable)
const parent = new Agent({
  plugins: [basePlugin.withMetadataProvider(() => ({ agentRole: { stringValue: 'orchestrator' } }))],
});
const subagent = new Agent({
  plugins: [basePlugin.withMetadataProvider(() => ({ agentRole: { stringValue: 'researcher' } }))],
});
```

Sharing memories across agents could work similarly, where its up to the customer how they want to separate the events based on agent.

Leveraging the actor approach allows for isolated LTM extractions that could be selectively injected, leading to an overall higher level of control. However, if fine-grained control over extraction is not important, we can also support a metadata-based approach that is simpler, and provides a unified view of all messages between the user and ones of the agents. Therefore, we want to allow the customer to choose what approach makes sense for them and their project.

### Branching

Today, AC memory supports organizing events into branches, but this concept does not yet exist in Strands. Because we are vending a Plugin, the only requirement for future support is that the branching information is exposed to plugins in some form (ex: additional metadata on the messages, events we can hook into, etc.). To avoid backwards-incompatible changes, we can hardcode to the main branch for the integration until Strands has a clear proposed plan for this support.

## Alternatives Considered

### Bundle Features Behind Transcript Support in a Single Plugin

Wait for Strands TS support for transcript-based session management, then build a single Plugin that handles all functionality behind the scenes, with a smaller and simpler interface.

**Advantages:**
- customers are familiar with this experience from Python.
- simpler customer interface.

**Drawbacks:**
- See Current Gaps section.
- Delayed until transcript support is launched in strands.
- Restoration may be inconsistent based on ConversationManager.

### Expose Lower Level Hooks Directly

Expose hooks like `storeMessagesAsMemories` and `injectContext` that customers can wire into their own plugins, or wire up directly on their agents.

**Advantages:**
- maximum flexibility, could extend to other integrations beyond strands.

**Drawbacks:**
- requires customer to wire them up themselves manually, which could lead to issues if used incorrectly. Ex. injecting context before storing messages could cause a feedback loop.
- no central place to manage batching, or to configure it.

## Open Questions

- What batch size makes sense as the default?

## Closed Questions

### How do we allow customers with existing data in AC memory events to build an agent that leverages those events as its conversation history?

Note that this design does support leveraging the LTM generated from those events as part of its context injection. However, it does not support loading an agent session from AC Memory. Because Strands uses a Snapshot based session management system, and AgentCore Memory is storing messages individually in a transcript style, there is an inherent incompatibility between the two components that makes it difficult to load an agent session from a different format. In order to support this feature, we would need to create artificial snapshots from the message history, and inject that into the strands agent. This is not a supported feature in Strands today, and may result in some less-than-ideal behavior. If there is strong evidence that customers are looking for this functionality, we can investigate further.

## Testing Requirements

- Must have a separate bug bash with the memory team and CLI/SDK.
- It should have batching options to allow customers control how many `create_events` API calls occur per turn.
- Should be low latency (look into doing async API calls to `create_events`).
- Performance tests with an agent running a huge conversation (1000-3000 messages).

## Appendix

### Strands Agents SDK

- Documentation home: https://strandsagents.com/docs/user-guide/quickstart/overview/
- TypeScript API reference: https://strandsagents.com/docs/api/typescript/
- Hooks: https://strandsagents.com/docs/user-guide/concepts/agents/hooks/
- Plugins: https://strandsagents.com/docs/user-guide/concepts/plugins/
- Session Management: https://strandsagents.com/docs/user-guide/concepts/agents/session-management/
- Conversation Management: https://strandsagents.com/docs/user-guide/concepts/agents/conversation-management/
- SnapshotStorage API: https://strandsagents.com/docs/api/typescript/SnapshotStorage/
- SessionManager API: https://strandsagents.com/docs/api/typescript/SessionManager/
- SessionManagerConfig API: https://strandsagents.com/docs/api/typescript/SessionManagerConfig/
- Plugin API: https://strandsagents.com/docs/api/typescript/Plugin/
- AgentConfig API: https://strandsagents.com/docs/api/typescript/AgentConfig/
- Snapshot API: https://strandsagents.com/docs/api/typescript/Snapshot/
- TypeScript SDK repo: https://github.com/strands-agents/sdk-typescript
- Python SDK repo: https://github.com/strands-agents/sdk-python

### AgentCore

- AgentCore Memory pricing: https://aws.amazon.com/bedrock/agentcore/pricing/
- AgentCore Memory dev guide: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-sdk-memory.html
- ListEvents API: https://docs.aws.amazon.com/Bedrock-AgentCore/latest/APIReference/API_ListEvents.html
- Short-term memory operations: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/short-term-memory-operations.html
- AgentCore Python SDK repo: https://github.com/aws/bedrock-agentcore-sdk-python
- AgentCore TypeScript SDK repo: https://github.com/aws/bedrock-agentcore-sdk-typescript
- MemoryClient PR: https://github.com/aws/bedrock-agentcore-sdk-typescript/pull/108
- Extraction: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/long-term-saving-and-retrieving-insights.html

### Misc

- S3 pricing: https://aws.amazon.com/s3/pricing/
