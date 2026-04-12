/**
 * DataLoadingBanner — single-item loading toast (floats, animates in/out).
 *
 * DataLoadingToasts — container that stacks multiple DataLoadingBanner items
 * as floating toasts anchored to the bottom-center of the nearest positioned
 * parent. Drop it once inside any canvas or panel, feed it an array of
 * loading operations, and it handles layout + animation.
 *
 * Usage (preferred — multiple operations):
 *
 *   <DataLoadingToasts
 *     items={[
 *       { key: 'assignments', isLoading: assignmentStatus === 'loading', label: 'Computing assignments' },
 *       { key: 'edges', isLoading: isLoadingEdges, label: 'Loading edges' },
 *       { key: 'children', isLoading: isLoadingChildren, label: 'Expanding hierarchy' },
 *     ]}
 *   />
 *
 * Usage (single operation — backward compatible):
 *
 *   <DataLoadingBanner isLoading={isLoading} label="Loading entities" />
 */

import { AnimatePresence, motion } from 'framer-motion'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

// ─── Single toast item ────────────────────────────────────────────────────

export interface DataLoadingBannerProps {
  isLoading: boolean
  label?: string
  detail?: string
  className?: string
}

export function DataLoadingBanner({
  isLoading,
  label = 'Loading data',
  detail,
  className,
}: DataLoadingBannerProps) {
  return (
    <AnimatePresence>
      {isLoading && (
        <motion.div
          initial={{ opacity: 0, y: 16, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, scale: 0.95 }}
          transition={{ type: 'spring', damping: 24, stiffness: 300 }}
          className={cn('pointer-events-auto', className)}
        >
          <div className={cn(
            'flex items-center gap-2.5 pl-3 pr-4 py-2 rounded-full',
            'bg-slate-900/90 dark:bg-slate-100/90 backdrop-blur-md',
            'shadow-lg shadow-black/10 dark:shadow-black/30',
            'ring-1 ring-white/10 dark:ring-black/10',
          )}>
            <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-400 dark:text-indigo-600 shrink-0" />
            <span className="text-xs font-medium text-white dark:text-slate-900 whitespace-nowrap">
              {label}
            </span>
            {detail && (
              <>
                <span className="text-white/30 dark:text-slate-900/30">·</span>
                <span className="text-[11px] text-white/50 dark:text-slate-900/50 truncate max-w-[200px]">
                  {detail}
                </span>
              </>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

// ─── Multi-item toast container ───────────────────────────────────────────

export interface LoadingToastItem {
  /** Stable key for AnimatePresence (e.g. 'assignments', 'children'). */
  key: string
  isLoading: boolean
  label: string
  detail?: string
}

export interface DataLoadingToastsProps {
  items: LoadingToastItem[]
  className?: string
}

/**
 * Floating toast stack — renders at the bottom-center of the nearest
 * positioned ancestor. Only visible items (isLoading=true) are shown;
 * they animate in/out individually.
 */
export function DataLoadingToasts({ items, className }: DataLoadingToastsProps) {
  const active = items.filter(i => i.isLoading)

  return (
    <div
      className={cn(
        'absolute bottom-4 left-1/2 -translate-x-1/2 z-30',
        'flex flex-col-reverse items-center gap-2',
        'pointer-events-none',
        className,
      )}
    >
      <AnimatePresence>
        {active.map(item => (
          <motion.div
            key={item.key}
            layout
            initial={{ opacity: 0, y: 16, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.95 }}
            transition={{ type: 'spring', damping: 24, stiffness: 300 }}
            className="pointer-events-auto"
          >
            <div className={cn(
              'flex items-center gap-2.5 pl-3 pr-4 py-2 rounded-full',
              'bg-slate-900/90 dark:bg-slate-100/90 backdrop-blur-md',
              'shadow-lg shadow-black/10 dark:shadow-black/30',
              'ring-1 ring-white/10 dark:ring-black/10',
            )}>
              <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-400 dark:text-indigo-600 shrink-0" />
              <span className="text-xs font-medium text-white dark:text-slate-900 whitespace-nowrap">
                {item.label}
              </span>
              {item.detail && (
                <>
                  <span className="text-white/30 dark:text-slate-900/30">·</span>
                  <span className="text-[11px] text-white/50 dark:text-slate-900/50 truncate max-w-[200px]">
                    {item.detail}
                  </span>
                </>
              )}
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
