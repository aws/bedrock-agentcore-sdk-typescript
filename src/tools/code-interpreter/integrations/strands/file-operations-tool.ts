/// <reference types="node" />

import { tool } from '@strands-agents/sdk'
import { z } from 'zod'
import type { CodeInterpreter } from '../../client.js'

/**
 * Creates a Strands SDK tool for file operations in CodeInterpreter.
 *
 * @param interpreter - CodeInterpreter instance
 * @returns Strands SDK tool for file operations
 *
 * @experimental
 * @example
 * ```typescript
 * import { createFileOperationsTool } from 'bedrock-agentcore/experimental/code-interpreter/strands'
 * import { CodeInterpreter } from 'bedrock-agentcore/code-interpreter'
 *
 * const interpreter = new CodeInterpreter({ region: 'us-west-2' })
 * const fileOpsTool = createFileOperationsTool(interpreter)
 *
 * // Use with Strands SDK Agent
 * const agent = new Agent({
 *   model: new BedrockModel({ modelId: 'anthropic.claude-sonnet-4-20250514-v1:0' }),
 *   tools: [fileOpsTool]
 * })
 * ```
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type, @typescript-eslint/explicit-module-boundary-types
export function createFileOperationsTool(interpreter: CodeInterpreter) {
  return tool({
    name: 'fileOperations',
    description: `Manage files in the code execution sandbox.
Use this to create notebooks/scripts, store intermediate results, and inspect outputs.
Operations: write (create/update files), read (get file contents), list (show directory contents), remove (delete files).`,
    inputSchema: z.object({
      operation: z.enum(['write', 'read', 'list', 'remove']).describe('File operation to perform'),
      files: z
        .array(
          z.object({
            path: z.string().describe('File path'),
            content: z.string().describe('File content (for write operation)'),
          })
        )
        .optional()
        .describe('Files to write (for write operation)'),
      paths: z.array(z.string()).optional().describe('File paths to read or remove (for read/remove operations)'),
      path: z.string().optional().default('.').describe('Directory path to list (for list operation)'),
    }),
    callback: async ({ operation, files, paths, path }) => {
      switch (operation) {
        case 'write': {
          if (!files || files.length === 0) {
            return 'status: error\nerror: No files specified for write operation'
          }
          const result = await interpreter.writeFiles({ files })
          return result
        }

        case 'read': {
          if (!paths || paths.length === 0) {
            return 'status: error\nerror: No paths specified for read operation'
          }
          const result = await interpreter.readFiles({ paths })
          return result
        }

        case 'list': {
          const result = await interpreter.listFiles({ path })
          return result
        }

        case 'remove': {
          if (!paths || paths.length === 0) {
            return 'status: error\nerror: No paths specified for remove operation'
          }
          const result = await interpreter.removeFiles({ paths })
          return result
        }

        default:
          return 'status: error\nerror: Invalid operation'
      }
    },
  })
}
