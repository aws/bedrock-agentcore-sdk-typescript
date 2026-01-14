/**
 * Strands SDK Browser Tool Integration
 *
 * This module provides Strands SDK integration for the AWS Bedrock AgentCore Browser service.
 * It follows the three-layer architecture:
 * - User Application Layer (Strands SDK)
 * - Integration Layer (this module - thin wrappers)
 * - Base Client Layer (BrowserClient - all browser logic)
 * - AWS SDK Layer (\@aws-sdk/client-bedrock-agentcore)
 */

export { BrowserTools } from './tools.js'
export { createNavigateTool } from './navigate-tool.js'
export { createClickTool } from './click-tool.js'
export { createTypeTool } from './type-tool.js'
export { createGetTextTool } from './get-text-tool.js'
export { createGetHtmlTool } from './get-html-tool.js'
export { createScreenshotTool } from './screenshot-tool.js'
export { createEvaluateTool } from './evaluate-tool.js'
