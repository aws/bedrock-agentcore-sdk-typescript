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

Do not commit directly to `feat/agentcore-memory`. Always:

1. Create a new feature branch off `feat/agentcore-memory` (e.g. `feat/memory-plugin-types`)
2. Commit and push to that feature branch
3. Open a PR targeting `feat/agentcore-memory` as the base branch, using the PR template in `.github/PULL_REQUEST_TEMPLATE.md`

## Build & Test

```bash
npm install
npm run build
npm test
```
