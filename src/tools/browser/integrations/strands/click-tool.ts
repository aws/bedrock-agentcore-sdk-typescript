import { tool } from '@strands-agents/sdk'
import { z } from 'zod'
import type { PlaywrightBrowser } from '../playwright/client.js'

/**
 * Creates a Strands SDK tool for clicking elements.
 * Thin wrapper around PlaywrightBrowser.click()
 *
 * @experimental
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type, @typescript-eslint/explicit-module-boundary-types
export function createClickTool(client: PlaywrightBrowser) {
  return tool({
    name: 'click',
    description: 'Click an element on the page',
    inputSchema: z.object({
      selector: z.string().describe('CSS selector for the element to click'),
      timeout: z.number().positive().optional().describe('Maximum time in milliseconds'),
    }),
    callback: async ({ selector, timeout }) => {
      try {
        const params: { selector: string; timeout?: number } = { selector }
        if (timeout !== undefined) params.timeout = timeout
        await client.click(params)
        return { success: true, message: `Clicked element: ${selector}` }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        return { success: false, error: message }
      }
    },
  })
}
