import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          // Heavy vendor libs isolated so the landing page doesn't block on them
          peerjs: ['peerjs'],
          streamsaver: ['streamsaver', 'fflate'],
          dnd: ['@dnd-kit/core', '@dnd-kit/sortable', '@dnd-kit/utilities'],
          qrcode: ['qrcode.react'],
        },
      },
    },
  },
})
