/**
 * Integration tests for PlaywrightBrowser with real Wikipedia website
 *
 * These tests validate end-to-end browser automation on a real public website.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PlaywrightBrowser } from '../src/tools/browser/integrations/playwright/client.js'

describe('PlaywrightBrowser Wikipedia Integration', () => {
  let browser: PlaywrightBrowser

  beforeAll(async () => {
    browser = new PlaywrightBrowser({
      region: process.env.AWS_REGION || 'us-west-2',
    })
    await browser.startSession({
      sessionName: 'wikipedia-test',
      viewport: { width: 1280, height: 720 },
    })
  })

  afterAll(async () => {
    await browser.stopSession()
  })

  it('navigates to Wikipedia homepage', async () => {
    await browser.navigate({
      url: 'https://www.wikipedia.org',
      waitUntil: 'load',
    })

    const html = await browser.getHtml()
    expect(html).toContain('Wikipedia')
  })

  it('gets page title text', async () => {
    await browser.navigate({
      url: 'https://www.wikipedia.org',
    })

    const text = await browser.getText({ selector: 'h1' })
    expect(text).toBeTruthy()
    expect(text.length).toBeGreaterThan(0)
  })

  it('searches for an article by typing and clicking', async () => {
    await browser.navigate({
      url: 'https://en.wikipedia.org/wiki/Main_Page',
      waitUntil: 'load',
      timeout: 60000,
    })

    // Wait for search input to be visible and ready
    await browser.waitForSelector({
      selector: '#searchInput',
      timeout: 60000,
      state: 'visible',
    })

    // Fill search box (more reliable than type)
    await browser.fill({
      selector: '#searchInput',
      value: 'TypeScript',
      timeout: 60000,
    })

    // Press Enter to search
    await browser.pressKey('Enter')

    // Wait for the article heading to appear
    await browser.waitForSelector({
      selector: '#firstHeading',
      timeout: 60000,
      state: 'visible',
    })

    // Check we're on TypeScript article
    const html = await browser.getHtml()
    expect(html).toContain('TypeScript')
  }, 90000)

  it('extracts article content', async () => {
    await browser.navigate({
      url: 'https://en.wikipedia.org/wiki/TypeScript',
      waitUntil: 'load',
    })

    // Get page title
    const title = await browser.getText({
      selector: '#firstHeading',
    })

    expect(title).toContain('TypeScript')

    // Get content
    const html = await browser.getHtml({
      selector: '#mw-content-text',
    })

    expect(html).toBeTruthy()
    expect(html.length).toBeGreaterThan(100)
  })

  it('evaluates JavaScript on the page', async () => {
    await browser.navigate({
      url: 'https://www.wikipedia.org',
    })

    const result = await browser.evaluate({
      script: 'document.title',
    })

    expect(result).toContain('Wikipedia')
  })

  it('navigates back and forward', async () => {
    // Navigate to homepage
    await browser.navigate({
      url: 'https://www.wikipedia.org',
      waitUntil: 'load',
      timeout: 60000,
    })

    // Wait for a key element to ensure page is fully loaded
    await browser.waitForSelector({
      selector: 'h1',
      timeout: 30000,
      state: 'visible',
    })

    // Navigate to TypeScript article
    await browser.navigate({
      url: 'https://en.wikipedia.org/wiki/TypeScript',
      waitUntil: 'load',
      timeout: 60000,
    })

    // Wait for article heading to ensure page is fully loaded
    await browser.waitForSelector({
      selector: '#firstHeading',
      timeout: 30000,
      state: 'visible',
    })

    // Go back
    await browser.back()

    // Wait for homepage element after going back
    await browser.waitForSelector({
      selector: 'h1',
      timeout: 60000,
      state: 'visible',
    })

    const backUrl = await browser.evaluate({
      script: 'window.location.href',
    })
    expect(backUrl).toContain('wikipedia.org')

    // Go forward
    await browser.forward()

    // Wait for article heading after going forward
    await browser.waitForSelector({
      selector: '#firstHeading',
      timeout: 60000,
      state: 'visible',
    })

    const forwardUrl = await browser.evaluate({
      script: 'window.location.href',
    })
    expect(forwardUrl).toContain('TypeScript')
  }, 120000)

  it('takes a screenshot', async () => {
    await browser.navigate({
      url: 'https://www.wikipedia.org',
    })

    const screenshot = await browser.screenshot({
      encoding: 'base64',
      type: 'png',
    })

    expect(screenshot).toBeTruthy()
    expect(typeof screenshot).toBe('string')
    expect((screenshot as string).length).toBeGreaterThan(1000)
  })

  it('gets and sets cookies', async () => {
    await browser.navigate({
      url: 'https://www.wikipedia.org',
    })

    // Get cookies
    const cookies = await browser.getCookies()
    expect(Array.isArray(cookies)).toBe(true)

    // Set a cookie
    await browser.setCookies({
      cookies: [
        {
          name: 'test_cookie',
          value: 'test_value',
          domain: '.wikipedia.org',
          path: '/',
        },
      ],
    })

    // Verify cookie was set
    const updatedCookies = await browser.getCookies()
    const testCookie = updatedCookies.find((c: any) => c.name === 'test_cookie')
    expect(testCookie).toBeDefined()
    expect(testCookie?.value).toBe('test_value')
  })

  it('presses keyboard keys', async () => {
    await browser.navigate({
      url: 'https://en.wikipedia.org/wiki/Main_Page',
      waitUntil: 'load',
      timeout: 60000,
    })

    // Wait for search input to be visible and ready
    await browser.waitForSelector({
      selector: '#searchInput',
      timeout: 60000,
      state: 'visible',
    })

    // Fill the input (more reliable than type)
    await browser.fill({
      selector: '#searchInput',
      value: 'JavaScript',
      timeout: 60000,
    })

    // Press Enter key
    await browser.pressKey('Enter')

    // Wait for article heading to appear
    await browser.waitForSelector({
      selector: '#firstHeading',
      timeout: 60000,
      state: 'visible',
    })

    // Check we navigated
    const url = await browser.evaluate({
      script: 'window.location.href',
    })

    expect(url).toContain('JavaScript')
  }, 90000)

  it('refreshes the page', async () => {
    await browser.navigate({
      url: 'https://www.wikipedia.org',
      waitUntil: 'load',
    })

    await new Promise((resolve) => setTimeout(resolve, 1000))

    // Add some state via JavaScript
    await browser.evaluate({
      script: 'window.testState = "before_refresh"',
    })

    let state = await browser.evaluate({
      script: 'window.testState',
    })
    expect(state).toBe('before_refresh')

    // Refresh
    await browser.refresh()
    await new Promise((resolve) => setTimeout(resolve, 2000))

    // State should be gone after refresh
    state = await browser.evaluate({
      script: 'typeof window.testState',
    })
    expect(state).toBe('undefined')
  })

  it('extracts structured data from page', async () => {
    await browser.navigate({
      url: 'https://en.wikipedia.org/wiki/TypeScript',
      waitUntil: 'load',
    })

    await new Promise((resolve) => setTimeout(resolve, 1000))

    // Get page title and verify structure
    const pageData = await browser.evaluate({
      script: `(() => {
        return {
          title: document.querySelector('#firstHeading')?.textContent,
          hasContent: !!document.querySelector('#mw-content-text'),
          hasTOC: !!document.querySelector('#toc'),
        };
      })()`,
    })

    expect(pageData).toBeTruthy()
    expect(pageData.title).toContain('TypeScript')
    expect(pageData.hasContent).toBe(true)
  })

  describe('Session Query Methods', () => {
    it('gets current session details', async () => {
      // Use the shared browser instance that was started in beforeAll
      const session = await browser.getSession()

      expect(session).toBeDefined()
      expect(session.sessionId).toBeDefined()
      expect(session.browserIdentifier).toBe('aws.browser.v1')
      expect(session.name).toBe('wikipedia-test')
      expect(session.status).toBe('READY')
      expect(session.createdAt).toBeInstanceOf(Date)
      expect(session.lastUpdatedAt).toBeInstanceOf(Date)
      expect(session.sessionTimeoutSeconds).toBeGreaterThan(0)
    }, 30000)

    it('lists sessions with default parameters', async () => {
      const response = await browser.listSessions()

      expect(response).toBeDefined()
      expect(response.items).toBeInstanceOf(Array)
      expect(response.items.length).toBeGreaterThan(0)

      const session = response.items[0]
      expect(session.sessionId).toBeDefined()
      expect(session.name).toBeDefined()
      expect(session.status).toMatch(/READY|TERMINATED/)
      expect(session.createdAt).toBeInstanceOf(Date)
      expect(session.lastUpdatedAt).toBeInstanceOf(Date)
    }, 30000)

    it('filters sessions by status', async () => {
      const response = await browser.listSessions({ status: 'READY' })

      expect(response).toBeDefined()
      expect(response.items).toBeInstanceOf(Array)
      // All returned sessions should have READY status
      expect(response.items.every((item) => item.status === 'READY')).toBe(true)
    }, 30000)

    it('respects maxResults parameter', async () => {
      const response = await browser.listSessions({ maxResults: 1 })

      expect(response).toBeDefined()
      expect(response.items.length).toBeLessThanOrEqual(1)
    }, 30000)

    it('throws error when no session is active for getSession on new instance', async () => {
      const newBrowser = new PlaywrightBrowser({
        region: process.env.AWS_REGION || 'us-west-2',
      })

      await expect(newBrowser.getSession()).rejects.toThrow(/must be provided/)
    }, 30000)
  })
})
