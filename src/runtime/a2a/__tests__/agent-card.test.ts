import { describe, it, expect, afterEach, vi } from 'vitest'
import { buildAgentCard, withJsonRpcUrl } from '../agent-card.js'

describe('buildAgentCard', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('builds a card with v1.0 and legacy v0.3 JSONRPC interfaces', () => {
    const card = buildAgentCard({ name: 'my-agent', description: 'demo', url: 'http://localhost:9000/' })

    expect(card.name).toBe('my-agent')
    expect(card.description).toBe('demo')
    expect(card.capabilities?.streaming).toBe(true)
    const bindings = card.supportedInterfaces.map((i) => ({ url: i.url, protocolVersion: i.protocolVersion }))
    expect(bindings).toEqual([
      { url: 'http://localhost:9000/', protocolVersion: '1.0' },
      { url: 'http://localhost:9000/', protocolVersion: '0.3' },
    ])
  })

  it('resolves the URL from AGENTCORE_RUNTIME_URL when no url is given', () => {
    vi.stubEnv('AGENTCORE_RUNTIME_URL', 'https://runtime.example.com/invocations/')
    const card = buildAgentCard({ name: 'deployed', description: 'x' })
    expect(card.supportedInterfaces[0]!.url).toBe('https://runtime.example.com/invocations/')
  })

  it('appends a trailing slash to a slashless AGENTCORE_RUNTIME_URL', () => {
    // The platform injects the env value without a trailing slash; clients
    // resolving the well-known card path relative to a slashless URL lose
    // the final path segment.
    vi.stubEnv('AGENTCORE_RUNTIME_URL', 'https://runtime.example.com/invocations')
    const card = buildAgentCard({ name: 'deployed', description: 'x' })
    expect(card.supportedInterfaces[0]!.url).toBe('https://runtime.example.com/invocations/')
  })

  it('falls back to localhost with the given port', () => {
    const card = buildAgentCard({ name: 'local', description: 'x', port: 3005 })
    expect(card.supportedInterfaces[0]!.url).toBe('http://localhost:3005/')
  })

  it('normalizes partial skills to complete AgentSkill objects', () => {
    const card = buildAgentCard({
      name: 'skilled',
      description: 'x',
      skills: [{ id: 'main', name: 'main', description: 'primary skill' }],
    })
    expect(card.skills).toEqual([
      {
        id: 'main',
        name: 'main',
        description: 'primary skill',
        tags: [],
        examples: [],
        inputModes: [],
        outputModes: [],
        securityRequirements: [],
      },
    ])
  })
})

describe('withJsonRpcUrl', () => {
  it('rewrites every JSONRPC interface URL', () => {
    const card = buildAgentCard({ name: 'stale', description: 'x', url: 'http://stale:9000/' })
    const updated = withJsonRpcUrl(card, 'https://fresh.example.com/')

    expect(updated.supportedInterfaces.map((i) => i.url)).toEqual([
      'https://fresh.example.com/',
      'https://fresh.example.com/',
    ])
    // Original card is not mutated
    expect(card.supportedInterfaces[0]!.url).toBe('http://stale:9000/')
  })

  it('appends a JSONRPC interface when the card has none', () => {
    const card = { ...buildAgentCard({ name: 'no-rpc', description: 'x' }), supportedInterfaces: [] }
    const updated = withJsonRpcUrl(card, 'https://fresh.example.com/')
    expect(updated.supportedInterfaces).toEqual([
      { url: 'https://fresh.example.com/', protocolBinding: 'JSONRPC', tenant: '', protocolVersion: '1.0' },
    ])
  })
})
