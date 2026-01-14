/// <reference types="node" />

import { tool } from '@strands-agents/sdk'
import { z } from 'zod'
import type { CodeInterpreter } from '../../client.js'

/**
 * Creates a Strands SDK tool for executing code in CodeInterpreter.
 *
 * @param interpreter - CodeInterpreter instance
 * @returns Strands SDK tool for code execution
 *
 * @example
 * ```typescript
 * import { createExecuteCodeTool } from 'bedrock-agentcore/code-interpreter/strands'
 * import { CodeInterpreter } from 'bedrock-agentcore/code-interpreter'
 *
 * const interpreter = new CodeInterpreter({ region: 'us-west-2' })
 * const executeCodeTool = createExecuteCodeTool(interpreter)
 *
 * // Use with Strands SDK Agent
 * const agent = new Agent({
 *   model: new BedrockModel({ modelId: 'anthropic.claude-sonnet-4-20250514-v1:0' }),
 *   tools: [executeCodeTool]
 * })
 * ```
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type, @typescript-eslint/explicit-module-boundary-types
export function createExecuteCodeTool(interpreter: CodeInterpreter) {
  return tool({
    name: 'executeCode',
    description: `Execute code in a secure sandbox environment.
Use this to perform calculations, data analysis, create visualizations, or run any code.
The environment persists across executions within the same session.
Supports Python, JavaScript, and TypeScript.`,
    inputSchema: z.object({
      code: z.string().describe('The code to execute. Can use imports and access files.'),
      language: z
        .enum(['python', 'javascript', 'typescript'])
        .default('python')
        .describe('Programming language to use (default: python)'),
    }),
    callback: async ({ code, language }) => {
      const result = await interpreter.executeCode({ code, language })

      return result
    },
  })
}
