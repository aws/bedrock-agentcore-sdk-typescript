/// <reference types="node" />

import { tool } from 'ai'
import { z } from 'zod'
import type { CodeInterpreter } from '../../client.js'

/**
 * Creates a Vercel AI SDK tool for executing shell commands in CodeInterpreter.
 *
 * @param interpreter - CodeInterpreter instance
 * @returns Vercel AI SDK tool for command execution
 *
 * @example
 * ```typescript
 * import { createExecuteCommandTool } from 'bedrock-agentcore/code-interpreter/vercel-ai'
 * import { CodeInterpreter } from 'bedrock-agentcore/code-interpreter'
 *
 * const interpreter = new CodeInterpreter({ region: 'us-west-2' })
 * const executeCommandTool = createExecuteCommandTool(interpreter)
 *
 * // Use with Vercel AI SDK Agent
 * const agent = new ToolLoopAgent({
 *   model: bedrock('global.anthropic.claude-sonnet-4-20250514-v1:0'),
 *   tools: { executeCommand: executeCommandTool }
 * })
 * ```
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type, @typescript-eslint/explicit-module-boundary-types
export function createExecuteCommandTool(interpreter: CodeInterpreter) {
  return tool({
    description: `Execute shell commands in the sandbox environment.
Use this to run system commands, install packages, manipulate files with Unix tools, etc.
The environment persists across executions within the same session.`,
    inputSchema: z.object({
      command: z.string().describe('The shell command to execute'),
    }),
    execute: async ({ command }) => {
      'use step'

      const result = await interpreter.executeCommand({ command })

      return result
    },
  })
}
