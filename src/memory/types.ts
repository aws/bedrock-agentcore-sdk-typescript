import type { AwsCredentialIdentityProvider } from '@aws-sdk/types'
import type { MessageRoleValue, MemoryStatusValue } from './constants.js'

// ============================================================================
// Client Configuration
// ============================================================================

/**
 * Configuration options for MemoryClient.
 */
export interface MemoryClientConfig {
  /**
   * AWS region where the memory service is deployed.
   * Defaults to process.env.AWS_REGION or 'us-west-2'.
   */
  region?: string

  /**
   * Optional AWS credentials provider.
   * When omitted, the SDK uses the default Node.js credential provider chain.
   */
  credentialsProvider?: AwsCredentialIdentityProvider
}

/**
 * Configuration options for MemorySessionManager.
 */
export interface MemorySessionManagerConfig {
  /**
   * Memory resource ID to manage.
   */
  memoryId: string

  /**
   * AWS region where the memory service is deployed.
   */
  region?: string

  /**
   * Optional AWS credentials provider.
   */
  credentialsProvider?: AwsCredentialIdentityProvider
}

/**
 * Configuration for MemoryControlPlaneClient.
 */
export interface MemoryControlPlaneClientConfig {
  /**
   * AWS region where the memory service is deployed.
   */
  region?: string

  /**
   * Optional AWS credentials provider.
   */
  credentialsProvider?: AwsCredentialIdentityProvider
}

// ============================================================================
// Wait Options
// ============================================================================

/**
 * Options for wait/poll operations.
 */
export interface WaitOptions {
  /**
   * Maximum time to wait in seconds.
   * @default 300
   */
  maxWait?: number

  /**
   * Time between status checks in seconds.
   * @default 10
   */
  pollInterval?: number
}

// ============================================================================
// Memory Operations
// ============================================================================

/**
 * Parameters for creating a memory resource.
 */
export interface CreateMemoryParams {
  /**
   * Name for the memory resource.
   */
  name: string

  /**
   * List of strategy configurations.
   * If empty, creates short-term memory only.
   */
  strategies?: StrategyConfig[]

  /**
   * Optional description.
   */
  description?: string

  /**
   * How long to retain events in days.
   * @default 90
   */
  eventExpiryDays?: number

  /**
   * IAM role ARN for memory execution.
   */
  memoryExecutionRoleArn?: string
}

/**
 * Strategy configuration object.
 * Exactly one strategy type key should be present.
 */
export interface StrategyConfig {
  semanticMemoryStrategy?: SemanticStrategyConfig
  summaryMemoryStrategy?: SummaryStrategyConfig
  userPreferenceMemoryStrategy?: UserPreferenceStrategyConfig
  customMemoryStrategy?: CustomStrategyConfig
}

/**
 * Semantic memory strategy configuration.
 */
export interface SemanticStrategyConfig {
  name: string
  description?: string
  namespaces?: string[]
}

/**
 * Summary memory strategy configuration.
 */
export interface SummaryStrategyConfig {
  name: string
  description?: string
  namespaces?: string[]
}

/**
 * User preference memory strategy configuration.
 */
export interface UserPreferenceStrategyConfig {
  name: string
  description?: string
  namespaces?: string[]
}

/**
 * Custom memory strategy configuration.
 */
export interface CustomStrategyConfig {
  name: string
  description?: string
  namespaces?: string[]
  configuration?: CustomStrategyConfiguration
}

/**
 * Custom strategy configuration details.
 */
export interface CustomStrategyConfiguration {
  semanticOverride?: {
    extraction: {
      appendToPrompt: string
      modelId: string
    }
    consolidation: {
      appendToPrompt: string
      modelId: string
    }
  }
}

// ============================================================================
// Event Operations
// ============================================================================

/**
 * Message tuple: [text, role]
 * Used in MemoryClient.createEvent()
 */
export type MessageTuple = [string, string]

/**
 * Conversational message class.
 */
export interface ConversationalMessage {
  text: string
  role: MessageRoleValue
}

/**
 * Blob message for non-conversational data.
 */
export interface BlobMessage {
  data: unknown
}

/**
 * Union type for messages in add_turns.
 */
export type Message = ConversationalMessage | BlobMessage

/**
 * Branch information for conversation forking.
 */
export interface BranchInfo {
  /**
   * Event ID to branch from.
   * Required when creating a new branch.
   */
  rootEventId?: string

  /**
   * Branch name.
   */
  name: string
}

/**
 * Parameters for creating an event.
 */
export interface CreateEventParams {
  /**
   * Memory resource ID.
   */
  memoryId: string

  /**
   * Actor identifier.
   */
  actorId: string

  /**
   * Session identifier.
   */
  sessionId: string

  /**
   * List of message tuples [text, role].
   */
  messages: MessageTuple[]

  /**
   * Optional timestamp for the event.
   */
  eventTimestamp?: Date

  /**
   * Optional branch information.
   */
  branch?: BranchInfo
}

/**
 * Parameters for creating a blob event.
 */
export interface CreateBlobEventParams {
  memoryId: string
  actorId: string
  sessionId: string
  blobData: unknown
  eventTimestamp?: Date
  branch?: BranchInfo
}

/**
 * Parameters for getting an event.
 */
export interface GetEventParams {
  memoryId: string
  actorId: string
  sessionId: string
  eventId: string
}

/**
 * Parameters for listing events.
 */
export interface ListEventsParams {
  memoryId: string
  actorId: string
  sessionId: string
  branchName?: string
  includeParentBranches?: boolean
  eventMetadata?: EventMetadataFilter[]
  maxResults?: number
  includePayload?: boolean
}

/**
 * Parameters for deleting an event.
 */
export interface DeleteEventParams {
  memoryId: string
  actorId: string
  sessionId: string
  eventId: string
}

// ============================================================================
// Memory Retrieval
// ============================================================================

/**
 * Parameters for retrieving memories.
 */
export interface RetrieveMemoriesParams {
  /**
   * Memory resource ID.
   */
  memoryId: string

  /**
   * Exact namespace path (no wildcards).
   */
  namespace: string

  /**
   * Search query.
   */
  query: string

  /**
   * Optional actor ID (deprecated, use namespace).
   */
  actorId?: string

  /**
   * Number of results to return.
   * @default 3
   */
  topK?: number
}

/**
 * Configuration for memory retrieval in process_turn_with_llm.
 */
export interface RetrievalConfig {
  /**
   * Number of top-scoring records to return.
   * @default 10
   */
  topK?: number

  /**
   * Minimum relevance score (0.0 to 1.0).
   * @default 0.0
   */
  relevanceScore?: number

  /**
   * Optional strategy ID to filter.
   */
  strategyId?: string

  /**
   * Optional custom query for semantic search.
   */
  retrievalQuery?: string
}

/**
 * Parameters for waiting for memories.
 */
export interface WaitForMemoriesParams {
  memoryId: string
  namespace: string
  testQuery?: string
  maxWait?: number
  pollInterval?: number
}

// ============================================================================
// Branch Operations
// ============================================================================

/**
 * Parameters for forking a conversation.
 */
export interface ForkConversationParams {
  memoryId: string
  actorId: string
  sessionId: string
  rootEventId: string
  branchName: string
  messages: MessageTuple[]
  eventTimestamp?: Date
}

/**
 * Parameters for listing branches.
 */
export interface ListBranchesParams {
  memoryId: string
  actorId: string
  sessionId: string
}

/**
 * Parameters for getting last K turns.
 */
export interface GetLastKTurnsParams {
  memoryId: string
  actorId: string
  sessionId: string
  k?: number
  branchName?: string
  includeParentBranches?: boolean
  maxResults?: number
}

/**
 * Parameters for getting conversation tree.
 */
export interface GetConversationTreeParams {
  memoryId: string
  actorId: string
  sessionId: string
}

// ============================================================================
// Strategy Operations
// ============================================================================

/**
 * Parameters for adding a semantic strategy.
 */
export interface AddSemanticStrategyParams {
  memoryId: string
  name: string
  description?: string
  namespaces?: string[]
}

/**
 * Parameters for adding a summary strategy.
 */
export interface AddSummaryStrategyParams {
  memoryId: string
  name: string
  description?: string
  namespaces?: string[]
}

/**
 * Parameters for adding a user preference strategy.
 */
export interface AddUserPreferenceStrategyParams {
  memoryId: string
  name: string
  description?: string
  namespaces?: string[]
}

/**
 * Parameters for adding a custom semantic strategy.
 */
export interface AddCustomSemanticStrategyParams {
  memoryId: string
  name: string
  extractionConfig: {
    prompt: string
    modelId: string
  }
  consolidationConfig: {
    prompt: string
    modelId: string
  }
  description?: string
  namespaces?: string[]
}

/**
 * Parameters for modifying a strategy.
 */
export interface ModifyStrategyParams {
  memoryId: string
  strategyId: string
  description?: string
  namespaces?: string[]
  configuration?: Record<string, unknown>
}

/**
 * Parameters for updating memory strategies.
 */
export interface UpdateMemoryStrategiesParams {
  memoryId: string
  addStrategies?: StrategyConfig[]
  modifyStrategies?: ModifyStrategyInput[]
  deleteStrategyIds?: string[]
}

/**
 * Input for modifying a strategy.
 */
export interface ModifyStrategyInput {
  memoryStrategyId: string
  description?: string
  namespaces?: string[]
  configuration?: Record<string, unknown>
}

// ============================================================================
// LLM Integration
// ============================================================================

/**
 * Callback function type for LLM integration.
 */
export type LlmCallback = (userInput: string, memories: Record<string, unknown>[]) => string

/**
 * Async callback function type for LLM integration.
 */
export type LlmCallbackAsync = (userInput: string, memories: Record<string, unknown>[]) => Promise<string>

/**
 * Parameters for processing turn with LLM.
 */
export interface ProcessTurnWithLlmParams {
  memoryId: string
  actorId: string
  sessionId: string
  userInput: string
  llmCallback: LlmCallback
  retrievalConfig?: Record<string, RetrievalConfig>
  metadata?: Record<string, MetadataValue>
  eventTimestamp?: Date
}

/**
 * Result from processing turn with LLM.
 */
export interface ProcessTurnResult {
  memories: Record<string, unknown>[]
  response: string
  event: Record<string, unknown>
}

// ============================================================================
// Metadata Types
// ============================================================================

/**
 * String value for metadata.
 */
export interface StringValue {
  stringValue: string
}

/**
 * Metadata value union type.
 */
export type MetadataValue = StringValue

/**
 * Left expression in event metadata filter.
 */
export interface LeftExpression {
  metadataKey: string
}

/**
 * Operator types for event metadata filters.
 */
export type OperatorType = 'EQUALS_TO' | 'EXISTS' | 'NOT_EXISTS'

/**
 * Right expression in event metadata filter.
 */
export interface RightExpression {
  metadataValue: MetadataValue
}

/**
 * Event metadata filter.
 */
export interface EventMetadataFilter {
  left: LeftExpression
  operator: OperatorType
  right?: RightExpression
}

// ============================================================================
// Response Types
// ============================================================================

/**
 * Normalized memory response with both old and new field names.
 */
export interface NormalizedMemory {
  // New field names (primary)
  id: string
  name: string
  status: MemoryStatusValue
  strategies?: NormalizedStrategy[]

  // Old field names (backward compatibility)
  memoryId: string
  memoryStrategies?: NormalizedStrategy[]

  // Common fields
  description?: string
  eventExpiryDuration?: number
  createdAt?: Date
  updatedAt?: Date
  failureReason?: string
}

/**
 * Normalized strategy response.
 */
export interface NormalizedStrategy {
  // New field names
  strategyId: string
  type: string

  // Old field names
  memoryStrategyId: string
  memoryStrategyType: string

  // Common fields
  name: string
  description?: string
  namespaces?: string[]
  status?: string
  configuration?: Record<string, unknown>
}

/**
 * Conversation tree structure.
 */
export interface ConversationTree {
  sessionId: string
  actorId: string
  mainBranch: {
    events: EventSummary[]
    branches: Record<string, BranchEvents>
  }
}

/**
 * Event summary for tree view.
 */
export interface EventSummary {
  eventId: string
  timestamp: Date | string
  messages: MessageSummary[]
}

/**
 * Message summary for tree view.
 */
export interface MessageSummary {
  role: string
  text: string
}

/**
 * Branch events structure.
 */
export interface BranchEvents {
  rootEventId?: string
  events: EventSummary[]
}

// ============================================================================
// Batch Operations
// ============================================================================

/**
 * Result of batch delete operation.
 */
export interface BatchDeleteResult {
  successfulRecords: Array<{ memoryRecordId: string }>
  failedRecords: Array<{ memoryRecordId: string; error?: string }>
}
