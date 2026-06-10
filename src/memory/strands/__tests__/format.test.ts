import { describe, expect, it } from 'vitest'
import { extractText, isUserOrAssistantWithText, mapRole } from '../format.js'
import type { MessageData } from '../_strands-memory-types.js'

const msg = (role: MessageData['role'], content: MessageData['content']): MessageData => ({ role, content })

describe('mapRole', () => {
  it('maps user -> USER', () => {
    expect(mapRole({ role: 'user' })).toBe('USER')
  })
  it('maps assistant -> ASSISTANT', () => {
    expect(mapRole({ role: 'assistant' })).toBe('ASSISTANT')
  })
})

describe('extractText', () => {
  it('concatenates text blocks with newlines', () => {
    expect(extractText(msg('user', [{ text: 'hello' }, { text: 'world' }]))).toBe('hello\nworld')
  })
  it('ignores non-text blocks', () => {
    expect(extractText(msg('user', [{ text: 'keep' }, { toolUse: {} }, { toolResult: {} }]))).toBe('keep')
  })
  it('returns empty string when no text blocks', () => {
    expect(extractText(msg('assistant', [{ toolUse: {} }]))).toBe('')
  })
  it('trims surrounding whitespace', () => {
    expect(extractText(msg('user', [{ text: '  spaced  ' }]))).toBe('spaced')
  })
})

describe('isUserOrAssistantWithText', () => {
  it('accepts a user message with text', () => {
    expect(isUserOrAssistantWithText(msg('user', [{ text: 'hi' }]))).toBe(true)
  })
  it('accepts an assistant message with text', () => {
    expect(isUserOrAssistantWithText(msg('assistant', [{ text: 'hi' }]))).toBe(true)
  })
  it('rejects a message with no extractable text', () => {
    expect(isUserOrAssistantWithText(msg('user', [{ toolUse: {} }]))).toBe(false)
  })
  it('rejects a whitespace-only message', () => {
    expect(isUserOrAssistantWithText(msg('assistant', [{ text: '   ' }]))).toBe(false)
  })
})
