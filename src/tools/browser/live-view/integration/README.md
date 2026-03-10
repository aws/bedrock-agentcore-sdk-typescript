# Browser Live View — Integration Reference

Reference Vite + React app demonstrating how to integrate `BrowserLiveView` from the `bedrock-agentcore` SDK.

## What This Shows

1. **Vite `resolve.alias`** — `BrowserLiveView` imports `dcv` and `dcv-ui` as bare specifiers. Without aliases pointing to the vendored DCV SDK, the bundler can't resolve them.
2. **`viteStaticCopy`** — The DCV SDK loads worker scripts and WASM decoders at runtime via dynamic URLs. These must be physically present in the build output at `/nice-dcv-web-client-sdk/`.
3. **`resolve.dedupe`** — The vendored DCV UI SDK imports Cloudscape and other deps. Since it lives inside the SDK package, Vite needs `dedupe` to resolve these from your project's `node_modules`.
4. **Working demo** — Fill in credentials, run `npm run dev`, and verify the live-view stream.

## Required Dependencies

The DCV UI SDK (`dcv-ui`) has runtime dependencies that must be installed in your project:

```bash
npm install react react-dom prop-types \
  @cloudscape-design/components @cloudscape-design/global-styles @cloudscape-design/design-tokens \
  @babel/runtime
```

## Setup

1. Edit `constants.ts` with valid AWS credentials, a browser ID, and a session ID:

```ts
export const credentials = {
  accessKeyId: '...',
  secretAccessKey: '...',
  sessionToken: '...',
}
export const browserId = 'browser_use_tool_...'
export const sessionId = '...'
```

2. Install dependencies and run:

```bash
npm install
npm run dev    # Vite dev server on port 3001
```

3. Click "Connect" to generate a presigned URL and stream the browser session.

## Key Files

| File             | Purpose                                                              |
| ---------------- | -------------------------------------------------------------------- |
| `vite.config.ts` | ⭐ Required bundler config: DCV aliases + static asset copy + dedupe |
| `App.tsx`        | Demo app using `Browser` client + `BrowserLiveView`                  |
| `constants.ts`   | Placeholder credentials (replace with your own)                      |

## Adapting for Your Project

Copy the `resolve.alias`, `resolve.dedupe`, and `viteStaticCopy` sections from `vite.config.ts` into your own Vite config. Adjust the paths to point to the installed SDK:

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
      'react',
      'react-dom',
      'prop-types',
      '@cloudscape-design/components',
      '@cloudscape-design/global-styles',
      '@cloudscape-design/design-tokens',
      '@babel/runtime',
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
