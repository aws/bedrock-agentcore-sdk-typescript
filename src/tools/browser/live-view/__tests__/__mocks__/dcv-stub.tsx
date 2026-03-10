import React from 'react'
import { vi } from 'vitest'

export const mockSetLogLevel = vi.fn()
export const mockAuthenticate = vi.fn()

const dcv = {
  LogLevel: { INFO: 3 },
  setLogLevel: mockSetLogLevel,
  authenticate: mockAuthenticate,
}

export default dcv

export const DCVViewer = (props: any) =>
  React.createElement('div', {
    'data-testid': 'dcv-viewer',
    'data-session-id': props.dcv?.sessionId,
  })
