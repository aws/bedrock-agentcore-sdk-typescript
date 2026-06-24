import { describe, it, expect } from 'vitest'
import { validateShellId } from '../validation.js'

describe('validateShellId', () => {
  it('accepts valid alphanumeric IDs', () => {
    expect(() => validateShellId('abc123')).not.toThrow()
    expect(() => validateShellId('a')).not.toThrow()
    expect(() => validateShellId('A')).not.toThrow()
    expect(() => validateShellId('myShell')).not.toThrow()
  })

  it('accepts IDs with hyphens and underscores', () => {
    expect(() => validateShellId('my-shell')).not.toThrow()
    expect(() => validateShellId('debug_session_01')).not.toThrow()
    expect(() => validateShellId('shell-01_test')).not.toThrow()
  })

  it('accepts exactly 128 characters', () => {
    expect(() => validateShellId('a'.repeat(128))).not.toThrow()
  })

  it('throws for empty string', () => {
    expect(() => validateShellId('')).toThrow()
  })

  it('throws for ID starting with hyphen', () => {
    expect(() => validateShellId('-bad-start')).toThrow()
  })

  it('throws for ID starting with underscore', () => {
    expect(() => validateShellId('_bad-start')).toThrow()
  })

  it('throws for ID longer than 128 characters', () => {
    expect(() => validateShellId('a'.repeat(129))).toThrow()
  })

  it('throws for forbidden characters', () => {
    expect(() => validateShellId('shell?bad')).toThrow()
    expect(() => validateShellId('shell#bad')).toThrow()
    expect(() => validateShellId('shell&bad')).toThrow()
    expect(() => validateShellId('shell/bad')).toThrow()
    expect(() => validateShellId('shell bad')).toThrow()
  })
})
