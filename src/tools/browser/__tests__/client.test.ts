import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Browser } from '../client.js'
import type { SessionConfiguration } from '../types.js'

// Track session state for mocking
const mockSessionState = new Map<
  string,
  {
    sessionId: string
    identifier: string
    sessionName: string
    status: 'READY' | 'TERMINATED'
    createdAt: Date
  }
>()

vi.mock('@aws-sdk/client-bedrock-agentcore', () => {
  const mockSend = vi.fn((command: any) => {
    // Mock response for StartBrowserSessionCommand
    if (command._commandName === 'StartBrowserSessionCommand') {
      const sessionId = `session-${Date.now()}-${Math.random().toString(36).substring(7)}`
      const sessionName = command.input.name || 'default'
      const identifier = command.input.browserIdentifier || 'aws.browser.v1'

      mockSessionState.set(sessionName, {
        sessionId,
        identifier,
        sessionName,
        status: 'READY',
        createdAt: new Date(),
      })

      return Promise.resolve({
        browserIdentifier: identifier,
        sessionId,
        name: sessionName,
        createdAt: new Date(),
      })
    }

    // Mock response for StopBrowserSessionCommand
    if (command._commandName === 'StopBrowserSessionCommand') {
      const sessionId = command.input.sessionId
      const session = Array.from(mockSessionState.values()).find((s) => s.sessionId === sessionId)

      if (session) {
        session.status = 'TERMINATED'
        mockSessionState.delete(session.sessionName)
      }

      return Promise.resolve({
        browserIdentifier: command.input.browserIdentifier,
        sessionId: command.input.sessionId,
        lastUpdatedAt: new Date(),
      })
    }

    // Mock response for GetBrowserSessionCommand
    if (command._commandName === 'GetBrowserSessionCommand') {
      return Promise.resolve({
        sessionId: command.input.sessionId,
        browserIdentifier: command.input.browserIdentifier,
        name: 'test-session',
        status: 'READY',
        createdAt: new Date('2024-01-01T00:00:00Z'),
        lastUpdatedAt: new Date('2024-01-01T00:00:00Z'),
        sessionTimeoutSeconds: 3600,
      })
    }

    // Mock response for ListBrowserSessionsCommand
    if (command._commandName === 'ListBrowserSessionsCommand') {
      const mockSessions = [
        {
          sessionId: 'session-1',
          name: 'session-1',
          status: 'READY',
          createdAt: new Date('2024-01-01T00:00:00Z'),
          lastUpdatedAt: new Date('2024-01-01T00:01:00Z'),
        },
        {
          sessionId: 'session-2',
          name: 'session-2',
          status: 'TERMINATED',
          createdAt: new Date('2024-01-01T00:00:00Z'),
          lastUpdatedAt: new Date('2024-01-01T00:02:00Z'),
        },
      ]

      let filtered = command.input.status
        ? mockSessions.filter((s: any) => s.status === command.input.status)
        : mockSessions
      const maxResults = command.input.maxResults || 10
      filtered = filtered.slice(0, maxResults)

      return Promise.resolve({
        items: filtered,
        nextToken: filtered.length >= maxResults ? 'next-token' : undefined,
      })
    }

    // Mock response for UpdateBrowserStreamCommand
    if (command._commandName === 'UpdateBrowserStreamCommand') {
      return Promise.resolve({
        browserIdentifier: command.input.browserIdentifier,
        sessionId: command.input.sessionId,
        streams: {
          automationStream: {
            streamEndpoint: 'wss://example.com/stream',
            streamStatus: command.input.streamUpdate.automationStreamUpdate.streamStatus,
          },
        },
      })
    }

    return Promise.resolve({})
  })

  return {
    BedrockAgentCoreClient: vi.fn(function (this: any) {
      this.send = mockSend
      return this
    }),
    StartBrowserSessionCommand: vi.fn(function (this: any, input: any) {
      this._commandName = 'StartBrowserSessionCommand'
      this.input = input
      return this
    }),
    StopBrowserSessionCommand: vi.fn(function (this: any, input: any) {
      this._commandName = 'StopBrowserSessionCommand'
      this.input = input
      return this
    }),
    GetBrowserSessionCommand: vi.fn(function (this: any, input: any) {
      this._commandName = 'GetBrowserSessionCommand'
      this.input = input
      return this
    }),
    ListBrowserSessionsCommand: vi.fn(function (this: any, input: any) {
      this._commandName = 'ListBrowserSessionsCommand'
      this.input = input
      return this
    }),
    UpdateBrowserStreamCommand: vi.fn(function (this: any, input: any) {
      this._commandName = 'UpdateBrowserStreamCommand'
      this.input = input
      return this
    }),
  }
})

// Mock credential providers for WebSocket URL generation
vi.mock('@aws-sdk/credential-providers', () => ({
  fromNodeProviderChain: vi.fn(() => {
    return async () => ({
      accessKeyId: 'mock-access-key',
      secretAccessKey: 'mock-secret-key',
      sessionToken: 'mock-session-token',
    })
  }),
}))

// Mock smithy signing
vi.mock('@smithy/signature-v4', () => ({
  SignatureV4: vi.fn(function (this: any) {
    this.sign = vi.fn(async (request: any) => ({
      ...request,
      headers: {
        ...request.headers,
        Authorization: 'AWS4-HMAC-SHA256 Credential=mock-access-key/20250114/us-east-1/bedrock-agentcore/aws4_request',
        'X-Amz-Date': '20250114T000000Z',
        'X-Amz-Security-Token': 'mock-session-token',
      },
    }))
    this.presign = vi.fn(async (request: any) => ({
      ...request,
      query: {
        'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
        'X-Amz-Credential': 'mock-access-key/20250114/us-east-1/bedrock-agentcore/aws4_request',
        'X-Amz-Date': '20250114T000000Z',
        'X-Amz-Expires': '300',
        'X-Amz-SignedHeaders': 'host',
        'X-Amz-Signature': 'mock-signature',
      },
    }))
    return this
  }),
}))

describe('Browser', () => {
  beforeEach(() => {
    mockSessionState.clear()
  })

  describe('constructor', () => {
    it('creates client with required region', () => {
      const client = new Browser({ region: 'us-east-1' })
      expect(client).toBeDefined()
      expect(client.region).toBe('us-east-1')
    })

    it('uses default identifier when not provided', () => {
      const client = new Browser({ region: 'us-east-1' })
      expect(client.identifier).toBe('aws.browser.v1')
    })

    it('uses custom identifier when provided', () => {
      const client = new Browser({
        region: 'us-east-1',
        identifier: 'custom.browser.v2',
      })
      expect(client.identifier).toBe('custom.browser.v2')
    })
  })

  describe('startSession', () => {
    let client: Browser

    beforeEach(() => {
      client = new Browser({ region: 'us-east-1' })
    })

    it('starts session with default name when sessionName omitted', async () => {
      const session = await client.startSession()

      expect(session).toBeDefined()
      expect(session.sessionName).toBe('default')
      expect(session.sessionId).toBeDefined()
      expect(session.createdAt).toBeInstanceOf(Date)
    })

    it('starts session with provided name', async () => {
      const session = await client.startSession({
        sessionName: 'test-session',
      })

      expect(session.sessionName).toBe('test-session')
      expect(session.sessionId).toBeDefined()
    })

    it('accepts session configuration with various optional parameters', async () => {
      // Test defaults
      const session1 = await client.startSession()
      expect(session1).toBeDefined()
      await client.stopSession()

      // Test custom timeout
      const session2 = await client.startSession({ timeout: 7200 })
      expect(session2).toBeDefined()
      await client.stopSession()

      // Test viewport
      const session3 = await client.startSession({
        viewport: { width: 1920, height: 1080 },
      })
      expect(session3).toBeDefined()
    })

    it('throws error when session already active', async () => {
      await client.startSession()

      await expect(client.startSession()).rejects.toThrow(/already active/)
    })

    it('includes proxyConfiguration in command input when provided', async () => {
      const proxyConfig = {
        proxies: [
          {
            externalProxy: {
              server: 'proxy.example.com',
              port: 8080,
              domainPatterns: ['.example.com'],
              credentials: {
                basicAuth: {
                  secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:proxy-creds',
                },
              },
            },
          },
        ],
        bypass: {
          domainPatterns: ['internal.example.com'],
        },
      }

      const StartBrowserSessionCommand = (await import('@aws-sdk/client-bedrock-agentcore')).StartBrowserSessionCommand
      const commandSpy = vi.mocked(StartBrowserSessionCommand)

      await client.startSession({ proxyConfiguration: proxyConfig })

      const lastCall = commandSpy.mock.calls[commandSpy.mock.calls.length - 1]
      expect(lastCall![0]).toHaveProperty('proxyConfiguration')
      expect(lastCall![0]!.proxyConfiguration).toEqual(proxyConfig)
    })

    it('includes extensions in command input when provided', async () => {
      const extensions = [
        {
          location: {
            s3: {
              bucket: 'my-extensions',
              prefix: 'extension1.zip',
            },
          },
        },
        {
          location: {
            s3: {
              bucket: 'my-extensions',
              prefix: 'extension2.zip',
              versionId: 'v123',
            },
          },
        },
      ]

      const StartBrowserSessionCommand = (await import('@aws-sdk/client-bedrock-agentcore')).StartBrowserSessionCommand
      const commandSpy = vi.mocked(StartBrowserSessionCommand)

      await client.startSession({ extensions })

      const lastCall = commandSpy.mock.calls[commandSpy.mock.calls.length - 1]
      expect(lastCall![0]).toHaveProperty('extensions')
      expect(lastCall![0]!.extensions).toEqual(extensions)
    })

    it('includes profileConfiguration in command input when provided', async () => {
      const profileConfig = {
        profileIdentifier: 'my-profile-id',
      }

      const StartBrowserSessionCommand = (await import('@aws-sdk/client-bedrock-agentcore')).StartBrowserSessionCommand
      const commandSpy = vi.mocked(StartBrowserSessionCommand)

      await client.startSession({ profileConfiguration: profileConfig })

      const lastCall = commandSpy.mock.calls[commandSpy.mock.calls.length - 1]
      expect(lastCall![0]).toHaveProperty('profileConfiguration')
      expect(lastCall![0]!.profileConfiguration).toEqual(profileConfig)
    })

    it('includes all new params together when provided', async () => {
      const proxyConfig = {
        proxies: [
          {
            externalProxy: {
              server: 'proxy.example.com',
              port: 8080,
            },
          },
        ],
      }

      const extensions = [
        {
          location: {
            s3: {
              bucket: 'extensions-bucket',
              prefix: 'ext.zip',
            },
          },
        },
      ]

      const profileConfig = {
        profileIdentifier: 'my-profile-id',
      }

      const StartBrowserSessionCommand = (await import('@aws-sdk/client-bedrock-agentcore')).StartBrowserSessionCommand
      const commandSpy = vi.mocked(StartBrowserSessionCommand)

      await client.startSession({
        sessionName: 'full-config-test',
        timeout: 7200,
        viewport: { width: 1920, height: 1080 },
        proxyConfiguration: proxyConfig,
        extensions,
        profileConfiguration: profileConfig,
      })

      const lastCall = commandSpy.mock.calls[commandSpy.mock.calls.length - 1]
      expect(lastCall![0]).toHaveProperty('proxyConfiguration')
      expect(lastCall![0]).toHaveProperty('extensions')
      expect(lastCall![0]).toHaveProperty('profileConfiguration')
      expect(lastCall![0]!.proxyConfiguration).toEqual(proxyConfig)
      expect(lastCall![0]!.extensions).toEqual(extensions)
      expect(lastCall![0]!.profileConfiguration).toEqual(profileConfig)
    })

    it('omits undefined new params from command input', async () => {
      const StartBrowserSessionCommand = (await import('@aws-sdk/client-bedrock-agentcore')).StartBrowserSessionCommand
      const commandSpy = vi.mocked(StartBrowserSessionCommand)

      await client.startSession({ sessionName: 'basic-test' })

      const lastCall = commandSpy.mock.calls[commandSpy.mock.calls.length - 1]
      expect(lastCall![0]).not.toHaveProperty('proxyConfiguration')
      expect(lastCall![0]).not.toHaveProperty('extensions')
      expect(lastCall![0]).not.toHaveProperty('profileConfiguration')
    })
  })

  describe('stopSession', () => {
    let client: Browser

    beforeEach(() => {
      client = new Browser({ region: 'us-east-1' })
    })

    it('stops active session', async () => {
      await client.startSession()
      await client.stopSession()

      // Should allow starting a new session after stopping
      await expect(client.startSession()).resolves.toBeDefined()
    })

    it('gracefully handles stopping non-existent session without throwing error', async () => {
      // Should not throw error when no session exists
      await expect(client.stopSession()).resolves.not.toThrow()
    })
  })

  describe('getSession', () => {
    let client: Browser

    beforeEach(() => {
      client = new Browser({ region: 'us-east-1' })
    })

    it('gets current session details', async () => {
      await client.startSession({ sessionName: 'test-session' })

      const session = await client.getSession()

      expect(session).toBeDefined()
      expect(session.sessionId).toBeDefined()
      expect(session.browserIdentifier).toBe('aws.browser.v1')
      expect(session.name).toBe('test-session')
      expect(session.status).toBe('READY')
      expect(session.createdAt).toBeInstanceOf(Date)
      expect(session.lastUpdatedAt).toBeInstanceOf(Date)
      expect(session.sessionTimeoutSeconds).toBe(3600)
    })

    it('throws error when no session is active', async () => {
      await expect(client.getSession()).rejects.toThrow(
        'Browser ID and Session ID must be provided or available from current session'
      )
    })

    it('gets specific session by ID', async () => {
      const session = await client.getSession({
        browserId: 'aws.browser.v1',
        sessionId: 'specific-session-id',
      })

      expect(session).toBeDefined()
      expect(session.sessionId).toBe('specific-session-id')
      expect(session.status).toBe('READY')
    })
  })

  describe('listSessions', () => {
    let client: Browser

    beforeEach(() => {
      client = new Browser({ region: 'us-east-1' })
    })

    it('lists all sessions', async () => {
      const response = await client.listSessions()

      expect(response).toBeDefined()
      expect(response.items).toBeInstanceOf(Array)
      expect(response.items.length).toBeGreaterThan(0)
      expect(response.items[0]!.sessionId).toBeDefined()
      expect(response.items[0]!.name).toBeDefined()
      expect(response.items[0]!.status).toBeDefined()
    })

    it('filters sessions by status', async () => {
      const response = await client.listSessions({ status: 'READY' })

      expect(response).toBeDefined()
      expect(response.items).toBeInstanceOf(Array)
      expect(response.items.every((item) => item.status === 'READY')).toBe(true)
    })

    it('respects maxResults parameter', async () => {
      const response = await client.listSessions({ maxResults: 1 })

      expect(response).toBeDefined()
      expect(response.items.length).toBe(1)
      expect(response.nextToken).toBeDefined()
    })

    it('supports pagination', async () => {
      const firstPage = await client.listSessions({ maxResults: 1 })
      expect(firstPage.nextToken).toBeDefined()

      const secondPage = await client.listSessions({
        maxResults: 1,
        nextToken: firstPage.nextToken!,
      })

      expect(secondPage).toBeDefined()
      expect(secondPage.items).toBeInstanceOf(Array)
    })

    it('can specify different browser ID', async () => {
      const response = await client.listSessions({
        browserId: 'custom.browser.v1',
      })

      expect(response).toBeDefined()
      expect(response.items).toBeInstanceOf(Array)
    })
  })

  describe('generateWebSocketUrl', () => {
    let client: Browser

    beforeEach(() => {
      client = new Browser({ region: 'us-east-1' })
    })

    it('generates WebSocket URL for active session', async () => {
      await client.startSession()
      const wsConnection = await client.generateWebSocketUrl()

      expect(wsConnection.url).toMatch(/^wss:\/\//)
      expect(wsConnection.url).toContain('browser-streams')
      expect(wsConnection.url).toContain('automation')
      expect(wsConnection.headers).toHaveProperty('Authorization')
      expect(wsConnection.headers).toHaveProperty('X-Amz-Date')
    })

    it('throws error when no active session', async () => {
      await expect(client.generateWebSocketUrl()).rejects.toThrow(/No active session/)
    })

    it('includes session ID and identifier in WebSocket URL', async () => {
      const session = await client.startSession()
      const wsConnection = await client.generateWebSocketUrl()

      expect(wsConnection.url).toContain(session.sessionId)
      expect(wsConnection.url).toContain(client.identifier)
    })
  })

  describe('generateLiveViewUrl', () => {
    let client: Browser

    beforeEach(() => {
      client = new Browser({ region: 'us-east-1' })
    })

    it('generates presigned HTTPS URL for active session', async () => {
      await client.startSession()
      const url = await client.generateLiveViewUrl()

      expect(url).toMatch(/^https:\/\//)
      expect(url).toContain('browser-streams')
      expect(url).toContain('live-view')
      expect(url).toContain('X-Amz-Signature')
      expect(url).toContain('X-Amz-Credential')
      expect(url).toContain('X-Amz-Algorithm')
    })

    it('throws error when no active session', async () => {
      await expect(client.generateLiveViewUrl()).rejects.toThrow(/No active session/)
    })

    it('includes session ID and identifier in URL', async () => {
      const session = await client.startSession()
      const url = await client.generateLiveViewUrl()

      expect(url).toContain(session.sessionId)
      expect(url).toContain(client.identifier)
    })

    it('does not use wss protocol', async () => {
      await client.startSession()
      const url = await client.generateLiveViewUrl()

      expect(url).not.toMatch(/^wss:\/\//)
    })

    it('uses query params not headers for auth', async () => {
      await client.startSession()
      const url = await client.generateLiveViewUrl()

      expect(url).toContain('X-Amz-Expires')
      expect(url).not.toContain('/automation')
    })
  })

  describe('updateBrowserStream', () => {
    let streamClient: Browser

    beforeEach(() => {
      streamClient = new Browser({ region: 'us-east-1' })
    })

    it('enables automation stream for current session', async () => {
      await streamClient.startSession()
      const result = await streamClient.updateBrowserStream({ streamStatus: 'ENABLED' })

      expect(result).toBeDefined()
      expect(result.streamEndpoint).toBe('wss://example.com/stream')
      expect(result.streamStatus).toBe('ENABLED')
    })

    it('disables automation stream for current session', async () => {
      await streamClient.startSession()
      const result = await streamClient.updateBrowserStream({ streamStatus: 'DISABLED' })

      expect(result).toBeDefined()
      expect(result.streamEndpoint).toBe('wss://example.com/stream')
      expect(result.streamStatus).toBe('DISABLED')
    })

    it('throws error when no active session', async () => {
      await expect(streamClient.updateBrowserStream({ streamStatus: 'ENABLED' })).rejects.toThrow(
        /Browser ID and Session ID must be provided/
      )
    })

    it('updates stream with explicit browser and session IDs', async () => {
      const result = await streamClient.updateBrowserStream({
        browserId: 'custom-browser',
        sessionId: 'custom-session',
        streamStatus: 'ENABLED',
      })

      expect(result).toBeDefined()
      expect(result.streamStatus).toBe('ENABLED')
    })
  })

  describe('SessionConfiguration', () => {
    let client: Browser

    beforeEach(() => {
      client = new Browser({ region: 'us-east-1' })
    })

    it('can be spread into startSession params', async () => {
      const config: SessionConfiguration = {
        viewport: { width: 1920, height: 1080 },
        proxyConfiguration: {
          proxies: [
            {
              externalProxy: {
                server: 'proxy.example.com',
                port: 8080,
              },
            },
          ],
        },
        extensions: [
          {
            location: {
              s3: {
                bucket: 'my-extensions',
                prefix: 'extension.zip',
              },
            },
          },
        ],
        profileConfiguration: {
          profileIdentifier: 'my-profile-id',
        },
      }

      const StartBrowserSessionCommand = (await import('@aws-sdk/client-bedrock-agentcore')).StartBrowserSessionCommand
      const commandSpy = vi.mocked(StartBrowserSessionCommand)

      await client.startSession({ sessionName: 'config-test', ...config })

      const lastCall = commandSpy.mock.calls[commandSpy.mock.calls.length - 1]
      expect(lastCall![0]!.proxyConfiguration).toEqual(config.proxyConfiguration)
      expect(lastCall![0]!.extensions).toEqual(config.extensions)
      expect(lastCall![0]!.profileConfiguration).toEqual(config.profileConfiguration)
    })

    it('works with only a subset of fields', async () => {
      const config: SessionConfiguration = {
        proxyConfiguration: {
          proxies: [
            {
              externalProxy: {
                server: 'proxy.example.com',
                port: 3128,
              },
            },
          ],
        },
      }

      const StartBrowserSessionCommand = (await import('@aws-sdk/client-bedrock-agentcore')).StartBrowserSessionCommand
      const commandSpy = vi.mocked(StartBrowserSessionCommand)

      await client.startSession({ sessionName: 'partial-config', ...config })

      const lastCall = commandSpy.mock.calls[commandSpy.mock.calls.length - 1]
      expect(lastCall![0]!.proxyConfiguration).toEqual(config.proxyConfiguration)
      expect(lastCall![0]).not.toHaveProperty('extensions')
      expect(lastCall![0]).not.toHaveProperty('profileConfiguration')
    })

    it('passes through malformed proxy config without client-side validation', async () => {
      // The SDK passes configs through to the API without validation;
      // the API is responsible for rejecting invalid configs.
      const malformedProxy = {
        proxies: [] as any[],
      }

      const StartBrowserSessionCommand = (await import('@aws-sdk/client-bedrock-agentcore')).StartBrowserSessionCommand
      const commandSpy = vi.mocked(StartBrowserSessionCommand)

      await client.startSession({ proxyConfiguration: malformedProxy })

      const lastCall = commandSpy.mock.calls[commandSpy.mock.calls.length - 1]
      expect(lastCall![0]!.proxyConfiguration).toEqual(malformedProxy)
    })
  })
})
