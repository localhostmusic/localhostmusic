import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), {
    name: 'offline-assets',
    transformIndexHtml() { return [{ tag: 'meta', attrs: { name: 'lhm-offline-manifest', content: '1' }, injectTo: 'head' }]; },
    generateBundle(_options, bundle) {
      this.emitFile({ type: 'asset', fileName: 'asset-manifest.json', source: JSON.stringify(
        Object.keys(bundle).filter(f => /\.(js|css)$/.test(f)).map(f => '/' + f),
      ) });
    },
  }],
  // `ws: true` so the Connect WebSocket (/api/connect) is proxied in dev.
  // In production the SPA is same-origin with the API.
  server: { proxy: { '/api': { target: 'http://localhost:3000', ws: true } } },
  // setupFiles: restore localStorage/sessionStorage, which Node 24 shadows out of
  // jsdom's globals (see vitest.setup.ts).
  test: { environment: 'jsdom', globals: true, setupFiles: ['./vitest.setup.ts'] },
})
