# AgentCore Memory for Strands (`bedrock-agentcore/memory/strands`)

`AgentCoreMemoryStore` makes [AgentCore Memory](https://docs.aws.amazon.com/bedrock-agentcore/) a
first-class [Strands](https://strandsagents.com) `MemoryStore`: the agent recalls long-term memories
through `search_memory`, and conversation turns are written to AgentCore (role-preserved) for
server-side extraction into long-term records.

> **Status: experimental.** This integration implements the Strands `MemoryManager` / `MemoryStore`
> extraction interface, consumed directly from `@strands-agents/sdk` (>= 1.5.0). The surface is still
> evolving upstream, so treat it as experimental rather than GA.

## What it does

- **Recall** — `search()` maps to `retrieveMemoryRecords`. Per namespace (exact prefix) or across a
  subtree (`namespacePath`).
- **Write** — `addMessages()` maps each role-tagged message to a `createEvent`. No client-side
  extractor and no LLM pass: AgentCore extracts and consolidates server-side.
- **Cadence** — `extraction: true` uses the framework's default trigger; or pass an
  `AgentCoreBatchTrigger` to fire writes by message count, content size, or wall-clock time and control
  API call volume from one place.
- **Topology** — `createAgentCoreMemoryStores(...)` returns the stores ready to spread into
  `MemoryManagerConfig.stores`.

## Usage

```typescript
import { Agent, MemoryManager } from '@strands-agents/sdk'
import { createAgentCoreMemoryStores, AgentCoreBatchTrigger } from 'bedrock-agentcore/memory/strands'

// One call per (actorId, sessionId). `per-namespace` (default) gives one store per namespace.
const stores = createAgentCoreMemoryStores({
  memoryId: 'mem-abc',
  actorId: 'user-123',
  sessionId: 'session-1',
  namespaces: [
    { namespace: '/strategy/{id}/actor/{actorId}/facts' },
    { namespace: '/strategy/{id}/actor/{actorId}/preferences', minScore: 0.5 },
  ],
  // `extraction` is the single write switch. Object form: custom cadence (and optionally which
  // namespace writes). Omit it entirely for recall-only; use `true` for the default cadence.
  extraction: {
    cadence: new AgentCoreBatchTrigger({ messageCount: 10, maxDelayMs: 5000 }),
  },
})

const agent = new Agent({
  model,
  memoryManager: new MemoryManager({ stores }), // search_memory on; add_memory left off
})
```

For a single namespace, `createAgentCoreMemoryStore` (singular) returns one store directly.

### Subtree reads

For "recall everything relevant about this user" in a single retrieval per turn:

```typescript
const stores = createAgentCoreMemoryStores({
  memoryId,
  actorId,
  sessionId,
  namespaces: [
    { namespace: '/strategy/{id}/actor/{actorId}/facts' },
    { namespace: '/strategy/{id}/actor/{actorId}/preferences' },
  ],
  readMode: 'subtree', // 1 store, reads the common parent via namespacePath
  extraction: { cadence: new AgentCoreBatchTrigger() },
})
```

## Design notes

- **One writable store per `(actorId, sessionId)`.** `createEvent` is namespace-free, so writes
  collapse to a single stream regardless of `readMode`. When `extraction` is enabled, exactly one store
  in `per-namespace` mode is writable (the `extraction.namespace`, else the first); the rest are
  search-only. Omit `extraction` for a fully recall-only topology.
- **No `add()`.** AgentCore's conversation path is role-aware; a flat string would discard role, so we
  implement only `addMessages`. The `add_memory` tool is therefore off (the manager handles this when
  no store implements `add`).
- **Write errors propagate to the coordinator.** `addMessages` throws on any `createEvent` failure
  (as an `AggregateError`). The `ExtractionCoordinator` then rolls back its high-water mark and re-fires
  the batch on the next trigger, with its own backoff and repeated-failure logging — so the sender keeps
  no retry/timeout/drop machinery of its own (that would duplicate or fight the coordinator). To bound a
  slow `createEvent`, configure a request timeout on the `client` you pass in (it also bounds reads).
- **Idempotency.** When the manager provides per-message sequence numbers (`AddMessagesContext.sequenceNumbers`,
  available on the no-extractor path this store uses), the sender derives a deterministic `clientToken`
  for exact-once writes — distinct messages keep distinct tokens, so genuinely-identical turns are never
  collapsed, and a coordinator re-fire dedups exactly. Sequence numbers reset to 0 across runs (e.g. on
  session restore) and `sessionId` does not refresh, so the token is anchored on a **run-unique id**
  minted per sender (a UUID by default; override via `runId`) rather than `sessionId`. If sequence
  numbers are absent, the sender sends no token; duplicate _events_ are then collapsed by AgentCore's
  server-side consolidation at the _record_ level, so they are wasteful but not incorrect.
- **Eventual consistency.** Writes and extraction are async; a fact written this turn may not be
  retrievable next turn. `MemoryManager.flush()` drains in-flight `createEvent` calls (not server-side
  extraction).
- **Read errors propagate to the manager.** `search()` lets retrieval errors throw; `MemoryManager`
  wraps each store's `search()` in `Promise.allSettled`, so a failure is isolated to this store and
  surfaced through the manager's partial-failure handling rather than breaking the agent loop.

## Out of scope: memory-resource setup

This store consumes an **existing** memory resource (`memoryId`). Configuring the resource itself —
**strategies**, event expiry, encryption, **indexed keys**, and **record streaming** — is a
control-plane concern (`CreateMemory`), handled outside this integration (e.g. the AgentCore CLI or
CDK). None of these reach the runtime read/write surface (`createEvent` / `retrieveMemoryRecords`):

- **Strategies** define server-side extraction/consolidation; the only runtime touchpoint is the
  optional `searchCriteria.memoryStrategyId` recall filter, which we intentionally leave unset (we
  recall across all strategies).
- **Record streaming** (`streamDeliveryResources`) pushes record changes to external sinks; it is
  entirely server-side and never involves the agent loop.
- **Indexed keys** make metadata keys filterable on retrieval (see Known limitations).

## Known limitations

A deliberate v1 gap with a clear upgrade path; it does not block use.

1. **Metadata-filtered recall (indexed keys) is app-scoped, not model-chosen.** AgentCore supports
   `metadataFilters` on `retrieveMemoryRecords` (gated on indexed keys declared at resource creation).
   The supported path is **per-instance store defaults** — bake the filter into the store's config so
   it applies on every `retrieveMemoryRecords` call (like `minScore`). The model-facing `search_memory`
   tool intentionally does not let the agent choose filter values; a per-turn, model-chosen filter would
   need a custom search tool.

## Requirements

- `@aws-sdk/client-bedrock-agentcore` >= 3.1020 (typed `namespacePath`).
- `@strands-agents/sdk` >= 1.5.0 (the memory `MemoryManager` / `MemoryStore` / extraction surface).
