import type {
  StringValue,
  MetadataValue,
  LeftExpression,
  OperatorType,
  RightExpression,
  EventMetadataFilter,
} from '../types.js'

/**
 * Helper to build StringValue.
 */
export function buildStringValue(value: string): StringValue {
  return { stringValue: value }
}

/**
 * Helper to build LeftExpression.
 */
export function buildLeftExpression(key: string): LeftExpression {
  return { metadataKey: key }
}

/**
 * Helper to build RightExpression.
 */
export function buildRightExpression(value: string): RightExpression {
  return { metadataValue: buildStringValue(value) }
}

/**
 * Helper to build EventMetadataFilter.
 */
export function buildEventMetadataFilter(
  key: string,
  operator: OperatorType,
  value?: string
): EventMetadataFilter {
  const filter: EventMetadataFilter = {
    left: buildLeftExpression(key),
    operator,
  }

  if (value !== undefined && operator === 'EQUALS_TO') {
    filter.right = buildRightExpression(value)
  }

  return filter
}

// Re-export types for convenience
export type { StringValue, MetadataValue, LeftExpression, OperatorType, RightExpression, EventMetadataFilter }
