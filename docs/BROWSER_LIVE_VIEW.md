# Browser Live View

DCV-based real-time browser session streaming component for React applications.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                      │
│  Customer's React App (runs in browser)                                              │
│                                                                                      │
│  ┌────────────────────────┐          ┌────────────────────────────────────────────┐  │
│  │                        │          │                                            │  │
│  │  App.tsx               │          │  BrowserLiveView (React component)         │  │
│  │                        │          │                                            │  │
│  │  1. Call               │─────────▶│  1. dcv.authenticate(url)                  │  │
│  │     generateLive       │   pass   │     Opens /live-view/auth WebSocket        │  │
│  │     ViewUrl()          │   url    │                                            │  │
│  │                        │          │  2. DCVViewer (from dcv-ui)                │  │
│  │  2. Pass presigned     │          │     Opens /live-view main channel          │  │
│  │     URL to component   │          │     Renders streaming video                │  │
│  │                        │          │                                            │  │
│  └────────────────────────┘          │  3. Scaling + ResizeObserver               │  │
│                                      │     Fits remote desktop to container       │  │
│                                      │                                            │  │
│                                      └──────────────────┬─────────────────────────┘  │
│                                                         │                            │
│  Bundler (Vite) must resolve:                           │  WebSocket (wss://)        │
│                                                         │                            │
│  ┌────────────────────────────────────────────┐         │                            │
│  │                                            │         │                            │
│  │  nice-dcv-web-client-sdk/ (vendored)       │         │                            │
│  │                                            │         │                            │
│  │  dcvjs-esm/dcv.js                          │         │                            │
│  │    Core DCV: WebSocket, codecs,            │         │                            │
│  │    workers, WASM decoders                  │         │                            │
│  │                                            │         │                            │
│  │  dcv-ui/dcv-ui.js                          │         │                            │
│  │    React UI: DCVViewer component           │         │                            │
│  │    Imports: react, react-dom,              │         │                            │
│  │    prop-types, @cloudscape-design/*,       │         │                            │
│  │    @babel/runtime                          │         │                            │
│  │                                            │         │                            │
│  └────────────────────────────────────────────┘         │                            │
│                                                         │                            │
└─────────────────────────────────────────────────────────┼────────────────────────────┘
                                                          │
                                                          ▼
                                           ┌────────────────────────────────┐
                                           │                                │
                                           │  Bedrock AgentCore Service     │
                                           │                                │
                                           │  /browser-streams/{id}         │
                                           │    /sessions/{sid}             │
                                           │      /live-view                │
                                           │                                │
                                           │  SigV4 auth via query          │
                                           │  params (presigned URL)        │
                                           │                                │
                                           └────────────────────────────────┘
```

## File Layout

```
src/tools/browser/
├── client.ts                    # Browser class — generateLiveViewUrl() + generateWebSocketUrl()
├── live-view/
│   ├── index.ts                 # Public exports: BrowserLiveView, BrowserLiveViewProps, calculateScale
│   ├── BrowserLiveView.tsx      # Core React component
│   ├── scaling.ts               # Pure calculateScale() — extracted for testability
│   ├── types/dcv.d.ts           # TypeScript declarations for DCV SDK
│   ├── nice-dcv-web-client-sdk/ # Vendored DCV SDK runtime (~4.5MB, excluded from tsc)
│   │   ├── dcvjs-esm/dcv.js     # DCV core (WebSocket, streaming, codecs)
│   │   └── dcv-ui/dcv-ui.js     # DCV React UI (DCVViewer component)
│   ├── __tests__/
│   │   └── BrowserLiveView.test.ts
│   └── integration/             # Reference Vite app (source-only, excluded from dist)
│       ├── App.tsx
│       ├── vite.config.ts       # ⭐ Required bundler config customers must replicate
│       ├── constants.ts
│       ├── index.html, index.tsx, tsconfig.json
│       └── README.md
```

## Why Things Are the Way They Are

### Why is the DCV SDK vendored?

The NICE DCV Web Client SDK is not published to npm. It's a set of pre-built JS files that must be:
1. Aliased as bare specifiers (`dcv`, `dcv-ui`) via bundler config
2. Copied to the build output for runtime loading (workers, WASM decoders)

### Why `scaling.ts` is separate from `BrowserLiveView.tsx`

`BrowserLiveView.tsx` imports `dcv` as a bare specifier. In Node/vitest, there's no bundler to resolve this alias, so importing the file fails. `calculateScale()` was extracted to `scaling.ts` so unit tests can import it without triggering the DCV import chain.

### Why `https:` protocol for live-view signing (not `wss:`)

`generateLiveViewUrl()` signs with `https:` protocol and returns an `https://` URL. The DCV SDK internally converts to `wss://` when opening WebSocket connections. If you sign with `wss:`, the SigV4 canonical request differs from what the server expects, and the main channel connection fails silently (auth succeeds but streaming doesn't start).

`generateWebSocketUrl()` (for Playwright automation) uses `wss:` + `sign()` with headers — this is correct because Playwright runs server-side in Node.js where WebSocket clients can send custom headers.

### Why `presign()` vs `sign()` for live-view

- `presign()` → auth in query parameters → works in browsers (WebSocket API can't set custom headers)
- `sign()` → auth in HTTP headers → works server-side only (Playwright/Node.js WebSocket clients)

### Why `resolve.dedupe` is required in Vite config

The vendored `dcv-ui.js` imports `@cloudscape-design/components`, `prop-types`, `@babel/runtime`, etc. Since `dcv-ui.js` lives inside the SDK package (not the consumer's project), Vite resolves these imports from the SDK's location — where they don't exist. `resolve.dedupe` forces Vite to resolve them from the consumer's `node_modules`.

### Why `integration/` is excluded from dist

The integration app is a source-only reference. It imports `bedrock-agentcore/browser` which uses Node-specific code (`fromNodeProviderChain`). Including it in the dist would break browser bundlers that tree-shake the SDK. It's excluded via `tsconfig.json` excludes.

### Why module-level auth state in BrowserLiveView

React 18 Strict Mode unmounts and remounts components in development. Without module-level state, `dcv.authenticate()` runs twice in parallel, causing a WebSocket race condition where the second auth closes the first connection. The `moduleAuth` object persists across mount cycles.

## Consumer Requirements

### npm dependencies

```bash
npm install bedrock-agentcore react react-dom
# DCV UI runtime deps:
npm install prop-types @cloudscape-design/components @cloudscape-design/global-styles @cloudscape-design/design-tokens @babel/runtime
```

### Vite config (required)

```ts
import { resolve } from 'path'
import { viteStaticCopy } from 'vite-plugin-static-copy'

const dcvSdkDir = resolve(
  __dirname,
  'node_modules/bedrock-agentcore/dist/src/tools/browser/live-view/nice-dcv-web-client-sdk'
)

export default defineConfig({
  resolve: {
    alias: {
      dcv: resolve(dcvSdkDir, 'dcvjs-esm/dcv.js'),
      'dcv-ui': resolve(dcvSdkDir, 'dcv-ui/dcv-ui.js'),
    },
    dedupe: [
      'react', 'react-dom', 'prop-types',
      '@cloudscape-design/components', '@cloudscape-design/global-styles',
      '@cloudscape-design/design-tokens', '@babel/runtime',
    ],
  },
  plugins: [
    viteStaticCopy({
      targets: [
        { src: resolve(dcvSdkDir, 'dcvjs-esm'), dest: 'nice-dcv-web-client-sdk' },
        { src: resolve(dcvSdkDir, 'dcv-ui'), dest: 'nice-dcv-web-client-sdk' },
      ],
    }),
  ],
})
```

## Troubleshooting

### Auth succeeds but streaming fails (code 1006, "Connection failed")

The presigned URL was signed with `wss:` protocol instead of `https:`. The DCV auth channel (`/auth` suffix) is lenient, but the main streaming channel validates the SigV4 signature strictly. Use `generateLiveViewUrl()` which signs with `https:`.

Symptoms:
- `[authentication] INFO Auth WebSocket connection opened` — auth works
- `Main channel was closed before the connection was fully established` — repeated with exponential backoff
- `[client] ERROR Connection failed: {"code":16,"message":"Connection failed"}`

### `"dcv" is not defined` or `Cannot resolve "dcv"`

Missing bundler aliases. The DCV SDK uses bare specifiers `dcv` and `dcv-ui` which must be aliased to the vendored files. See Vite config above.

### `Cannot resolve "@cloudscape-design/components"` (or similar)

Two possible causes:
1. Missing dependency — install it: `npm install @cloudscape-design/components`
2. Missing `resolve.dedupe` — Vite resolves imports from the vendored SDK's physical path (inside `node_modules/bedrock-agentcore/dist/...`), not from the consumer's `node_modules`. Add the package to `resolve.dedupe`.

### DCV connects twice / WebSocket race condition

React Strict Mode double-mounts in development. The `BrowserLiveView` component handles this via module-level `moduleAuth` state. If you see duplicate `Calling client.connect` logs, this is expected in dev — only one connection proceeds.

### `fromNodeProviderChain is not exported` (Vite build error)

You're importing `Browser` from `bedrock-agentcore/browser` in a browser build. The `Browser` class uses Node-specific credential resolution. For browser-side apps, generate the presigned URL server-side and pass it to `BrowserLiveView`, or use the SigV4 utilities directly (`@smithy/signature-v4`, `@aws-crypto/sha256-js`).

### Build output missing DCV SDK files / blank screen

The `viteStaticCopy` plugin must copy `dcvjs-esm/` and `dcv-ui/` to `nice-dcv-web-client-sdk/` in the build output. The DCV SDK loads workers and WASM decoders at runtime from `baseUrl` (`/nice-dcv-web-client-sdk/dcvjs-esm`). If these files are missing, the viewer renders nothing.

Verify: `ls dist/nice-dcv-web-client-sdk/` should show `dcvjs-esm/` and `dcv-ui/`.

### Scaling / display size issues

`BrowserLiveView` accepts `remoteWidth` and `remoteHeight` props that must match the viewport dimensions used in `startSession()`. Default is 1920×1080. If the remote desktop appears cropped or has black bars, check these values match.

## Build & Test

```bash
# Type-check (includes BrowserLiveView.tsx)
npx tsc --noEmit

# Build (tsc + copy vendored SDK to dist)
npm run build

# Unit tests (tests calculateScale via scaling.ts, avoids DCV SDK import)
npx vitest run --project unit-node

# Verify dist output
ls dist/src/tools/browser/live-view/
# Should contain: index.js, BrowserLiveView.js, scaling.js, nice-dcv-web-client-sdk/
# Should NOT contain: integration/
```
