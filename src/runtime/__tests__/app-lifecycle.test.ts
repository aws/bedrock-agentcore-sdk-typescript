import type { AddressInfo } from 'net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BedrockAgentCoreApp } from '../app.js'
import type { BedrockAgentCoreAppParams } from '../types.js'

const HOST = '127.0.0.1'

describe('BedrockAgentCoreApp', () => {
  let apps: BedrockAgentCoreApp[] = []

  function createApp(
    App: new (params: BedrockAgentCoreAppParams) => BedrockAgentCoreApp = BedrockAgentCoreApp
  ): BedrockAgentCoreApp {
    const app = new App({
      invocationHandler: { process: async () => 'ok' },
      config: { logging: { enabled: false } },
    })
    apps.push(app)
    return app
  }

  async function occupyPort(): Promise<number> {
    const { port } = await createApp().listen({ port: 0, host: HOST })
    return port
  }

  function stubExit(): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
  }

  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(apps.map((app) => app.close()))
    apps = []
  })

  describe('listen', () => {
    it('resolves with the bound address once the server serves requests', async () => {
      const address = await createApp().listen({ port: 0, host: HOST })

      expect(address).toEqual({ address: HOST, family: 'IPv4', port: expect.any(Number) })
      const response = await fetch(`http://${HOST}:${address.port}/ping`)
      expect(await response.json()).toEqual({ status: 'Healthy', time_of_last_update: expect.any(Number) })
    })

    it('rejects without exiting the process when the port is in use', async () => {
      const port = await occupyPort()
      const exit = stubExit()

      await expect(createApp().listen({ port, host: HOST })).rejects.toThrow('EADDRINUSE')
      expect(exit).not.toHaveBeenCalled()
    })
  })

  describe('close', () => {
    it('stops the server', async () => {
      const app = createApp()
      const { port } = await app.listen({ port: 0, host: HOST })

      await app.close()

      await expect(fetch(`http://${HOST}:${port}/ping`)).rejects.toThrow()
    })
  })

  describe('run', () => {
    it('exits the process when the port is in use', async () => {
      const port = await occupyPort()
      const exit = stubExit()

      createApp().run({ port, host: HOST })

      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
    })

    it('does not call a listen() that a subclass defines', async () => {
      const port = await occupyPort()
      const exit = stubExit()
      let listenCalls = 0
      class ExtendedApp extends BedrockAgentCoreApp {
        override async listen(options?: { port?: number; host?: string }): Promise<AddressInfo> {
          listenCalls++
          return super.listen(options)
        }
      }

      createApp(ExtendedApp).run({ port, host: HOST })

      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
      expect(listenCalls).toBe(0)
    })
  })
})
