# Browser Automation Patterns

This document contains browser automation patterns and best practices extracted from the development documentation.

## Explicit Waits (Required)

**ALWAYS use explicit waits** before interacting with elements. Never assume elements are immediately available.

```typescript
// ✅ Good: Wait for element before interaction
await browser.waitForSelector({
  selector: '#submit-button',
  state: 'visible',
  timeout: 30000,
})
await browser.click({ selector: '#submit-button' })

// ❌ Bad: No wait, causes race conditions
await browser.click({ selector: '#submit-button' })
```

**Rationale**: Progressive page loading means HTML may be present but JavaScript is still modifying the DOM. Explicit waits prevent race conditions with dynamic content.

## Form Input: fill() vs type()

**Use `fill()` for form inputs**, not `type()`. The `fill()` method clears existing values and sets the new value atomically.

```typescript
// ✅ Good: Clear and set value atomically
await browser.fill({
  selector: '#email',
  value: 'user@example.com',
  timeout: 30000,
})

// ❌ Bad: Character-by-character typing is slow and unreliable
await browser.type({
  selector: '#email',
  text: 'user@example.com',
  delay: 100,
})
```

**When to use `type()`**: Only when simulating realistic human typing behavior is required (e.g., testing keystroke handlers, autocomplete).

## Navigation with Fallback Strategies

Back/forward navigation should use intelligent fallback strategies to handle different page loading patterns:

```typescript
async back(): Promise<void> {
  try {
    // Try networkidle (best for dynamic sites)
    await this._playwrightPage.goBack({ waitUntil: 'networkidle', timeout: 30000 })
  } catch {
    try {
      // Fallback to load event
      await this._playwrightPage.goBack({ waitUntil: 'load', timeout: 30000 })
    } catch {
      // Ultimate fallback: trigger navigation without waiting
      await this._playwrightPage.evaluate('window.history.back()')
    }
  }
}
```

**Rationale**: Sites with heavy tracking scripts and ads may never reach `networkidle`. The fallback strategy handles clean pages, slow pages, and problematic pages gracefully.

## Element Visibility Checks

**Check visibility before interaction** when dealing with conditional UI elements:

```typescript
// ✅ Good: Check visibility first
const isVisible = await browser.isVisible({ selector: '#modal' })
if (isVisible) {
  await browser.click({ selector: '#modal .close-button' })
}

// ❌ Bad: Direct interaction without checking
try {
  await browser.click({ selector: '#modal .close-button' })
} catch (error) {
  // Element may not exist
}
```

## Session Management and Cleanup

**Always clean up sessions** in finally blocks to prevent resource leaks:

```typescript
// ✅ Good: Cleanup in finally block
const browser = new PlaywrightBrowser({ region: 'us-east-1' })
try {
  await browser.startSession()
  await browser.navigate({ url: 'https://example.com' })
  // ... browser operations
} finally {
  await browser.stopSession()
}

// ❌ Bad: No cleanup on error
const browser = new PlaywrightBrowser({ region: 'us-east-1' })
await browser.startSession()
await browser.navigate({ url: 'https://example.com' })
await browser.stopSession()
```

## Integration Test Patterns

Integration tests should follow these patterns:

```typescript
describe('PlaywrightBrowser Integration', () => {
  let browser: PlaywrightBrowser

  beforeAll(async () => {
    browser = new PlaywrightBrowser({ region: 'us-west-2' })
    await browser.startSession({ sessionName: 'test-session' })
  })

  afterAll(async () => {
    await browser.stopSession()
  })

  it('searches for content', async () => {
    // Navigate
    await browser.navigate({
      url: 'https://example.com',
      waitUntil: 'load',
      timeout: 60000,
    })

    // Wait for search input to be ready
    await browser.waitForSelector({
      selector: '#search-input',
      state: 'visible',
      timeout: 60000,
    })

    // Fill search box
    await browser.fill({
      selector: '#search-input',
      value: 'TypeScript',
      timeout: 60000,
    })

    // Submit search
    await browser.pressKey('Enter')

    // Wait for results to appear
    await browser.waitForSelector({
      selector: '#results',
      state: 'visible',
      timeout: 60000,
    })

    // Verify results
    const html = await browser.getHtml()
    expect(html).toContain('TypeScript')
  }, 90000)
})
```

**Key principles**:
- Use `beforeAll`/`afterAll` for session management (not `beforeEach`/`afterEach`)
- Set generous timeouts for real website interactions (60s+)
- Wait for each element before interaction
- Use `fill()` instead of `type()` for form inputs
- Set test timeout longer than sum of operation timeouts