# AgentCore Memory for Strands (`bedrock-agentcore/memory/strands`)

`AgentCoreMemoryStore` makes [AgentCore Memory](https://docs.aws.amazon.com/bedrock-agentcore/) a
first-class [Strands](https://strandsagents.com) `MemoryStore`: the agent recalls long-term memories
through `search_memory`, and conversation turns are written to AgentCore (role-preserved) for
server-side extraction into long-term records.

This integration implements the Strands `MemoryManager` / `MemoryStore` extraction interface,
consumed directly from `@strands-agents/sdk` (>= 1.5.0).

## What it does

- **Recall** — `search()` maps to `retrieveMemoryRecords`. Per namespace (exact prefix) or across a
  subtree (`namespacePath`).
- **Write** — `addMessages()` packs a turn's role-tagged messages into a single `createEvent` (one API
  call carrying many turns, not one call per message). No client-side extractor and no LLM pass:
  AgentCore extracts and consolidates server-side, and a multi-turn event extracts the same records as
  the equivalent single-turn events would.
- **Cost control** — three independent levers (batching, cadence, flush) govern `createEvent` volume;
  see [Reducing write API calls](#reducing-write-api-calls).
- **Topology** — `createAgentCoreMemoryStores(...)` returns the stores ready to spread into
  `MemoryManagerConfig.stores`.
- **Session persistence** — `createAgentCoreSessionStorage(...)` is a Strands `SessionStorage`
  for `SessionManager`: the agent's full session snapshot lives in AgentCore short-term memory and
  survives runtime cold starts. See [Session persistence](#session-persistence-sessionmanager).

## Usage

```typescript
import { Agent, MemoryManager } from '@strands-agents/sdk'
import { createAgentCoreMemoryStores } from 'bedrock-agentcore/memory/strands'

// One call per (actorId, sessionId). Builds one store per namespace, sharing a client.
const stores = createAgentCoreMemoryStores({
  memoryId: 'mem-abc',
  actorId: 'user-123',
  sessionId: 'session-1',
  namespaces: [
    { namespace: '/strategy/{id}/actor/{actorId}/facts', writable: true }, // the write sink
    { namespace: '/strategy/{id}/actor/{actorId}/preferences', minScore: 0.5 },
  ],
  // `extraction` is the single write switch: omit for recall-only, `true` for the default cadence, or
  // an object for a custom cadence/filter. The writer is the namespace flagged `writable` (else the
  // first). Cadence accepts any Strands trigger.
  extraction: true,
})

const agent = new Agent({
  model,
  memoryManager: new MemoryManager({ stores }), // search_memory on; add_memory left off
})
```

For a single namespace, the store stands alone — construct it directly:

```typescript
import { AgentCoreMemoryStore } from 'bedrock-agentcore/memory/strands'

const store = new AgentCoreMemoryStore({
  memoryId: 'mem-abc',
  actorId: 'user-123',
  sessionId: 'session-1',
  namespace: '/users/{actorId}/facts',
  writable: true,
  extraction: true,
})
const agent = new Agent({ model, memoryManager: new MemoryManager({ stores: [store] }) })
```

This mirrors how the framework's own `BedrockKnowledgeBaseStore` exposes a single store — a constructor,
no factory. Reach for `createAgentCoreMemoryStores` only when you have multiple namespaces (it builds one
shared client and enforces the single-writer topology).

### Subtree reads

For "recall everything relevant about this user" in a single retrieval per turn — read a parent path via
`namespacePath`, covering all child namespaces. A subtree read is a single store, so construct it
directly (no factory): pass `namespacePath` instead of `namespace`.

```typescript
const store = new AgentCoreMemoryStore({
  memoryId,
  actorId,
  sessionId,
  namespacePath: '/strategy/{id}/actor/{actorId}', // the subtree root to query
  writable: true,
  extraction: true,
})
```

`namespace` (exact prefix) and `namespacePath` (subtree) are the two arms of the read-target union —
exactly the `retrieveMemoryRecords` API shape. There is no `readMode` flag: the field you set _is_ the
read mode.

## Session persistence (`SessionManager`)

`AgentCoreSnapshotStorage` implements the Strands `SnapshotStorage` interface, so the Strands
`SessionManager` can keep an agent's session (messages, state, interrupts — whatever the `'session'`
snapshot preset captures) in AgentCore Memory short-term events. A restarted runtime picks up the
conversation where it left off; nothing is kept on the local filesystem.

```typescript
import { Agent, SessionManager } from '@strands-agents/sdk'
import { createAgentCoreSessionStorage } from 'bedrock-agentcore/memory/strands'

const agent = new Agent({
  model,
  sessionManager: new SessionManager({
    sessionId, // becomes the AgentCore sessionId
    storage: createAgentCoreSessionStorage({
      memoryId: 'mem-abc',
      region: 'us-west-2',
      actorId: 'user-123', // optional; defaults to 'strands-agent'
    }),
  }),
})
```

`createAgentCoreSessionStorage(config)` returns `{ snapshot: new AgentCoreSnapshotStorage(config) }`;
construct the class directly when you assemble the `SessionStorage` yourself. It accepts `memoryId`,
`actorId`, `maxChunkBytes`, and the usual `region` / `credentialsProvider` / `client`. Any memory
resource works, with or without strategies: snapshots are plain short-term events.

### Id mapping

| Strands                   | AgentCore Memory                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| —                         | `actorId` from the config (default `strands-agent`); owns every event                       |
| `sessionId`               | `sessionId`, unchanged                                                                      |
| `scope` + `scopeId`       | event metadata `strands.location` = `<scope>/<scopeId>`, e.g. `agent/default`               |
| `snapshotId` / `isLatest` | event metadata `strands.snapshotId` (`latest` for the latest snapshot) / `strands.isLatest` |

Ids are validated, never rewritten: a lossy rewrite could merge two Strands sessions into one AgentCore
session. The `sessionId` must satisfy both the Strands identifier rule and AgentCore's session pattern:
1–100 lowercase letters, digits, `-` or `_`, starting with a letter or digit (a UUID-based runtime
session id qualifies). `scopeId` and `snapshotId` follow the Strands identifier rule, and `actorId`
follows AgentCore's actor pattern (letters, digits, `-`, `_`, `/`, single `:`; up to 255 characters).
In a multi-user server, set `actorId` per user so each user's sessions sit under their own actor.

### Event layout and chunking

Each save is one **write**: the snapshot (or manifest) is serialized to JSON, split into chunks, and
stored as `blob` payload items of one or more `CreateEvent` calls. Every event carries metadata
`strands.layout`, `strands.kind` (`snapshot` | `manifest`), `strands.location`, `strands.snapshotId`
and `strands.isLatest` (snapshots only), `strands.writeId`, `strands.part`, and `strands.partCount`.
Reads select events with `ListEvents` metadata filters and reassemble only complete writes.

- **Chunk size.** AgentCore caps a payload item at 100 KB, a `CreateEvent` at 100 items and 10 MB. A
  chunk holds at most `maxChunkBytes` (default 64 KiB, maximum 100,000) measured as the UTF-8 size of
  its JSON-escaped text, so quotes, newlines and multi-byte characters can't push an item over the
  limit. Up to 100 chunks go in one event (fewer for chunks above 80,000 bytes, keeping each event
  under 8 MB), so any snapshot below about 6.4 MB is a single `CreateEvent`.
- **Latest replaces latest.** Events are append-only, so after writing a new latest snapshot (or
  manifest) the storage deletes the events of the writes it supersedes (those older than the new
  one). Reads pick the newest complete write by `eventTimestamp`, which the storage keeps strictly
  increasing per instance at the service's millisecond resolution. Immutable snapshots
  (`snapshotTrigger`) are never pruned.
- **Partial writes.** If a later part of a multi-event write fails, the parts already written are
  deleted and the error is thrown; an incomplete write is never returned by a read.
- **Expiry.** Events expire after the memory's event expiry (7–365 days, set at `CreateMemory`). The
  latest snapshot is rewritten on every save, but a session idle for longer than the expiry, and
  immutable snapshots older than it, are gone.

### API calls and limits

| Operation                       | AgentCore calls                                                                |
| ------------------------------- | ------------------------------------------------------------------------------ |
| save latest snapshot / manifest | 1 `CreateEvent` per part, 1 `ListEvents`, 1 `DeleteEvent` per superseded event |
| save immutable snapshot         | 1 `CreateEvent` per part                                                       |
| load snapshot / manifest        | 1 `ListEvents` per 100 matching events (normally 1)                            |
| `listSnapshotIds`               | 1 `ListEvents` per 100 history events                                          |
| `deleteSession`                 | `ListEvents` pages, then one `DeleteEvent` per event, sequentially             |

With `SessionManager`'s default `saveLatestOn: 'invocation'`, a turn costs one `CreateEvent`, one
`ListEvents`, and one `DeleteEvent`. Mind the per-actor, per-session quotas: 10 `CreateEvent`/s for
non-conversational events, 20 `ListEvents`/s, and 5 `DeleteEvent`/s; `saveLatestOn: 'message'` on a
fast tool loop is the setting most likely to approach them. `listSnapshotIds` reads every history event
of the location because `ListEvents` has no ordering or range filter; `limit` and `startAfter` are
applied after the scan.

### Errors

AWS failures surface as `AgentCoreSessionStorageError` with the AWS SDK error as `cause`.
`ResourceNotFoundException` on a read is treated as "nothing stored" (`null`, `[]`, or a default
manifest), matching how the Strands S3 storage treats a missing object. A failure to prune superseded
events is logged as a warning and does not fail the save, since the new snapshot is already stored and
reads still pick the newest one. Invalid ids throw a plain `Error` before any call is made.

### Required IAM actions

```json
{
  "Effect": "Allow",
  "Action": ["bedrock-agentcore:CreateEvent", "bedrock-agentcore:ListEvents", "bedrock-agentcore:DeleteEvent"],
  "Resource": "arn:aws:bedrock-agentcore:<region>:<account-id>:memory/<memory-id>"
}
```

### With `AgentCoreMemoryStore`

The two compose: point both at the same `memoryId`, `actorId`, and `sessionId`. `AgentCoreMemoryStore`
writes conversational events that long-term strategies extract from; the session storage writes only
`blob` events tagged `strands.*`, and its reads and `deleteSession` touch only those events.

## Design notes

- **At most one writable store per `(actorId, sessionId)`.** `createEvent` is namespace-free, so writes
  collapse to a single stream regardless of read target — two writable stores would emit duplicate events.
  Across a factory-built set the writer is the namespace flagged `writable: true` (else, when `extraction`
  is enabled, the first); the rest are search-only. `createAgentCoreMemoryStores` calls
  `assertWritableTopology` to enforce the at-most-one rule, and that guard is **exported** so hand-built
  (`new AgentCoreMemoryStore`) multi-store setups can call it themselves. Omit `extraction` (and leave
  `writable` unset, defaulting to `false`) for a fully recall-only topology.
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
- **Reserved result metadata.** Each returned `MemoryEntry.metadata` carries store-provided fields under
  the `RESERVED_METADATA_PREFIX` (`_`): `_id`, `_score`, `_namespaces`, `_createdAt`. Avoid that prefix
  for your own metadata keys so they never collide.
- **`minScore` over-fetch is tunable.** When a `minScore` floor is set, the store over-fetches `topK`
  (default `4×`, capped at 100) so the client-side filter doesn't under-deliver; override per store via
  `overFetchFactor`. (AgentCore's retrieve API has no server-side relevance threshold, so the floor is
  applied client-side.)

## Reducing write API calls

`createEvent` is the write API call, and three independent levers control how many you make. They
compose — understand them separately:

1. **Batching (always on).** A flush packs all of its role-tagged turns into a _single_ `createEvent`
   (chunked only at `maxTurnsPerEvent`, default 50), instead of one call per message. So a 6-message
   turn is 1 call, not 6. This needs no configuration and applies under every trigger; it is the
   primary write-cost reduction.

2. **Cadence (the trigger) — tunes calls _across_ turns.** The trigger decides _when_ a flush happens.
   `extraction: true` defers to Strands' default (`IntervalTrigger`, every **5 turns** — not every
   invocation; and a fire with no new messages is a no-op, so it never writes "empty"). Pass any Strands
   trigger to tune it, e.g. `extraction: { cadence: new IntervalTrigger({ turns: 10 }) }`, or an array to
   compose several. **Cadence only changes call volume if writes actually buffer across turns** — which
   requires reusing the `MemoryManager` across the session's invocations (see below) and _not_ flushing
   every turn. So in the common per-turn-`flush()` pattern the trigger choice is largely moot. It is
   **not** the cost lever — batching (lever 1) is.

3. **`flush()` — durability, not cost.** `MemoryManager.flush()` force-drains the buffer immediately,
   ignoring the trigger. A trigger only _dispatches_ a write (fire-and-forget; never awaited), and the
   AgentCore runtime can reclaim the session microVM on idle before a dispatched write lands — and any
   turn may be the last (there is no session-end signal). `flush()` awaits the writes while the runtime
   is alive, so it is the durability mechanism. The safe default is to `flush()` at the end of each
   invocation handler; it's cheap because batching makes a turn's flush a single call.

**The tension, and how to resolve it:** flushing every turn (durable) means ~1 `createEvent` per turn —
the trigger's cross-turn batching never kicks in. To cut calls further you flush _less_ often and let
the cadence batch across turns, accepting that an unflushed tail is lost if the microVM is reclaimed
mid-session. Two working setups:

- **Durable default (recommended):** reuse the `MemoryManager` per session, the default cadence
  (`extraction: true`), and `await memory.flush()` at the end of every handler. One batched call per
  turn; no loss.
- **Cost-tuned (advanced):** reuse the `MemoryManager` per session, a coarse `IntervalTrigger`, and
  flush only when you detect session end. Fewer calls; small tail-loss risk on idle reclamation.

**Reuse the manager across invocations.** The runtime keeps one microVM alive per session (idle timeout
~15 min, max 8 h), so build the `MemoryManager` once per `(actorId, sessionId)` and reuse it across that
session's invocations — that's what keeps the coordinator buffer and the trigger's timer alive so
cadence can batch across turns. The **application** owns this reuse (e.g. a `Map` keyed by
`actorId:sessionId`); the SDK deliberately holds no session cache, so eviction and lifecycle stay in
your control. See the runtime example for the full pattern.

## The namespace contract (read this if recall comes back empty)

Recall only works when the namespace this store **queries** matches where AgentCore **stored** the
records. That handshake has sharp edges:

- **AgentCore resolves placeholders at _write_ time, not _read_ time.** When a strategy's
  `namespaceTemplates` contain `{actorId}`/`{sessionId}`/`{memoryStrategyId}`, the service substitutes
  them when it extracts a record and stores it under the concrete path (e.g.
  `/strategies/sem-abc123/actors/user-7/facts`). On retrieval it does **not** substitute anything — it
  matches your query string as a **prefix** against those stored paths.
- **This store only resolves `{actorId}` and `{sessionId}` (client-side).** Any other placeholder left
  in the namespace (notably `{memoryStrategyId}`) would survive into the query. AgentCore rejects `{`/`}`
  in a namespace, so the store **throws at construction** with a clear message rather than letting recall
  fail later. Provide a namespace whose only placeholders are `{actorId}`/`{sessionId}` (or pre-substitute
  a concrete strategy id).
- **Match the convention you provisioned.** The AgentCore CLI provisions strategies with
  `{actorId}`/`{sessionId}`-only templates — e.g. SEMANTIC `/users/{actorId}/facts`, USER_PREFERENCE
  `/users/{actorId}/preferences`, SUMMARIZATION `/summaries/{actorId}/{sessionId}`. Query with the same
  template you provisioned. Do **not** copy a `/strategies/{memoryStrategyId}/...` template from other
  SDK docs into a CLI-provisioned setup — it's a different, incompatible convention.
- **`{sessionId}` namespaces are per-session.** For SUMMARIZATION/EPISODIC templates that include
  `{sessionId}`, a store built for session B will not see session A's records. Use a stable `sessionId`
  (or an `{actorId}`-only namespace) when you want cross-session recall.

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

- `@aws-sdk/client-bedrock-agentcore` >= 3.1065.0 (typed `namespacePath`).
- `@strands-agents/sdk` >= 1.5.0 (the memory `MemoryManager` / `MemoryStore` / extraction surface, and the
  `SessionManager` / `SnapshotStorage` session surface).
