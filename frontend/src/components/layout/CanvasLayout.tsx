/**
 * CanvasLayout — Layout wrapper for routes that need the graph schema.
 *
 * Wraps /views/:viewId, /schema, and /explorer so that:
 *   - useGraphSchema() (fetches /metadata/schema) only fires when the user
 *     navigates to a canvas-bearing route, not on /dashboard or /admin.
 *   - Child routes always mount — they handle their own loading/error states.
 *
 * When the provider is unavailable, the layout renders in degraded mode:
 *   - Schema loads from management DB cache (fast, no provider dependency)
 *   - A floating status pill is shown top-center in the canvas
 *   - Graph data queries will fail per-component with inline error messages
 *
 * AppLayout handles auth, sidebar, topbar, and the view list (lightweight).
 * This component handles the heavier ontology fetch.
 */

import { Outlet } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { Loader2, RefreshCw, CloudOff } from 'lucide-react'
import { useGraphSchema } from '@/hooks/useGraphSchema'

export function CanvasLayout() {
  const { isLoading, isFetching, isError, error, refetch } = useGraphSchema()

  return (
    <>
      {/* Always render child routes — they manage their own loading/error */}
      <Outlet />

      {/* Degraded-mode pill — top-center, floating above the canvas */}
      <AnimatePresence>
        {isError && (
          <motion.div
            key="provider-degraded"
            role="status"
            aria-live="polite"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ type: 'spring', stiffness: 500, damping: 35 }}
            className="absolute top-4 left-1/2 -translate-x-1/2 z-40"
          >
            <div className="flex items-center gap-3 pl-4 pr-2 py-2 rounded-full bg-amber-50 dark:bg-amber-950/60 border border-amber-300/60 dark:border-amber-500/30 shadow-lg shadow-amber-500/10 backdrop-blur-sm">
              <CloudOff className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-semibold text-amber-800 dark:text-amber-300 whitespace-nowrap">
                  Provider Offline
                </span>
                <span className="text-sm text-amber-600/80 dark:text-amber-400/70 hidden sm:inline">
                  — {error instanceof Error ? error.message : 'showing cached data'}
                </span>
              </div>
              <button
                onClick={() => refetch()}
                className="shrink-0 ml-1 p-1.5 rounded-full text-amber-600 dark:text-amber-400 hover:bg-amber-200/50 dark:hover:bg-amber-500/20 transition-colors"
                title="Retry connection"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Initial schema load overlay — non-blocking, pointer-events-none */}
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-canvas/60 backdrop-blur-[2px] z-30 pointer-events-none">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="w-6 h-6 animate-spin text-accent-lineage" />
            <span className="text-sm text-ink-muted">Loading schema…</span>
          </div>
        </div>
      )}

      {/* Subtle overlay during schema refetches (workspace/datasource switch) */}
      {isFetching && !isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-canvas/40 backdrop-blur-[2px] z-30 pointer-events-none">
          <div className="flex flex-col items-center gap-2">
            <Loader2 className="w-5 h-5 animate-spin text-accent-lineage" />
            <span className="text-xs text-ink-muted">Switching context…</span>
          </div>
        </div>
      )}
    </>
  )
}
