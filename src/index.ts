/**
 * Bedrock AgentCore SDK root entrypoint.
 */

export { BedrockAgentCoreApp, RuntimeClient } from './runtime/index.js'
export { withAccessToken, withApiKey } from './identity/index.js'
export { Browser } from './tools/browser/index.js'
export { CodeInterpreter } from './tools/code-interpreter/index.js'

export * as runtime from './runtime/index.js'
export * as identity from './identity/index.js'
export * as browser from './tools/browser/index.js'
export * as codeInterpreter from './tools/code-interpreter/index.js'
