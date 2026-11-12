/**
 * The SDK's own version, for anything that reports this client's identity.
 */

import { createRequire } from 'node:module'

/**
 * Where package.json sits relative to this module.
 *
 * Sources live in `src/_utils/` and the build emits `dist/src/_utils/`, so the package
 * root is two levels up when running from source and three from a build.
 */
const PACKAGE_JSON_PATHS = ['../../package.json', '../../../package.json']

/**
 * Reported when package.json cannot be read, so telling a server who we are never
 * fails a request.
 */
const UNKNOWN_VERSION = '0.0.0-unknown'

/**
 * Reads the version out of this package's own package.json.
 *
 * The package name is checked as well as the version, so a package.json belonging to
 * something else is not mistaken for ours.
 */
function readVersion(): string {
  const require = createRequire(import.meta.url)
  for (const path of PACKAGE_JSON_PATHS) {
    try {
      const pkg = require(path) as { name?: string; version?: string }
      if (pkg.name === 'bedrock-agentcore' && typeof pkg.version === 'string' && pkg.version) {
        return pkg.version
      }
    } catch {
      continue
    }
  }
  return UNKNOWN_VERSION
}

/**
 * Version of this SDK, as published.
 */
export const SDK_VERSION: string = readVersion()
