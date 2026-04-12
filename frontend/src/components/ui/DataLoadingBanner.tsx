/**
 * DataLoadingBanner — generic, reusable loading indicator for slow API calls.
 *
 * Designed as a non-blocking banner that communicates "data is being fetched"
 * without obscuring the UI. Supports multiple visual modes:
 *
 *   - 'banner': A horizontal bar with pulsing dot + message (default)
 *   - 'inline': Compact single-line for tight spaces (e.g. inside panels)
 *   - 'overlay': Centered overlay with backdrop for initial loads
 *
 * Usage:
 *   <DataLoadingBanner
 *     isLoading={isLoading}
 *     label="Loading entities"
 *     detail="Fetching top-level nodes from graph..."
 *   />
 */

import { AnimatePresence, motion } from 'framer-motion'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface DataLoadingBannerProps {
  /** Whether data is currently loading. Banner is hidden when false. */
  isLoading: boolean
  /** Short label describing what is loading (e.g. "Loading entities"). */
  label?: string
  /** Optional detail text (e.g. endpoint description or progress hint). */
  detail?: string
  /** Visual mode. Defaults to 'banner'. */
  mode?: 'banner' | 'inline' | 'overlay'
  /** Additional class names. */
  className?: string
}

export function DataLoadingBanner({
  isLoading,
  label = 'Loading data',
  detail,
  mode = 'banner',
  className,
}: DataLoadingBannerProps) {
  return (
    <AnimatePresence>
      {isLoading && (
        mode === 'overlay' ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className={cn(
              'absolute inset-0 z-20 flex items-center justify-center',
              'bg-canvas/60 backdrop-blur-[2px]',
              className,
            )}
          >
            <div className="flex flex-col items-center gap-3 px-6 py-5 rounded-2xl bg-canvas-elevated border border-glass-border shadow-xl">
              <Loader2 className="w-6 h-6 animate-spin text-accent-lineage" />
              <div className="text-center">
                <p className="text-sm font-semibold text-ink">{label}</p>
                {detail && (
                  <p className="text-xs text-ink-muted mt-1 max-w-[260px]">{detail}</p>
                )}
              </div>
            </div>
          </motion.div>
        ) : mode === 'inline' ? (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.15 }}
            className={cn('overflow-hidden', className)}
          >
            <div className="flex items-center gap-2 py-1.5 px-1 text-xs text-ink-muted">
              <Loader2 className="w-3 h-3 animate-spin text-accent-lineage shrink-0" />
              <span className="truncate">{label}</span>
            </div>
          </motion.div>
        ) : (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.15 }}
            className={cn('overflow-hidden', className)}
          >
            <div className={cn(
              'flex items-center gap-3 px-4 py-2.5 rounded-xl',
              'bg-accent-lineage/5 border border-accent-lineage/15',
            )}>
              <div className="relative flex items-center justify-center w-5 h-5 shrink-0">
                <span className="absolute w-2.5 h-2.5 rounded-full bg-accent-lineage/30 animate-ping" />
                <span className="relative w-2 h-2 rounded-full bg-accent-lineage" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-ink">{label}</p>
                {detail && (
                  <p className="text-[11px] text-ink-muted mt-0.5 truncate">{detail}</p>
                )}
              </div>
              <Loader2 className="w-3.5 h-3.5 animate-spin text-accent-lineage shrink-0" />
            </div>
          </motion.div>
        )
      )}
    </AnimatePresence>
  )
}
