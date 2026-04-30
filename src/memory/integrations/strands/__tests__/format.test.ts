import { describe, it, expect } from 'vitest'
import type { Message, SystemContentBlock } from '@strands-agents/sdk'
import {
  escapeRegex,
  deriveLabel,
  formatMemoryBlock,
  truncateToCharBudget,
  stripMemoryBlock,
  appendMemoryBlock,
  extractText,
  mapRole,
} from '../format.js'
import type { MemoryRecordGroup } from '../types.js'

function msg(role: 'user' | 'assistant', content: unknown[]): Message {
  return { role, content } as unknown as Message
}

describe('escapeRegex', () => {
  it('escapes all regex metacharacters', () => {
    expect(escapeRegex('hello.world')).toBe('hello\\.world')
    expect(escapeRegex('a+b*c?d')).toBe('a\\+b\\*c\\?d')
    expect(escapeRegex('[foo](bar)')).toBe('\\[foo\\]\\(bar\\)')
    expect(escapeRegex('a{1}|b$^c')).toBe('a\\{1\\}\\|b\\$\\^c')
  })

  it('returns plain strings unchanged', () => {
    expect(escapeRegex('hello')).toBe('hello')
  })
})

describe('deriveLabel', () => {
  it('extracts label from path with placeholders', () => {
    expect(deriveLabel('/facts/{actorId}/')).toBe('facts')
  })

  it('extracts last segment from nested path', () => {
    expect(deriveLabel('/preferences/{actorId}/summaries/')).toBe('summaries')
  })

  it('falls back to memory for placeholder-only path', () => {
    expect(deriveLabel('/{actorId}/')).toBe('memory')
  })

  it('extracts label from simple path', () => {
    expect(deriveLabel('/facts/')).toBe('facts')
  })

  it('handles path without leading/trailing slashes', () => {
    expect(deriveLabel('facts')).toBe('facts')
  })

  it('returns memory for empty string', () => {
    expect(deriveLabel('')).toBe('memory')
  })

  it('returns memory for only slashes', () => {
    expect(deriveLabel('///')).toBe('memory')
  })
})

describe('formatMemoryBlock', () => {
  it('formats multiple groups', () => {
    const groups: MemoryRecordGroup[] = [
      { namespace: 'ns1', label: 'facts', records: [{ content: 'likes cats' }, { content: 'lives in Seattle' }] },
      { namespace: 'ns2', label: 'prefs', records: [{ content: 'prefers dark mode' }] },
    ]
    const result = formatMemoryBlock(groups, 'memory_context')
    expect(result).toBe(
      '<memory_context>\n' +
        'The following are relevant memories about the user:\n\n' +
        '[facts]\n- likes cats\n- lives in Seattle\n\n' +
        '[prefs]\n- prefers dark mode\n' +
        '</memory_context>'
    )
  })

  it('returns empty string when all groups have zero records', () => {
    const groups: MemoryRecordGroup[] = [
      { namespace: 'ns1', label: 'facts', records: [] },
      { namespace: 'ns2', label: 'prefs', records: [] },
    ]
    expect(formatMemoryBlock(groups, 'tag')).toBe('')
  })

  it('returns empty string for empty groups array', () => {
    expect(formatMemoryBlock([], 'tag')).toBe('')
  })

  it('formats a single group with single record', () => {
    const groups: MemoryRecordGroup[] = [{ namespace: 'ns', label: 'info', records: [{ content: 'one item' }] }]
    const result = formatMemoryBlock(groups, 'ctx')
    expect(result).toBe('<ctx>\nThe following are relevant memories about the user:\n\n[info]\n- one item\n</ctx>')
  })

  it('uses custom contextTag', () => {
    const groups: MemoryRecordGroup[] = [{ namespace: 'ns', label: 'data', records: [{ content: 'hello' }] }]
    const result = formatMemoryBlock(groups, 'my_custom_tag')
    expect(result).toContain('<my_custom_tag>')
    expect(result).toContain('</my_custom_tag>')
  })

  it('skips groups with zero records when mixed with non-empty', () => {
    const groups: MemoryRecordGroup[] = [
      { namespace: 'ns1', label: 'empty', records: [] },
      { namespace: 'ns2', label: 'full', records: [{ content: 'data' }] },
    ]
    const result = formatMemoryBlock(groups, 'tag')
    expect(result).not.toContain('[empty]')
    expect(result).toContain('[full]')
  })
})

describe('truncateToCharBudget', () => {
  it('returns all records when within budget', () => {
    const groups: MemoryRecordGroup[] = [{ namespace: 'ns', label: 'a', records: [{ content: 'short', score: 1 }] }]
    const result = truncateToCharBudget(groups, 1000)
    expect(result).toHaveLength(1)
    expect(result[0]!.records).toHaveLength(1)
  })

  it('drops least relevant records when over budget', () => {
    const groups: MemoryRecordGroup[] = [
      {
        namespace: 'ns',
        label: 'a',
        records: [
          { content: 'high relevance', score: 0.9 },
          { content: 'low relevance', score: 0.1 },
        ],
      },
    ]
    const result = truncateToCharBudget(groups, 20)
    expect(result).toHaveLength(1)
    expect(result[0]!.records).toHaveLength(1)
    expect(result[0]!.records[0]!.content).toBe('high relevance')
  })

  it('treats undefined score as 0', () => {
    const groups: MemoryRecordGroup[] = [
      {
        namespace: 'ns',
        label: 'a',
        records: [{ content: 'scored', score: 0.5 }, { content: 'unscored' }],
      },
    ]
    const result = truncateToCharBudget(groups, 10)
    expect(result).toHaveLength(1)
    expect(result[0]!.records[0]!.content).toBe('scored')
  })

  it('drops empty groups after truncation', () => {
    const groups: MemoryRecordGroup[] = [
      { namespace: 'ns1', label: 'high', records: [{ content: 'important', score: 0.9 }] },
      { namespace: 'ns2', label: 'low', records: [{ content: 'not important at all', score: 0.1 }] },
    ]
    const result = truncateToCharBudget(groups, 15)
    expect(result).toHaveLength(1)
    expect(result[0]!.label).toBe('high')
  })

  it('returns empty array for empty input', () => {
    expect(truncateToCharBudget([], 100)).toEqual([])
  })

  it('maintains original group order', () => {
    const groups: MemoryRecordGroup[] = [
      { namespace: 'ns1', label: 'first', records: [{ content: 'aa', score: 0.5 }] },
      { namespace: 'ns2', label: 'second', records: [{ content: 'bb', score: 0.9 }] },
    ]
    const result = truncateToCharBudget(groups, 100)
    expect(result[0]!.label).toBe('first')
    expect(result[1]!.label).toBe('second')
  })
})

describe('stripMemoryBlock', () => {
  it('returns undefined for undefined prompt', () => {
    expect(stripMemoryBlock(undefined, 'tag')).toBeUndefined()
  })

  it('strips tag from string prompt', () => {
    const prompt = 'before <memory>some content</memory> after'
    expect(stripMemoryBlock(prompt, 'memory')).toBe('before  after')
  })

  it('leaves string prompt unchanged when tag is absent', () => {
    const prompt = 'no tags here'
    expect(stripMemoryBlock(prompt, 'memory')).toBe('no tags here')
  })

  it('does not trim the result for string prompts', () => {
    const prompt = '  <memory>content</memory>  '
    expect(stripMemoryBlock(prompt, 'memory')).toBe('    ')
  })

  it('strips multiple occurrences with global flag', () => {
    const prompt = '<m>first</m> middle <m>second</m>'
    expect(stripMemoryBlock(prompt, 'm')).toBe(' middle ')
  })

  it('handles regex metacharacters in tag name', () => {
    const prompt = '<tag.name>content</tag.name> rest'
    expect(stripMemoryBlock(prompt, 'tag.name')).toBe(' rest')
  })

  it('strips tag from TextBlock in array prompt', () => {
    const prompt: SystemContentBlock[] = [
      { type: 'textBlock', text: 'before <memory>stuff</memory> after' } as SystemContentBlock,
    ]
    const result = stripMemoryBlock(prompt, 'memory') as SystemContentBlock[]
    expect(result).toHaveLength(1)
    expect((result[0] as { text: string }).text).toBe('before  after')
  })

  it('removes TextBlock entirely when text is empty after stripping', () => {
    const prompt: SystemContentBlock[] = [
      { type: 'textBlock', text: '<memory>only this</memory>' } as SystemContentBlock,
      { type: 'cachePointBlock', cacheType: 'default' } as unknown as SystemContentBlock,
    ]
    const result = stripMemoryBlock(prompt, 'memory') as SystemContentBlock[]
    expect(result).toHaveLength(1)
    expect((result[0] as { type: string }).type).toBe('cachePointBlock')
  })

  it('passes through CachePointBlock and GuardContentBlock unchanged', () => {
    const cacheBlock = { type: 'cachePointBlock', cacheType: 'default' } as unknown as SystemContentBlock
    const guardBlock = { type: 'guardContentBlock' } as unknown as SystemContentBlock
    const prompt: SystemContentBlock[] = [cacheBlock, guardBlock]
    const result = stripMemoryBlock(prompt, 'tag') as SystemContentBlock[]
    expect(result).toHaveLength(2)
    expect(result[0]).toBe(cacheBlock)
    expect(result[1]).toBe(guardBlock)
  })
})

describe('appendMemoryBlock', () => {
  it('returns block as string when prompt is undefined', () => {
    expect(appendMemoryBlock(undefined, 'hello')).toBe('hello')
  })

  it('appends to string prompt with double newline', () => {
    expect(appendMemoryBlock('existing', 'new')).toBe('existing\n\nnew')
  })

  it('appends TextBlock to array prompt', () => {
    const prompt: SystemContentBlock[] = [{ type: 'textBlock', text: 'existing' } as SystemContentBlock]
    const result = appendMemoryBlock(prompt, 'new block') as SystemContentBlock[]
    expect(result).toHaveLength(2)
    expect((result[1] as { type: string; text: string }).type).toBe('textBlock')
    expect((result[1] as { type: string; text: string }).text).toBe('new block')
  })

  it('preserves existing blocks in array prompt', () => {
    const cacheBlock = { type: 'cachePointBlock', cacheType: 'default' } as unknown as SystemContentBlock
    const prompt: SystemContentBlock[] = [cacheBlock]
    const result = appendMemoryBlock(prompt, 'new') as SystemContentBlock[]
    expect(result[0]).toBe(cacheBlock)
  })
})

describe('extractText', () => {
  it('extracts text from text blocks', () => {
    const message = msg('user', [
      { type: 'textBlock', text: 'hello' },
      { type: 'textBlock', text: 'world' },
    ])
    expect(extractText(message)).toBe('hello\nworld')
  })

  it('skips tool use blocks (agent internals, not user content)', () => {
    const message = msg('assistant', [
      { type: 'toolUseBlock', name: 'search', toolUseId: 't1', input: { query: 'test' } },
    ])
    expect(extractText(message)).toBe('')
  })

  it('skips tool result blocks (agent internals, not user content)', () => {
    const message = msg('user', [
      {
        type: 'toolResultBlock',
        toolUseId: 't1',
        status: 'success',
        content: [
          { type: 'textBlock', text: 'result text' },
          { type: 'jsonBlock', json: { key: 'value' } },
        ],
      },
    ])
    expect(extractText(message)).toBe('')
  })

  it('skips reasoning blocks (chain-of-thought, not user content)', () => {
    const message = msg('assistant', [{ type: 'reasoningBlock', text: 'thinking...' }])
    expect(extractText(message)).toBe('')
  })

  it('skips reasoning blocks without text', () => {
    const message = msg('assistant', [
      { type: 'reasoningBlock', signature: 'sig' },
      { type: 'textBlock', text: 'visible' },
    ])
    expect(extractText(message)).toBe('visible')
  })

  it('extracts text and skips tool-use blocks in mixed content', () => {
    const message = msg('assistant', [
      { type: 'textBlock', text: 'I will search' },
      { type: 'toolUseBlock', name: 'lookup', toolUseId: 't1', input: 'q' },
    ])
    expect(extractText(message)).toBe('I will search')
  })

  it('skips binary content blocks', () => {
    const message = msg('user', [
      { type: 'imageBlock' },
      { type: 'videoBlock' },
      { type: 'documentBlock' },
      { type: 'cachePointBlock' },
      { type: 'guardContentBlock' },
      { type: 'citationsBlock' },
    ])
    expect(extractText(message)).toBe('')
  })

  it('returns empty string for empty message', () => {
    const message = msg('user', [])
    expect(extractText(message)).toBe('')
  })
})

describe('mapRole', () => {
  it('maps user to USER', () => {
    expect(mapRole(msg('user', []))).toBe('USER')
  })

  it('maps assistant to ASSISTANT', () => {
    expect(mapRole(msg('assistant', []))).toBe('ASSISTANT')
  })
})
