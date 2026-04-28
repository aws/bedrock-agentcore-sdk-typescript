import type { Message, SystemPrompt } from '@strands-agents/sdk'
import type { MemoryClientConfig } from '../../types.js'
import type { MemoryClient } from '../../client.js'

export interface NamespaceConfig {
  topK?: number
  relevanceScore?: number
}

export interface ExtractionConfig {
  batchSize?: number
  batchTimeoutMs?: number
  messageFilter?: (message: Message) => boolean
  fireAndForget?: boolean
  flushTimeoutMs?: number
  maxDrainIterations?: number
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
  memoryClient?: MemoryClientConfig | MemoryClient
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
  flushTimeoutMs: number
  maxDrainIterations: number
}

export type MetadataProviderFn = (message: Message) => Record<string, { stringValue: string }>

const DEFAULT_EXTRACTION: ResolvedExtractionConfig = {
  batchSize: 10,
  batchTimeoutMs: 5000,
  messageFilter: () => true,
  fireAndForget: false,
  flushTimeoutMs: 10000,
  maxDrainIterations: 10,
}

function isNonNegative(n: number): boolean {
  return Number.isFinite(n) && n >= 0 && !Object.is(n, -0)
}

export function resolveExtractionConfig(
  config: boolean | ExtractionConfig | undefined
): ResolvedExtractionConfig | null {
  if (config === undefined || config === false) {
    return null
  }
  if (config === true) {
    return Object.freeze({ ...DEFAULT_EXTRACTION })
  }
  if (config.batchSize !== undefined && (!Number.isInteger(config.batchSize) || config.batchSize < 1)) {
    throw new TypeError(`extraction.batchSize must be a positive integer, got ${config.batchSize}`)
  }
  if (config.batchTimeoutMs !== undefined && !isNonNegative(config.batchTimeoutMs)) {
    throw new TypeError(`extraction.batchTimeoutMs must be a non-negative finite number, got ${config.batchTimeoutMs}`)
  }
  if (config.flushTimeoutMs !== undefined && (!isNonNegative(config.flushTimeoutMs) || config.flushTimeoutMs < 1)) {
    throw new TypeError(`extraction.flushTimeoutMs must be a positive finite number, got ${config.flushTimeoutMs}`)
  }
  if (
    config.maxDrainIterations !== undefined &&
    (!Number.isInteger(config.maxDrainIterations) || config.maxDrainIterations < 1)
  ) {
    throw new TypeError(`extraction.maxDrainIterations must be a positive integer, got ${config.maxDrainIterations}`)
  }
  return Object.freeze({
    batchSize: config.batchSize ?? DEFAULT_EXTRACTION.batchSize,
    batchTimeoutMs: config.batchTimeoutMs ?? DEFAULT_EXTRACTION.batchTimeoutMs,
    messageFilter: config.messageFilter ?? DEFAULT_EXTRACTION.messageFilter,
    fireAndForget: config.fireAndForget ?? DEFAULT_EXTRACTION.fireAndForget,
    flushTimeoutMs: config.flushTimeoutMs ?? DEFAULT_EXTRACTION.flushTimeoutMs,
    maxDrainIterations: config.maxDrainIterations ?? DEFAULT_EXTRACTION.maxDrainIterations,
  })
}

export function resolveNamespaceTemplate(ns: string, actorId: string, sessionId: string): string {
  return ns.replace(/\{actorId\}/g, actorId).replace(/\{sessionId\}/g, sessionId)
}

export function resolveNamespaces(
  namespaces: Record<string, NamespaceConfig>,
  actorId: string,
  sessionId: string
): Record<string, NamespaceConfig> {
  const resolved: Record<string, NamespaceConfig> = {}
  for (const [ns, cfg] of Object.entries(namespaces)) {
    resolved[resolveNamespaceTemplate(ns, actorId, sessionId)] = cfg
  }
  return resolved
}

export type { SystemPrompt }
