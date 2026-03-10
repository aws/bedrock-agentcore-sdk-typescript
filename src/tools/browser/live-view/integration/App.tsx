import React, { useCallback, useState } from 'react'
import { BrowserLiveView } from 'bedrock-agentcore/browser/live-view'
import { Browser } from 'bedrock-agentcore/browser'
import { credentials, browserId, sessionId } from './constants'

const REGION = 'us-west-2'

export const App: React.FC = () => {
  const [signedUrl, setSignedUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleConnect = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const browser = new Browser({
        region: REGION,
        identifier: browserId,
        credentialsProvider: async () => credentials,
      })

      // Attach the existing session so generateLiveViewUrl() can sign it
      browser.attachSession(sessionId)

      setSignedUrl(await browser.generateLiveViewUrl())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate signed URL')
    } finally {
      setLoading(false)
    }
  }, [])

  if (signedUrl) {
    return (
      <div style={{ width: '100%', maxWidth: '400px', aspectRatio: '9/16', margin: '0 auto' }}>
        <BrowserLiveView signedUrl={signedUrl} remoteHeight={1920} remoteWidth={1080} />
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
      <div style={{ textAlign: 'center' }}>
        <button onClick={handleConnect} disabled={loading} style={{ padding: '10px 24px', fontSize: '16px' }}>
          {loading ? 'Connecting...' : 'Connect'}
        </button>
        {error && <p style={{ color: 'red', marginTop: '8px' }}>{error}</p>}
      </div>
    </div>
  )
}
