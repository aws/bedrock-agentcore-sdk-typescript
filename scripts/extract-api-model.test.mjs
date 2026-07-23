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
