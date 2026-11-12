import { describe, it, expect } from 'vitest'
import { isForwardableHeader } from '../headers.js'

describe('isForwardableHeader', () => {
  it('allows application headers including trace propagation', () => {
    expect(isForwardableHeader('traceparent')).toBe(true)
    expect(isForwardableHeader('baggage')).toBe(true)
    expect(isForwardableHeader('x-request-source')).toBe(true)
    expect(isForwardableHeader('x-amzn-bedrock-agentcore-runtime-custom-tenant')).toBe(true)
  })

  // The one x-amz-* exception: withWatPropagation sends the workload token
  // under this header, so blocking it breaks the identity chain between agents.
  it('allows the identity WAT header despite the x-amz- prefix', () => {
    expect(isForwardableHeader('x-amz-bedrock-agentcore-identity-wat')).toBe(true)
  })

  it('rejects restricted, x-amz-*, and non-custom x-amzn-* headers', () => {
    expect(isForwardableHeader('Content-Type')).toBe(false)
    expect(isForwardableHeader('host')).toBe(false)
    expect(isForwardableHeader('Cookie')).toBe(false)
    expect(isForwardableHeader('x-amz-date')).toBe(false)
    expect(isForwardableHeader('X-Amzn-Trace-Id')).toBe(false)
    expect(isForwardableHeader('x-amzn-bedrock-agentcore-runtime-session-id')).toBe(false)
  })
})
