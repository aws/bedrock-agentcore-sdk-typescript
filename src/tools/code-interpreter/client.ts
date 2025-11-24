import {
  BedrockAgentCoreClient,
  StartCodeInterpreterSessionCommand,
  StopCodeInterpreterSessionCommand,
  InvokeCodeInterpreterCommand,
  GetCodeInterpreterSessionCommand,
  ListCodeInterpreterSessionsCommand,
} from '@aws-sdk/client-bedrock-agentcore'
import type { AwsCredentialIdentityProvider } from '@aws-sdk/types'
import type {
  CodeInterpreterConfig,
  StartSessionParams,
  SessionInfo,
  ExecuteCodeParams,
  ExecuteCommandParams,
  ReadFilesParams,
  WriteFilesParams,
  ListFilesParams,
  RemoveFilesParams,
  GetSessionParams,
  GetSessionResponse,
  ListSessionsParams,
  ListSessionsResponse,
  SessionSummary,
} from './types.js'
import { DEFAULT_IDENTIFIER, DEFAULT_SESSION_NAME, DEFAULT_TIMEOUT, DEFAULT_REGION } from './types.js'

/**
 * Client for AWS Bedrock Code Interpreter.
 *
 * Provides functionality to execute Python, JavaScript, and TypeScript code
 * in isolated sandbox environments with file system access and shell commands.
 *
 * Each CodeInterpreter instance manages a single session. Sessions are automatically
 * created on first use and can be explicitly managed with startSession/stopSession.
 *
 * @example
 * ```typescript
 * const interpreter = new CodeInterpreter({ region: 'us-east-1' })
 *
 * // Execute code (auto-creates session)
 * await interpreter.executeCode({ code: 'print("Hello")' })
 *
 * // Explicitly manage session lifecycle
 * await interpreter.startSession({ sessionName: 'my-session' })
 * await interpreter.executeCode({ code: 'x = 1' })
 * await interpreter.stopSession()
 * ```
 */
export class CodeInterpreter {
  readonly region: string
  readonly identifier: string

  private _client: BedrockAgentCoreClient
  private _session: SessionInfo | null = null
  private _credentialsProvider: AwsCredentialIdentityProvider | undefined = undefined

  /**
   * Creates a new CodeInterpreter instance.
   *
   * @param config - Configuration options
   */
  constructor(config: CodeInterpreterConfig) {
    this.region = config.region ?? process.env.AWS_REGION ?? DEFAULT_REGION
    this.identifier = config.identifier ?? DEFAULT_IDENTIFIER
    this._credentialsProvider = config.credentialsProvider

    this._client = new BedrockAgentCoreClient({
      region: this.region,
      ...(this._credentialsProvider && { credentials: this._credentialsProvider }),
      ...config.clientConfig,
    })
  }

  // ===========================
  // Session Management
  // ===========================

  /**
   * Start a new code interpreter session.
   *
   * @param params - Session configuration
   * @returns Session information including AWS-assigned session ID
   *
   * @example
   * ```typescript
   * const session = await interpreter.startSession({
   *   sessionName: 'data-analysis',
   *   description: 'Processing customer data',
   *   timeout: 1800
   * })
   * ```
   */
  async startSession(params?: StartSessionParams): Promise<SessionInfo> {
    if (this._session) {
      throw new Error('Session already active. Call stopSession() first.')
    }

    const sessionName = params?.sessionName ?? DEFAULT_SESSION_NAME

    // Call AWS SDK to start the session
    const command = new StartCodeInterpreterSessionCommand({
      codeInterpreterIdentifier: this.identifier,
      name: sessionName,
      sessionTimeoutSeconds: params?.timeout ?? DEFAULT_TIMEOUT,
    })

    const response = await this._client.send(command)

    const sessionInfo: SessionInfo = {
      sessionName,
      sessionId: response.sessionId!,
      createdAt: response.createdAt!,
      ...(params?.description !== undefined && { description: params.description }),
    }

    this._session = sessionInfo
    return sessionInfo
  }

  /**
   * Stop the active code interpreter session.
   * Gracefully handles non-existent sessions without throwing errors.
   *
   * @example
   * ```typescript
   * await interpreter.stopSession()
   * ```
   */
  async stopSession(): Promise<void> {
    // Gracefully return if session doesn't exist
    if (!this._session) {
      return
    }

    // Call AWS SDK to stop the session
    const command = new StopCodeInterpreterSessionCommand({
      codeInterpreterIdentifier: this.identifier,
      sessionId: this._session.sessionId,
    })

    await this._client.send(command)

    this._session = null
  }

  /**
   * Get detailed information about a code interpreter session.
   *
   * @param params - Optional parameters specifying which session to query
   * @returns Detailed session information
   *
   * @example
   * ```typescript
   * // Get current active session details
   * const sessionInfo = await interpreter.getSession()
   * console.log(`Session status: ${sessionInfo.status}`)
   *
   * // Get details for a specific session
   * const sessionInfo = await interpreter.getSession({
   *   sessionId: 'specific-session-id'
   * })
   * ```
   */
  async getSession(params?: GetSessionParams): Promise<GetSessionResponse> {
    const interpreterId = params?.interpreterId ?? this.identifier
    const sessionId = params?.sessionId ?? this._session?.sessionId

    if (!interpreterId || !sessionId) {
      throw new Error(
        'Interpreter ID and Session ID must be provided or available from current session. ' +
          'Start a session first or provide explicit IDs.'
      )
    }

    const command = new GetCodeInterpreterSessionCommand({
      codeInterpreterIdentifier: interpreterId,
      sessionId,
    })

    const response = await this._client.send(command)

    return {
      sessionId: response.sessionId!,
      codeInterpreterIdentifier: response.codeInterpreterIdentifier!,
      name: response.name!,
      status: response.status ?? 'UNKNOWN',
      createdAt: response.createdAt!,
      lastUpdatedAt: (response as any).lastUpdatedAt ?? response.createdAt!,
      sessionTimeoutSeconds: response.sessionTimeoutSeconds!,
    }
  }

  /**
   * List code interpreter sessions for this interpreter.
   *
   * @param params - Optional filtering and pagination parameters
   * @returns List of session summaries with optional pagination token
   *
   * @example
   * ```typescript
   * // List all active sessions
   * const response = await interpreter.listSessions({ status: 'READY' })
   * for (const session of response.items) {
   *   console.log(`Session ${session.sessionId}: ${session.status}`)
   * }
   *
   * // Paginate through results
   * let response = await interpreter.listSessions({ maxResults: 10 })
   * while (response.nextToken) {
   *   response = await interpreter.listSessions({
   *     maxResults: 10,
   *     nextToken: response.nextToken
   *   })
   * }
   * ```
   */
  async listSessions(params?: ListSessionsParams): Promise<ListSessionsResponse> {
    const interpreterId = params?.interpreterId ?? this.identifier

    if (!interpreterId) {
      throw new Error('Interpreter ID must be provided or available from configuration')
    }

    const command = new ListCodeInterpreterSessionsCommand({
      codeInterpreterIdentifier: interpreterId,
      ...(params?.status && { status: params.status as any }),
      ...(params?.maxResults && { maxResults: params.maxResults }),
      ...(params?.nextToken && { nextToken: params.nextToken }),
    })

    const response = await this._client.send(command)

    const items: SessionSummary[] =
      response.items?.map((item) => ({
        sessionId: item.sessionId!,
        name: item.name!,
        status: item.status ?? 'UNKNOWN',
        createdAt: item.createdAt!,
        lastUpdatedAt: item.lastUpdatedAt!,
      })) ?? []

    return {
      items,
      ...(response.nextToken && { nextToken: response.nextToken }),
    }
  }

  // ===========================
  // Code Execution
  // ===========================

  /**
   * Execute code in a code interpreter session.
   * Automatically creates a session if one doesn't exist.
   *
   * @param params - Execution parameters
   * @returns Execution result with output or error
   *
   * @example
   * ```typescript
   * // Auto-creates default session
   * const result = await interpreter.executeCode({
   *   code: 'print("Hello")',
   *   language: 'python'
   * })
   * ```
   */
  async executeCode(params: ExecuteCodeParams): Promise<string> {
    if (!this._session) {
      await this.startSession()
    }

    try {
      const command = new InvokeCodeInterpreterCommand({
        codeInterpreterIdentifier: this.identifier,
        sessionId: this._session!.sessionId,
        name: 'executeCode',
        arguments: {
          code: params.code,
          language: params.language ?? 'python',
          ...(params.clearContext !== undefined && { clearContext: params.clearContext }),
        },
      })

      const response = await this._client.send(command)

      // Returns raw content string from AWS
      return await this._parseInvokeResponse(response)
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : 'Unknown execution error'}`
    }
  }

  // ===========================
  // Command Execution
  // ===========================

  /**
   * Execute a shell command in a code interpreter session.
   * Automatically creates a session if one doesn't exist.
   *
   * @param params - Command parameters
   * @returns Command result with output or error
   *
   * @example
   * ```typescript
   * const result = await interpreter.executeCommand({
   *   command: 'ls -la'
   * })
   * ```
   */
  async executeCommand(params: ExecuteCommandParams): Promise<string> {
    if (!this._session) {
      await this.startSession()
    }

    try {
      const command = new InvokeCodeInterpreterCommand({
        codeInterpreterIdentifier: this.identifier,
        sessionId: this._session!.sessionId,
        name: 'executeCommand',
        arguments: {
          command: params.command,
        },
      })

      const response = await this._client.send(command)

      // Returns raw content string from AWS
      return await this._parseInvokeResponse(response)
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : 'Command execution failed'}`
    }
  }

  // ===========================
  // File Operations
  // ===========================

  /**
   * Read files from the code interpreter sandbox.
   * Automatically creates a session if one doesn't exist.
   *
   * @param params - Read parameters
   * @returns Read result with file contents or errors
   *
   * @example
   * ```typescript
   * const result = await interpreter.readFiles({
   *   paths: ['data.txt', 'output.json']
   * })
   * ```
   */
  async readFiles(params: ReadFilesParams): Promise<string> {
    if (!this._session) {
      await this.startSession()
    }

    try {
      const command = new InvokeCodeInterpreterCommand({
        codeInterpreterIdentifier: this.identifier,
        sessionId: this._session!.sessionId,
        name: 'readFiles',
        arguments: {
          paths: params.paths,
        },
      })

      const response = await this._client.send(command)

      // Returns raw content string from AWS
      return await this._parseInvokeResponse(response)
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : 'Read failed'}`
    }
  }

  /**
   * Write files to the code interpreter sandbox.
   * Automatically creates a session if one doesn't exist.
   *
   * @param params - Write parameters
   * @returns Write result with written file paths or errors
   *
   * @example
   * ```typescript
   * await interpreter.writeFiles({
   *   files: [
   *     { path: 'script.py', content: 'print("Hello")' },
   *     { path: 'data.json', content: '{"key": "value"}' }
   *   ]
   * })
   * ```
   */
  async writeFiles(params: WriteFilesParams): Promise<string> {
    if (!this._session) {
      await this.startSession()
    }

    try {
      const command = new InvokeCodeInterpreterCommand({
        codeInterpreterIdentifier: this.identifier,
        sessionId: this._session!.sessionId,
        name: 'writeFiles',
        arguments: {
          content: params.files.map((f) => ({
            path: f.path,
            text: f.content,
          })),
        },
      })

      const response = await this._client.send(command)

      // Returns raw content string from AWS
      return await this._parseInvokeResponse(response)
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : 'Write failed'}`
    }
  }

  /**
   * List files in the code interpreter sandbox.
   * Automatically creates a session if one doesn't exist.
   *
   * @param params - List parameters
   * @returns List result with file information or error
   *
   * @example
   * ```typescript
   * const result = await interpreter.listFiles({ path: '/tmp' })
   * ```
   */
  async listFiles(params?: ListFilesParams): Promise<string> {
    if (!this._session) {
      await this.startSession()
    }

    try {
      const command = new InvokeCodeInterpreterCommand({
        codeInterpreterIdentifier: this.identifier,
        sessionId: this._session!.sessionId,
        name: 'listFiles',
        arguments: {
          path: params?.path ?? '.',
        },
      })

      const response = await this._client.send(command)

      // Returns raw content string from AWS
      return await this._parseInvokeResponse(response)
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : 'List failed'}`
    }
  }

  /**
   * Remove files from the code interpreter sandbox.
   * Automatically creates a session if one doesn't exist.
   *
   * @param params - Remove parameters
   * @returns Remove result with removed file paths or errors
   *
   * @example
   * ```typescript
   * await interpreter.removeFiles({
   *   paths: ['temp.txt', 'cache.json']
   * })
   * ```
   */
  async removeFiles(params: RemoveFilesParams): Promise<string> {
    if (!this._session) {
      await this.startSession()
    }

    try {
      const command = new InvokeCodeInterpreterCommand({
        codeInterpreterIdentifier: this.identifier,
        sessionId: this._session!.sessionId,
        name: 'removeFiles',
        arguments: {
          paths: params.paths,
        },
      })

      const response = await this._client.send(command)

      // Returns raw content string from AWS
      return await this._parseInvokeResponse(response)
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : 'Remove failed'}`
    }
  }

  // ===========================
  // Private Helpers
  // ===========================

  /**
   * Extract and parse the streaming response from InvokeCodeInterpreterCommand.
   * Returns the raw content string from AWS without additional formatting.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async _parseInvokeResponse(response: any): Promise<string> {
    let contentStr = ''

    // Extract content string from stream
    if (response.stream) {
      for await (const event of response.stream) {
        if (event.result?.content) {
          const content = event.result.content

          // Handle AWS structured response format
          if (Array.isArray(content)) {
            contentStr = this._extractFromContentArray(content)
          } else if (typeof content === 'string') {
            contentStr = content
          } else {
            // Fallback for unknown formats
            contentStr = JSON.stringify(content)
          }
        }
        if (event.error) {
          contentStr = event.error.message || 'Unknown error'
        }
      }
    } else if (response.result?.content) {
      const content = response.result.content

      // Handle AWS structured response format (same logic as streaming)
      if (Array.isArray(content)) {
        contentStr = this._extractFromContentArray(content)
      } else if (typeof content === 'string') {
        contentStr = content
      } else {
        contentStr = JSON.stringify(content)
      }
    }

    // Return raw content string - let the AI SDK handle formatting
    return contentStr
  }

  /**
   * Extract text from AWS content array, handling multiple content types:
   * - type: "text" - Direct text output (code execution, commands)
   * - type: "resource" - File content with nested resource object
   * - type: "resource_link" - File metadata (listFiles)
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _extractFromContentArray(content: any[]): string {
    const parts: string[] = []

    for (const item of content) {
      if (item.type === 'text') {
        // Direct text output
        parts.push(item.text)
      } else if (item.type === 'resource' && item.resource) {
        // File content - extract text from nested resource object
        if (item.resource.text) {
          parts.push(item.resource.text)
        } else {
          // Resource without text - show metadata
          parts.push(JSON.stringify(item.resource))
        }
      } else if (item.type === 'resource_link') {
        // File metadata - format as human-readable string
        const { name, description, mimeType, uri } = item
        const meta = [name, description, mimeType].filter(Boolean).join(' - ')
        parts.push(`${meta} (${uri})`)
      } else {
        // Unknown type - fallback to JSON
        parts.push(JSON.stringify(item))
      }
    }

    return parts.join('\n')
  }
}
