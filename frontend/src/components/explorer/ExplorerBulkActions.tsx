/**
 * ExplorerBulkActions — Floating action bar shown when views are selected.
 */
import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Trash2, Eye, X, ChevronDown, FileDown } from 'lucide-react'
import { usePlatformPublishPolicy } from '@/hooks/usePublishGate'
import {
  VISIBILITY_ICON,
  visibilityDescription,
  visibilityLabel,
  type ViewVisibility,
} from '@/lib/viewVisibility'
import { cn } from '@/lib/utils'

interface ExplorerBulkActionsProps {
  selectedCount: number
  /** Hidden when undefined — used to suppress the affordance for callers
   *  that can't delete every selected view (creator OR
   *  workspace:view:delete in each view's workspace). */
  onDelete?: () => void
  onChangeVisibility: (visibility: 'private' | 'workspace' | 'enterprise') => void
  /** Download the selection as one view file. Hidden when undefined (the
   *  export switch is off, or the selection can't be exported, e.g. Trash). */
  onExport?: () => void
  onClearSelection: () => void
}

// Data from the shared module (lib/viewVisibility), broad → narrow as
// this menu has always rendered it.
const VISIBILITY_OPTIONS: Array<{
  value: ViewVisibility
  label: string
  icon: React.ElementType
  description: string
}> = (['enterprise', 'workspace', 'private'] as const).map(value => ({
  value,
  label: visibilityLabel(value),
  icon: VISIBILITY_ICON[value],
  description: visibilityDescription(value),
}))

export function ExplorerBulkActions({
  selectedCount,
  onDelete,
  onChangeVisibility,
  onExport,
  onClearSelection,
}: ExplorerBulkActionsProps) {
  const [showVisMenu, setShowVisMenu] = useState(false)
  // A deployment that has withdrawn the enterprise tier must not be
  // offered a bulk action that publishes N views at once — every one of
  // them would 403, and a menu entry that always fails is worse than a
  // missing one. The selection can span workspaces, so only the
  // platform-wide ceiling is knowable here; per-workspace policy and
  // restricted sources are enforced per view by the server, and the
  // Explorer already reports partial failures with their reason.
  const platformPolicy = usePlatformPublishPolicy()
  const options = platformPolicy === 'off'
    ? VISIBILITY_OPTIONS.filter(o => o.value !== 'enterprise')
    : VISIBILITY_OPTIONS
  const menuRef = useRef<HTMLDivElement>(null)

  // Close menu on outside click
  useEffect(() => {
    if (!showVisMenu) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowVisMenu(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showVisMenu])

  // The bar floats at the foot of the window, centred on the column it is rendered
  // in rather than on the window, whose left the sidebar takes. The centring sits on
  // a wrapper: on the bar itself, the slide-in animation's transform replaced the
  // `-translate-x-1/2`, and the bar started at the middle instead of straddling it.
  const anchorRef = useRef<HTMLSpanElement>(null)
  const [centre, setCentre] = useState<number | null>(null)
  useLayoutEffect(() => {
    const column = anchorRef.current?.parentElement
    if (!column) return
    const measure = () => {
      const r = column.getBoundingClientRect()
      setCentre(r.left + r.width / 2)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(column)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])

  return (
    <>
      <span ref={anchorRef} hidden />
      <div
        className="pointer-events-none fixed bottom-6 z-50 -translate-x-1/2"
        style={{ left: centre ?? '50%' }}
      >
        <AnimatePresence>
          {selectedCount > 0 && (
            <motion.div
              initial={{ y: 100, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 100, opacity: 0 }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
              className="pointer-events-auto"
            >
              <div className={cn(
                'flex items-center gap-3 px-5 py-3',
                'bg-white dark:bg-slate-900 rounded-2xl shadow-lg',
                'border border-glass-border',
              )}>
                <span className="text-sm font-semibold text-ink">
                  {selectedCount} view{selectedCount !== 1 ? 's' : ''} selected
                </span>

                <div className="w-px h-5 bg-glass-border" />

                {/* Visibility dropdown */}
                <div className="relative" ref={menuRef}>
                  <button
                    onClick={() => setShowVisMenu(prev => !prev)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors duration-150"
                  >
                    <Eye className="w-3.5 h-3.5" />
                    Change Visibility
                    <ChevronDown className={cn('w-3 h-3 transition-transform duration-150', showVisMenu && 'rotate-180')} />
                  </button>

                  <AnimatePresence>
                    {showVisMenu && (
                      <motion.div
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 8 }}
                        transition={{ duration: 0.15 }}
                        className="absolute bottom-full mb-2 left-0 w-56 rounded-xl border border-glass-border bg-white dark:bg-slate-900 shadow-xl overflow-hidden"
                      >
                        <div className="px-3 py-2 border-b border-glass-border/50">
                          <span className="text-[10px] uppercase tracking-wider font-bold text-ink-muted">
                            Set visibility for {selectedCount} view{selectedCount !== 1 ? 's' : ''}
                          </span>
                        </div>
                        {options.map(opt => {
                          const Icon = opt.icon
                          return (
                            <button
                              key={opt.value}
                              onClick={() => {
                                onChangeVisibility(opt.value)
                                setShowVisMenu(false)
                              }}
                              className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                            >
                              <div className="w-7 h-7 rounded-lg bg-accent-lineage/10 flex items-center justify-center shrink-0">
                                <Icon className="w-3.5 h-3.5 text-accent-lineage" />
                              </div>
                              <div className="min-w-0">
                                <div className="text-sm font-medium text-ink">{opt.label}</div>
                                <div className="text-[11px] text-ink-muted">{opt.description}</div>
                              </div>
                            </button>
                          )
                        })}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                {onExport && (
                  <button
                    onClick={onExport}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors duration-150"
                  >
                    <FileDown className="w-3.5 h-3.5" />
                    Export
                  </button>
                )}

                {onDelete && (
                  <>
                    <button
                      onClick={onDelete}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-medium text-red-500 hover:bg-red-500/10 transition-colors duration-150"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Delete ({selectedCount})
                    </button>

                    <div className="w-px h-5 bg-glass-border" />
                  </>
                )}

                <button
                  onClick={onClearSelection}
                  className="p-1.5 rounded-xl text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors duration-150"
                  title="Clear selection"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </>
  )
}
