import assert from 'node:assert/strict'
import test from 'node:test'

import { buildModel, typeToString } from './extract-api-model.mjs'

function reflection(id, kind, name, fileName) {
  return {
    id,
    kind,
    name,
    sources: [{ fileName }],
    signatures: kind === 64 ? [{ parameters: [], type: { name: 'void' } }] : undefined,
    children: [],
  }
}

test('integration entries have distinct labels and anchors', () => {
  const doc = {
    children: [
      reflection(1, 64, 'createClickTool', 'src/tools/browser/integrations/strands/click-tool.ts'),
      reflection(2, 64, 'createClickTool', 'src/tools/browser/integrations/vercel-ai/click-tool.ts'),
    ],
  }

  const entries = buildModel(doc, '1.0.0').groups[0].entries
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ['createClickTool (Strands SDK)', 'createClickTool (Vercel AI SDK)']
  )
  assert.equal(new Set(entries.map((entry) => entry.anchor)).size, 2)
})

test('undocumented parameters receive meaningful fallback descriptions', () => {
  const callable = reflection(1, 64, 'createTool', 'src/tools/browser/create-tool.ts')
  callable.signatures[0].parameters = [
    { name: 'client', type: { name: 'PlaywrightBrowser' }, flags: {} },
    { name: 'expectExtraction', type: { name: 'boolean' }, flags: {} },
  ]
  const doc = { children: [callable] }

  const params = buildModel(doc, '1.0.0').groups[0].entries[0].params

  assert.deepEqual(
    params.map((param) => param.description),
    ['The PlaywrightBrowser instance to use for browser automation.', 'Specifies whether extraction is expected.']
  )
})

test('AgentCoreEventSender omits internal implementation details', () => {
  const sender = reflection(1, 128, 'AgentCoreEventSender', 'src/memory/integrations/strands/sender.ts')
  sender.comment = { summary: [{ text: 'Internal coordinator and token derivation details.' }] }
  sender.children = [
    {
      id: 2,
      kind: 2048,
      name: 'sendBatch',
      signatures: [{ parameters: [], type: { name: 'Promise' } }],
    },
  ]
  const doc = { children: [sender] }

  const entry = buildModel(doc, '1.0.0').groups[0].entries[0]

  assert.equal(entry.summary, 'Sends batches of conversation messages to Amazon Bedrock AgentCore.')
  assert.match(entry.description, /operation throws/)
  assert.doesNotMatch(entry.description, /createEvent|committed/)
  assert.doesNotMatch(entry.description, /coordinator|token derivation/)
  assert.equal(entry.members[0].summary, 'Sends a batch of messages to Amazon Bedrock AgentCore.')
})

test('assertWritableTopology omits internal stream details', () => {
  const callable = reflection(1, 64, 'assertWritableTopology', 'src/memory/integrations/strands/factory.ts')
  callable.signatures[0].comment = {
    summary: [{ text: 'Internal stream and deduplication details.' }],
  }
  const doc = { children: [callable] }

  const entry = buildModel(doc, '1.0.0').groups[0].entries[0]

  assert.match(entry.summary, /Validates the memory store topology/)
  assert.match(entry.summary, /store can be writable/)
  assert.doesNotMatch(entry.summary, /may|throws|stream|deduplication/)
  assert.equal(entry.description, '')
})

test('runWithContext exposes only its observable contract', () => {
  const callable = reflection(1, 64, 'runWithContext', 'src/runtime/context.ts')
  callable.signatures[0].comment = {
    summary: [{ text: 'This function is internal and should not be used directly.' }],
  }
  const doc = { children: [callable] }

  const entry = buildModel(doc, '1.0.0').groups[0].entries[0]

  assert.equal(entry.summary, 'Runs a function within a request context scope.')
  assert.equal(entry.description, '')
  assert.doesNotMatch(entry.description, /internal|customers/)
})

test('TypeDoc types render as concrete TypeScript syntax', () => {
  assert.equal(
    typeToString({
      type: 'typeOperator',
      operator: 'readonly',
      target: {
        type: 'array',
        elementType: { type: 'reference', name: 'AgentCoreMemoryStore' },
      },
    }),
    'readonly AgentCoreMemoryStore[]'
  )

  assert.equal(
    typeToString({
      type: 'reflection',
      declaration: {
        children: [
          {
            name: 'host',
            flags: { isOptional: true },
            type: { type: 'intrinsic', name: 'string' },
          },
          {
            name: 'port',
            flags: { isOptional: true },
            type: { type: 'intrinsic', name: 'number' },
          },
        ],
      },
    }),
    '{ host?: string; port?: number }'
  )

  assert.equal(
    typeToString({
      type: 'reflection',
      declaration: {
        signatures: [
          {
            parameters: [
              {
                name: 'args',
                flags: { isRest: true },
                type: { type: 'reference', name: 'TParams' },
              },
            ],
            type: {
              type: 'reference',
              name: 'Promise',
              typeArguments: [{ type: 'reference', name: 'TReturn' }],
            },
          },
        ],
      },
    }),
    '(...args: TParams) => Promise<TReturn>'
  )

  assert.equal(
    typeToString({
      type: 'union',
      types: [
        { type: 'literal', value: null },
        { type: 'reference', name: 'Element', qualifiedName: 'JSX.Element' },
      ],
    }),
    'null | JSX.Element'
  )

  assert.equal(
    typeToString({
      type: 'reference',
      name: 'Buffer',
      qualifiedName: '__global.Buffer',
      typeArguments: [{ type: 'reference', name: 'ArrayBufferLike' }],
    }),
    'Buffer<ArrayBufferLike>'
  )
})
