declare module 'dcv' {
  interface AuthCallbacks {
    promptCredentials: () => void
    error: (authObj: unknown, error: unknown) => void
    success: (authObj: unknown, result: Array<Record<string, string>>) => void
    httpExtraSearchParams: (conn: DCVConnection) => URLSearchParams
  }

  interface DCVConnection {
    disconnect: () => void
    requestDisplayLayout?: (displays: Array<DisplayLayout>) => void
  }

  interface DisplayLayout {
    name: string
    rect: { x: number; y: number; width: number; height: number }
    primary: boolean
  }

  interface LogLevel {
    INFO: number
  }

  const LogLevel: LogLevel
  function setLogLevel(level: number): void
  function authenticate(url: string, callbacks: AuthCallbacks): void

  export default { LogLevel, setLogLevel, authenticate }
  export type { AuthCallbacks, DCVConnection, DisplayLayout }
}

declare module 'dcv-ui' {
  import type { DCVConnection } from 'dcv'

  interface DCVViewerProps {
    dcv: {
      sessionId: string
      authToken: string
      serverUrl: string
      baseUrl: string
      onDisconnect: (reason: unknown) => void
      onConnectionEstablished: (conn: DCVConnection) => void
      logLevel: number
      observers: { httpExtraSearchParams: (conn: DCVConnection) => URLSearchParams }
      divId?: string
    }
    uiConfig: {
      toolbar: { visible: boolean; fullscreenButton: boolean; multimonitorButton: boolean }
    }
  }

  export function DCVViewer(props: DCVViewerProps): JSX.Element
}
