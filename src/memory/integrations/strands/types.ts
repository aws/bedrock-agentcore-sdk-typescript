import type { Message, SystemPrompt } from '@strands-agents/sdk'
import type { MemoryClientConfig } from '../../types.js'

export interface NamespaceConfig {
  topK?: number
  relevanceScore?: number
}

export interface ExtractionConfig {
  batchSize?: number
  batchTimeoutMs?: number
  messageFilter?: (message: Message) => boolean
  fireAndForget?: boolean
}

export interface InjectionConfig {
  namespaces: Record<string, NamespaceConfig>
  automatic?: boolean
  searchTool?: boolean
  maxInjectionChars?: number
  contextTag?: string
  formatMemories?: (records: MemoryRecordGroup[]) => string
}

export interface AgentCoreMemoryConfig {
  memoryId: string
  actorId: string
  sessionId: string
  extraction?: boolean | ExtractionConfig
  injection?: InjectionConfig
  metadataProvider?: (message: Message) => Record<string, { stringValue: string }>
  memoryClient?: MemoryClientConfig
}

export interface MemoryRecordGroup {
  namespace: string
  label: string
  records: MemoryRecord[]
}

export interface MemoryRecord {
  content: string
  score?: number
  createdAt?: Date
}

export interface ResolvedExtractionConfig {
  batchSize: number
  batchTimeoutMs: number
  messageFilter: (message: Message) => boolean
  fireAndForget: boolean
}

export type MetadataProviderFn = (message: Message) => Record<string, { stringValue: string }>

const DEFAULT_EXTRACTION: ResolvedExtractionConfig = {
  batchSize: 10,
  batchTimeoutMs: 5000,
  messageFilter: () => true,
  fireAndForget: false,
}

export function resolveExtractionConfig(
  config: boolean | ExtractionConfig | undefined
): ResolvedExtractionConfig | null {
  if (config === undefined || config === false) {
    return null
  }
  if (config === true) {
    return { ...DEFAULT_EXTRACTION }
  }
  return {
    batchSize: config.batchSize ?? DEFAULT_EXTRACTION.batchSize,
    batchTimeoutMs: config.batchTimeoutMs ?? DEFAULT_EXTRACTION.batchTimeoutMs,
    messageFilter: config.messageFilter ?? DEFAULT_EXTRACTION.messageFilter,
    fireAndForget: config.fireAndForget ?? DEFAULT_EXTRACTION.fireAndForget,
  }
}

export type { SystemPrompt }
