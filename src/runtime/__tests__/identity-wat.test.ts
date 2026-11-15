import { describe, expect, it } from 'vitest'
import { BedrockAgentCoreApp } from '../app.js'
import { withWAT } from '../../identity/wrappers.js'
import type { RequestContext } from '../types.js'
import { createTestClient } from '../testing.js'

async function invoke(
  handler: (request: unknown, context: RequestContext) => Promise<unknown>,
  headers: Record<string, string>
): Promise<Record<string, unknown>> {
  const app = new BedrockAgentCoreApp({ invocationHandler: { process: handler } })
  const { body } = await createTestClient(app).invoke({}, { sessionId: 'session-1', headers })
  return body as Record<string, unknown>
}

describe('Identity WAT propagation', () => {
  it.each<{ name: string; headers: Record<string, string>; expectedWat: string | undefined }>([
    {
      name: 'extracts WAT from new header',
      headers: { 'x-amz-bedrock-agentcore-identity-wat': 'new-token' },
      expectedWat: 'new-token',
    },
    {
      name: 'falls back to legacy header',
      headers: { workloadaccesstoken: 'legacy-token' },
      expectedWat: 'legacy-token',
    },
    {
      name: 'new header takes precedence over legacy',
      headers: {
        'x-amz-bedrock-agentcore-identity-wat': 'new-wins',
        workloadaccesstoken: 'legacy-loses',
      },
      expectedWat: 'new-wins',
    },
    {
      name: 'no WAT headers results in undefined',
      headers: {},
      expectedWat: undefined,
    },
  ])('$name', async ({ headers, expectedWat }) => {
    let injectedWat: string | undefined

    const captureToken = withWAT(async (wat: string) => {
      injectedWat = wat
    })

    const body = await invoke(async (_request, context) => {
      if (context.workloadAccessToken) {
        await captureToken()
      }
      return { contextWat: context.workloadAccessToken, injectedWat }
    }, headers)

    expect(body.contextWat).toBe(expectedWat)
    if (expectedWat) {
      expect(body.injectedWat).toBe(expectedWat)
    }
  })

  it('withWAT throws when no WAT in context', async () => {
    const captureToken = withWAT(async (wat: string) => wat)

    const body = await invoke(async () => {
      try {
        await captureToken()
        return { error: null }
      } catch (e) {
        return { error: (e as Error).message }
      }
    }, {})

    expect(body.error).toMatch(/no workload access token in context/i)
  })
})
