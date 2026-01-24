import { tool } from '@strands-agents/sdk'
import { z } from 'zod'
import type { PlaywrightBrowser } from '../playwright/client.js'

/**
 * Creates a Strands SDK tool for evaluating JavaScript.
 * Thin wrapper around PlaywrightBrowser.evaluate()
 *
 * @experimental
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type, @typescript-eslint/explicit-module-boundary-types
export function createEvaluateTool(client: PlaywrightBrowser) {
  return tool({
    name: 'evaluate',
    description: 'Evaluate JavaScript code in the page context',
    inputSchema: z.object({
      script: z.string().describe('JavaScript code to execute'),
      args: z.array(z.any()).optional().describe('Arguments to pass to the script'),
    }),
    callback: async ({ script, args }) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const params: { script: string; args?: any[] } = { script }
        if (args !== undefined) params.args = args
        const result = await client.evaluate(params)
        return { success: true, result }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        return { success: false, error: message }
      }
    },
  })
}
