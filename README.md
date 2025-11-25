<div align="center">
  <div>
    <a href="https://aws.amazon.com/bedrock/agentcore/">
      <img width="150" height="150" alt="image" src="https://github.com/user-attachments/assets/b8b9456d-c9e2-45e1-ac5b-760f21f1ac18" />
   </a>
  </div>

  <h1>
    Bedrock AgentCore SDK
  </h1>

  <h2>
    Deploy your local AI agent to Bedrock AgentCore with zero infrastructure
  </h2>

  <div align="center">
    <a href="https://github.com/aws/bedrock-agentcore-sdk-typescript/graphs/commit-activity"><img alt="GitHub commit activity" src="https://img.shields.io/github/commit-activity/m/aws/bedrock-agentcore-sdk-typescript"/></a>
    <a href="https://github.com/aws/bedrock-agentcore-sdk-typescript/issues"><img alt="GitHub open issues" src="https://img.shields.io/github/issues/aws/bedrock-agentcore-sdk-typescript"/></a>
    <a href="https://github.com/aws/bedrock-agentcore-sdk-typescript/pulls"><img alt="GitHub open pull requests" src="https://img.shields.io/github/issues-pr/aws/bedrock-agentcore-sdk-typescript"/></a>
    <a href="https://github.com/aws/bedrock-agentcore-sdk-typescript/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/aws/bedrock-agentcore-sdk-typescript"/></a>
    <a href="https://www.npmjs.com/package/bedrock-agentcore"><img alt="npm version" src="https://img.shields.io/npm/v/bedrock-agentcore"/></a>
    <a href="https://nodejs.org"><img alt="Node.js versions" src="https://img.shields.io/node/v/bedrock-agentcore"/></a>
  </div>

  <p>
  <a href="https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/what-is-bedrock-agentcore.html">Documentation</a>
    ◆ <a href="https://github.com/awslabs/amazon-bedrock-agentcore-samples">Samples</a>
    ◆ <a href="https://discord.gg/bedrockagentcore-preview">Discord</a>
    ◆ <a href="https://boto3.amazonaws.com/v1/documentation/api/latest/reference/services/bedrock-agentcore-control.html">AWS Boto3 SDK</a>
    ◆ <a href="https://github.com/aws/bedrock-agentcore-sdk-python">Python SDK</a>
    ◆ <a href="https://github.com/aws/bedrock-agentcore-sdk-typescript">TypeScript SDK</a>
    ◆ <a href="https://github.com/aws/bedrock-agentcore-starter-toolkit">Starter Toolkit</a>

  </p>
</div>

## Overview
Amazon Bedrock AgentCore enables you to deploy and operate highly effective agents securely, at scale using any framework and model. With Amazon Bedrock AgentCore, developers can accelerate AI agents into production with the scale, reliability, and security, critical to real-world deployment. AgentCore provides tools and capabilities to make agents more effective and capable, purpose-built infrastructure to securely scale agents, and controls to operate trustworthy agents. Amazon Bedrock AgentCore services are composable and work with popular open-source frameworks and any model, so you don’t have to choose between open-source flexibility and enterprise-grade security and reliability.

**What you get with Bedrock AgentCore:**
- ✅ **Keep your agent logic** - Works with Strands, LangGraph, CrewAI, Autogen, custom frameworks
- ✅ **Zero infrastructure management** - No servers, containers, or scaling concerns
- ✅ **Enterprise-grade platform** - Built-in auth, memory, observability, security
- ✅ **Production-ready deployment** - Reliable, scalable, compliant hosting

## Amazon Bedrock AgentCore services
- 🚀 **Runtime** - Secure and session isolated compute: **[Runtime Quick Start](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-toolkit.html)**
- 🧠 **Memory** - Persistent knowledge across sessions: **[Memory Quick Start](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-get-started.html)**
- 🔗 **Gateway** - Transform APIs into MCP tools: **[Gateway Quick Start](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-quick-start.html)**
- 💻 **Code Interpreter** - Secure sandboxed execution: **[Code Interpreter Quick Start](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-getting-started.html)**
- 🌐 **Browser** - Cloud-based web automation: **[Browser Quick Start](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/browser-onboarding.html)**
- 📊 **Observability** - OpenTelemetry tracing: **[Observability Quick Start](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-get-started.html)**
- 🔐 **Identity** - AWS & third-party auth: **[Identity Quick Start](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/identity-getting-started-cognito.html)**

## ⚠️ TypeScript SDK Scope

This SDK currently provides Code Interpreter and Browser tools. Additional service integrations are on the roadmap.

## AgentCore Tools

### 💻 Code Interpreter
Execute Python, JavaScript, or TypeScript in a secure AWS-managed sandbox:

```typescript
// Core client (framework-agnostic)
import { CodeInterpreterClient } from 'bedrock-agentcore/code-interpreter'
// Methods: startSession, stopSession, executeCode, writeFiles, readFiles, 
// listFiles, deleteFiles, executeCommand
```

### 🌐 Browser
Automate web browsing with cloud-based browser automation (compatible with Playwright, Puppeteer, and other browser automation SDKs):

```typescript
// Playwright client (framework-agnostic)
import { PlaywrightBrowser } from 'bedrock-agentcore/browser/playwright'
// Methods: startSession, stopSession, navigate, click, fill, type, getText, 
// getHtml, screenshot, evaluate, waitForSelector, back, forward
```

## AgentCore Tools with Vercel AI SDK

Integrate Code Interpreter and Browser capabilities into your AI agents using the Vercel AI SDK.

### Installation

```bash
# Install the SDK
npm install bedrock-agentcore

# Install AI SDK v6 (required), use any model provider
npm install ai@beta @ai-sdk/amazon-bedrock@beta

# Install Playwright (optional, only for Browser tools)
npm install playwright
```

**Prerequisites:**
- Node.js >= 20.0.0
- [AWS credentials](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) with Bedrock AgentCore access
- Access to any large language model like models available in AWS Bedrock


### Integration

```typescript
import { bedrock } from '@ai-sdk/amazon-bedrock'
import { ToolLoopAgent } from 'ai'
import { CodeInterpreterTools } from 'bedrock-agentcore/code-interpreter/vercel-ai'
import { BrowserTools } from 'bedrock-agentcore/browser/vercel-ai'

const codeInterpreter = new CodeInterpreterTools()
const browser = new BrowserTools()

const agent = new ToolLoopAgent({
  model: bedrock('global.anthropic.claude-sonnet-4-20250514-v1:0'),
  tools: {
    ...codeInterpreter.tools,
    ...browser.tools,
  },
})

// Invoke the agent with any prompt
const result = await agent.run({
  prompt: 'Visit news.ycombinator.com, scrape the top 5 stories, and analyze sentiment',
})

console.log(result.text)
```

> **Note:** If deploying to Vercel, use [Vercel OIDC](https://vercel.com/docs/oidc/aws) for secure AWS credentials. 

## Try Examples

Run the standalone example:
```bash
npx tsx examples/agent-with-code-interpreter.ts
```

Or try the Next.js app with streaming UI:
```bash
cd examples/deep-research-ui && npm install && npm run dev
```

## 🏗️ Deployment

See [AWS setup guide](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/getting-started-custom.html) for getting started with agentcore.

**Production:** [AWS CDK](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_bedrockagentcore-readme.html).


## 📝 License & Contributing

- **License:** Apache 2.0 - see [LICENSE](LICENSE)
- **Contributing:** See [CONTRIBUTING.md](CONTRIBUTING.md)
- **Security:** See [SECURITY.md](SECURITY.md)