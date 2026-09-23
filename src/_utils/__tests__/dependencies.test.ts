import { describe, it, expect } from 'vitest'
import { createRequire, isBuiltin } from 'node:module'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const SRC = resolve(import.meta.dirname, '../..')

// Only shipped sources matter. These mirror tsconfig.json's "exclude": tests may use
// devDependencies freely, integration/ is a standalone demo app with its own tsconfig,
// and the DCV SDK is vendored into dist by scripts/copy-dcv-sdk.ts rather than resolved.
const SKIP_DIRS = new Set(['__tests__', '__fixtures__', '__mocks__', 'nice-dcv-web-client-sdk', 'integration'])

// 'dcv'/'dcv-ui' are satisfied by an ambient `declare module` in
// src/tools/browser/live-view/types/dcv.d.ts plus the vendored SDK above, so they
// are intentionally absent from package.json.
const AMBIENT_MODULES = new Set(['dcv', 'dcv-ui'])

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : sourceFiles(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

/** Strips comments so that `@example` blocks in TSDoc are not mistaken for real imports. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

function importedPackages(source: string): string[] {
  // Covers `from 'x'`, bare `import 'x'`, and dynamic `import('x')`.
  const specifiers = [...stripComments(source).matchAll(/\b(?:from|import)\s*\(?\s*'([^']+)'/g)].map(
    (match) => match[1]!
  )

  return specifiers
    .filter((specifier) => !specifier.startsWith('.') && !specifier.startsWith('/'))
    .map((specifier) =>
      specifier
        .split('/')
        .slice(0, specifier.startsWith('@') ? 2 : 1)
        .join('/')
    )
}

describe('package.json dependencies', () => {
  // Regression guard for #268: the runtime imported @aws-sdk/credential-provider-node
  // without declaring it, which resolved only via npm's flat node_modules and broke
  // under pnpm with hoisting disabled. Type-only imports count too — they survive
  // into the emitted .d.ts, so a consumer's tsc needs them declared as well.
  it('declares every package imported by shipped sources', () => {
    const require = createRequire(import.meta.url)
    const pkg = require('../../../package.json') as {
      dependencies: Record<string, string>
      peerDependencies: Record<string, string>
    }
    const declared = new Set([...Object.keys(pkg.dependencies), ...Object.keys(pkg.peerDependencies)])

    const undeclared = new Map<string, string[]>()
    for (const file of sourceFiles(SRC)) {
      for (const name of importedPackages(readFileSync(file, 'utf8'))) {
        if (isBuiltin(name) || declared.has(name) || AMBIENT_MODULES.has(name)) continue
        undeclared.set(name, [...(undeclared.get(name) ?? []), file.slice(SRC.length + 1)])
      }
    }

    expect(Object.fromEntries(undeclared)).toEqual({})
  })
})
