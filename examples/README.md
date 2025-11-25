# Examples

This directory contains runnable examples demonstrating how to use the AWS Bedrock AgentCore SDK with the Vercel AI SDK.

## Prerequisites

1. **AWS Credentials**: Configure via environment or AWS config

```bash
   export AWS_REGION=us-west-2
   export AWS_ACCESS_KEY_ID=your-key
   export AWS_SECRET_ACCESS_KEY=your-secret
```

2. **AWS Bedrock Access**: Enable Claude Sonnet 4 in your AWS Bedrock console

3. **Build the SDK** (from repository root):

```bash
   npm install
   npm run build
```

## Available Examples

### Code Interpreter Examples

| Example                          | Description                           | Run Command                                       |
| -------------------------------- | ------------------------------------- | ------------------------------------------------- |
| `agent-with-code-interpreter.ts` | Basic, file ops, and complex analysis | `npx tsx examples/agent-with-code-interpreter.ts` |

**Features demonstrated:**

- ToolLoopAgent with automatic tool execution
- Python code execution
- File read/write operations
- Multi-step data analysis

### Browser Examples

| Example                 | Description                          | Run Command                              |
| ----------------------- | ------------------------------------ | ---------------------------------------- |
| `agent-with-browser.ts` | Web scraping, interaction, streaming | `npx tsx examples/agent-with-browser.ts` |

**Features demonstrated:**

- Web navigation
- Text and HTML extraction
- Interactive elements (click, type)
- Streaming output while browsing

### Combined Tools Examples

| Example                       | Description                         | Run Command                                    |
| ----------------------------- | ----------------------------------- | ---------------------------------------------- |
| `agent-research-assistant.ts` | Full research agent with both tools | `npx tsx examples/agent-research-assistant.ts` |

**Features demonstrated:**

- Browser + CodeInterpreter together
- Web research with data analysis
- Multi-step data pipelines
- Streaming research reports

### Streaming Examples

| Example                 | Description                | Run Command                              |
| ----------------------- | -------------------------- | ---------------------------------------- |
| `streaming-examples.ts` | Various streaming patterns | `npx tsx examples/streaming-examples.ts` |

**Features demonstrated:**

- Basic text streaming
- Progress tracking
- Browser streaming with events
- Combined tools streaming

### Deep Research UI (Next.js App)

```bash
cd examples/deep-research-ui
npm install
npm run dev
```

**Features demonstrated:**

- Full Next.js application
- Streaming UI with useChat
- Tool execution visibility
- Production-ready patterns

## Running Specific Sub-Examples

Most example files contain multiple demonstrations. You can run a specific one:

```bash
# Run all examples in a file
npx tsx examples/agent-with-code-interpreter.ts

# Run a specific example by name
npx tsx examples/agent-with-code-interpreter.ts basic
npx tsx examples/agent-with-code-interpreter.ts file
npx tsx examples/agent-with-code-interpreter.ts complex
```

## Troubleshooting

### "Region is required" Error

```bash
export AWS_REGION=us-west-2
```

### "Access Denied" or "Model not found"

1. Enable Claude Sonnet 4 in AWS Bedrock console
2. Verify IAM permissions for:
   - `bedrock:InvokeModel`
   - `bedrock-agentcore:*`

### Import Errors

Make sure you've built the SDK:

```bash
npm run build
```

## Related Documentation

- [Vercel AI SDK v6 Documentation](https://ai-sdk.dev/docs)
- [AWS Bedrock AgentCore Documentation](https://docs.aws.amazon.com/bedrock-agentcore/)
- [SDK README](../README.md)
