/**
 * AgentCore Runtime module
 */

export { BedrockAgentCoreApp } from './app.js'
export { RuntimeClient } from './client.js'
export type {
  BedrockAgentCoreAppConfig,
  ContentTypeParserConfig,
  InvocationHandler as Handler,
  RequestContext,
  HealthStatus,
  HealthCheckResponse,
  AsyncTaskInfo,
  AsyncTaskStatus,
  RuntimeClientConfig,
  GenerateWsConnectionParams,
  GeneratePresignedUrlParams,
  GenerateWsConnectionOAuthParams,
  WebSocketConnection,
  ParsedRuntimeArn,
} from './types.js'
export { DEFAULT_PRESIGNED_URL_TIMEOUT, MAX_PRESIGNED_URL_TIMEOUT, DEFAULT_REGION, RuntimeArnSchema } from './types.js'

// Shell — Layer 1: auth helpers + wire protocol
export type {
  ConnectShellSigV4Params,
  ConnectShellPresignedParams,
  ConnectShellOAuthParams,
  ShellConnectionSigV4,
  ShellConnectionPresigned,
  ShellConnectionOAuth,
  OpenShellParams,
  ShellAuthMode,
} from './types.js'
export { ShellChannel, ShellFramer, MAX_FRAME_SIZE } from './shell/index.js'
export type { ShellFrame } from './shell/index.js'

// Shell — Layer 2: managed session
export { ShellSession } from './shell/index.js'
export type { ReconnectConfig, ConnectFn, ShellSessionOptions, Logger } from './shell/index.js'
