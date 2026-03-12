# Browser Live View

Stream a bedrock agentcore browser session to your React app in real time using the DCV protocol.

## Quick Start

### 1. Install dependencies

```bash
npm install bedrock-agentcore react react-dom

# Required DCV UI runtime dependencies
npm install prop-types @cloudscape-design/components @cloudscape-design/global-styles \
  @cloudscape-design/design-tokens @babel/runtime
```

### 2. Configure your bundler (Vite)

The DCV SDK ships as vendored JS files that need bundler aliases and a static copy step.

```ts
// vite.config.ts
import { resolve } from 'path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'

const dcvSdkDir = resolve(
  __dirname,
  'node_modules/bedrock-agentcore/dist/src/tools/browser/live-view/nice-dcv-web-client-sdk'
)

export default defineConfig({
  plugins: [
    react(),
    viteStaticCopy({
      targets: [
        { src: resolve(dcvSdkDir, 'dcvjs-esm'), dest: 'nice-dcv-web-client-sdk' },
        { src: resolve(dcvSdkDir, 'dcv-ui'), dest: 'nice-dcv-web-client-sdk' },
      ],
    }),
  ],
  resolve: {
    alias: {
      dcv: resolve(dcvSdkDir, 'dcvjs-esm/dcv.js'),
      'dcv-ui': resolve(dcvSdkDir, 'dcv-ui/dcv-ui.js'),
    },
    dedupe: [
      'react',
      'react-dom',
      'prop-types',
      '@cloudscape-design/components',
      '@cloudscape-design/global-styles',
      '@cloudscape-design/design-tokens',
      '@babel/runtime',
    ],
  },
})
```

### 3. Generate a presigned URL (server-side)

```ts
import { Browser } from 'bedrock-agentcore/browser'

const browser = new Browser({ region: 'us-west-2', browserId: 'your-browser-id' })

// Option A: Start a new session
const session = await browser.startSession({ viewPort: { width: 1920, height: 1080 } })

// Option B: Attach an existing session
browser.attachSession('existing-session-id')

// Generate the presigned URL and pass it to your frontend
const signedUrl = await browser.generateLiveViewUrl()
```

### 4. Render the component (client-side)

```tsx
import { BrowserLiveView } from 'bedrock-agentcore/browser/live-view'

function App({ signedUrl }: { signedUrl: string }) {
  const remoteWidth = 1920
  const remoteHeight = 1080

  return (
    <div style={{ width: '100%', aspectRatio: `${remoteWidth}/${remoteHeight}` }}>
      <BrowserLiveView signedUrl={signedUrl} remoteWidth={remoteWidth} remoteHeight={remoteHeight} />
    </div>
  )
}
```

## API

### `<BrowserLiveView>`

| Prop           | Type     | Default  | Description                                                              |
| -------------- | -------- | -------- | ------------------------------------------------------------------------ |
| `signedUrl`    | `string` | required | SigV4-presigned DCV live-view URL                                        |
| `remoteWidth`  | `number` | `1920`   | Remote desktop width (must match `viewPort.width` from `startSession`)   |
| `remoteHeight` | `number` | `1080`   | Remote desktop height (must match `viewPort.height` from `startSession`) |

### `browser.generateLiveViewUrl(expiresIn?)`

Returns a presigned HTTPS URL for the DCV streaming endpoint. Default expiry is 300 seconds.

### `browser.attachSession(sessionId)`

Attaches an existing session ID so `generateLiveViewUrl()` can be called without `startSession()`.

## Important Notes

- `remoteWidth`/`remoteHeight` must match the viewport dimensions from `startSession()`, otherwise the display will appear cropped or have black bars
- The component auto-scales to fit its parent container while preserving aspect ratio
- The `signedUrl` must use `https:` protocol (not `wss:`) — the DCV SDK handles the WebSocket upgrade internally
- Generate the presigned URL server-side using the `Browser` class (it requires Node.js credentials). Pass only the URL string to the browser

## Troubleshooting

See [docs/BROWSER_LIVE_VIEW.md](../../../docs/BROWSER_LIVE_VIEW.md#troubleshooting) for common issues and solutions.
