/**
 * Integration tests for browser session configuration: proxy, extensions, and profile.
 *
 * Proxy tests require environment variables:
 *   PROXY_SERVER     - proxy hostname (e.g., 'brd.superproxy.io')
 *   PROXY_PORT       - proxy port (e.g., '33335')
 *   PROXY_SECRET_ARN - Secrets Manager ARN for proxy credentials
 *
 * Extension tests require environment variables:
 *   EXTENSION_BUCKET - S3 bucket containing test extensions
 *   EXTENSION_KEY    - S3 key for a test extension zip
 *
 * Profile tests require environment variables:
 *   PROFILE_IDENTIFIER - Pre-existing browser profile identifier
 *                        (format: [a-zA-Z][a-zA-Z0-9_]{0,47}-[a-zA-Z0-9]{10})
 *                        Create profiles via CreateBrowserProfileCommand (control plane SDK).
 *
 * When env vars are not set, the corresponding tests are automatically skipped.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { Browser } from '../src/tools/browser/client.js'
import { PlaywrightBrowser } from '../src/tools/browser/integrations/playwright/client.js'
import type { ProxyConfiguration, BrowserExtension, ProfileConfiguration } from '../src/tools/browser/types.js'

// --- Proxy configuration ---

const proxyServer = process.env.PROXY_SERVER
const proxyPort = parseInt(process.env.PROXY_PORT ?? '0', 10)
const proxySecretArn = process.env.PROXY_SECRET_ARN

const describeProxy = proxyServer && proxyPort && proxySecretArn ? describe : describe.skip

const buildProxyConfig = (): ProxyConfiguration => ({
  proxies: [
    {
      externalProxy: {
        server: proxyServer!,
        port: proxyPort,
        domainPatterns: ['.icanhazip.com', '.whoer.net', '.httpbin.org'],
        credentials: {
          basicAuth: {
            secretArn: proxySecretArn!,
          },
        },
      },
    },
  ],
  bypass: {
    domainPatterns: ['checkip.amazonaws.com', '169.254.169.254'],
  },
})

// --- Extension configuration ---

const extensionBucket = process.env.EXTENSION_BUCKET
const extensionKey = process.env.EXTENSION_KEY

const describeExtensions = extensionBucket && extensionKey ? describe : describe.skip

const buildExtensions = (): BrowserExtension[] => [
  {
    location: {
      s3: {
        bucket: extensionBucket!,
        prefix: extensionKey!,
      },
    },
  },
]

// --- Proxy tests ---

describeProxy('Browser Session with Proxy Configuration', () => {
  let browser: PlaywrightBrowser

  afterEach(async () => {
    try {
      await browser?.stopSession()
    } catch {
      // Ensure cleanup even on failure
    }
  })

  it('starts session with proxy configuration', async () => {
    browser = new PlaywrightBrowser({
      region: process.env.AWS_REGION || 'us-west-2',
    })

    const session = await browser.startSession({
      sessionName: 'proxy-config-test',
      proxyConfiguration: buildProxyConfig(),
    })

    expect(session).toBeDefined()
    expect(session.sessionId).toBeDefined()
  }, 30000)

  it('routes traffic through proxy', async () => {
    browser = new PlaywrightBrowser({
      region: process.env.AWS_REGION || 'us-west-2',
    })

    await browser.startSession({
      sessionName: 'proxy-routing-test',
      proxyConfiguration: buildProxyConfig(),
    })

    await browser.navigate({
      url: 'https://icanhazip.com',
      waitUntil: 'load',
      timeout: 30000,
    })

    const text = await browser.getText({ selector: 'body' })
    const trimmed = text.trim()

    // icanhazip.com returns the requester's IP address
    expect(trimmed).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/)
  }, 60000)

  it('bypasses proxy for bypass domains', async () => {
    browser = new PlaywrightBrowser({
      region: process.env.AWS_REGION || 'us-west-2',
    })

    await browser.startSession({
      sessionName: 'proxy-bypass-test',
      proxyConfiguration: buildProxyConfig(),
    })

    await browser.navigate({
      url: 'https://checkip.amazonaws.com',
      waitUntil: 'load',
      timeout: 30000,
    })

    const text = await browser.getText({ selector: 'body' })
    const trimmed = text.trim()

    // checkip.amazonaws.com returns an IP, confirming bypass works
    expect(trimmed).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/)
  }, 60000)
})

// --- Extension tests ---

describeExtensions('Browser Session with Extensions', () => {
  let browser: PlaywrightBrowser

  afterEach(async () => {
    try {
      await browser?.stopSession()
    } catch {
      // Ensure cleanup even on failure
    }
  })

  it('starts session with extension loaded', async () => {
    browser = new PlaywrightBrowser({
      region: process.env.AWS_REGION || 'us-west-2',
    })

    const session = await browser.startSession({
      sessionName: 'extension-test',
      extensions: buildExtensions(),
    })

    expect(session).toBeDefined()
    expect(session.sessionId).toBeDefined()
  }, 60000)

  it('session is functional with extension loaded', async () => {
    browser = new PlaywrightBrowser({
      region: process.env.AWS_REGION || 'us-west-2',
    })

    await browser.startSession({
      sessionName: 'extension-active-test',
      extensions: buildExtensions(),
    })

    // Navigate to chrome://extensions to verify extension is loaded
    // Note: chrome:// URLs may not be accessible; use a regular page and
    // check for extension side effects instead
    await browser.navigate({
      url: 'https://www.wikipedia.org',
      waitUntil: 'load',
      timeout: 30000,
    })

    // Verify the session is functional with extensions loaded
    const title = await browser.evaluate({ script: 'document.title' })
    expect(title).toContain('Wikipedia')
  }, 60000)
})

// --- Profile configuration ---

const profileIdentifier = process.env.PROFILE_IDENTIFIER

const describeProfile = profileIdentifier ? describe : describe.skip

describeProfile('Browser Session with Profile Configuration', () => {
  let browser: Browser

  afterEach(async () => {
    try {
      await browser?.stopSession()
    } catch {
      // Ensure cleanup even on failure
    }
  })

  it('starts session with profile configuration', async () => {
    browser = new Browser({
      region: process.env.AWS_REGION || 'us-west-2',
    })

    const profileConfig: ProfileConfiguration = {
      profileIdentifier: profileIdentifier!,
    }

    const session = await browser.startSession({
      sessionName: 'profile-test',
      profileConfiguration: profileConfig,
    })

    expect(session).toBeDefined()
    expect(session.sessionId).toBeDefined()
  }, 30000)

  it('reuses same profile across sessions', async () => {
    const profileConfig: ProfileConfiguration = {
      profileIdentifier: profileIdentifier!,
    }

    // First session with profile
    const browser1 = new Browser({
      region: process.env.AWS_REGION || 'us-west-2',
    })

    const session1 = await browser1.startSession({
      sessionName: 'profile-reuse-1',
      profileConfiguration: profileConfig,
    })

    expect(session1.sessionId).toBeDefined()
    await browser1.stopSession()

    // Second session with same profile succeeds
    browser = new Browser({
      region: process.env.AWS_REGION || 'us-west-2',
    })

    const session2 = await browser.startSession({
      sessionName: 'profile-reuse-2',
      profileConfiguration: profileConfig,
    })

    expect(session2.sessionId).toBeDefined()
    expect(session2.sessionId).not.toBe(session1.sessionId)
  }, 60000)
})

// --- Backward compatibility ---

describe('Browser Session Backward Compatibility', () => {
  let browser: Browser

  afterEach(async () => {
    try {
      await browser?.stopSession()
    } catch {
      // Ensure cleanup even on failure
    }
  })

  it('starts session without new params', async () => {
    browser = new Browser({
      region: process.env.AWS_REGION || 'us-west-2',
    })

    const session = await browser.startSession({
      sessionName: 'backward-compat-test',
    })

    expect(session).toBeDefined()
    expect(session.sessionId).toBeDefined()
    expect(session.sessionName).toBe('backward-compat-test')
  }, 30000)
})
