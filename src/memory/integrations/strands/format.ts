import type { Message, SystemPrompt, SystemContentBlock, ContentBlock, ToolResultContent } from '@strands-agents/sdk'
import type { MemoryRecordGroup } from './types.js'

export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function deriveLabel(namespacePath: string): string {
  const segments = namespacePath.split('/').filter((s) => s.length > 0 && !s.startsWith('{'))
  if (segments.length > 0) {
    return segments[segments.length - 1]!
  }
  const stripped = namespacePath.replace(/\{[^}]*\}/g, '').replace(/\//g, '')
  return stripped || 'memory'
}

export function formatMemoryBlock(groups: MemoryRecordGroup[], contextTag: string): string {
  const totalRecords = groups.reduce((sum, g) => sum + g.records.length, 0)
  if (totalRecords === 0) return ''

  const sections = groups
    .filter((g) => g.records.length > 0)
    .map((g) => {
      const lines = g.records.map((r) => `- ${r.content}`)
      return `[${g.label}]\n${lines.join('\n')}`
    })

  return `<${contextTag}>\nThe following are relevant memories about the user:\n\n${sections.join('\n\n')}\n</${contextTag}>`
}

export function truncateToCharBudget(groups: MemoryRecordGroup[], maxChars: number): MemoryRecordGroup[] {
  const flat = groups.flatMap((g, groupIndex) => g.records.map((r) => ({ record: r, groupIndex })))

  flat.sort((a, b) => (b.record.score ?? 0) - (a.record.score ?? 0))

  let budget = maxChars
  const surviving = new Map<number, typeof flat>()

  for (const entry of flat) {
    if (budget <= 0) break
    const cost = entry.record.content.length
    if (cost > budget) break
    budget -= cost

    const list = surviving.get(entry.groupIndex)
    if (list) {
      list.push(entry)
    } else {
      surviving.set(entry.groupIndex, [entry])
    }
  }

  return groups
    .map((g, i) => {
      const kept = surviving.get(i)
      if (!kept) return null
      return {
        namespace: g.namespace,
        label: g.label,
        records: kept.map((e) => e.record),
      }
    })
    .filter((g): g is MemoryRecordGroup => g !== null)
}

export function stripMemoryBlock(prompt: SystemPrompt | undefined, tag: string): SystemPrompt | undefined {
  if (prompt === undefined) return undefined

  const escaped = escapeRegex(tag)
  const regex = new RegExp(`<${escaped}>[\\s\\S]*?</${escaped}>`, 'g')

  if (typeof prompt === 'string') {
    return prompt.replace(regex, '')
  }

  const result: SystemContentBlock[] = []
  for (const block of prompt) {
    if (block.type === 'textBlock') {
      const stripped = block.text.replace(regex, '')
      if (!stripped.trim()) continue
      result.push({ ...block, text: stripped } as SystemContentBlock)
    } else {
      result.push(block)
    }
  }
  return result
}

export function appendMemoryBlock(prompt: SystemPrompt | undefined, block: string): SystemPrompt {
  if (prompt === undefined) return block
  if (typeof prompt === 'string') return `${prompt}\n\n${block}`
  return [...prompt, { type: 'textBlock' as const, text: block } as SystemContentBlock]
}

export function extractText(message: Message): string {
  const parts: string[] = []

  for (const block of message.content) {
    const text = extractContentBlockText(block)
    if (text) parts.push(text)
  }

  return parts.join('\n').trim()
}

function extractContentBlockText(block: ContentBlock): string | undefined {
  switch (block.type) {
    case 'textBlock':
      return block.text
    case 'toolUseBlock':
      return `[tool_use: ${block.name}(${JSON.stringify(block.input)})]`
    case 'toolResultBlock':
      return extractToolResultText(block.content)
    case 'reasoningBlock':
      return block.text ?? undefined
    default:
      return undefined
  }
}

function extractToolResultText(content: ToolResultContent[]): string | undefined {
  const parts: string[] = []
  for (const item of content) {
    if (item.type === 'textBlock') {
      parts.push(item.text)
    } else if (item.type === 'jsonBlock') {
      parts.push(JSON.stringify(item.json))
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined
}

export function mapRole(message: Message): 'USER' | 'ASSISTANT' {
  return message.role === 'user' ? 'USER' : 'ASSISTANT'
}
