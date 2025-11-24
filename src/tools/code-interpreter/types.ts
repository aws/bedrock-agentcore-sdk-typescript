import { z } from 'zod'
import type { BedrockAgentCoreClientConfig } from '@aws-sdk/client-bedrock-agentcore'
import type { AwsCredentialIdentityProvider } from '@aws-sdk/types'

// ===========================
// Configuration
// ===========================

/**
 * Default AWS region.
 */
export const DEFAULT_REGION = 'us-west-2'

/**
 * Configuration for the CodeInterpreter client.
 */
export interface CodeInterpreterConfig {
  /**
   * AWS region where the code interpreter service is available.
   * Defaults to process.env.AWS_REGION or 'us-west-2'.
   */
  region?: string

  /**
   * Code interpreter identifier.
   * Defaults to 'aws.codeinterpreter.v1'
   */
  identifier?: string

  /**
   * Optional AWS credentials provider.
   * When omitted, the SDK uses the default Node.js credential provider chain.
   *
   * @example
   * Using Vercel OIDC credentials:
   * ```ts
   * import { vercelOidcAwsCredentials } from '\@vercel/oidc-aws-credentials-provider'
   *
   * const interpreter = new CodeInterpreter(\{
   *   region: process.env.AWS_REGION || 'us-west-2',
   *   credentialsProvider: vercelOidcAwsCredentials()
   * \})
   * ```
   */
  credentialsProvider?: AwsCredentialIdentityProvider

  /**
   * Optional AWS SDK client configuration for advanced use cases.
   */
  clientConfig?: Partial<BedrockAgentCoreClientConfig>
}

// ===========================
// Session Management
// ===========================

/**
 * Parameters for starting a code interpreter session.
 */
export interface StartSessionParams {
  /**
   * Name for the session. Auto-generated if omitted.
   */
  sessionName?: string

  /**
   * Human-readable description of the session purpose.
   */
  description?: string

  /**
   * Session timeout in seconds.
   * Defaults to 900
   */
  timeout?: number
}

/**
 * Information about an active code interpreter session.
 */
export interface SessionInfo {
  /**
   * Local name for the session.
   */
  sessionName: string

  /**
   * AWS-assigned session identifier.
   */
  sessionId: string

  /**
   * Session description.
   */
  description?: string

  /**
   * Timestamp when session was created.
   */
  createdAt: Date
}

/**
 * Parameters for getting session details.
 */
export interface GetSessionParams {
  /**
   * Code interpreter identifier.
   * Uses current instance identifier if not provided.
   */
  interpreterId?: string

  /**
   * Session ID to query.
   * Uses current active session ID if not provided.
   */
  sessionId?: string
}

/**
 * Detailed session information returned by getSession.
 */
export interface GetSessionResponse {
  /**
   * AWS-assigned session identifier.
   */
  sessionId: string

  /**
   * Code interpreter identifier.
   */
  codeInterpreterIdentifier: string

  /**
   * Session name.
   */
  name: string

  /**
   * Session status.
   */
  status: 'READY' | 'TERMINATED'

  /**
   * Timestamp when session was created.
   */
  createdAt: Date

  /**
   * Timestamp when session was last updated.
   */
  lastUpdatedAt: Date

  /**
   * Session timeout in seconds.
   */
  sessionTimeoutSeconds: number
}

/**
 * Parameters for listing sessions.
 */
export interface ListSessionsParams {
  /**
   * Code interpreter identifier.
   * Uses current instance identifier if not provided.
   */
  interpreterId?: string

  /**
   * Filter by session status.
   */
  status?: 'READY' | 'TERMINATED'

  /**
   * Maximum number of results to return (1-100).
   * Defaults to 10
   */
  maxResults?: number

  /**
   * Pagination token for fetching next page of results.
   */
  nextToken?: string
}

/**
 * Summary information for a session in list results.
 */
export interface SessionSummary {
  /**
   * AWS-assigned session identifier.
   */
  sessionId: string

  /**
   * Session name.
   */
  name: string

  /**
   * Session status.
   */
  status: 'READY' | 'TERMINATED'

  /**
   * Timestamp when session was created.
   */
  createdAt: Date

  /**
   * Timestamp when session was last updated.
   */
  lastUpdatedAt: Date
}

/**
 * Response from listing sessions.
 */
export interface ListSessionsResponse {
  /**
   * List of session summaries.
   */
  items: SessionSummary[]

  /**
   * Token for fetching next page of results.
   * Present if there are more results available.
   */
  nextToken?: string
}

// ===========================
// Code Execution
// ===========================

/**
 * Supported programming languages for code execution.
 */
export type CodeLanguage = 'python' | 'javascript' | 'typescript'

/**
 * Parameters for executing code in a session.
 */
export interface ExecuteCodeParams {
  /**
   * Code to execute.
   */
  code: string

  /**
   * Programming language.
   * Defaults to 'python'
   */
  language?: CodeLanguage

  /**
   * Clear the execution context before running.
   * Defaults to false
   */
  clearContext?: boolean
}

/**
 * Result of code execution.
 */
export interface ExecuteCodeResult {
  /**
   * Execution status.
   */
  status: 'success' | 'error'

  /**
   * Standard output from execution.
   */
  output?: string

  /**
   * Error message if execution failed.
   */
  error?: string

  /**
   * Process exit code.
   */
  exitCode?: number
}

// ===========================
// Command Execution
// ===========================

/**
 * Parameters for executing shell commands.
 */
export interface ExecuteCommandParams {
  /**
   * Shell command to execute.
   */
  command: string
}

/**
 * Result of command execution.
 */
export interface ExecuteCommandResult {
  /**
   * Execution status.
   */
  status: 'success' | 'error'

  /**
   * Standard output from command.
   */
  output?: string

  /**
   * Error message if command failed.
   */
  error?: string

  /**
   * Command exit code.
   */
  exitCode?: number
}

// ===========================
// File Operations
// ===========================

/**
 * Parameters for reading files from sandbox.
 */
export interface ReadFilesParams {
  /**
   * Array of file paths to read.
   */
  paths: string[]
}

/**
 * Content of a file read from sandbox.
 */
export interface FileContent {
  /**
   * File path.
   */
  path: string

  /**
   * File content as string.
   */
  content: string

  /**
   * File size in bytes.
   */
  size: number
}

/**
 * Result of reading files.
 */
export interface ReadFilesResult {
  /**
   * Operation status.
   */
  status: 'success' | 'error'

  /**
   * Successfully read files.
   */
  files: FileContent[]

  /**
   * Errors encountered for specific files.
   */
  errors?: Array<{ path: string; error: string }>
}

/**
 * Parameters for writing files to sandbox.
 */
export interface WriteFilesParams {
  /**
   * Array of files to write.
   */
  files: Array<{
    /**
     * File path.
     */
    path: string
    /**
     * File content.
     */
    content: string
  }>
}

/**
 * Result of writing files.
 */
export interface WriteFilesResult {
  /**
   * Operation status.
   */
  status: 'success' | 'error'

  /**
   * Paths of successfully written files.
   */
  written: string[]

  /**
   * Errors encountered for specific files.
   */
  errors?: Array<{ path: string; error: string }>
}

/**
 * Parameters for listing files in sandbox.
 */
export interface ListFilesParams {
  /**
   * Directory path to list.
   * Defaults to '.'
   */
  path?: string
}

/**
 * Information about a file or directory.
 */
export interface FileInfo {
  /**
   * File or directory path.
   */
  path: string

  /**
   * Type of entry.
   */
  type: 'file' | 'directory'

  /**
   * File size in bytes (files only).
   */
  size?: number

  /**
   * Last modified timestamp.
   */
  modified?: Date
}

/**
 * Result of listing files.
 */
export interface ListFilesResult {
  /**
   * Operation status.
   */
  status: 'success' | 'error'

  /**
   * List of files and directories.
   */
  files: FileInfo[]

  /**
   * Error message if operation failed.
   */
  error?: string
}

/**
 * Parameters for removing files from sandbox.
 */
export interface RemoveFilesParams {
  /**
   * Array of file paths to remove.
   */
  paths: string[]
}

/**
 * Result of removing files.
 */
export interface RemoveFilesResult {
  /**
   * Operation status.
   */
  status: 'success' | 'error'

  /**
   * Paths of successfully removed files.
   */
  removed: string[]

  /**
   * Errors encountered for specific files.
   */
  errors?: Array<{ path: string; error: string }>
}

// ===========================
// Zod Schemas for Validation
// ===========================

export const CodeLanguageSchema = z.enum(['python', 'javascript', 'typescript'])

export const ExecuteCodeParamsSchema = z.object({
  code: z.string().min(1, 'Code cannot be empty'),
  language: CodeLanguageSchema.optional().default('python'),
})

export const ExecuteCommandParamsSchema = z.object({
  command: z.string().min(1, 'Command cannot be empty'),
})

export const ReadFilesParamsSchema = z.object({
  paths: z.array(z.string()).min(1, 'At least one path required'),
})

export const WriteFilesParamsSchema = z.object({
  files: z
    .array(
      z.object({
        path: z.string().min(1, 'File path cannot be empty'),
        content: z.string(),
      })
    )
    .min(1, 'At least one file required'),
})

export const ListFilesParamsSchema = z.object({
  path: z.string().optional().default('.'),
})

export const RemoveFilesParamsSchema = z.object({
  paths: z.array(z.string()).min(1, 'At least one path required'),
})

// ===========================
// Constants
// ===========================

/**
 * Default code interpreter identifier.
 */
export const DEFAULT_IDENTIFIER = 'aws.codeinterpreter.v1'

/**
 * Default session timeout in seconds.
 */
export const DEFAULT_TIMEOUT = 900

/**
 * Default session name.
 */
export const DEFAULT_SESSION_NAME = 'default'
