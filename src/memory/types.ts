import type { AwsCredentialIdentityProvider } from '@aws-sdk/types'
import type { Event as MemoryEvent, BedrockAgentCore } from '@aws-sdk/client-bedrock-agentcore'
import type { BedrockAgentCoreControl } from '@aws-sdk/client-bedrock-agentcore-control'

export const DATA_PLANE_METHODS = [
  'createEvent',
  'listEvents',
  'getEvent',
  'deleteEvent',
  'retrieveMemoryRecords',
  'getMemoryRecord',
  'deleteMemoryRecord',
  'listMemoryRecords',
  'listActors',
  'listSessions',
  'batchCreateMemoryRecords',
  'batchDeleteMemoryRecords',
  'batchUpdateMemoryRecords',
  'listMemoryExtractionJobs',
  'startMemoryExtractionJob',
] as const

export const CONTROL_PLANE_METHODS = [
  'createMemory',
  'getMemory',
  'listMemories',
  'updateMemory',
  'deleteMemory',
] as const

export type DataPlaneMethods = Pick<BedrockAgentCore, (typeof DATA_PLANE_METHODS)[number]>
export type ControlPlaneMethods = Pick<BedrockAgentCoreControl, (typeof CONTROL_PLANE_METHODS)[number]>

export interface MemoryClientConfig {
  region?: string
  credentialsProvider?: AwsCredentialIdentityProvider
  dataPlaneClient?: BedrockAgentCore
  controlPlaneClient?: BedrockAgentCoreControl
}

export interface WaitOptions {
  maxWaitSeconds?: number
  pollIntervalMs?: number
}

export interface BranchInfo {
  name: string
  rootEventId?: string | undefined
  eventCount: number
}

export interface WaitForMemoriesParams {
  memoryId: string
  namespace: string
  testQuery?: string
  maxWaitSeconds?: number
  pollIntervalMs?: number
}

export interface GetLastKTurnsParams {
  memoryId: string
  actorId: string
  sessionId: string
  k: number
  branchName?: string
  includeParentBranches?: boolean
}

export type { MemoryEvent }
