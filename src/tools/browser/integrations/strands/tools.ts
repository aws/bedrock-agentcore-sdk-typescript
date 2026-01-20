/**
 * Unified BrowserTools for Strands SDK
 *
 * Provides browser automation tools and session management in one class.
 * Thin wrapper around PlaywrightBrowser - all logic lives in the Playwright integration.
 */

import { PlaywrightBrowser } from '../playwright/client.js'
import type { BrowserClientConfig, SessionInfo, StartSessionParams } from '../../types.js'
import { createNavigateTool } from './navigate-tool.js'
import { createClickTool } from './click-tool.js'
import { createTypeTool } from './type-tool.js'
import { createGetTextTool } from './get-text-tool.js'
import { createGetHtmlTool } from './get-html-tool.js'
import { createScreenshotTool } from './screenshot-tool.js'
import { createEvaluateTool } from './evaluate-tool.js'

/**
 * BrowserTools - All-in-one browser automation for Strands SDK
 *
 * Provides browser automation tools and session management.
 * All browser logic is in PlaywrightBrowser - this is just a thin wrapper.
 *
 * @example
 * ```typescript
 * import { BrowserTools } from 'bedrock-agentcore/experimental/browser/strands'
 * import { Agent, BedrockModel } from '@strands-agents/sdk'
 *
 * // Create tools instance
 * const browser = new BrowserTools({ region: 'us-west-2' })
 *
 * // Start session (optional - automatically started on first use)
 * await browser.startSession()
 *
 * // Create agent with browser tools
 * const agent = new Agent({
 *   model: new BedrockModel({ modelId: 'anthropic.claude-sonnet-4-20250514-v1:0' }),
 *   tools: browser.tools,
 * })
 *
 * // Or use client directly
 * await browser.getClient().navigate({ url: 'https://example.com' })
 *
 * // Clean up when done
 * await browser.stopSession()
 * ```
 */
export class BrowserTools {
  private client: PlaywrightBrowser

  /**
   * Tool for navigating to URLs
   */
  public readonly navigate: ReturnType<typeof createNavigateTool>

  /**
   * Tool for clicking elements
   */
  public readonly click: ReturnType<typeof createClickTool>

  /**
   * Tool for typing text
   */
  public readonly type: ReturnType<typeof createTypeTool>

  /**
   * Tool for getting text content
   */
  public readonly getText: ReturnType<typeof createGetTextTool>

  /**
   * Tool for getting HTML
   */
  public readonly getHtml: ReturnType<typeof createGetHtmlTool>

  /**
   * Tool for taking screenshots
   */
  public readonly screenshot: ReturnType<typeof createScreenshotTool>

  /**
   * Tool for evaluating JavaScript
   */
  public readonly evaluate: ReturnType<typeof createEvaluateTool>

  /**
   * All tools in an array for easy spreading into agent config
   *
   * @example
   * ```typescript
   * const agent = new Agent({
   *   tools: browser.tools, // spreads all browser tools
   * })
   *
   * // Or combine with other tools
   * const agent = new Agent({
   *   tools: [...codeInterpreter.tools, ...browser.tools],
   * })
   * ```
   */
  public readonly tools: Array<
    | ReturnType<typeof createNavigateTool>
    | ReturnType<typeof createClickTool>
    | ReturnType<typeof createTypeTool>
    | ReturnType<typeof createGetTextTool>
    | ReturnType<typeof createGetHtmlTool>
    | ReturnType<typeof createScreenshotTool>
    | ReturnType<typeof createEvaluateTool>
  >

  constructor(config: BrowserClientConfig = {}) {
    this.client = new PlaywrightBrowser(config)

    // Create all tools - each is a thin wrapper around client methods
    this.navigate = createNavigateTool(this.client)
    this.click = createClickTool(this.client)
    this.type = createTypeTool(this.client)
    this.getText = createGetTextTool(this.client)
    this.getHtml = createGetHtmlTool(this.client)
    this.screenshot = createScreenshotTool(this.client)
    this.evaluate = createEvaluateTool(this.client)

    // Create tools array for Strands SDK (uses arrays, not objects)
    this.tools = [this.navigate, this.click, this.type, this.getText, this.getHtml, this.screenshot, this.evaluate]
  }

  /**
   * Start a browser session
   *
   * Sessions are automatically started on first tool use, but you can
   * call this explicitly to start the session upfront.
   *
   * @param sessionName - Optional session name for AWS
   * @param timeout - Optional session timeout in seconds (default: 3600, max: 28800)
   * @returns Session information
   */
  async startSession(sessionName?: string, timeout?: number): Promise<SessionInfo> {
    const params: StartSessionParams = {}
    if (sessionName !== undefined) params.sessionName = sessionName
    if (timeout !== undefined) params.timeout = timeout
    return this.client.startSession(Object.keys(params).length > 0 ? params : undefined)
  }

  /**
   * Stop the current browser session
   *
   * Call this when you're done using the tools to clean up resources.
   */
  async stopSession(): Promise<void> {
    await this.client.stopSession()
  }

  /**
   * Get the underlying PlaywrightBrowser
   *
   * Provides direct access to the client for advanced use cases.
   *
   * @returns The PlaywrightBrowser instance
   */
  getClient(): PlaywrightBrowser {
    return this.client
  }
}
