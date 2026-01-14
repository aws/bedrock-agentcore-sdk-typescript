/**
 * Strands SDK integrations for AWS Bedrock AgentCore CodeInterpreter.
 *
 * This module provides a unified CodeInterpreterTools class that simplifies
 * integration with Strands SDK Agent.
 *
 * @example
 * ```typescript
 * import { Agent, BedrockModel } from '@strands-agents/sdk'
 * import { CodeInterpreterTools } from 'bedrock-agentcore/code-interpreter/strands'
 *
 * const codeInterpreter = new CodeInterpreterTools({ region: 'us-west-2' })
 *
 * const agent = new Agent({
 *   model: new BedrockModel({ modelId: 'anthropic.claude-sonnet-4-20250514-v1:0' }),
 *   instructions: 'You are a helpful coding assistant...',
 *   tools: codeInterpreter.tools,
 * })
 *
 * // Clean up when done
 * await codeInterpreter.stopSession()
 * ```
 */

export { CodeInterpreterTools } from './tools.js'
export { createExecuteCodeTool } from './execute-code-tool.js'
export { createExecuteCommandTool } from './execute-command-tool.js'
export { createFileOperationsTool } from './file-operations-tool.js'
