/**
 * Vercel AI SDK integrations for AWS Bedrock AgentCore CodeInterpreter.
 *
 * This module provides a unified CodeInterpreterTools class that simplifies
 * integration with Vercel AI SDK v6 ToolLoopAgent.
 *
 * @example
 * ```typescript
 * import { ToolLoopAgent } from 'ai'
 * import { bedrock } from '@ai-sdk/amazon-bedrock'
 * import { CodeInterpreterTools } from 'bedrock-agentcore/code-interpreter/vercel-ai'
 *
 * const codeInterpreter = new CodeInterpreterTools({ region: 'us-west-2' })
 *
 * const agent = new ToolLoopAgent({
 *   model: bedrock('global.anthropic.claude-sonnet-4-20250514-v1:0'),
 *   instructions: 'You are a helpful coding assistant...',
 *   tools: codeInterpreter.tools,
 * })
 *
 * // Clean up when done
 * await codeInterpreter.stopSession()
 * ```
 */

export { CodeInterpreterTools } from './tools.js'
