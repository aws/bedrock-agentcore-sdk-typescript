import { tool } from '@strands-agents/sdk'
import { z } from 'zod'
import type { PlaywrightBrowser } from '../playwright/client.js'

/**
 * Creates a Strands SDK tool for getting text content.
 * Thin wrapper around PlaywrightBrowser.getText()
 *
 * @experimental
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type, @typescript-eslint/explicit-module-boundary-types
export function createGetTextTool(client: PlaywrightBrowser) {
  return tool({
    name: 'getText',
    description: 'Get text content from an element or the entire page',
    inputSchema: z.object({
      selector: z.string().optional().describe('CSS selector for the element (omit for full page text)'),
    }),
    callback: async ({ selector }) => {
      try {
        const params: { selector?: string } = {}
        if (selector !== undefined) params.selector = selector
        const text = await client.getText(params)
        return { success: true, text }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        return { success: false, error: message }
      }
    },
  })
}
