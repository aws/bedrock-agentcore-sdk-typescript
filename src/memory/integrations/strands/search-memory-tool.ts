import { tool } from '@strands-agents/sdk'
import type { InvokableTool } from '@strands-agents/sdk'
import { z } from 'zod'
import type { MemoryClient } from '../../client.js'
import type { NamespaceConfig } from './types.js'

function namespaceLabel(ns: string): string {
  const parts = ns.split('/').filter((p) => p.length > 0 && !p.startsWith('{'))
  return parts[parts.length - 1] ?? ns
}

const searchMemoryInputSchema = z.object({
  query: z.string().describe('What to search for in memory'),
  namespace: z
    .string()
    .optional()
    .describe('Specific namespace to search. If omitted, searches all configured namespaces.'),
})

export type SearchMemoryInput = z.infer<typeof searchMemoryInputSchema>
export type SearchMemoryTool = InvokableTool<SearchMemoryInput, string>

export function createSearchMemoryTool(
  client: MemoryClient,
  config: { memoryId: string; namespaces: Record<string, NamespaceConfig> }
): SearchMemoryTool {
  return tool({
    name: 'search_memory',
    description:
      'Search long-term memory for relevant user context, preferences, or past interactions. Use this when you need to recall information from previous conversations.',
    inputSchema: searchMemoryInputSchema,
    callback: async ({ query, namespace }) => {
      const namespacesToSearch: string[] = namespace ? [namespace] : Object.keys(config.namespaces)

      if (namespace !== undefined && !(namespace in config.namespaces)) {
        return `Error: unknown namespace "${namespace}". Configured namespaces: ${Object.keys(config.namespaces).join(', ')}`
      }

      const retrievals = await Promise.allSettled(
        namespacesToSearch.map(async (ns) => {
          const nsConfig = config.namespaces[ns] ?? {}
          const result = await client.retrieveMemoryRecords({
            memoryId: config.memoryId,
            namespace: ns,
            searchCriteria: {
              searchQuery: query,
              topK: nsConfig.topK ?? 5,
            },
          })
          return { ns, records: result.memoryRecordSummaries ?? [], nsConfig }
        })
      )

      const sections: string[] = []
      const errors: string[] = []

      for (let i = 0; i < retrievals.length; i++) {
        const settled = retrievals[i]!
        if (settled.status === 'rejected') {
          const ns = namespacesToSearch[i]
          console.warn(`[agentcore-memory] search_memory retrieval failed for namespace ${ns}:`, settled.reason)
          errors.push(`${ns}: ${settled.reason instanceof Error ? settled.reason.message : String(settled.reason)}`)
          continue
        }

        const { ns, records, nsConfig } = settled.value

        const filtered =
          nsConfig.relevanceScore !== undefined
            ? records.filter((r) => (r.score ?? 0) >= nsConfig.relevanceScore!)
            : records

        if (filtered.length === 0) continue

        const label = namespaceLabel(ns)
        const lines = filtered.map((r) => `- ${r.content?.text ?? ''}`)
        sections.push(`[${label}]\n${lines.join('\n')}`)
      }

      if (sections.length === 0) {
        if (errors.length > 0) {
          return `Memory search failed for all requested namespaces:\n${errors.map((e) => `- ${e}`).join('\n')}`
        }
        return 'No relevant memories found.'
      }

      return sections.join('\n\n')
    },
  })
}
