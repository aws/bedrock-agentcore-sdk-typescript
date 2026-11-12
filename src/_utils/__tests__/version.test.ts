import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { SDK_VERSION } from '../version.js'

describe('SDK_VERSION', () => {
  it('is the version in package.json, so a release does not leave it behind', () => {
    const require = createRequire(import.meta.url)
    const pkg = require('../../../package.json') as { name: string; version: string }

    expect(pkg.name).toBe('bedrock-agentcore')
    expect(SDK_VERSION).toBe(pkg.version)
  })

  it('is a version and not the fallback', () => {
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+/)
    expect(SDK_VERSION).not.toContain('unknown')
  })
})
