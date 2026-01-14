import { tool } from '@strands-agents/sdk'
import { z } from 'zod'
import type { PlaywrightBrowser } from '../playwright/client.js'

/**
 * Creates a Strands SDK tool for getting HTML content.
 * Thin wrapper around PlaywrightBrowser.getHtml()
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type, @typescript-eslint/explicit-module-boundary-types
export function createGetHtmlTool(client: PlaywrightBrowser) {
  return tool({
    name: 'getHtml',
    description: 'Get HTML content from an element or the entire page',
    inputSchema: z.object({
      selector: z.string().optional().describe('CSS selector for the element (omit for full page HTML)'),
    }),
    callback: async ({ selector }) => {
      try {
        const params: { selector?: string } = {}
        if (selector !== undefined) params.selector = selector
        const html = await client.getHtml(params)
        return { success: true, html }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        return { success: false, error: message }
      }
    },
  })
}
