/**
 * Unified CodeInterpreter Tools for Vercel AI SDK
 *
 * Provides all three CodeInterpreter tools and session management in one class.
 */

import { CodeInterpreter } from '../../client.js'
import type { CodeInterpreterConfig, SessionInfo, StartSessionParams } from '../../types.js'
import { createExecuteCodeTool } from './execute-code-tool.js'
import { createFileOperationsTool } from './file-operations-tool.js'
import { createExecuteCommandTool } from './execute-command-tool.js'

/**
 * CodeInterpreterTools - All-in-one CodeInterpreter integration for Vercel AI SDK
 *
 * Provides three ready-to-use tools and session management in a single class.
 *
 * @example
 * ```typescript
 * import { CodeInterpreterTools } from 'bedrock-agentcore/code-interpreter/vercel-ai'
 * import { ToolLoopAgent } from 'ai'
 * import { bedrock } from '@ai-sdk/amazon-bedrock'
 *
 * // Create tools instance
 * const codeInterpreter = new CodeInterpreterTools({ region: 'us-west-2' })
 *
 * // Start session (optional - automatically started on first use)
 * await codeInterpreter.startSession()
 *
 * // Create agent with all three tools
 * const agent = new ToolLoopAgent({
 *   model: bedrock('global.anthropic.claude-sonnet-4-20250514-v1:0'),
 *   tools: codeInterpreter.tools,
 * })
 *
 * // Clean up when done
 * await codeInterpreter.stopSession()
 * ```
 */
export class CodeInterpreterTools {
  private interpreter: CodeInterpreter

  /**
   * Tool for executing Python, JavaScript, or TypeScript code
   */
  public readonly executeCode: ReturnType<typeof createExecuteCodeTool>

  /**
   * Tool for file operations (read, write, list, remove)
   */
  public readonly fileOperations: ReturnType<typeof createFileOperationsTool>

  /**
   * Tool for executing shell commands
   */
  public readonly executeCommand: ReturnType<typeof createExecuteCommandTool>

  /**
   * All three tools in an object for easy spreading into agent config
   *
   * @example
   * ```typescript
   * const agent = new ToolLoopAgent({
   *   tools: codeInterpreter.tools, // spreads all three tools
   * })
   * ```
   */
  public readonly tools: {
    executeCode: ReturnType<typeof createExecuteCodeTool>
    fileOperations: ReturnType<typeof createFileOperationsTool>
    executeCommand: ReturnType<typeof createExecuteCommandTool>
  }

  constructor(config: CodeInterpreterConfig = {}) {
    this.interpreter = new CodeInterpreter(config)

    // Create all three tools
    this.executeCode = createExecuteCodeTool(this.interpreter)
    this.fileOperations = createFileOperationsTool(this.interpreter)
    this.executeCommand = createExecuteCommandTool(this.interpreter)

    // Create tools object for easy spreading
    this.tools = {
      executeCode: this.executeCode,
      fileOperations: this.fileOperations,
      executeCommand: this.executeCommand,
    }
  }

  /**
   * Start a CodeInterpreter session
   *
   * Sessions are automatically started on first tool use, but you can
   * call this explicitly to start the session upfront.
   *
   * @param sessionName - Optional session name for AWS
   * @param timeout - Optional session timeout in seconds (default: 900, max: 28800)
   * @returns Session information
   */
  async startSession(sessionName?: string, timeout?: number): Promise<SessionInfo> {
    const params: StartSessionParams = {}
    if (sessionName !== undefined) params.sessionName = sessionName
    if (timeout !== undefined) params.timeout = timeout
    return this.interpreter.startSession(Object.keys(params).length > 0 ? params : undefined)
  }

  /**
   * Stop the current CodeInterpreter session
   *
   * Call this when you're done using the tools to clean up resources.
   */
  async stopSession(): Promise<void> {
    await this.interpreter.stopSession()
  }

  /**
   * Get the underlying CodeInterpreter client
   *
   * Provides direct access to the client for advanced use cases.
   *
   * @returns The CodeInterpreter client instance
   */
  getClient(): CodeInterpreter {
    return this.interpreter
  }
}
