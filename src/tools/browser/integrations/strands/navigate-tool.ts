import { tool } from '@strands-agents/sdk'
import { z } from 'zod'
import type { PlaywrightBrowser } from '../playwright/client.js'

/**
 * Creates a Strands SDK tool for browser navigation.
 * Thin wrapper around PlaywrightBrowser.navigate()
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type, @typescript-eslint/explicit-module-boundary-types
export function createNavigateTool(client: PlaywrightBrowser) {
  return tool({
    name: 'navigate',
    description: 'Navigate to a URL in the browser',
    inputSchema: z.object({
      url: z.string().url().describe('URL to navigate to'),
      waitUntil: z
        .enum(['load', 'domcontentloaded', 'networkidle'])
        .optional()
        .describe('When to consider navigation successful'),
      timeout: z.number().positive().optional().describe('Maximum navigation time in milliseconds'),
    }),
    callback: async ({ url, waitUntil, timeout }) => {
      try {
        const params: { url: string; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'; timeout?: number } = {
          url,
        }
        if (waitUntil !== undefined) params.waitUntil = waitUntil
        if (timeout !== undefined) params.timeout = timeout
        await client.navigate(params)
        return { success: true, message: `Navigated to ${url}` }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        return { success: false, error: message }
      }
    },
  })
}
