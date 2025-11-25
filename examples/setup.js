/**
 * Setup for examples - polyfills crypto for @ai-sdk/amazon-bedrock
 */
import { webcrypto } from 'node:crypto'

if (!globalThis.crypto) {
  // @ts-expect-error - webcrypto is compatible but types differ slightly
  globalThis.crypto = webcrypto
}
