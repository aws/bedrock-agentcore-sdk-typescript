export { AgentCoreMemoryStore } from './store.js'
export { createAgentCoreMemoryStores, assertWritableTopology } from './factory.js'
export { AgentCoreEventSender } from './sender.js'
export { resolveNamespace, slugifyNamespace, RESERVED_METADATA_PREFIX } from './types.js'
export { configureMemoryLogging } from './logger.js'
export type { Logger } from './logger.js'

export type {
  AgentCoreMemoryConfig,
  AgentCoreMemoryStoreConfig,
  AgentCoreReadTarget,
  MetadataProvider,
} from './types.js'
export type {
  CreateAgentCoreMemoryStoresInput,
  AgentCoreNamespaceConfig,
  AgentCoreExtractionConfig,
} from './factory.js'
export type { AgentCoreEventSenderConfig } from './sender.js'
export type { AgentCoreRole } from './format.js'
