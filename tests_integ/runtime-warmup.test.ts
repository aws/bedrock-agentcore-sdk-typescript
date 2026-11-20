/**
 * Integration tests for the BedrockAgentCoreApp build warmup hook
 *
 * These tests start the app with run() on real ports, with the hook on its own port.
 */

import { createServer } from 'net'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { BedrockAgentCoreApp } from '../src/runtime/app.js'

describe.sequential('Build warmup hook on its own port', () => {
  const WARMUP_HEADER = 'x-amzn-bedrock-agentcore-runtime-warmup-type'
  let app: BedrockAgentCoreApp
  let servingUrl: string
  let hookUrl: string
  let memoryWarmed = false

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
  const warmup = (url: string, type: string): Promise<Response> =>
    fetch(`${url}/warmup`, { method: 'POST', headers: { [WARMUP_HEADER]: type } })
  const invoke = async (): Promise<unknown> => {
    const response = await fetch(`${servingUrl}/invocations`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-amzn-bedrock-agentcore-runtime-session-id': 'warmup-session',
      },
      body: '{}',
    })
    return response.json()
  }

  beforeAll(async () => {
    const servingPort = await findFreePort(8100, 8199)
    const hookPort = await findFreePort(8200, 8299)
    servingUrl = `http://127.0.0.1:${servingPort}`
    hookUrl = `http://127.0.0.1:${hookPort}`

    app = new BedrockAgentCoreApp({
      invocationHandler: { process: async () => ({ memoryWarmed }) },
      warmupHook: {
        path: '/warmup',
        port: hookPort,
        handlers: {
          memory: async () => {
            await sleep(2000)
            memoryWarmed = true
          },
        },
      },
      config: { logging: { enabled: false } },
    })
    app.run({ port: servingPort, host: '127.0.0.1' })

    // The hook server listens before the serving port, so both are up once /ping answers
    await vi.waitFor(
      async () => {
        expect((await fetch(`${servingUrl}/ping`)).status).toBe(200)
      },
      { timeout: 10000, interval: 50 }
    )
  })

  afterAll(async () => {
    await app['_app'].close()
  })

  it('shows the unwarmed state before the warmup', async () => {
    expect(await invoke()).toEqual({ memoryWarmed: false })
  })

  it('keeps /ping on the serving port responsive while the memory handler awaits', async () => {
    const start = Date.now()
    let warmupDone = false
    const pending = warmup(hookUrl, 'memory').then(async (response) => {
      warmupDone = true
      return { status: response.status, body: await response.json(), elapsed: Date.now() - start }
    })

    const pings: { status: string; duration: number }[] = []
    while (!warmupDone) {
      const pingStart = Date.now()
      const response = await fetch(`${servingUrl}/ping`)
      const body = (await response.json()) as { status: string }
      if (!warmupDone) {
        pings.push({ status: body.status, duration: Date.now() - pingStart })
      }
      await sleep(100)
    }
    const result = await pending

    expect(result.status).toBe(200)
    expect(result.body).toEqual({ status: 'ok', type: 'memory', result: 'completed' })
    expect(result.elapsed).toBeGreaterThanOrEqual(1900)
    expect(pings.length).toBeGreaterThanOrEqual(5)
    for (const ping of pings) {
      expect(ping.status).toBe('Healthy')
      expect(ping.duration).toBeLessThan(500)
    }
  })

  it('skips disk without a handler and rejects an invalid type', async () => {
    const disk = await warmup(hookUrl, 'disk')
    expect(disk.status).toBe(200)
    expect(await disk.json()).toEqual({ status: 'ok', type: 'disk', result: 'skipped' })

    const invalid = await warmup(hookUrl, 'cpu')
    expect(invalid.status).toBe(400)
  })

  it('does not serve the hook on the serving port', async () => {
    expect((await warmup(servingUrl, 'memory')).status).toBe(404)
  })

  it('shows the warmed state after the warmup', async () => {
    expect(await invoke()).toEqual({ memoryWarmed: true })
  })
})

/**
 * Finds a free local port in a range; hook ports must be 8000-12000, so port 0 can't be used.
 */
async function findFreePort(from: number, to: number): Promise<number> {
  for (let port = from; port <= to; port++) {
    const free = await new Promise<boolean>((resolve) => {
      const server = createServer()
      server.once('error', () => resolve(false))
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
    })
    if (free) {
      return port
    }
  }
  throw new Error(`No free port in ${from}-${to}`)
}
