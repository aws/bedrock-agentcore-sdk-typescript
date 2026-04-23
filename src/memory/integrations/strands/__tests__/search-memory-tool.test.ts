import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createSearchMemoryTool } from '../search-memory-tool.js'

vi.mock('@strands-agents/sdk', () => ({
  tool: vi.fn((config) => ({
    name: config.name,
    description: config.description,
    inputSchema: config.inputSchema,
    callback: config.callback,
  })),
}))

const mockRetrieveMemoryRecords = vi.fn()

const mockClient = {
  retrieveMemoryRecords: mockRetrieveMemoryRecords,
} as unknown as import('../../../../client.js').MemoryClient

const baseConfig = {
  memoryId: 'mem-123',
  namespaces: {
    'user/facts': { topK: 3 },
    'user/preferences': { topK: 5 },
  },
}

describe('createSearchMemoryTool', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('has correct name and description', () => {
    const t = createSearchMemoryTool(mockClient, baseConfig)
    expect(t.name).toBe('search_memory')
    expect(t.description).toContain('Search long-term memory')
  })

  it('searches all namespaces when no namespace specified', async () => {
    mockRetrieveMemoryRecords.mockResolvedValue({ memoryRecordSummaries: [] })

    const t = createSearchMemoryTool(mockClient, baseConfig)
    await (t as any).callback({ query: 'dark mode' })

    expect(mockRetrieveMemoryRecords).toHaveBeenCalledTimes(2)
    expect(mockRetrieveMemoryRecords).toHaveBeenCalledWith(expect.objectContaining({ namespace: 'user/facts' }))
    expect(mockRetrieveMemoryRecords).toHaveBeenCalledWith(expect.objectContaining({ namespace: 'user/preferences' }))
  })

  it('searches specific namespace when specified', async () => {
    mockRetrieveMemoryRecords.mockResolvedValue({ memoryRecordSummaries: [] })

    const t = createSearchMemoryTool(mockClient, baseConfig)
    await (t as any).callback({ query: 'timezone', namespace: 'user/facts' })

    expect(mockRetrieveMemoryRecords).toHaveBeenCalledTimes(1)
    expect(mockRetrieveMemoryRecords).toHaveBeenCalledWith(expect.objectContaining({ namespace: 'user/facts' }))
  })

  it('returns error for unknown namespace', async () => {
    const t = createSearchMemoryTool(mockClient, baseConfig)
    const result = await (t as any).callback({ query: 'test', namespace: 'unknown/ns' })

    expect(result).toContain('Error: unknown namespace "unknown/ns"')
    expect(result).toContain('user/facts')
    expect(result).toContain('user/preferences')
    expect(mockRetrieveMemoryRecords).not.toHaveBeenCalled()
  })

  it('formats results with namespace labels', async () => {
    mockRetrieveMemoryRecords.mockImplementation(({ namespace }: { namespace: string }) => {
      if (namespace === 'user/facts') {
        return Promise.resolve({
          memoryRecordSummaries: [
            { memoryRecordId: 'r1', content: { text: 'User prefers dark mode' }, score: 0.9 },
            { memoryRecordId: 'r2', content: { text: 'User timezone is US/Pacific' }, score: 0.8 },
          ],
        })
      }
      return Promise.resolve({
        memoryRecordSummaries: [{ memoryRecordId: 'r3', content: { text: 'Likes concise responses' }, score: 0.7 }],
      })
    })

    const t = createSearchMemoryTool(mockClient, baseConfig)
    const result = await (t as any).callback({ query: 'preferences' })

    expect(result).toContain('[facts]')
    expect(result).toContain('- User prefers dark mode')
    expect(result).toContain('- User timezone is US/Pacific')
    expect(result).toContain('[preferences]')
    expect(result).toContain('- Likes concise responses')
  })

  it("returns 'No relevant memories found.' when no results", async () => {
    mockRetrieveMemoryRecords.mockResolvedValue({ memoryRecordSummaries: [] })

    const t = createSearchMemoryTool(mockClient, baseConfig)
    const result = await (t as any).callback({ query: 'something obscure' })

    expect(result).toBe('No relevant memories found.')
  })

  it('handles retrieval errors gracefully via Promise.allSettled', async () => {
    mockRetrieveMemoryRecords.mockImplementation(({ namespace }: { namespace: string }) => {
      if (namespace === 'user/facts') {
        return Promise.reject(new Error('network error'))
      }
      return Promise.resolve({
        memoryRecordSummaries: [{ memoryRecordId: 'r1', content: { text: 'Likes concise responses' }, score: 0.9 }],
      })
    })

    const t = createSearchMemoryTool(mockClient, baseConfig)
    const result = await (t as any).callback({ query: 'preferences' })

    expect(result).toContain('[preferences]')
    expect(result).toContain('- Likes concise responses')
    expect(result).not.toContain('[facts]')
  })

  it('applies relevanceScore filter when configured', async () => {
    const configWithThreshold = {
      memoryId: 'mem-123',
      namespaces: {
        'user/facts': { topK: 5, relevanceScore: 0.8 },
      },
    }

    mockRetrieveMemoryRecords.mockResolvedValue({
      memoryRecordSummaries: [
        { memoryRecordId: 'r1', content: { text: 'High relevance' }, score: 0.95 },
        { memoryRecordId: 'r2', content: { text: 'Below threshold' }, score: 0.5 },
        { memoryRecordId: 'r3', content: { text: 'Exactly at threshold' }, score: 0.8 },
      ],
    })

    const t = createSearchMemoryTool(mockClient, configWithThreshold)
    const result = await (t as any).callback({ query: 'test' })

    expect(result).toContain('High relevance')
    expect(result).toContain('Exactly at threshold')
    expect(result).not.toContain('Below threshold')
  })

  it('passes correct topK from config to API', async () => {
    const configWithTopK = {
      memoryId: 'mem-456',
      namespaces: {
        'user/facts': { topK: 10 },
      },
    }

    mockRetrieveMemoryRecords.mockResolvedValue({ memoryRecordSummaries: [] })

    const t = createSearchMemoryTool(mockClient, configWithTopK)
    await (t as any).callback({ query: 'test' })

    expect(mockRetrieveMemoryRecords).toHaveBeenCalledWith({
      memoryId: 'mem-456',
      namespace: 'user/facts',
      searchCriteria: { searchQuery: 'test', topK: 10 },
    })
  })
})
