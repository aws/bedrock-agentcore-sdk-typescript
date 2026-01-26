<div align="center">
  <a href="https://aws.amazon.com/bedrock/agentcore/">
    <img width="150" height="150" alt="Bedrock AgentCore" src="https://github.com/user-attachments/assets/b8b9456d-c9e2-45e1-ac5b-760f21f1ac18" />
  </a>

  <h1>Bedrock AgentCore SDK for TypeScript</h1>

  <p>Deploy AI agents to AWS with VM-level isolation and zero infrastructure</p>

  <p>
    <a href="https://www.npmjs.com/package/bedrock-agentcore"><img alt="npm version" src="https://img.shields.io/npm/v/bedrock-agentcore"/></a>
    <a href="https://www.typescriptlang.org/"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.5+-blue"/></a>
    <a href="https://nodejs.org/"><img alt="Node.js" src="https://img.shields.io/badge/Node.js-20+-green"/></a>
    <a href="https://github.com/aws/bedrock-agentcore-sdk-typescript/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/badge/License-Apache%202.0-blue"/></a>
  </p>

  <p>
    <a href="https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/what-is-bedrock-agentcore.html">Documentation</a>
    &nbsp;&nbsp;|&nbsp;&nbsp;
    <a href="https://github.com/awslabs/bedrock-agentcore-samples-typescript">Samples</a>
    &nbsp;&nbsp;|&nbsp;&nbsp;
    <a href="https://github.com/aws/bedrock-agentcore-sdk-python">Python SDK</a>
  </p>
</div>

---

## Why AgentCore?

- **Zero infrastructure** — No servers to provision, no containers to manage, no scaling to configure.
- **Session isolation** — Each agent session runs in its own VM. No shared state, no noisy neighbors.
- **Long-lived sessions** — Sessions persist across requests. Your agent maintains context without external storage.
- **Managed tools** — Secure code execution and browser automation, ready to use.
- **Credential management** — Centralized API keys and OAuth tokens, injected at runtime.

Works with [Strands Agents](https://strandsagents.com), [Vercel AI SDK](https://ai-sdk.dev), or any framework.

---

## Quick Start

```bash
npm install bedrock-agentcore @strands-agents/sdk
```

```typescript
import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime'
import { Agent, BedrockModel } from '@strands-agents/sdk'
import { z } from 'zod'

const agent = new Agent({
  model: new BedrockModel({ modelId: 'global.amazon.nova-2-lite-v1:0' }),
})

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    requestSchema: z.object({ prompt: z.string() }),
    process: async function* (request) {
      for await (const event of agent.stream(request.prompt)) {
        if (event.type === 'modelContentBlockDeltaEvent' && event.delta?.type === 'textDelta') {
          yield { event: 'message', data: { text: event.delta.text } }
        }
      }
    },
  },
})

app.run()
```

`BedrockAgentCoreApp` creates an AgentCore Runtime-compliant server—handling request parsing, streaming responses, and session management for seamless deployment.

---

## Tools

Give your agent secure code execution with three lines:

```typescript
import { CodeInterpreterTools } from 'bedrock-agentcore/experimental/code-interpreter/strands'
import { Agent, BedrockModel } from '@strands-agents/sdk'

const codeInterpreter = new CodeInterpreterTools({ region: 'us-east-1' })

const agent = new Agent({
  model: new BedrockModel({ modelId: 'global.amazon.nova-2-lite-v1:0' }),
  tools: codeInterpreter.tools,
})

// Agent can now execute code in a secure sandboxed environment
```

---

## Features

- **Runtime** — Secure, session-isolated compute → [Examples](https://github.com/awslabs/bedrock-agentcore-samples-typescript/tree/main/primitives/runtime)
- **Code Interpreter** — Execute Python/JS/TS in a sandbox → [Examples](https://github.com/awslabs/bedrock-agentcore-samples-typescript/tree/main/primitives/tools/code-interpreter)
- **Browser** — Cloud-based web automation → [Examples](https://github.com/awslabs/bedrock-agentcore-samples-typescript/tree/main/primitives/tools/browser)
- **Identity** — Manage API keys and OAuth tokens → [Examples](https://github.com/awslabs/bedrock-agentcore-samples-typescript/tree/main/primitives/identity)
- **Memory** — Persistent knowledge across sessions (coming soon)
- **Gateway** — Transform APIs into MCP tools (coming soon)
- **Observability** — OpenTelemetry tracing (coming soon)

---

## Installation

```bash
npm install bedrock-agentcore
```


**Prerequisites:** Node.js 20+, [AWS credentials](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html), [AgentCore access](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-regions.html)

---

## Deployment

- [Sample Applications](https://github.com/awslabs/bedrock-agentcore-samples-typescript) — Working examples with deployment templates
- [CloudFormation](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/AWS_BedrockAgentCore.html) — Infrastructure as code
- [AWS CDK](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_bedrockagentcore-readme.html) — Infrastructure as code
- [Deployment Guide](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/getting-started-custom.html) — Step-by-step walkthrough

---

## Resources

- [AgentCore Documentation](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/what-is-bedrock-agentcore.html)
- [Python SDK](https://github.com/aws/bedrock-agentcore-sdk-python)

---

## License

Apache 2.0 — see [LICENSE](LICENSE)

[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)
