import { tool } from '@strands-agents/sdk'
import { z } from 'zod'
import type { PlaywrightBrowser } from '../playwright/client.js'

/**
 * Creates a Strands SDK tool for typing text.
 * Thin wrapper around PlaywrightBrowser.type()
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type, @typescript-eslint/explicit-module-boundary-types
export function createTypeTool(client: PlaywrightBrowser) {
  return tool({
    name: 'type',
    description: 'Type text into an input element',
    inputSchema: z.object({
      selector: z.string().describe('CSS selector for the input element'),
      text: z.string().describe('Text to type'),
      delay: z.number().positive().optional().describe('Time to wait between key presses in milliseconds'),
      timeout: z.number().positive().optional().describe('Maximum time in milliseconds'),
    }),
    callback: async ({ selector, text, delay, timeout }) => {
      try {
        const params: { selector: string; text: string; delay?: number; timeout?: number } = { selector, text }
        if (delay !== undefined) params.delay = delay
        if (timeout !== undefined) params.timeout = timeout
        await client.type(params)
        return { success: true, message: `Typed text into ${selector}` }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        return { success: false, error: message }
      }
    },
  })
}
