# AgentCore Memory (Strands integration)

How to give a Strands agent persistent, cross-session memory backed by [Amazon Bedrock AgentCore
Memory](https://docs.aws.amazon.com/bedrock-agentcore/). This is the conceptual + deployment guide;
the per-call API reference lives alongside the code in
[`src/memory/strands/README.md`](../src/memory/strands/index.ts).

> **Status: experimental / pre-release.** This integration implements the Strands `MemoryManager` /
> `MemoryStore` interface from the upstream extraction work (`strands-agents/harness-sdk` #2671). That
> interface is merged upstream but not yet in a published `@strands-agents/sdk`, so the module is
> currently built against a local mirror of the interface and is **not yet GA**. See
> [Release status](#release-status).

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
import { Agent, MemoryManager, MessageAddedEvent } from '@strands-agents/sdk'
import { createAgentCoreMemoryStores, AgentCoreBatchTrigger } from 'bedrock-agentcore/experimental/memory/strands'

const stores = createAgentCoreMemoryStores({
  memoryId: process.env.MEMORY_MYMEMORY_ID!, // injected by the deploy (see below)
  actorId, // see "Who is the actor?"
  sessionId, // from the runtime request context
  namespaces: [
    { namespace: '/users/{actorId}/facts' },
    { namespace: '/users/{actorId}/preferences' },
  ],
  trigger: new AgentCoreBatchTrigger({ messageCount: 4, maxDelayMs: 3000, messageAddedEvent: MessageAddedEvent }),
})

const agent = new Agent({ model, memoryManager: new MemoryManager({ stores }) })
```

See [`src/memory/strands/README.md`](../src/memory/strands/index.ts) for `readMode` (`per-namespace`
vs `subtree`), `minScore`, `writeOptions`, and the full factory surface.

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
- **Reads fail open.** A failed `search()` returns `[]` and logs; memory never throws into the agent
  loop.
- **Resource setup is out of scope.** Strategies, indexed keys, record streaming, expiry, and
  encryption are control-plane concerns configured at `CreateMemory` (via the CLI/CDK), not through
  this store.

## Known limitations

1. **Metadata-filtered recall (indexed keys) is not exposed to the agent.** AgentCore supports
   `metadataFilters` on retrieval (gated on indexed keys declared at resource creation), but the
   generic `MemoryStore.search(query, { maxSearchResults })` interface has no slot to carry a filter,
   so the `search_memory` tool can't express one. Pending an upstream `SearchOptions` addition.
2. **Write idempotency tolerates error-path duplicates.** On a write-failure re-fire, duplicate events
   can be written; AgentCore consolidation collapses them at the record level (a cost/cleanliness gap,
   not a correctness one). An exactly-once upgrade is pending a per-message `seq` from the upstream
   `AddMessagesContext`.

## Release status

The module is built against a local mirror of the upstream interface
(`src/memory/strands/_strands-memory-types.ts`) because `@strands-agents/sdk` has not yet published
its memory module. When it does, the "release flip" is import-only — see the
[Release flip checklist](../src/memory/strands/index.ts) in the module README. Until then this is
experimental and should not be relied on for GA workloads.

**SDK requirements:** `@aws-sdk/client-bedrock-agentcore` >= 3.1020 (for the typed `namespacePath`
field used by `subtree` reads).
