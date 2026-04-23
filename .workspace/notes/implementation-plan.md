# AgentCoreMemory Plugin — Implementation Plan

**Status:** Approved (Ralplan consensus: Planner → Architect → Critic)
**Date:** 2026-04-22
**Branch:** `feat/agentcore-memory` → feature branches per step

---

## RALPLAN-DR Summary

### Principles
1. Memory is never critical path — all failures log + continue, never crash the agent
2. Follow existing SDK patterns — mirror integrations/strands/ directory structure
3. Plugin interface is the contract — implement Strands Plugin (0.7.0)
4. Extraction and injection are independent — customer opts into each separately
5. Batch by default — reduce API call volume without customer effort

### Decision Drivers
1. API shape matches team consensus — `extraction:`/`injection:` naming, `automatic`/`searchTool` booleans
2. MemoryClient is the only integration surface — `createEvent()` and `retrieveMemoryRecords()`
3. Existing tool patterns set the structure — `src/memory/integrations/strands/`

### Chosen Option: Single Plugin class + tool factory
Single `AgentCoreMemory` class implementing Plugin interface, with internal helper functions (not classes) for formatting and batching. Also exports `createSearchMemoryTool` as a standalone factory for advanced composability.

---

## Naming Changes from Design Doc

The following names were changed per team review consensus (Quip comments). The design doc examples still use the old names and will need updating:

| Design Doc | Implementation | Rationale |
|---|---|---|
| `AgentCoreMemoryPlugin` | `AgentCoreMemory` | Jack Yuan: "Plugin doesn't need Plugin in the name" |
| `storeMessages:` | `extraction:` | Team consensus: options 1 or 3 from Quip thread |
| `injectContext:` | `injection:` | Parallel naming with extraction |
| `mode: 'tool'` | `automatic: false, searchTool: true` | Jesse's `automaticInjection` suggestion (2 likes) |
| `bedrock-agentcore/memory/strands` | `bedrock-agentcore/experimental/memory/strands` | Matches existing SDK export convention |

## Design Decision Resolutions

Open questions from the design doc, resolved during review:

| Question | Resolution | Source |
|---|---|---|
| Prefetch mode needed on day one? | No — deferred until customer demand | Design doc Decision 1 recommendation, no objection |
| searchTool auto vs explicit opt-in? | Explicit opt-in (`searchTool: false` default) | Design doc recommendation adopted |
| batchSize default? | 10 (match Python SDK) | Design doc Decision 2, no objection |
| Built-in filter presets? | Deferred — leave filtering to customer via `messageFilter` | No team feedback requesting presets |
| Auto-derive namespace labels? | Yes, from path | Design doc Decision 3 recommendation adopted |
| Staleness metadata in injection? | Deferred — not enough signal to justify extra tokens | No team feedback requesting it |
| contextTag configurability? | Yes — TJ requested it | Quip comment, moved from open question |
| System prompt reinforcement for tool mode? | No — TJ + Mackenzie consensus | Quip comment: "shouldn't interfere with customer's system prompt" |
| Await vs fire-and-forget flush? | Await by default, `fireAndForget: true` escape hatch | Aidan's decision |

## Why BeforeInvocationEvent, Not BeforeModelCallEvent

We considered `BeforeModelCallEvent` for injection — it fires after user message is appended, so the current user message would be available as a search query. We rejected it because `BeforeModelCallEvent` fires on **every model call within an invocation**, including after each tool-use loop iteration. With ephemeral injection, this would mean stripping and re-injecting memory context (with a retrieval API call) on every loop iteration — wasteful and potentially 5-10x the API calls per turn for tool-heavy agents. `BeforeInvocationEvent` fires once per invocation, which is the right granularity.

## Verified Strands SDK 0.7.0 Facts

- `Plugin` interface: `{ readonly name: string; initAgent(agent: LocalAgent): void | Promise<void>; getTools?(): Tool[] }`
- `AgentConfig` has `plugins?: Plugin[]`
- `initAgent()` receives the `Agent` instance at runtime (typed as `LocalAgent`, but Agent passes `this`)
- `systemPrompt` is on `Agent`, NOT on `LocalAgent` — must cast in initAgent
- `BeforeInvocationEvent` fires BEFORE user message is appended to `agent.messages`
- **`MessageAddedEvent` DOES fire for user input** despite JSDoc claiming otherwise. Verified: `_appendMessage()` is called for user messages and yields `MessageAddedEvent`. The JSDoc is stale.
- `AfterInvocationEvent` fires in the `finally` block (always runs)
- `SystemPrompt = string | SystemContentBlock[]` where `SystemContentBlock = TextBlock | CachePointBlock | GuardContentBlock`

## MemoryClient API Surface (PR #139, merged)

- `createEvent({ memoryId, actorId, sessionId, eventTimestamp, payload, metadata?, clientToken? })` — single event, NO batch event API. `payload` is `PayloadType[]` (array — can hold multiple conversational items per event). `clientToken` enables idempotent retries.
- `retrieveMemoryRecords({ memoryId, namespace, searchCriteria: { searchQuery, topK? } })` — `namespace` is a **prefix filter** (not exact match). One call per namespace needed for per-namespace `topK` control. Requires `searchQuery` string.
- Payload: `PayloadType[] where ConversationalMember = { conversational: { role: Role, content: { text: string } } }`
- Role: AWS SDK uses uppercase `'USER' | 'ASSISTANT' | 'TOOL' | 'OTHER'`. Strands uses lowercase `'user' | 'assistant'`.
- MetadataValue: discriminated union `{ stringValue: string; $unknown?: never }` from `@aws-sdk/client-bedrock-agentcore`

---

## Step 1: Types & Configuration

**File:** `src/memory/integrations/strands/types.ts`
**Tests:** Type-only — TypeScript compiler validates

```typescript
export interface NamespaceConfig {
  topK?: number              // default: 5
  relevanceScore?: number    // client-side post-filter on response scores (NOT an API param)
                             // records below this threshold are dropped after retrieval
}

export interface ExtractionConfig {
  batchSize?: number              // default: 10
  batchTimeoutMs?: number         // default: 5000
  messageFilter?: (message: Message) => boolean
  fireAndForget?: boolean         // default: false (await flush)
}

export interface InjectionConfig {
  namespaces: Record<string, NamespaceConfig>
  automatic?: boolean              // default: true
  searchTool?: boolean             // default: false
  maxInjectionChars?: number       // default: 8000 (~2000 tokens)
  contextTag?: string              // default: 'agentcore_memory'
  formatMemories?: (records: MemoryRecordGroup[]) => string
}

export interface AgentCoreMemoryConfig {
  memoryId: string
  actorId: string
  sessionId: string
  extraction?: boolean | ExtractionConfig    // Resolution: undefined/false = disabled,
                                             // true/{} = enabled with defaults,
                                             // { batchSize: 20 } = enabled with overrides
  injection?: InjectionConfig
  metadataProvider?: (message: Message) => Record<string, MetadataValue>
  memoryClient?: MemoryClientConfig
}

export interface MemoryRecordGroup {
  namespace: string
  label: string              // auto-derived: '/facts/{actorId}/' → 'facts'
  records: MemoryRecord[]
}

export interface MemoryRecord {
  content: string
  score?: number
  createdAt?: Date
}

// Internal — defaults applied
export interface ResolvedExtractionConfig {
  batchSize: number          // 10
  batchTimeoutMs: number     // 5000
  messageFilter: (message: Message) => boolean  // () => true
  fireAndForget: boolean     // false
}
```

---

## Step 2: Formatting & Utilities

**File:** `src/memory/integrations/strands/format.ts`
**Tests:** `src/memory/integrations/strands/__tests__/format.test.ts` — pure functions, no mocks

### Functions

**`deriveLabel(namespacePath: string): string`**
- Split on `/`, filter out empty strings and `{...}` placeholders, return the last remaining segment
- If no segments remain, return the full path stripped of `{...}` and `/`
- Examples: `/facts/{actorId}/` → `facts`, `/preferences/{actorId}/summaries/` → `summaries`, `/{actorId}/` → path itself, `/facts/` → `facts`

**`formatMemoryBlock(groups: MemoryRecordGroup[], contextTag: string): string`**
- If groups contain zero total records, return empty string (caller skips injection)
- Produces: `<agentcore_memory>\nThe following are relevant memories...\n\n[facts]\n- record1\n...\n</agentcore_memory>`

**`truncateToCharBudget(groups: MemoryRecordGroup[], maxChars: number): MemoryRecordGroup[]`**
- Flatten all records across groups, sort by score **descending** (most relevant first). Records with `undefined` score are treated as score 0 (least relevant).
- Take records from the top until cumulative char count exceeds `maxChars`. Discard the rest.
- Reconstruct groups from the surviving records.

**`stripMemoryBlock(prompt: SystemPrompt | undefined, tag: string): SystemPrompt | undefined`**
- **Escape `tag` for regex metacharacters** before building the pattern (e.g., `memory.v2` → `memory\.v2`)
- Three code paths:
  - `undefined` → return undefined
  - `string` → regex `<escaped_tag>[\s\S]*?</escaped_tag>` with global flag `/g` to strip all occurrences. Do NOT trim (preserve customer whitespace).
  - `SystemContentBlock[]` → map TextBlocks: strip tag content from text, filter out empty blocks, pass CachePointBlock/GuardContentBlock through unchanged

**`appendMemoryBlock(prompt: SystemPrompt | undefined, block: string): SystemPrompt`**
- `undefined` → return block as string
- `string` → `${prompt}\n\n${block}`
- `SystemContentBlock[]` → `[...prompt, { text: block }]` (preserves CachePointBlocks)

**`extractText(message: Message): string`**
- Iterate `message.content` (which is `ContentBlock[]`), concatenate text from supported block types:
  - `TextBlock` → use `.text`
  - `ToolUseBlock` → stringify as `[tool_use: ${name}(${JSON.stringify(input)})]`
  - `ToolResultBlock` → extract text from `.content` (which is `TextBlock | JsonBlock`)
  - `ReasoningBlock` → use `.text` if present
  - `ImageBlock`, `VideoBlock`, `DocumentBlock` → skip (lossy — binary content not extractable)
  - `CachePointBlock`, `GuardContentBlock`, `CitationsBlock` → skip
- Multi-modal messages are lossy by design — only text-representable content is extracted.

**`mapRole(message: Message): 'USER' | 'ASSISTANT'`**
- `message.role === 'user'` → `'USER'`
- `message.role === 'assistant'` → `'ASSISTANT'`
- Strands only has two roles. Tool results are `user`-role messages with `ToolResultBlock` content — they map to `'USER'` (the service handles the distinction via content inspection).

---

## Step 3: search_memory Tool Factory

**File:** `src/memory/integrations/strands/search-memory-tool.ts`
**Tests:** `src/memory/integrations/strands/__tests__/search-memory-tool.test.ts` — mock MemoryClient

Follows the `createExecuteCodeTool()` pattern from code-interpreter:

```typescript
import { tool } from '@strands-agents/sdk'
import { z } from 'zod'

export function createSearchMemoryTool(
  client: MemoryClient,
  config: { memoryId: string; namespaces: Record<string, NamespaceConfig> }
) {
  return tool({
    name: 'search_memory',
    description: 'Search long-term memory for relevant user context, preferences, or past interactions.',
    inputSchema: z.object({
      query: z.string().describe('What to search for in memory'),
      namespace: z.string().optional().describe('Specific namespace to search (default: all configured)'),
    }),
    callback: async ({ query, namespace }) => {
      // If namespace specified, search only that one. Otherwise search all configured.
      // Format results and return as string.
    },
  })
}
```

---

## Step 4: AgentCoreMemory Plugin Class

**File:** `src/memory/integrations/strands/plugin.ts`
**Tests:** `src/memory/integrations/strands/__tests__/plugin.test.ts`

### Class Shape

```typescript
export class AgentCoreMemory implements Plugin {
  readonly name = 'agentcore-memory'

  private client: MemoryClient
  private config: AgentCoreMemoryConfig
  private extractionConfig: ResolvedExtractionConfig | null
  private injectionConfig: InjectionConfig | null
  private agent!: AgentWithSystemPrompt  // set in initAgent
  private initialized = false            // guard against double-registration
  private buffer: Message[] = []
  private flushTimer?: ReturnType<typeof setTimeout>
  private flushing = false               // guard against concurrent flushes
  private searchMemoryTool?: ReturnType<typeof createSearchMemoryTool>

  constructor(config: AgentCoreMemoryConfig)

  // --- Plugin interface ---
  initAgent(agent: LocalAgent): void     // throws if called twice on same instance
  getTools(): Tool[]

  // --- Multi-agent helpers ---
  withActor(actorId: string): AgentCoreMemory       // returns uninitialized instance for new Agent
  withMetadataProvider(fn: MetadataProviderFn): AgentCoreMemory

  // --- Private: Injection ---
  private async handleBeforeInvocation(): Promise<void>
  private async retrieveAndInject(): Promise<void>
  private getSearchQuery(): string
  private buildGenericQuery(): string    // e.g., "Retrieve relevant context about: facts, preferences"

  // --- Private: Extraction ---
  private handleMessageAdded(event: MessageAddedEvent): void
  private async handleAfterInvocation(): Promise<void>
  private bufferMessage(message: Message): void
  private shouldBuffer(message: Message): boolean
  private async flushBuffer(): Promise<void>
  private createEventFromMessage(message: Message): Promise<CreateEventCommandOutput>
  private generateClientToken(message: Message, index: number): string
  private clearFlushTimer(): void
}
```

### Key Implementation Details

**initAgent — conditional hook registration + double-registration guard:**
```typescript
initAgent(agent: LocalAgent): void {
  if (this.initialized) {
    throw new Error('AgentCoreMemory plugin already initialized. Use withActor() or withMetadataProvider() to create a new instance for a different agent.')
  }
  this.initialized = true
  this.agent = agent as unknown as AgentWithSystemPrompt

  if (this.injectionConfig?.automatic !== false) {
    agent.addHook(BeforeInvocationEvent, () => this.handleBeforeInvocation())
  }
  if (this.extractionConfig) {
    agent.addHook(MessageAddedEvent, (e) => this.handleMessageAdded(e))
    agent.addHook(AfterInvocationEvent, () => this.handleAfterInvocation())
  }
}
```

**Injection — search query strategy:**
- BeforeInvocationEvent fires BEFORE user message is appended
- Use last message in `agent.messages` (previous turn's content)
- Fresh session with empty messages: `buildGenericQuery()` derives from namespace paths, e.g., `"Retrieve relevant context about: facts, preferences"` from `/facts/{actorId}/` and `/preferences/{actorId}/`
- Retrieve from all configured namespaces in parallel via `Promise.all()` (N calls needed for per-namespace `topK`)
- If all namespaces return zero records, **skip injection entirely** (don't inject empty block)
- Apply client-side `relevanceScore` post-filter: drop records with `score < config.relevanceScore` after retrieval

**Extraction — simplified (MessageAddedEvent fires for ALL messages including user):**
- **Key finding:** Despite the JSDoc, `MessageAddedEvent` DOES fire for user input in SDK 0.7.0 (verified in source). The `_appendMessage()` method yields `MessageAddedEvent` for all messages.
- This simplifies extraction: `handleMessageAdded` receives ALL messages (user, assistant, tool results). No index-diffing needed.
- `handleMessageAdded`: apply `messageFilter`, then `bufferMessage()`
- Buffer flushed when `buffer.length >= batchSize` (early flush) OR at `AfterInvocationEvent` (end-of-turn flush)
- `batchTimeoutMs` timer: started on first `bufferMessage()` after buffer was empty. Cleared in `flushBuffer()` and in `handleAfterInvocation()`.

**Flush — Promise.allSettled + clientToken + retry-once-then-drop:**
```
1. If this.flushing, return (guard against concurrent flush from timer + AfterInvocation)
2. this.flushing = true
3. Copy buffer, clear buffer, clear timer
4. Promise.allSettled(toFlush.map((msg, i) => createEventFromMessage(msg, i)))
5. Collect rejected results
6. If any rejected: Promise.allSettled(retry failed ones with same clientTokens)
7. If still rejected: log warning with count, drop
8. this.flushing = false
```

**Message-to-Event conversion:**
```typescript
private createEventFromMessage(message: Message, index: number): Promise<CreateEventCommandOutput> {
  return this.client.createEvent({
    memoryId: this.config.memoryId,
    actorId: this.config.actorId,
    sessionId: this.config.sessionId,
    eventTimestamp: new Date(),
    clientToken: this.generateClientToken(message, index),
    payload: [{ conversational: { role: mapRole(message), content: { text: extractText(message) } } }],
    ...(this.config.metadataProvider && { metadata: this.config.metadataProvider(message) }),
  })
}
```

**Note on payload batching opportunity:** The `payload` field accepts an array of items. A future optimization could batch an entire turn's messages into a single `createEvent` call with multiple payload items, reducing API calls further. For v1, we use one event per message for simplicity and clearer event-to-message mapping.
```

**Error handling in hooks:**
```typescript
private async handleBeforeInvocation(): Promise<void> {
  try {
    await this.retrieveAndInject()
  } catch (err) {
    // Strip any existing memory block (don't leave stale data)
    this.agent.systemPrompt = stripMemoryBlock(this.agent.systemPrompt, this.injectionConfig!.contextTag ?? 'agentcore_memory')
    console.warn('[agentcore-memory] Injection failed, continuing without memory context:', err)
  }
}
```

**withActor / withMetadataProvider:**
- Return new `AgentCoreMemory` instance with overridden config
- Share the MemoryClient instance (no reason to create a new one)
- Fresh buffer (independent extraction state)

---

## Step 5: Exports & Package Configuration

**File:** `src/memory/integrations/strands/index.ts`
```typescript
export { AgentCoreMemory } from './plugin.js'
export { createSearchMemoryTool } from './search-memory-tool.js'
export type {
  AgentCoreMemoryConfig,
  ExtractionConfig,
  InjectionConfig,
  NamespaceConfig,
  MemoryRecordGroup,
  MemoryRecord,
} from './types.js'
```

**package.json updates:**
```json
// exports
"./experimental/memory/strands": {
  "import": "./dist/src/memory/integrations/strands/index.js",
  "types": "./dist/src/memory/integrations/strands/index.d.ts"
}

// devDependencies
"@strands-agents/sdk": "^0.7.0"

// peerDependencies
"@strands-agents/sdk": ">=0.7.0"
```

---

## Step 6: Integration Tests

**File:** `tests_integ/memory-strands.test.ts`

Pattern matches existing `tests_integ/memory.test.ts`. Use a **real Strands Agent with a mock Model** — do not manually simulate hooks. This ensures the real event ordering drives the plugin and catches assumptions like the MessageAddedEvent user-input behavior.

1. Create memory resource via `createMemoryAndWait()`
2. Create `AgentCoreMemory` plugin with extraction + injection
3. Create a real `Agent` with the plugin and a mock Model that returns canned responses
4. Invoke the agent with a user message — real Strands event machinery drives hooks
5. Verify events created via `listEvents()` (user + assistant messages extracted)
6. Wait for LTM insights via `waitForMemories()`
7. Invoke the agent again — verify injection retrieves and injects LTM into systemPrompt
8. Test search_memory tool callback directly (with real MemoryClient)
9. Cleanup: delete memory resource

---

## Build Sequence

```
Step 1: types.ts              (no deps)           ─┐
Step 2: format.ts             (depends on types)    ├── parallelizable
Step 3: search-memory-tool.ts (depends on types)   ─┘
Step 4: plugin.ts             (depends on 1-3)
Step 5: index.ts + package.json (depends on 4)
Step 6: integration tests     (depends on 5)
```

## Known Limitations to Document

These should be documented in the plugin's JSDoc and/or README:

1. **Snapshot rewinding may cause duplicate extraction.** If a customer restores an older snapshot (rewinding from turn 10 to turn 3), the plugin will re-extract messages that were already extracted in the original session. The service handles duplicates gracefully (no data corruption), but it's wasted API calls and may produce redundant LTM insights. Branching (when Strands adds support) is the proper solution.

2. **First-turn injection uses a generic search query.** `BeforeInvocationEvent` fires before the user's message is appended to `agent.messages`. On the first turn of a fresh session, there are no previous messages to use as a search query, so a generic fallback is used. LTM insights are broad enough that this still returns useful results, but relevance may be lower on the very first turn.

3. **`systemPrompt` access requires type cast.** The Plugin interface's `initAgent()` receives `LocalAgent`, which does not expose `systemPrompt`. The runtime value is the full `Agent` instance, so we cast. If Strands changes this internal behavior, the cast would break. This is mitigated by the peer dependency pin (`>=0.7.0`).

4. **No `mode` field.** The design doc originally proposed `mode: 'ephemeral' | 'tool' | 'prefetch'`. Per team review, this was simplified to two independent booleans: `automatic` (default true) and `searchTool` (default false). `prefetch` mode is deferred until customer demand.

5. **`fireAndForget: true` may lose messages on process exit.** When enabled, extraction flushes are not awaited. If the process exits before the flush completes (Lambda cold shutdown, container eviction), buffered messages are silently lost. Do not use `fireAndForget: true` in Lambda or other short-lived processes.

6. **`automatic: false` + `searchTool: false` is a valid but useless state.** If injection is configured with namespaces but both booleans are false, the plugin does nothing for injection. The constructor should log a warning for this degenerate configuration.

## Git Workflow

Each step = feature branch off `feat/agentcore-memory` → PR targeting `feat/agentcore-memory`.

---

## Acceptance Criteria

1. `npm run build` passes with no type errors
2. `npm test` passes with >=60% coverage on new files
3. `import { AgentCoreMemory } from 'bedrock-agentcore/experimental/memory/strands'` resolves
4. Plugin conditionally registers only hooks for enabled features
5. Plugin registers `search_memory` tool only when `injection.searchTool = true`
6. Extraction flushes via `Promise.allSettled()` with `clientToken` for idempotent retries + retry-once-then-drop
7. Extraction captures ALL messages via `MessageAddedEvent` (including user input — no index-diffing)
8. Injection strips stale `<contextTag>` block (with escaped regex), retrieves fresh LTM, injects into systemPrompt
9. Injection handles `string`, `SystemContentBlock[]`, and `undefined` systemPrompt types
10. Injection skips when all namespaces return zero records (no empty block injected)
11. All failures log warning and continue (never throw from hooks)
12. `withActor()` and `withMetadataProvider()` return independent uninitialized instances with shared MemoryClient
13. `extraction: true` and `extraction: {}` both resolve to default config `{ batchSize: 10, batchTimeoutMs: 5000 }`
14. `messageFilter` callback applied before buffering
15. `maxInjectionChars` truncates least-relevant records (score descending, undefined scores treated as 0)
16. `formatMemories` override replaces default formatter entirely
17. `initAgent()` throws if called twice on the same instance
18. `flushing` guard prevents concurrent flushes from timer + AfterInvocationEvent
19. Integration test uses real Agent with mock Model (not manual hook simulation)
20. Integration test proves end-to-end: extraction → wait for LTM → injection retrieves results

---

## Review Notes (Incorporated)

### Architect + Critic Review (Ralplan consensus)
- Plugin interface confirmed in SDK 0.7.0 — no HookProvider fallback needed
- systemPrompt access: cast `LocalAgent` in initAgent (Agent passes `this` at runtime)
- searchQuery for injection: use last message in agent.messages; generic fallback for fresh sessions
- SystemPrompt type: three code paths (string, array, undefined)
- Flush: Promise.allSettled() with retry, not Promise.all()
- Also export createSearchMemoryTool as standalone factory for composability
- Branching: hardcode to main branch
- Concurrency: Strands acquireLock() handles it, no plugin-level mutex

### Grumpy Reviewer Findings (5 independent reviewers, post-approval)
- **MessageAddedEvent DOES fire for user input** in 0.7.0 (JSDoc is stale). Simplified extraction: use MessageAddedEvent for all messages, dropped index-diffing hack.
- **`relevanceScore` is not an API input param** — clarified as client-side post-filter on response scores
- **`extractText()` is non-trivial** — specified behavior per ContentBlock type (TextBlock, ToolUseBlock, ToolResultBlock, skip binary)
- **Role mapping** — Strands lowercase → AWS SDK uppercase, explicitly defined
- **Payload batching opportunity** — deferred to v2, documented rationale
- **`clientToken`** — added for idempotent retry safety
- **Double-registration guard** — throw if `initAgent` called twice
- **Regex tag escaping** — escape `contextTag` before building strip pattern
- **Empty injection skip** — skip when zero records across all namespaces
- **`fireAndForget` data loss** — added to Known Limitations
- **Integration tests** — use real Agent with mock Model, not manual hook simulation
- **Naming changes documented** — added explicit table mapping old → new names
- **`extraction: {}` behavior** — documented resolution logic (same as `true`)
- **BeforeModelCallEvent rejection rationale** — documented why it fires too often for injection
