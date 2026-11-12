import eslint from '@eslint/js'
import tseslint from '@typescript-eslint/eslint-plugin'
import tsparser from '@typescript-eslint/parser'
import tsdoc from 'eslint-plugin-tsdoc'

/**
 * Local plugin enforcing AWS-partition safety in production source
 * (no-hardcoded-arn-partition / no-hardcoded-endpoint-tld). Only string/template
 * literals and regex-literal patterns are inspected, so TSDoc examples are not
 * flagged.
 * @type {import('eslint').ESLint.Plugin}
 */
const partitionPlugin = {
  rules: {
    'no-hardcoded-arn-partition': {
      meta: {
        type: 'problem',
        docs: {
          description:
            'Disallow hardcoded arn:aws: partition in ARN construction. Use a partition-tolerant matcher (arn:aws[a-z0-9-]*) instead.',
        },
        schema: [],
      },
      create(context) {
        function check(node, value) {
          if (/arn:aws:/.test(value)) {
            context.report({
              node,
              message:
                'Hardcoded "arn:aws:" detected. Use a partition-tolerant pattern (arn:aws[a-z0-9-]*) so aws-cn / aws-us-gov ARNs are accepted.',
            })
          }
        }
        return {
          TemplateLiteral(node) {
            for (const quasi of node.quasis) check(node, quasi.value.raw)
          },
          Literal(node) {
            if (typeof node.value === 'string') check(node, node.value)
            // Regex literals are Literal nodes whose .value is a RegExp, so the
            // string branch skips them; inspect the raw pattern too, e.g. a
            // reintroduced /^arn:aws:bedrock-agentcore:/ (the corrected
            // arn:aws[a-z0-9-]*: pattern does not match /arn:aws:/).
            else if (node.regex) check(node, node.regex.pattern)
          },
        }
      },
    },
    'no-hardcoded-endpoint-tld': {
      meta: {
        type: 'problem',
        docs: {
          description:
            'Disallow hardcoded amazonaws.com in endpoint URL construction. Derive the DNS suffix from the region partition (partition(region).dnsSuffix).',
        },
        schema: [],
      },
      create(context) {
        const REGION_PATTERN = /[a-z]{2}(-[a-z]+-\d+)/
        const hasEndpoint = (v) => /\.amazonaws\.com/.test(v)
        return {
          TemplateLiteral(node) {
            // Only interpolated template literals construct endpoints (e.g.
            // `bedrock-agentcore.${region}.amazonaws.com`); this keeps the branch
            // consistent with the region-gated Literal branch below and avoids
            // flagging static strings that merely mention the domain.
            if (node.expressions.length === 0) return
            for (const quasi of node.quasis) {
              if (hasEndpoint(quasi.value.raw)) {
                context.report({
                  node,
                  message:
                    'Hardcoded ".amazonaws.com" in constructed endpoint. Use partition(region).dnsSuffix for multi-partition support.',
                })
                break
              }
            }
          },
          Literal(node) {
            if (typeof node.value === 'string' && hasEndpoint(node.value) && REGION_PATTERN.test(node.value)) {
              context.report({
                node,
                message:
                  'Hardcoded endpoint with region detected. Use partition(region).dnsSuffix for multi-partition support.',
              })
            }
          },
        }
      },
    },
  },
}

export default [
  {
    ignores: [
      '**/.next/**',
      '**/node_modules/**',
      '**/dist/**',
      '**/next-env.d.ts',
      '**/nice-dcv-web-client-sdk/**',
      'src/tools/browser/live-view/types/**',
      'src/tools/browser/live-view/integration/**',
    ],
  },
  eslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/__tests__/**'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        project: './tsconfig.json',
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        Response: 'readonly',
        RequestInit: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      tsdoc: tsdoc,
      partition: partitionPlugin,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      'partition/no-hardcoded-arn-partition': 'error',
      'partition/no-hardcoded-endpoint-tld': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      'tsdoc/syntax': 'error',
    },
  },
  {
    files: ['src/**/__tests__/**/*.ts', 'tests_integ/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        Response: 'readonly',
        AbortSignal: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      quotes: ['error', 'single', { avoidEscape: true }],
    },
  },
]
