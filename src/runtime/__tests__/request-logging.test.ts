import { describe, expect, it, vi } from 'vitest'
import { BedrockAgentCoreApp } from '../app.js'
import type { BedrockAgentCoreAppConfig } from '../types.js'

interface LogEntry {
  msg: string
  req: { url: string }
}

async function createApp(
  lines: string[],
  logging?: BedrockAgentCoreAppConfig['logging']
): Promise<BedrockAgentCoreApp> {
  const app = new BedrockAgentCoreApp({
    invocationHandler: { process: async () => 'ok' },
    config: {
      logging: {
        ...logging,
        options: {
          stream: {
            write: (line: string): void => {
              lines.push(line)
            },
          },
        },
      },
    },
  })
  // Same setup as run(), without listening on a port, so that tests can use inject()
  await app['_registerPlugins']()
  app['_setupContentTypeParsers']()
  app['_setupRoutes']()
  await app['_app'].ready()
  return app
}

async function loggedUrls(logging?: BedrockAgentCoreAppConfig['logging']): Promise<string[]> {
  const lines: string[] = []
  const app = await createApp(lines, logging)
  await app['_app'].inject({ method: 'GET', url: '/ping' })
  await app['_app'].inject({
    method: 'POST',
    url: '/invocations',
    headers: { 'content-type': 'application/json' },
    payload: {},
  })
  return lines
    .map((line): LogEntry => JSON.parse(line))
    .filter((entry) => entry.msg === 'incoming request')
    .map((entry) => entry.req.url)
}

describe('BedrockAgentCoreApp', () => {
  describe('request logging', () => {
    it('does not log /ping requests by default', async () => {
      expect(await loggedUrls()).toEqual(['/invocations'])
    })

    it('uses config.logging.disableRequestLogging instead of the default', async () => {
      const urls = await loggedUrls({ disableRequestLogging: (request) => request.url === '/invocations' })
      expect(urls).toEqual(['/ping'])
    })

    it('does not emit the Fastify FSTDEP023 deprecation warning', async () => {
      const emitWarning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
      await createApp([])
      expect(emitWarning).not.toHaveBeenCalledWith(expect.any(String), 'FastifyDeprecation', 'FSTDEP023')
      emitWarning.mockRestore()
    })
  })
})
