# AgentCore Memory (Strands integration)

How to give a Strands agent persistent, cross-session memory backed by [Amazon Bedrock AgentCore
Memory](https://docs.aws.amazon.com/bedrock-agentcore/). This is the conceptual + deployment guide;
the per-call API reference lives alongside the code in
[`src/memory/integrations/strands/README.md`](../src/memory/integrations/strands/index.ts).

> **Status: experimental.** This integration implements the Strands `MemoryManager` / `MemoryStore`
> extraction interface, consumed directly from `@strands-agents/sdk` (>= 1.5.0). The upstream surface
> is still evolving, so the module is **experimental**, not yet GA. See [Release status](#release-status).

## What you get

A single store, `AgentCoreMemoryStore`, that plugs into Strands' `MemoryManager`:

- **Recall** — the agent's `search_memory` tool (and optional passive injection) reads long-term
  memory via `retrieveMemoryRecords`.
- **Write** — a turn's conversation messages are packed into a single role-tagged `createEvent` (one
  API call per flush carrying many turns, not one call per message). AgentCore extracts and
  consolidates them into long-term records **server-side** — no client-side LLM pass.
- **Cost control** — three independent levers (batching, cadence, flush) govern `createEvent` volume.
  See [Reducing write API calls](#reducing-write-api-calls).

## The two-tier model (why writes aren't instantly searchable)

AgentCore Memory is event-sourced with two tiers:

1. **Short-term events** — `createEvent` records each role-tagged turn for an `(actorId, sessionId)`.
2. **Long-term records** — configured _strategies_ (semantic, summary, user-preference, episodic)
   asynchronously extract and **consolidate** events into namespaced records, retrieved via
   `retrieveMemoryRecords`.

Two consequences the integration leans on:

- **Eventual consistency.** A fact written this turn may not be retrievable on the next turn until
  server-side extraction runs. `MemoryManager.flush()` drains in-flight `createEvent` calls (it does
  not wait for extraction).
- **Consolidation is the dedup backstop.** Because consolidation merges facts at the record level, a
  duplicate _event_ (e.g. from a retry) does not become a duplicate long-term memory.

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

See [`src/memory/integrations/strands/README.md`](../src/memory/integrations/strands/index.ts) for `readMode` (`per-namespace`
vs `subtree`), `minScore`, the `extraction` switch, recall-only setup, and the full factory surface.

## Deploying with the AgentCore CLI / CDK

Memory is a **resource** you create once (strategies, namespaces, expiry) and then _consume_ from the
agent. The integration never creates the resource — it takes an existing `memoryId`.

### The memory ID reaches the agent as an environment variable

When a memory and a runtime are deployed together, the CDK construct grants the runtime access and
injects the memory ID as `MEMORY_<NAME>_ID` (uppercased). For a memory named `MyMemory`:

```typescript
const memoryId = process.env.MEMORY_MYMEMORY_ID
```

No manual wiring is needed — declare the memory in `agentcore.json` and read the env var.

### Namespaces must match between provisioning and recall

The single most common cause of "the agent doesn't remember" is a namespace mismatch. AgentCore stores
each extracted record under the strategy's `namespaceTemplate` with placeholders **resolved at
extraction time**; on retrieval it matches your query namespace as a **prefix** against those stored
paths and does not resolve placeholders. So:

- **Query with the same template you provisioned.** The CLI provisions `{actorId}`/`{sessionId}`-only
  templates (e.g. SEMANTIC `/users/{actorId}/facts`, SUMMARIZATION `/summaries/{actorId}/{sessionId}`).
  Pass the _same_ string to `createAgentCoreMemoryStores`. The store resolves `{actorId}`/`{sessionId}`
  for you.
- **Don't mix conventions.** A `/strategies/{memoryStrategyId}/...` template (used by some other SDK
  defaults) is a different, incompatible convention. This store only resolves `{actorId}`/`{sessionId}`
  and **throws at construction** if any other placeholder (like `{memoryStrategyId}`) survives, since the
  AgentCore retrieve path rejects `{`/`}` — a loud error instead of silent empty recall.
- **`{sessionId}` namespaces are per-session.** Summaries/episodes scoped by `{sessionId}` are only
  recalled by a store using that same `sessionId`. For cross-session recall, use an `{actorId}`-only
  namespace.

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
     const actorId = context.headers['x-amzn-bedrock-agentcore-runtime-custom-actor-id'] ?? sessionId
     ```
   - Callers send it with `agentcore invoke ... -H "X-Amzn-Bedrock-AgentCore-Runtime-Custom-Actor-Id: user-123"`.

### Session ID length

`InvokeAgentRuntime` requires `runtimeSessionId` to be **at least 33 characters**. Generate session
IDs accordingly (a UUID-based value is comfortably long enough).

## Reducing write API calls

Each `createEvent` is a write API call. Three independent levers control how many you make — they
compose, so it helps to understand them separately:

**1. Batching (automatic).** Every flush packs its turns into a *single* `createEvent` (chunked only at
`maxTurnsPerEvent`, default 50) rather than one call per message. A 6-message turn is 1 call, not 6.
No configuration needed; it applies under any trigger. This is the main cost reduction.

**2. Cadence (the extraction trigger).** Controls *when* a flush happens. `extraction: true` uses
Strands' default (`IntervalTrigger`, ~every 5 turns); for AgentCore prefer
`extraction: { cadence: new AgentCoreBatchTrigger({ messageCount, maxBytes, maxDelayMs }) }`. Flushing
less often batches more turns per `createEvent`. **But cadence only cuts calls if writes buffer across
turns** — which requires reusing the `MemoryManager` across the session and not flushing every turn.

**3. `flush()` (durability, not cost).** `MemoryManager.flush()` force-drains the buffer now, ignoring
the trigger. It matters because a trigger only *dispatches* a write (fire-and-forget; the framework
never awaits it), and the runtime can reclaim the session microVM on idle before a dispatched write
lands — and any turn may be the last (there's no session-end signal). `flush()` awaits the writes while
the microVM is alive (e.g. the end of an invocation handler), so it's the durability guarantee.

**Reuse the `MemoryManager` across the session.** The runtime keeps one microVM alive per session
(idle ~15 min, max 8 h, [lifecycle docs](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-lifecycle-settings.html)),
so build the manager once per `(actorId, sessionId)` and reuse it across that session's invocations —
that keeps the buffer and trigger timer alive so cadence can batch across turns. The **application**
owns this reuse (e.g. a `Map` keyed by `actorId:sessionId`); the SDK holds no session cache, keeping
eviction and lifecycle in your control.

**Two working setups:**

- **Durable default (recommended):** reuse the manager per session, `AgentCoreBatchTrigger` cadence,
  and `await memory.flush()` at the end of every handler. One batched call per turn; no data loss.
- **Cost-tuned (advanced):** reuse the manager per session, a coarse `AgentCoreBatchTrigger`, and flush
  only on a session-end signal you define. Fewer calls; small risk of losing the tail on idle reclaim.

See the deploy example for the full per-session-reuse + flush pattern.

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

- **Unit tests** (`src/memory/integrations/strands/__tests__/`, run with `npm test`) mock the AWS clients and cover
  the factory topology, store search/write mapping, sender idempotency, the batch trigger, and the
  message formatter.
- **Integration + E2E tests** (`tests_integ/memory.test.ts`, run with `npm run test:integ`) exercise the
  store against the live AgentCore data plane. They create a throwaway memory resource (with a semantic
  strategy) in `beforeAll`, drive the store and a real `MemoryManager` + `Agent` through a
  write → server-side extraction → recall round trip, and delete the resource in `afterAll`. Because
  extraction is asynchronous, recall is verified by polling with a generous timeout, so a full run takes
  several minutes. Requires AWS credentials with `bedrock-agentcore-control:{Create,Get,Delete}Memory`,
  `bedrock-agentcore:{CreateEvent,RetrieveMemoryRecords}`, and (for the E2E case) `bedrock:InvokeModel*`.
