import type { AwsCredentialIdentityProvider } from '@aws-sdk/types'
import type {
  CreateEventCommandInput,
  CreateEventCommandOutput,
  ListEventsCommandInput,
  ListEventsCommandOutput,
  GetEventCommandInput,
  GetEventCommandOutput,
  DeleteEventCommandInput,
  DeleteEventCommandOutput,
  RetrieveMemoryRecordsCommandInput,
  RetrieveMemoryRecordsCommandOutput,
  ListActorsCommandOutput,
  ListSessionsCommandOutput,
  Event as MemoryEvent,
  Conversational,
  BedrockAgentCore,
} from '@aws-sdk/client-bedrock-agentcore'
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

type MemoryScoped = 'memoryId'

export interface ScopedMemory {
  createEvent(input: Omit<CreateEventCommandInput, MemoryScoped>): Promise<CreateEventCommandOutput>
  listEvents(input: Omit<ListEventsCommandInput, MemoryScoped>): Promise<ListEventsCommandOutput>
  listAllEvents(input: Omit<ListEventsCommandInput, MemoryScoped | 'nextToken'>): Promise<MemoryEvent[]>
  getEvent(input: Omit<GetEventCommandInput, MemoryScoped>): Promise<GetEventCommandOutput>
  deleteEvent(input: Omit<DeleteEventCommandInput, MemoryScoped>): Promise<DeleteEventCommandOutput>
  retrieveMemoryRecords(input: Omit<RetrieveMemoryRecordsCommandInput, MemoryScoped>): Promise<RetrieveMemoryRecordsCommandOutput>
  listActors(): Promise<ListActorsCommandOutput>
  listSessions(input: { actorId: string }): Promise<ListSessionsCommandOutput>
  getLastKTurns(params: Omit<GetLastKTurnsParams, MemoryScoped>): Promise<Conversational[][]>
  listBranches(params: { actorId: string; sessionId: string }): Promise<BranchInfo[]>
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
