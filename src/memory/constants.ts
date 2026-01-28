/**
 * Memory strategy types for API input.
 * These are the keys used in strategy configuration objects.
 */
export const StrategyType = {
  SEMANTIC: 'semanticMemoryStrategy',
  SUMMARY: 'summaryMemoryStrategy',
  USER_PREFERENCE: 'userPreferenceMemoryStrategy',
  CUSTOM: 'customMemoryStrategy',
} as const

export type StrategyTypeValue = (typeof StrategyType)[keyof typeof StrategyType]

/**
 * Internal strategy type enum (used in API responses).
 */
export const MemoryStrategyTypeEnum = {
  SEMANTIC: 'SEMANTIC',
  SUMMARIZATION: 'SUMMARIZATION',
  USER_PREFERENCE: 'USER_PREFERENCE',
  CUSTOM: 'CUSTOM',
} as const

export type MemoryStrategyTypeEnumValue = (typeof MemoryStrategyTypeEnum)[keyof typeof MemoryStrategyTypeEnum]

/**
 * Custom strategy override types.
 */
export const OverrideType = {
  SEMANTIC_OVERRIDE: 'SEMANTIC_OVERRIDE',
  SUMMARY_OVERRIDE: 'SUMMARY_OVERRIDE',
  USER_PREFERENCE_OVERRIDE: 'USER_PREFERENCE_OVERRIDE',
} as const

export type OverrideTypeValue = (typeof OverrideType)[keyof typeof OverrideType]

/**
 * Memory resource statuses.
 */
export const MemoryStatus = {
  CREATING: 'CREATING',
  ACTIVE: 'ACTIVE',
  FAILED: 'FAILED',
  UPDATING: 'UPDATING',
  DELETING: 'DELETING',
} as const

export type MemoryStatusValue = (typeof MemoryStatus)[keyof typeof MemoryStatus]

/**
 * Memory strategy statuses.
 */
export const MemoryStrategyStatus = {
  CREATING: 'CREATING',
  ACTIVE: 'ACTIVE',
  DELETING: 'DELETING',
  FAILED: 'FAILED',
} as const

export type MemoryStrategyStatusValue = (typeof MemoryStrategyStatus)[keyof typeof MemoryStrategyStatus]

/**
 * Basic conversation roles.
 */
export const Role = {
  USER: 'USER',
  ASSISTANT: 'ASSISTANT',
} as const

export type RoleValue = (typeof Role)[keyof typeof Role]

/**
 * Extended message roles including tool usage.
 */
export const MessageRole = {
  USER: 'USER',
  ASSISTANT: 'ASSISTANT',
  TOOL: 'TOOL',
  OTHER: 'OTHER',
} as const

export type MessageRoleValue = (typeof MessageRole)[keyof typeof MessageRole]

/**
 * Default namespaces for each strategy type.
 * Used when user doesn't provide namespaces in strategy configuration.
 */
export const DEFAULT_NAMESPACES: Record<StrategyTypeValue, string[]> = {
  [StrategyType.SEMANTIC]: ['/actor/{actorId}/strategy/{strategyId}/{sessionId}'],
  [StrategyType.SUMMARY]: ['/actor/{actorId}/strategy/{strategyId}/{sessionId}'],
  [StrategyType.USER_PREFERENCE]: ['/actor/{actorId}/strategy/{strategyId}'],
  [StrategyType.CUSTOM]: ['/custom/{actorId}/{sessionId}'],
}

/**
 * Default AWS region.
 */
export const DEFAULT_REGION = 'us-west-2'

/**
 * Default polling intervals and timeouts.
 */
export const DEFAULT_MAX_WAIT = 300 // seconds
export const DEFAULT_POLL_INTERVAL = 10 // seconds

/**
 * Configuration wrapper keys for update operations.
 */
export const EXTRACTION_WRAPPER_KEYS: Record<string, string> = {
  SEMANTIC: 'semanticExtractionConfiguration',
  USER_PREFERENCE: 'userPreferenceExtractionConfiguration',
}

export const CUSTOM_EXTRACTION_WRAPPER_KEYS: Record<OverrideTypeValue, string> = {
  [OverrideType.SEMANTIC_OVERRIDE]: 'semanticExtractionOverride',
  [OverrideType.USER_PREFERENCE_OVERRIDE]: 'userPreferenceExtractionOverride',
  [OverrideType.SUMMARY_OVERRIDE]: 'summaryExtractionOverride', // May not exist, check API
}

export const CUSTOM_CONSOLIDATION_WRAPPER_KEYS: Record<OverrideTypeValue, string> = {
  [OverrideType.SEMANTIC_OVERRIDE]: 'semanticConsolidationOverride',
  [OverrideType.SUMMARY_OVERRIDE]: 'summaryConsolidationOverride',
  [OverrideType.USER_PREFERENCE_OVERRIDE]: 'userPreferenceConsolidationOverride',
}

/**
 * Configuration limits.
 */
export const ConfigLimits = {
  MIN_TRIGGER_EVERY_N_MESSAGES: 1,
  MAX_TRIGGER_EVERY_N_MESSAGES: 16,
  MIN_HISTORICAL_CONTEXT_WINDOW: 0,
  MAX_HISTORICAL_CONTEXT_WINDOW: 12,
} as const
