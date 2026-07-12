import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    css: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@docs': path.resolve(__dirname, '../docs'),
      react: path.resolve(__dirname, './node_modules/react'),
      'react-dom': path.resolve(__dirname, './node_modules/react-dom'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('react-dom') || id.includes('/react/')) {
              return 'vendor-react'
            }
            if (id.includes('framer-motion')) {
              return 'vendor-motion'
            }
            if (id.includes('lucide-react')) {
              return 'vendor-icons'
            }
            if (id.includes('zustand')) {
              return 'vendor-state'
            }
            if (id.includes('react-markdown') || id.includes('remark-') || id.includes('rehype-') || id.includes('unified') || id.includes('mdast') || id.includes('hast') || id.includes('micromark')) {
              return 'vendor-markdown'
            }
            // elkjs is the canvas layout engine (statically imported by the graph
            // canvas). Keep it in its own chunk so opening a graph view no longer
            // drags in the ~4MB docs-only mermaid bundle it used to be merged with.
            if (id.includes('elkjs')) {
              return 'vendor-elk'
            }
            // mermaid is docs-only and already dynamically imported. Keep it
            // isolated; do NOT co-bundle d3/dagre here — d3 is a canvas (xyflow)
            // dependency, and merging it with mermaid was what pulled the whole
            // mermaid chunk onto every canvas route. Let Rollup auto-chunk d3.
            if (id.includes('mermaid')) {
              return 'vendor-mermaid'
            }
          }
        },
      },
    },
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': {
        target:
          process.env.VITE_PROXY_TARGET ||
          `http://127.0.0.1:${process.env.VIZ_PORT || '8000'}`,
        changeOrigin: true,
      },
    },
  },
})
