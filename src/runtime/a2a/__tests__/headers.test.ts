import { describe, it, expect } from 'vitest'
import { isForwardableHeader, extractA2AContext } from '../headers.js'

describe('isForwardableHeader', () => {
  it('allows application headers including trace propagation', () => {
    expect(isForwardableHeader('traceparent')).toBe(true)
    expect(isForwardableHeader('baggage')).toBe(true)
    expect(isForwardableHeader('x-request-source')).toBe(true)
    expect(isForwardableHeader('x-amzn-bedrock-agentcore-runtime-custom-tenant')).toBe(true)
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

describe('extractA2AContext', () => {
  it('extracts the AgentCore runtime headers into typed context fields', () => {
    const context = extractA2AContext({
      'x-amzn-bedrock-agentcore-runtime-session-id': 'sess-1',
      'x-amzn-bedrock-agentcore-runtime-request-id': 'req-1',
      workloadaccesstoken: 'token-1',
      oauth2callbackurl: 'https://callback.example.com',
      authorization: 'Bearer abc',
      'x-amzn-bedrock-agentcore-runtime-custom-tenant': 'acme',
      'content-type': 'application/json',
      'x-amz-date': '20260728T000000Z',
    })

    expect(context).toEqual({
      sessionId: 'sess-1',
      requestId: 'req-1',
      workloadAccessToken: 'token-1',
      oauth2CallbackUrl: 'https://callback.example.com',
      // The allowlist forwards everything not restricted — including the
      // token/callback headers, matching the Python SDK's builder.
      headers: {
        authorization: 'Bearer abc',
        workloadaccesstoken: 'token-1',
        oauth2callbackurl: 'https://callback.example.com',
        'x-amzn-bedrock-agentcore-runtime-custom-tenant': 'acme',
      },
    })
  })

  it('generates a request id when the header is absent', () => {
    const context = extractA2AContext({})
    expect(context.requestId).toMatch(/^[0-9a-f-]{36}$/)
    expect(context.sessionId).toBe('')
  })

  it('joins repeated header values with a comma', () => {
    const context = extractA2AContext({ 'x-custom-multi': ['a', 'b'] })
    expect(context.headers['x-custom-multi']).toBe('a, b')
  })
})
