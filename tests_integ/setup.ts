/**
 * Vitest setup for integration tests
 * Polyfills globalThis.crypto for @ai-sdk/amazon-bedrock compatibility
 */
import { webcrypto } from 'node:crypto'

// @ai-sdk/amazon-bedrock uses aws4fetch which expects Web Crypto API
if (!globalThis.crypto) {
  globalThis.crypto = webcrypto as any
}