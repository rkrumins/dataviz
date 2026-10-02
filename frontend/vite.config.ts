import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    css: false,
    // Vitest's 5s default is sized for unit tests; a good part of this suite is
    // jsdom integration work — virtualized canvas columns, trace walks, 1,200-row
    // scale scenarios — that legitimately costs 3-4s of CPU on its own. Measured:
    // the slowest test needs 3.4s in isolation but was observed at 10.5s in the
    // full run, because 16 parallel workers contend for cores and a per-test
    // timeout measures wall clock, including time the worker spent descheduled.
    // At 5s those tests failed intermittently, and on a DIFFERENT set each run —
    // which is why this is global rather than a few per-file overrides. CI is more
    // exposed than a dev machine (slower cores), and the job's own 20-minute budget
    // against a ~3-minute suite leaves plenty of room.
    testTimeout: 20000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@docs': path.resolve(__dirname, '../docs'),
      '@root': path.resolve(__dirname, '..'),
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
            // NOTE: deliberately NO manual chunk for mermaid. It is ONLY ever
            // dynamically imported (MermaidBlock: `import('mermaid')`), and forcing a
            // dynamically-imported module into a NAMED manual chunk promotes that chunk
            // into the entry's static graph — Vite then emits a <link modulepreload> for
            // it, so 3MB of docs-only mermaid was downloaded on EVERY page load and sat
            // directly on LCP. Letting the bundler split it naturally keeps it lazy.
          }
        },
      },
    },
  },
  server: {
    host: true,
    port: 5173,
    // The @docs alias (below) resolves to ../docs, outside this project's
    // root — without explicitly allowing it, Vite serves those files via a
    // static passthrough that skips plugin transforms (breaking `?raw`
    // imports) instead of the full dev-server pipeline.
    fs: {
      allow: [path.resolve(__dirname, '..')],
    },
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
