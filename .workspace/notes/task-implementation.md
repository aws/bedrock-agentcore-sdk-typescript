# Task Implementation Plan

**Last Updated:** April 15, 2026

* * *

## Context

This repo is the **Bedrock AgentCore SDK for TypeScript** (`bedrock-agentcore`). We're adding **AgentCore Memory integration** so that Strands agents running on AgentCore can persist and recall long-term memories (facts, preferences, summaries) from the AgentCore Memory service.

The Python SDK already ships this integration, but its design bundles persistence, extraction, and injection into one monolithic class — an all-or-nothing choice that has pushed customers to drop the integration and build their own. The TypeScript version fixes this by **decoupling extraction and injection into independent, opt-in capabilities** via a Strands Plugin.

There are two pieces to build:

1. **Memory Client** — a low-level TypeScript client for the AgentCore Memory service API (create events, list events, retrieve LTM records). This already exists as an open PR: [PR #108](https://github.com/aws/bedrock-agentcore-sdk-typescript/pull/108) on branch `feat/memory-client`. It provides passthrough methods over the AWS SDK, a `ScopedMemory` helper for working within a single memory, and convenience methods like `createOrGetMemory`, `getLastKTurns`, and polling wrappers.

2. **AgentCoreMemoryPlugin** — a [Strands Plugin](https://strandsagents.com/docs/user-guide/concepts/plugins/) that sits on top of the Memory Client and automatically handles memory operations on an agent. Developers opt into **LTM extraction** (storing conversation messages as memory events for insight generation), **LTM injection** (retrieving relevant insights and injecting them into agent context), or both. Batching is on by default to reduce API call volume. Multi-agent support is provided via `withActor()` and `withMetadataProvider()` helpers.

Session persistence is **not** handled by this plugin — customers use Strands' native `SessionManager` (S3, filesystem) instead, since storing agent state as memory events is ~50x more expensive than S3.

The full design is in `.workspace/notes/agentcore-memory-strands-integration.md`. The broader TypeScript CodeZip launch context (CLI templates, CDK constructs) is in `.workspace/notes/how-agentcore-cli-will-use-memory-integration-and-whats-needed.md`.

### Branch Structure

- **`feat/agentcore-memory`** — the integration branch where all work merges into.
- **`feat/memory-client`** — PR #108's branch with the Memory Client implementation. Both workstreams branch off this so they start with the client code already in place.

## Workstream A: Memory Client & Foundation — @ajesstur

Get the Memory Client production-ready, landed, then build CLI templates that consume the SDK.

| # | Task | Details |
|---|---|---|
| A1 | Retarget PR #108 to `feat/agentcore-memory` | Change base branch from `main` to `feat/agentcore-memory` |
| A2 | Review & update Memory Client implementation | Verify passthrough methods, `ScopedMemory`, convenience methods |
| A3 | Add `package.json` exports for `bedrock-agentcore/memory` | PR #108 notes this is missing — needed so consumers can `import { MemoryClient } from 'bedrock-agentcore/memory'` |
| A4 | Integration tests for Memory Client | Hit real AgentCore Memory service. Create memory, store events, retrieve LTM, delete. |
| A5 | Land PR onto `feat/agentcore-memory` | Final review + merge |
| A6 | Strands TypeScript template | Move to [AgentCore CLI repo](https://github.com/aws/agentcore-cli). Template under `src/assets/typescript/http/strands/base/` with memory support (`session.ts`, `plugin.ts` using `AgentCoreMemoryPlugin`) |
| A7 | Vercel AI TypeScript template | Template under `src/assets/typescript/http/vercel-ai/base/` with model provider, gateway, and identity support |

## Workstream B: AgentCoreMemoryPlugin (Strands Plugin) — @aidandal

Build the Strands plugin on top of the Memory Client. Branches off `feat/memory-client` so the client code is already available to import.

| # | Task | Details |
|---|---|---|
| B1 | Plugin types & config interfaces | `AgentCoreMemoryPluginConfig`, `MetadataProvider`, `InjectContextConfig`, `StoreMessagesConfig`, `BatchConfig` |
| B2 | Plugin core & lifecycle | Constructor, Strands `Plugin` interface implementation, hook registration on agent |
| B3 | Message batching engine | Timeout + buffer size batching, flush on threshold or timer, async `createEvents` calls |
| B4 | LTM Extraction (`storeMessages`) | Hook into Strands `MessageAddedEvent`, buffer messages, batch-flush to Memory Client. Extraction happens before injection to avoid feedback loops. |
| B5 | LTM Injection (`injectContext`) | Hook into invocation lifecycle, query Memory Client for LTM records per namespace config (`topK`, `relevance_score`), inject into agent context |
| B6 | Multi-agent helpers | `withActor(name)` and `withMetadataProvider(fn)` — return new plugin instances with overridden actorId or metadata |
| B7 | Unit tests | Full coverage: lifecycle, batching, extraction, injection, multi-agent, metadata |
| B8 | Integration tests | End-to-end: Strands agent with plugin → conversation → verify events stored in Memory → verify LTM injection |

## Dependency Graph

```
A1 (retarget) → A2 (review) → A3 (exports) → A4 (integ tests) → A5 (land) → A6 + A7 (CLI templates)
                                     ↓
B1 (types) → B2 (core) → B3 (batching) → B4 (extraction)
                                                 ↓
                                           B5 (injection) → B6 (multi-agent) → B7 (unit tests) → B8 (integ tests)
```

B1–B6 proceed in parallel with A1–A3 (plugin codes against Memory Client types from PR #108). B8 requires the client landed (A5). A6 + A7 start after A5 lands.
