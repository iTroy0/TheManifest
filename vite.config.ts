/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { visualizer } from 'rollup-plugin-visualizer'

// Bundle treemap. Emits dist/stats.html on every `npm run build`. Open it
// in a browser to see what's in each chunk (raw + gzip + brotli sizes).
// Cheap insurance against accidental fat imports — diff before/after a PR.
const BUILD_STATS = process.env.BUILD_STATS !== '0'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    ...(BUILD_STATS ? [visualizer({
      filename: 'dist/stats.html',
      template: 'treemap',
      gzipSize: true,
      brotliSize: true,
    })] : []),
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          // Heavy vendor libs isolated so the landing page doesn't block on them
          peerjs: ['peerjs'],
          streamsaver: ['streamsaver', 'client-zip'],
          dnd: ['@dnd-kit/core', '@dnd-kit/sortable', '@dnd-kit/utilities'],
          qrcode: ['qrcode.react'],
        },
      },
    },
  },
  test: {
    // Playwright specs use @playwright/test and can't be loaded by vitest.
    // Keep them out of the unit-test run; `npm run test:e2e` handles them.
    exclude: ['node_modules/**', 'dist/**', 'e2e/**', 'playwright-report/**', 'test-results/**'],
  },
})
