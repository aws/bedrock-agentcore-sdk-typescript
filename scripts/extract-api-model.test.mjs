import assert from 'node:assert/strict'
import test from 'node:test'

import { buildModel } from './extract-api-model.mjs'

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

  assert.equal(entry.summary, 'Sends batches of conversation messages to AgentCore.')
  assert.match(entry.description, /minimum number of `createEvent` calls/)
  assert.doesNotMatch(entry.description, /coordinator|token derivation/)
  assert.equal(entry.members[0].summary, 'Sends a batch of messages to AgentCore.')
})

test('assertWritableTopology omits internal stream details', () => {
  const callable = reflection(
    1,
    64,
    'assertWritableTopology',
    'src/memory/integrations/strands/factory.ts'
  )
  callable.signatures[0].comment = {
    summary: [{ text: 'Internal stream and deduplication details.' }],
  }
  const doc = { children: [callable] }

  const entry = buildModel(doc, '1.0.0').groups[0].entries[0]

  assert.match(entry.summary, /Validates that at most one store/)
  assert.doesNotMatch(entry.summary, /stream|deduplication/)
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
  assert.match(entry.description, /available through `getContext\(\)`/)
  assert.doesNotMatch(entry.description, /internal|customers/)
})
