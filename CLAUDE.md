# Bedrock AgentCore SDK for TypeScript

## Project

This is the official AWS Bedrock AgentCore SDK for TypeScript. It lets developers deploy AI agents to AWS with VM-level isolation, managed tools (code interpreter, browser), credential management, and framework-agnostic runtime support.

## Current Work

We are adding **AgentCore Memory integration with Strands Agents** to the TypeScript SDK (`feat/agentcore-memory` branch).

### Goal

Build an `AgentCoreMemoryPlugin` (Strands Plugin) that provides:

- **Memory extraction** — store agent conversation messages as events in AgentCore Memory for LTM insight generation.
- **Memory injection** — retrieve relevant LTM insights and inject them into the agent's context.

Key design decisions:
- Extraction and injection are **decoupled** — customers opt into each independently.
- Session persistence is **not** handled by this plugin — customers use Strands' native SnapshotStorage (S3, filesystem) instead.
- Batching (timeout + buffer size) is **on by default** to reduce API call volume.
- A `metadataProvider` interface lets customers attach custom metadata per message.
- Multi-agent support via `withActor()` and `withMetadataProvider()` helpers.

### Workspace

`.workspace/notes/` contains design docs and reference material for this feature:

- `agentcore-memory-strands-integration.md` — full design doc with proposed API, gaps analysis, alternatives considered, testing requirements, and reference links.

## Git Workflow

Do not commit directly to `feat/agentcore-memory`. Create a feature branch off `feat/agentcore-memory` and open a PR back into it.

## Build & Test

```bash
npm install
npm run build
npm test
```
