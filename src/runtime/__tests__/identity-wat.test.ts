import { describe, expect, it } from 'vitest'
import { BedrockAgentCoreApp } from '../app.js'
import { withWAT } from '../../identity/wrappers.js'
import type { RequestContext } from '../types.js'

async function createApp(handler: (request: unknown, context: RequestContext) => Promise<unknown>) {
  const app = new BedrockAgentCoreApp({ invocationHandler: { process: handler } })
  await app['_registerPlugins']()
  app['_setupContentTypeParsers']()
  app['_setupRoutes']()
  await app['_app'].ready()
  return app
}

function post(app: BedrockAgentCoreApp, headers: Record<string, string>) {
  return app['_app'].inject({
    method: 'POST',
    url: '/invocations',
    headers: {
      'content-type': 'application/json',
      'x-amzn-bedrock-agentcore-runtime-session-id': 'session-1',
      ...headers,
    },
    payload: {},
  })
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

    const app = await createApp(async (_request, context) => {
      if (context.workloadAccessToken) {
        await captureToken()
      }
      return { contextWat: context.workloadAccessToken, injectedWat }
    })

    const resp = await post(app, headers)
    const body = JSON.parse(resp.body)

    expect(body.contextWat).toBe(expectedWat)
    if (expectedWat) {
      expect(body.injectedWat).toBe(expectedWat)
    }
  })

  it('withWAT throws when no WAT in context', async () => {
    const captureToken = withWAT(async (wat: string) => wat)

    const app = await createApp(async () => {
      try {
        await captureToken()
        return { error: null }
      } catch (e) {
        return { error: (e as Error).message }
      }
    })

    const resp = await post(app, {})
    const body = JSON.parse(resp.body)

    expect(body.error).toMatch(/no workload access token in context/i)
  })
})
