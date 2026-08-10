import { describe, expect, it } from 'vitest'
import { TextBlock } from '@strands-agents/sdk'
import { Graph, Status } from '@strands-agents/sdk/multiagent'
import { commandInput, createHarnessAgent, createMockClient, textTurn } from './harness-test-helpers.js'

describe('AgentCoreHarnessAgent', () => {
  describe('composition', () => {
    it('runs as a Graph node and receives its predecessor output', async () => {
      const { client, send } = createMockClient(textTurn('Upstream summary'), textTurn('Harness graph result'))
      const upstream = createHarnessAgent({ client, id: 'upstream' })
      const downstream = createHarnessAgent({ client, id: 'downstream' })
      const graph = new Graph({
        nodes: [upstream, downstream],
        edges: [[upstream.id, downstream.id]],
      })

      const result = await graph.invoke('Original task')

      expect(result.status).toBe(Status.COMPLETED)
      expect(result.content).toStrictEqual([new TextBlock('Harness graph result')])
      const downstreamInput = commandInput(send, 1).messages![0]!.content![0]!
      expect(downstreamInput).toMatchObject({ text: expect.stringContaining('Original task') })
      expect(downstreamInput).toMatchObject({ text: expect.stringContaining('Upstream summary') })
    })
  })
})
