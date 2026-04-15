# TypeScript CodeZip Support: Developer Experience Design

**Status:** Draft 
**Last Updated:** April 15, 2026
* * *

## Overview

We're adding TypeScript support to AgentCore CodeZip deployments. A TypeScript developer will use the same CLI commands, project structure, and deploy pipeline as Python — `agentcore create` through `agentcore deploy` — with the same capabilities: multi-provider model support, MCP gateway integration, and AgentCore Memory.

This covers work across three packages: the **CLI** (templates, TUI, schema), the CDK Constructs (Node bundler), and the TypeScript SDK (memory client and Strands memory plugin). We're launching with four framework templates: **Strands Agents**, **Vercel AI SDK**, **LangGraph**, and **Claude Agent SDK**.
* * *

## Part 1: The Developer Experience

### Creating a TypeScript Agent

The CLI already has a language selection step in the TUI wizard — TypeScript is listed but disabled with "(coming soon)". We enable it. When a developer selects TypeScript, the framework options filter to show the four supported TypeScript frameworks.

```
`? Select a language:
  > Python
    TypeScript

? Select a framework:
  > Strands Agents
    LangGraph
    Vercel AI SDK
    Claude Agent SDK

? Select a model provider:
  > Bedrock
    Anthropic
    OpenAI
    Gemini

? Select memory:
  > none
    shortTerm
    longAndShortTerm
`
```

Or non-interactively:

```
`agentcore create \
  --language TypeScript \
  --framework Strands \
  --model-provider Bedrock \
  --memory longAndShortTerm
`
```

The scaffolded project looks like this:

```
`my-project/
├── agentcore/
│   ├── agentcore.json
│   └── cdk/
├── app/
│   └── my-project/
│       ├── main.ts                 # Agent entrypoint
│       ├── package.json            # Dependencies
│       ├── tsconfig.json           # IDE support (noEmit)
│       ├── model/
│       │   └── load.ts             # Model provider config
│       ├── mcp-client/             # (if gateways configured)
│       │   └── client.ts
│       └── memory/                 # (if memory enabled)
│           ├── session.ts
│           └── plugin.ts
└── README.md
`
```

Every template generates the same file structure. The framework choice determines the implementation inside each file — which classes are used, how tools are defined, how streaming works — but the project shape, feature set, and deploy behavior are identical across frameworks.

### What the Generated Code Does

**`main.ts`** creates a `BedrockAgentCoreApp` from the `bedrock-agentcore` runtime SDK — a Fastify HTTP server on port 8080 that satisfies the AgentCore Runtime service contract. Inside the invocation handler, the framework's agent is created with the loaded model, any configured tools (including MCP gateway tools), and memory if enabled. Responses stream back as SSE.

**`model/load.ts`** configures the model provider. For Bedrock, this is a direct connection using IAM credentials from the runtime environment. For Anthropic, OpenAI, or Gemini, the template uses `withApiKey` from `bedrock-agentcore/identity` to fetch the API key from AgentCore Identity at runtime, with a fallback to environment variables for local development.

**`mcp-client/client.ts`** (when gateways are configured) creates an MCP client for each gateway with authentication handling:

* **AWS_IAM gateways** use SigV4-signed HTTP connections. We wrap the MCP transport's `fetch` function with `aws4fetch` to sign requests against the `bedrock-agentcore` service. This is the TypeScript equivalent of Python's `mcp-proxy-for-aws` — approximately 50 lines of wrapper code using `aws4fetch` (already used in `@ai-sdk/amazon-bedrock` for Bedrock API signing).
* **CUSTOM_JWT gateways** use `withAccessToken` from `bedrock-agentcore/identity` to obtain an OAuth2 token, then pass it as a bearer header to the MCP transport.
* **Unauthenticated gateways** use a plain streamable-http connection.

Each framework's MCP client accepts these auth mechanisms natively: - **Strands** `McpClient` accepts any `Transport` — we pass a custom `StreamableHTTPClientTransport` with our signed fetch - **Vercel AI** `@ai-sdk/mcp` accepts `headers`, `authProvider`, and `fetch` options directly on the transport config - **LangGraph** `@langchain/mcp-adapters` accepts `headers`, `authProvider`, and per-call header injection via `beforeToolCall` hooks

**`memory/session.ts`** (when memory is enabled) sets up session persistence using the Strands SDK's native `SessionManager` with S3 storage for deployed environments and local file storage for development.

**`memory/plugin.ts`** (when long-term memory is enabled) configures the `AgentCoreMemoryPlugin` for LTM extraction and injection. More on this in Part 2.

### How Frameworks Differ

The four frameworks produce the same project structure and support the same features. They differ in syntax:

|A	|Strands	|Vercel AI	|LangGraph	|Claude Agent SDK	|
|---	|---	|---	|---	|---	|
|**Create agent**	|`new Agent({ model, tools })`	|`streamText({ model, tools })`	|`createReactAgent({ llm, tools })`	|`query({ prompt, options })`	|
|---	|---	|---	|---	|---	|
|**Define tool**	|`tool({ name, inputSchema, callback })`	|`tool({ description, inputSchema, execute })`	|`tool(fn, { name, schema })`	|`tool(name, desc, schema, handler)` + `createSdkMcpServer()`	|
|**Stream response**	|`agent.stream()`	|`result.textStream`	|`agent.stream({ streamMode })`	|`for await of query()`	|
|**Model (Bedrock)**	|`new BedrockModel()`	|`bedrock('model-id')`	|`new ChatBedrockConverse()`	|Env: `CLAUDE_CODE_USE_BEDROCK=1`	|
|**MCP client**	|`McpClient` (custom transport)	|`@ai-sdk/mcp` (custom fetch)	|`@langchain/mcp-adapters` (headers + hooks)	|Built-in `mcpServers` option	|

Claude Agent SDK is architecturally distinct — it runs the agent loop in a Claude Code subprocess via `query()`, not in-process. It comes with built-in tools (Read, Edit, Bash, Glob, Grep, WebSearch) and configures models via environment variables rather than a `model/load.ts` file. The SDK spawns the Claude Code CLI as a child process, but the `@anthropic-ai/claude-agent-sdk` npm package doesn't include it — the CLI is a separate package (`@anthropic-ai/claude-code`). The template includes both as dependencies, so `npm install` places the `claude` binary at `node_modules/.bin/claude` where the SDK finds it via PATH. No special container or binary installation needed.

### Developing Locally

`agentcore dev` starts a local development server with hot-reload, same as Python. The developer edits `main.ts`, saves, and the server restarts.

### Deploying

`agentcore deploy` works identically to Python. Under the hood:

1. The CLI copies source files to a staging directory
2. Runs `npm install --omit=dev` for production dependencies
3. Zips the source (`.ts` files) + `node_modules/` into an artifact
4. CDK synthesizes CloudFormation with the artifact uploaded to S3
5. AgentCore Runtime receives the zip and executes `main.ts` natively — no compilation step

This mirrors the Python flow where source is zipped with pip dependencies and the runtime executes `main.py` directly.

For container builds, a Dockerfile template is generated that uses `node:22-slim`, installs dependencies, and runs the entrypoint.

### BYO TypeScript Agents

Developers with existing TypeScript agent code can onboard without a template:

```
`agentcore add agent --name MyAgent --type byo --code-location ./my-agent --entrypoint main.ts --language TypeScrip`
```

Requirements: `package.json` present, HTTP server on port 8080 (or `BedrockAgentCoreApp`).
* * *

## Part 2: What We're Building

### CLI

**Enable TypeScript selection.** The TUI language step exists — we remove `disabled: true` from the TypeScript option and remove the "(coming soon)" label.

**Framework filtering.** When TypeScript is selected, the framework list shows Strands, LangGraph, Vercel AI, and Claude Agent SDK. When Python is selected, it shows Strands, LangGraph, GoogleADK, and OpenAI Agents. This requires adding `VercelAI` and `ClaudeAgentSDK` to the `SDKFramework` schema enum and updating the framework-language compatibility matrix.

**New renderers.** Strands and LangGraph already have renderer classes (`StrandsRenderer`, `LangGraphRenderer`) that resolve template paths by language — adding TypeScript templates "just works" for those two. Vercel AI and Claude Agent SDK need new renderer classes (`VercelAIRenderer`, `ClaudeAgentSDKRenderer`) and corresponding entries in the `createRenderer()` factory. These are thin — they extend `BaseRenderer` and set the SDK name.

**Templates.** Four sets of Handlebars template files under `src/assets/typescript/http/{framework}/base/`. Each template uses the same conditionals as the Python templates (`hasMemory`, `hasGateway`, `hasIdentity`, `modelProvider`, `gatewayProviders`, `memoryProviders`, `identityProviders`) so the rendering pipeline is identical.

**Preflight validation.** `agentcore validate` gains TypeScript-specific checks: `package.json` exists, entrypoint `.ts` file exists, valid Node runtime version.

**Schema defaults.** Default Node runtime version (`NODE_20`), default TypeScript entrypoint (`main.ts`), and language-aware branching in the schema mapper that currently hardcodes Python.

### CDK Constructs

**Node bundler.** A new `NodeBundledCodeZipAsset` class alongside the existing `PythonBundledCodeZipAsset`. The `AgentEnvironment` construct branches on runtime version — Node runtimes use the new bundler, Python runtimes use the existing one. The Node bundler copies source, runs `npm install --omit=dev`, zips, and enforces size limits.

**Runtime config.** The entrypoint is passed as-is to the AgentCore Runtime service (`entryPoint: ['main.ts']`). No compilation or transpilation — the runtime handles TypeScript execution natively.

**OTel.** Deferred for Node runtimes. The current Python OTel wrapper (`opentelemetry-instrument`) is Python-specific. TypeScript agents ship with `enableOtel: false` until the Node instrumentation approach is confirmed.

### TypeScript SDK — Memory

This is the largest piece of new AgentCore SDK work. We're building two components in the `bedrock-agentcore` TypeScript SDK.

#### Memory Client

A low-level client for the AgentCore Memory service API — the TypeScript equivalent of the Python SDK's memory client. We build this in `bedrock-agentcore/memory`. It handles:

* **Creating events** — storing conversation messages as memory events
* **Listing events** — retrieving stored events for a session
* **Retrieving LTM** — querying long-term memory records (facts, preferences, summaries) via semantic search

There is an existing draft implementation in PR #108 (`feat/memory-client`) on this repo that we'll rebase, update, and land. This client is a prerequisite for the Memory Plugin.

#### AgentCoreMemoryPlugin (Strands Plugin)

This is the integration layer that connects Strands agents to AgentCore Memory. We build this in `bedrock-agentcore/memory/integrations/strands`. It's implemented as a Strands Plugin — a composable unit that registers hooks on the agent to handle memory operations automatically.

The Python SDK bundles persistence, extraction, and injection into a single `AgentCoreMemorySessionManager`. The TypeScript design decouples these into independent, opt-in capabilities:

**LTM Injection** — retrieves relevant long-term memories (facts, preferences, summaries) and injects them into the agent's context before each invocation. The developer configures which namespaces to query and with what relevance thresholds:

```
`new AgentCoreMemoryPlugin({
  memoryId: 'mem-1',
  actorId: 'user-1',
  sessionId: 'session-1',
  injectContext: {
    '/users/{actorId}/facts': { topK: 5, relevance_score: 0.5 },
    '/users/{actorId}/preferences': { topK: 3, relevance_score: 0.5 },
  },
})
`
```

**LTM Extraction** — stores conversation messages as memory events, which the Memory service then processes for long-term insight extraction. Messages are batched by default to reduce API calls:

```
`new AgentCoreMemoryPlugin({
  memoryId: 'mem-1',
  actorId: 'user-1',
  sessionId: 'session-1',
  storeMessages: { batchSize: 10 },
})
`
```

**Both together** — a developer can enable injection, extraction, or both. This is the key difference from Python's all-or-nothing approach.

Internally, the plugin uses the Strands `MessageAddedEvent` hook to capture messages for extraction, and hooks into the invocation lifecycle for injection. The ordering is careful: extraction (storing messages) happens before injection (retrieving LTM) to avoid feeding extracted insights back into memory events.

**Session persistence is separate.** The plugin does not handle session persistence — that's the Strands SDK's native `SessionManager` with S3 or file storage. This is deliberate: storing agent state as memory events is up to 50x more expensive than S3, and blob events aren't leveraged by LTM extraction today.

**Multi-agent support.** The plugin provides `.withActor(name)` for isolated LTM namespaces per agent, and `.withMetadataProvider(fn)` for shared event streams with per-message metadata. This lets developers choose the right scoping for their multi-agent setup.
* * *

## Delivery

Everything ships together:

* **CLI:** Enable TypeScript, framework filtering, schema updates, new renderers for Vercel AI and Claude Agent SDK, four template sets, preflight validation
* **CDK:** `NodeBundledCodeZipAsset` for TypeScript CodeZip deployments
* **SDK:** Memory Client + `AgentCoreMemoryPlugin` for Strands memory integration
* **Templates:** Strands, Vercel AI, LangGraph, Claude Agent SDK — all with multi-provider, gateway, and (for Strands) memory support

### Dependencies

* **Runtime** **`.ts`** **execution.** Confirmation from the Runtime team on how TypeScript files are executed natively before templates are finalized.

* * *

## Risks

|Risk	|Impact	|Mitigation	|
|---	|---	|---	|
|Runtime `.ts` execution mechanism changes	|Templates need entrypoint adjustment	|Confirm with Runtime team before finalizing templates	|
|---	|---	|---	|
|AgentCoreMemoryPlugin API changes during implementation	|LTM template needs update	|Template tied to SDK publication	|
|`node_modules` zip exceeds size limits	|Deploy failure	|Existing `enforceZipSizeLimit()` + `npm install --omit=dev` |	|



