/**
 * Amazon Bedrock AgentCore sandbox for the Strands SDK — executes commands and
 * code in a managed Code Interpreter session via the `InvokeCodeInterpreter` API.
 *
 * Implements the Strands {@link Sandbox} interface, mapping every operation to a
 * native AgentCore tool (`executeCommand`, `executeCode`, `readFiles`,
 * `writeFiles`, `removeFiles`, `listFiles`) rather than faking file and code I/O
 * through shell commands. This makes file transfers binary-safe and lets code
 * execution return rich output artifacts (images, charts) as {@link OutputFile}s.
 *
 * Like the Strands `DockerSandbox` (which targets an already-running container),
 * this sandbox is pure I/O: it never starts or stops the session. The caller owns
 * the lifecycle — start a session with `StartCodeInterpreterSession`, pass its
 * `identifier` and `sessionId` here, and stop it (or let it expire) when done.
 * Sessions auto-expire after their `sessionTimeoutSeconds` (default 15 minutes).
 *
 * @example
 * ```typescript
 * import { CodeInterpreter } from 'bedrock-agentcore/code-interpreter'
 * import { AgentCoreSandbox } from 'bedrock-agentcore/experimental/code-interpreter/strands'
 *
 * const interpreter = new CodeInterpreter({ region: 'us-west-2' })
 * const session = await interpreter.startSession()
 *
 * const sandbox = new AgentCoreSandbox({
 *   identifier: interpreter.identifier,
 *   sessionId: session.sessionId,
 *   region: 'us-west-2',
 * })
 *
 * const result = await sandbox.execute('echo hello')
 * console.log(result.stdout)
 *
 * await interpreter.stopSession()
 * ```
 */

import { BedrockAgentCoreClient, InvokeCodeInterpreterCommand } from '@aws-sdk/client-bedrock-agentcore'
import type {
  CodeInterpreterStreamOutput,
  ContentBlock,
  ProgrammingLanguage,
  ToolArguments,
  ToolName,
} from '@aws-sdk/client-bedrock-agentcore'
import { Sandbox } from '@strands-agents/sdk/sandbox'
import type { ExecuteOptions, ExecutionResult, FileInfo, OutputFile, StreamChunk } from '@strands-agents/sdk/sandbox'

/**
 * Regex for validating environment variable names: a leading letter or
 * underscore, followed by letters, digits, or underscores (valid POSIX names).
 * Names outside this set are rejected to prevent shell-syntax injection where a
 * key is interpolated into a command.
 *
 * Inlined from the Strands SDK's internal sandbox helpers, which are not exposed
 * on the published `@strands-agents/sdk/sandbox` entrypoint.
 */
const ENV_KEY_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/

/**
 * Shell-escape a string by wrapping it in single quotes and escaping embedded
 * single quotes via the `'\''` pattern. Single quotes disable all shell
 * expansion, making this safe against injection.
 */
function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'"
}

/**
 * Build a shell `export KEY=VALUE && ...` prefix for a command, or `''` when
 * there are none. Keys are validated; values are {@link shellQuote}d. Applied to
 * `executeCommand` so env vars are set in the shell itself; `executeCode` runs in
 * a language kernel with no shell wrapper, so env is not applied there.
 *
 * Inlined from the Strands SDK's internal `buildShellEnvPrefix`, which is not
 * exposed on the published `@strands-agents/sdk/sandbox` entrypoint.
 */
function buildShellEnvPrefix(env?: Record<string, string>): string {
  if (!env || Object.keys(env).length === 0) {
    return ''
  }
  for (const key of Object.keys(env)) {
    if (!ENV_KEY_PATTERN.test(key)) {
      throw new Error(`Invalid environment variable name: ${key}`)
    }
  }
  const assignments = Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`)
  return `export ${assignments.join(' ')} && `
}

/**
 * Maps common interpreter names to the three languages AgentCore accepts.
 * The {@link Sandbox} interface takes a free-form `language` (Docker/SSH treat
 * it as an interpreter binary like `python3` or `node`), so aliases are mapped
 * to keep code execution portable across backends.
 */
const LANGUAGE_ALIASES: Record<string, ProgrammingLanguage> = {
  python: 'python',
  python3: 'python',
  py: 'python',
  javascript: 'javascript',
  js: 'javascript',
  node: 'javascript',
  nodejs: 'javascript',
  typescript: 'typescript',
  ts: 'typescript',
}

/** Resolve a free-form language to an AgentCore {@link ProgrammingLanguage}, or throw. */
function toProgrammingLanguage(language: string): ProgrammingLanguage {
  const mapped = LANGUAGE_ALIASES[language.toLowerCase()]
  if (!mapped) {
    throw new Error(
      `AgentCore code interpreter does not support language "${language}" (supported: python, javascript, typescript)`
    )
  }
  return mapped
}

/** Combine an optional abort signal with an optional timeout into a single signal. */
function resolveSignal(options?: ExecuteOptions): AbortSignal | undefined {
  const signals: AbortSignal[] = []
  if (options?.signal) signals.push(options.signal)
  if (options?.timeout !== undefined) signals.push(AbortSignal.timeout(options.timeout * 1000))
  if (signals.length === 0) return undefined
  if (signals.length === 1) return signals[0]
  return AbortSignal.any(signals)
}

/** Map a non-text content block (image or binary resource) to an {@link OutputFile}. */
function toOutputFile(block: ContentBlock): OutputFile | undefined {
  if (block.type === 'image' && block.data) {
    return { name: block.name ?? 'image', content: block.data, mimeType: block.mimeType ?? 'application/octet-stream' }
  }
  const resource = block.resource
  if (block.type === 'resource' && resource?.blob) {
    return {
      name: block.name ?? resource.uri ?? 'output',
      content: resource.blob,
      mimeType: resource.mimeType ?? 'application/octet-stream',
    }
  }
  return undefined
}

/** Concatenate the text content blocks of a result, used for surfacing error messages. */
function collectText(content: ContentBlock[]): string {
  return content
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text)
    .join('\n')
}

/**
 * Build a {@link FileInfo} from a directory entry name, inferring `isDir` from a
 * trailing slash (the same convention the Strands shell-backed sandboxes derive
 * from `ls -ap`). The slash is stripped from the reported name so AgentCore and
 * the shell backends produce identically shaped entries.
 *
 * AgentCore's `listFiles` exposes no explicit directory flag on a
 * {@link ContentBlock}, so this is best-effort: if the backend does not append a
 * trailing slash, `isDir` is `false` rather than `undefined`.
 */
function toFileInfo(rawName: string, size?: number): FileInfo {
  const isDir = rawName.endsWith('/')
  const name = isDir ? rawName.slice(0, -1) : rawName
  return size === undefined ? { name, isDir } : { name, size, isDir }
}

/**
 * Options for constructing an {@link AgentCoreSandbox}.
 */
export interface AgentCoreSandboxOptions {
  /**
   * The `codeInterpreterIdentifier` of the session (e.g. `"aws.codeinterpreter.v1"`).
   * Must match the identifier used to start the session.
   */
  identifier: string
  /** The active session id returned by `StartCodeInterpreterSession`. */
  sessionId: string
  /** AWS region. Used only when {@link client} is not provided. */
  region?: string
  /**
   * A pre-configured `BedrockAgentCoreClient`. When omitted, a client is
   * lazily constructed from {@link region} (and the default credential chain).
   */
  client?: BedrockAgentCoreClient
}

/**
 * Execute commands and code in an Amazon Bedrock AgentCore Code Interpreter session.
 *
 * {@link ExecuteOptions.env} and {@link ExecuteOptions.cwd} are applied to
 * `executeStreaming` by prepending `cd` / shell `export` to the command; they
 * are not applied to `executeCodeStreaming`, which runs in a language kernel
 * with no shell wrapper.
 *
 * Streaming is event-based: AgentCore returns result events rather than a live
 * byte stream, so chunks are yielded as the response arrives (typically after
 * the operation completes), followed by the final {@link ExecutionResult}.
 */
export class AgentCoreSandbox extends Sandbox {
  readonly identifier: string
  readonly sessionId: string
  private readonly _client: BedrockAgentCoreClient

  constructor(options: AgentCoreSandboxOptions) {
    super()
    this.identifier = options.identifier
    this.sessionId = options.sessionId
    this._client =
      options.client ?? new BedrockAgentCoreClient(options.region ? { region: options.region } : {})
  }

  /**
   * Issue an `InvokeCodeInterpreter` request, yielding each result event and
   * throwing on a service exception event.
   */
  private async *_invoke(
    name: ToolName,
    args: ToolArguments,
    options?: ExecuteOptions
  ): AsyncGenerator<NonNullable<CodeInterpreterStreamOutput['result']>, void, undefined> {
    const command = new InvokeCodeInterpreterCommand({
      codeInterpreterIdentifier: this.identifier,
      sessionId: this.sessionId,
      name,
      arguments: args,
    })
    const abortSignal = resolveSignal(options)
    const response = await (abortSignal
      ? this._client.send(command, { abortSignal })
      : this._client.send(command))
    if (!response.stream) {
      throw new Error('AgentCore code interpreter returned no result stream')
    }
    for await (const event of response.stream) {
      if (event.result) {
        yield event.result
        continue
      }
      const exception =
        event.accessDeniedException ??
        event.conflictException ??
        event.internalServerException ??
        event.resourceNotFoundException ??
        event.serviceQuotaExceededException ??
        event.throttlingException ??
        event.validationException
      if (exception) {
        throw new Error(exception.message ?? 'AgentCore code interpreter returned an error')
      }
    }
  }

  /** Invoke a tool and stream its output as {@link StreamChunk}s followed by an {@link ExecutionResult}. */
  private async *_stream(
    name: ToolName,
    args: ToolArguments,
    options?: ExecuteOptions
  ): AsyncGenerator<StreamChunk | ExecutionResult, void, undefined> {
    let textStdout = ''
    let structuredStdout = ''
    let stderr = ''
    let exitCode = 0
    let emittedStdout = false
    const outputFiles: OutputFile[] = []

    for await (const result of this._invoke(name, args, options)) {
      for (const block of result.content ?? []) {
        if (block.type === 'text' && block.text) {
          textStdout += block.text
          emittedStdout = true
          yield { type: 'streamChunk', data: block.text, streamType: 'stdout' }
        } else {
          const file = toOutputFile(block)
          if (file) outputFiles.push(file)
        }
      }

      const structured = result.structuredContent
      if (structured) {
        if (structured.stdout) structuredStdout += structured.stdout
        if (structured.stderr) {
          stderr += structured.stderr
          yield { type: 'streamChunk', data: structured.stderr, streamType: 'stderr' }
        }
        if (structured.exitCode !== undefined) exitCode = structured.exitCode
      }
      if (result.isError && exitCode === 0) exitCode = 1
    }

    // Prefer textual content blocks; fall back to structured stdout when the
    // backend reports output only there.
    let stdout = textStdout
    if (!emittedStdout && structuredStdout) {
      stdout = structuredStdout
      yield { type: 'streamChunk', data: structuredStdout, streamType: 'stdout' }
    }

    yield { type: 'executionResult', exitCode, stdout, stderr, outputFiles } satisfies ExecutionResult
  }

  /** Invoke a tool and drain its stream into the aggregated content blocks. */
  private async _collect(
    name: ToolName,
    args: ToolArguments,
    options?: ExecuteOptions
  ): Promise<{ content: ContentBlock[]; isError: boolean }> {
    const content: ContentBlock[] = []
    let isError = false
    for await (const result of this._invoke(name, args, options)) {
      if (result.content) content.push(...result.content)
      if (result.isError) isError = true
    }
    return { content, isError }
  }

  async *executeStreaming(
    command: string,
    options?: ExecuteOptions
  ): AsyncGenerator<StreamChunk | ExecutionResult, void, undefined> {
    // executeCommand has no native cwd/env args, so apply them via the shell.
    const cd = options?.cwd ? `cd ${shellQuote(options.cwd)} && ` : ''
    yield* this._stream('executeCommand', { command: cd + buildShellEnvPrefix(options?.env) + command }, options)
  }

  /**
   * Execute code via AgentCore's native `executeCode` tool, which runs in a
   * persistent language kernel and can return image/chart {@link OutputFile}s.
   *
   * Because the kernel has no surrounding shell, {@link ExecuteOptions.env} and
   * {@link ExecuteOptions.cwd} are not applied here — they only affect
   * {@link executeStreaming}. Set environment variables or change directory from
   * within the code itself (e.g. `os.environ` / `os.chdir` in Python).
   */
  async *executeCodeStreaming(
    code: string,
    language: string,
    options?: ExecuteOptions
  ): AsyncGenerator<StreamChunk | ExecutionResult, void, undefined> {
    yield* this._stream('executeCode', { code, language: toProgrammingLanguage(language) }, options)
  }

  async readFile(path: string): Promise<Uint8Array> {
    const { content, isError } = await this._collect('readFiles', { paths: [path] })
    if (isError) throw new Error(collectText(content) || `Failed to read file: ${path}`)
    for (const block of content) {
      if (block.resource?.blob) return block.resource.blob
      if (block.resource?.text !== undefined) return new TextEncoder().encode(block.resource.text)
      if (block.type === 'text' && block.text !== undefined) return new TextEncoder().encode(block.text)
    }
    // No content blocks on a non-error response means an empty (0-byte) file,
    // matching how the shell-backed sandboxes decode empty `base64` output.
    return new Uint8Array(0)
  }

  async writeFile(path: string, content: Uint8Array): Promise<void> {
    const result = await this._collect('writeFiles', { content: [{ path, blob: content }] })
    if (result.isError) throw new Error(collectText(result.content) || `Failed to write file: ${path}`)
  }

  async removeFile(path: string): Promise<void> {
    const result = await this._collect('removeFiles', { paths: [path] })
    if (result.isError) throw new Error(collectText(result.content) || `Failed to remove file: ${path}`)
  }

  async listFiles(path: string): Promise<FileInfo[]> {
    const { content, isError } = await this._collect('listFiles', { directoryPath: path })
    if (isError) throw new Error(collectText(content) || `Failed to list directory: ${path}`)

    const entries: FileInfo[] = []
    for (const block of content) {
      if (block.type === 'resource_link' || block.type === 'resource') {
        const name = block.name ?? block.resource?.uri
        if (name) entries.push(toFileInfo(name, block.size))
      } else if (block.type === 'text' && block.text) {
        for (const line of block.text.split('\n')) {
          const name = line.trim()
          if (name) entries.push(toFileInfo(name))
        }
      }
    }
    return entries
  }
}
