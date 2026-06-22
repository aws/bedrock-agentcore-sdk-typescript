# AgentCore Memory (Strands integration)

How to give a Strands agent persistent, cross-session memory backed by [Amazon Bedrock AgentCore
Memory](https://docs.aws.amazon.com/bedrock-agentcore/). This is the conceptual + deployment guide;
the per-call API reference lives alongside the code in
[`src/memory/strands/README.md`](../src/memory/strands/index.ts).

> **Status: experimental.** This integration implements the Strands `MemoryManager` / `MemoryStore`
> extraction interface, consumed directly from `@strands-agents/sdk` (>= 1.5.0). The upstream surface
> is still evolving, so the module is **experimental**, not yet GA. See [Release status](#release-status).

## What you get

A single store, `AgentCoreMemoryStore`, that plugs into Strands' `MemoryManager`:

- **Recall** — the agent's `search_memory` tool (and optional passive injection) reads long-term
  memory via `retrieveMemoryRecords`.
- **Write** — conversation turns are written to AgentCore as role-tagged events via `createEvent`.
  AgentCore extracts and consolidates them into long-term records **server-side** — no client-side
  LLM pass.
- **Cadence control** — a custom trigger flushes writes by message count, content size, or time, so
  you control API call volume from one place.

## The two-tier model (why writes aren't instantly searchable)

AgentCore Memory is event-sourced with two tiers:

1. **Short-term events** — `createEvent` records each role-tagged turn for an `(actorId, sessionId)`.
2. **Long-term records** — configured *strategies* (semantic, summary, user-preference, episodic)
   asynchronously extract and **consolidate** events into namespaced records, retrieved via
   `retrieveMemoryRecords`.

Two consequences the integration leans on:

- **Eventual consistency.** A fact written this turn may not be retrievable on the next turn until
  server-side extraction runs. `MemoryManager.flush()` drains in-flight `createEvent` calls (it does
  not wait for extraction).
- **Consolidation is the dedup backstop.** Because consolidation merges facts at the record level, a
  duplicate *event* (e.g. from a retry) does not become a duplicate long-term memory.

## Quick start

```typescript
import { Agent, MemoryManager } from '@strands-agents/sdk'
import { createAgentCoreMemoryStores, AgentCoreBatchTrigger } from 'bedrock-agentcore/experimental/memory/strands'

const stores = createAgentCoreMemoryStores({
  memoryId: process.env.MEMORY_MYMEMORY_ID!, // injected by the deploy (see below)
  actorId, // see "Who is the actor?"
  sessionId, // from the runtime request context
  namespaces: [{ namespace: '/users/{actorId}/facts' }, { namespace: '/users/{actorId}/preferences' }],
  // `extraction` is the single write switch: omit for recall-only; `true` for default cadence;
  // or an object for a custom cadence / which namespace writes.
  extraction: {
    cadence: new AgentCoreBatchTrigger({ messageCount: 4, maxDelayMs: 3000 }),
  },
})

const agent = new Agent({ model, memoryManager: new MemoryManager({ stores }) })
```

For a single namespace, use the singular convenience:

```typescript
import { createAgentCoreMemoryStore } from 'bedrock-agentcore/experimental/memory/strands'

const store = createAgentCoreMemoryStore({
  memoryId: process.env.MEMORY_MYMEMORY_ID!,
  actorId,
  sessionId,
  namespace: '/users/{actorId}/facts',
  extraction: { cadence: new AgentCoreBatchTrigger() },
})
const agent = new Agent({ model, memoryManager: new MemoryManager({ stores: [store] }) })
```

See [`src/memory/strands/README.md`](../src/memory/strands/index.ts) for `readMode` (`per-namespace`
vs `subtree`), `minScore`, the `extraction` switch, recall-only setup, and the full factory surface.

## Deploying with the AgentCore CLI / CDK

Memory is a **resource** you create once (strategies, namespaces, expiry) and then *consume* from the
agent. The integration never creates the resource — it takes an existing `memoryId`.

### The memory ID reaches the agent as an environment variable

When a memory and a runtime are deployed together, the CDK construct grants the runtime access and
injects the memory ID as `MEMORY_<NAME>_ID` (uppercased). For a memory named `MyMemory`:

```typescript
const memoryId = process.env.MEMORY_MYMEMORY_ID
```

No manual wiring is needed — declare the memory in `agentcore.json` and read the env var.

### Who is the actor? (`actorId`)

AgentCore is **session-centric**: the runtime request context exposes `sessionId` but **no actor
identity** — the platform does not send one. `actorId` is therefore application-supplied. Pick one of:

1. **Session as actor** — simplest; one session = one actor (`actorId = sessionId`).
2. **Payload field** — the caller passes `actorId` in the invocation body.
3. **Custom header (recommended for multi-actor)** — the platform-sanctioned per-request channel.
   This requires **two** things:
   - Declare the header in the runtime's allowlist in `agentcore.json`:
     ```json
     {
       "name": "MyAgent",
       "requestHeaderAllowlist": ["X-Amzn-Bedrock-AgentCore-Runtime-Custom-Actor-Id"]
     }
     ```
     Without the allowlist the platform **strips** the header before the agent sees it
     ([header allowlist docs](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-header-allowlist.html)).
   - Read it from the request context in your handler:
     ```typescript
     const actorId =
       context.headers['x-amzn-bedrock-agentcore-runtime-custom-actor-id'] ?? sessionId
     ```
   - Callers send it with `agentcore invoke ... -H "X-Amzn-Bedrock-AgentCore-Runtime-Custom-Actor-Id: user-123"`.

### Session ID length

`InvokeAgentRuntime` requires `runtimeSessionId` to be **at least 33 characters**. Generate session
IDs accordingly (a UUID-based value is comfortably long enough).

## Design notes

- **One write stream per `(actorId, sessionId)`.** `createEvent` is namespace-free, so writes always
  collapse to a single stream regardless of how many namespaces you read from. The factory marks
  exactly one store writable.
- **No `add()` / no `add_memory` tool.** The conversation path is role-aware (`addMessages` →
  role-tagged `createEvent`); a flat-string `add()` would discard role, so it is intentionally not
  implemented, and the `add_memory` tool is off.
- **Write errors propagate to the coordinator.** `addMessages` throws on a failed `createEvent`, so the
  `ExtractionCoordinator` re-fires the batch (with its own backoff). The store keeps no retry/drop layer
  of its own; bound a slow request via a timeout on the AWS `client` you supply.
- **`extraction: true` uses the framework's default cadence.** Passing `true` defers to the
  MemoryManager's own trigger (turn-based), matching the rest of Strands. Pass an `AgentCoreBatchTrigger`
  via `extraction: { cadence }` for AgentCore-tuned message-count / byte / time batching.
- **Read errors propagate.** `search()` lets retrieval errors throw; `MemoryManager` isolates them
  per-store via `Promise.allSettled`, so a failure never breaks the agent loop while still being
  surfaced (rather than silently swallowed).
- **Resource setup is out of scope.** Strategies, indexed keys, record streaming, expiry, and
  encryption are control-plane concerns configured at `CreateMemory` (via the CLI/CDK), not through
  this store.

## Known limitations

1. **Metadata-filtered recall (indexed keys) is app-scoped, not model-chosen.** AgentCore supports
   `metadataFilters` on retrieval (gated on indexed keys declared at resource creation). The supported
   path is **per-instance store defaults**: bake the filter into the store's config so it applies to
   every `retrieveMemoryRecords` call (the same way `minScore` does). The model-facing `search_memory`
   tool intentionally does **not** let the agent choose filter values. A use case needing
   per-turn, model-chosen filters would register its own custom search tool.
## Release status

This module is **experimental**. It consumes the Strands memory `MemoryManager` / `MemoryStore` /
extraction surface directly from `@strands-agents/sdk` (>= 1.5.0). That surface is still evolving
upstream, so the integration should not yet be relied on for GA workloads.

**SDK requirements:**

- `@aws-sdk/client-bedrock-agentcore` >= 3.1020 (for the typed `namespacePath` field used by `subtree` reads).
- `@strands-agents/sdk` >= 1.5.0 (memory / extraction module).

## Testing

- **Unit tests** (`src/memory/strands/__tests__/`, run with `npm test`) mock the AWS clients and cover
  the factory topology, store search/write mapping, sender idempotency, the batch trigger, and the
  message formatter.
- **Integration + E2E tests** (`tests_integ/memory.test.ts`, run with `npm run test:integ`) exercise the
  store against the live AgentCore data plane. They create a throwaway memory resource (with a semantic
  strategy) in `beforeAll`, drive the store and a real `MemoryManager` + `Agent` through a
  write → server-side extraction → recall round trip, and delete the resource in `afterAll`. Because
  extraction is asynchronous, recall is verified by polling with a generous timeout, so a full run takes
  several minutes. Requires AWS credentials with `bedrock-agentcore-control:{Create,Get,Delete}Memory`,
  `bedrock-agentcore:{CreateEvent,RetrieveMemoryRecords}`, and (for the E2E case) `bedrock:InvokeModel*`.
