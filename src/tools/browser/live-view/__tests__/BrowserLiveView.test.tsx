/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from '@testing-library/react'
import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { mockAuthenticate, mockSetLogLevel } from './__mocks__/dcv-stub.js'

const { BrowserLiveView } = await import('../BrowserLiveView.js')

// Each test uses a unique URL so the URL-keyed auth map provides isolation
let urlCounter = 0
const uniqueUrl = () => `https://example.com/dcv/${++urlCounter}?X-Amz-Signature=abc`

describe('BrowserLiveView', () => {
  afterEach(() => {
    mockSetLogLevel.mockClear()
    mockAuthenticate.mockClear()
    cleanup()
  })

  it('calls dcv.authenticate with the signed URL', () => {
    const url = uniqueUrl()
    render(React.createElement(BrowserLiveView, { signedUrl: url }))

    expect(mockSetLogLevel).toHaveBeenCalledWith(3)
    expect(mockAuthenticate).toHaveBeenCalledWith(
      url,
      expect.objectContaining({
        promptCredentials: expect.any(Function),
        error: expect.any(Function),
        success: expect.any(Function),
        httpExtraSearchParams: expect.any(Function),
      })
    )
  })

  it('renders nothing before authentication', () => {
    const { container } = render(React.createElement(BrowserLiveView, { signedUrl: uniqueUrl() }))
    expect(container.querySelector('[data-testid="dcv-viewer"]')).toBeNull()
  })

  it('renders DCVViewer after successful authentication', () => {
    mockAuthenticate.mockImplementation((_url: string, callbacks: any) => {
      callbacks.success({}, [{ sessionId: 'sess-123', authToken: 'token-abc' }])
    })

    render(React.createElement(BrowserLiveView, { signedUrl: uniqueUrl() }))

    const viewer = screen.getByTestId('dcv-viewer')
    expect(viewer).toBeDefined()
    expect(viewer.getAttribute('data-session-id')).toBe('sess-123')
  })

  it('renders error when dcv.authenticate throws', () => {
    mockAuthenticate.mockImplementation(() => {
      throw new Error('Connection refused')
    })

    render(React.createElement(BrowserLiveView, { signedUrl: uniqueUrl() }))

    expect(screen.getByText(/Connection refused/)).toBeDefined()
  })

  it('wraps DCVViewer in full-size relative container', () => {
    mockAuthenticate.mockImplementation((_url: string, callbacks: any) => {
      callbacks.success({}, [{ sessionId: 's', authToken: 't' }])
    })

    const { container } = render(React.createElement(BrowserLiveView, { signedUrl: uniqueUrl() }))

    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper.style.width).toBe('100%')
    expect(wrapper.style.height).toBe('100%')
    expect(wrapper.style.position).toBe('relative')
    expect(wrapper.style.overflow).toBe('hidden')
  })
})
