/**
 * ExplorerBulkActions — Floating action bar shown when views are selected.
 */
import { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Trash2, Eye, X, Globe, Users, Lock, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ExplorerBulkActionsProps {
  selectedCount: number
  onDelete: () => void
  onChangeVisibility: (visibility: 'private' | 'workspace' | 'enterprise') => void
  onClearSelection: () => void
}

const VISIBILITY_OPTIONS: Array<{
  value: 'private' | 'workspace' | 'enterprise'
  label: string
  icon: React.ElementType
  description: string
}> = [
  { value: 'enterprise', label: 'Enterprise', icon: Globe, description: 'Visible to everyone' },
  { value: 'workspace', label: 'Workspace', icon: Users, description: 'Visible to workspace members' },
  { value: 'private', label: 'Private', icon: Lock, description: 'Only visible to you' },
]

export function ExplorerBulkActions({
  selectedCount,
  onDelete,
  onChangeVisibility,
  onClearSelection,
}: ExplorerBulkActionsProps) {
  const [showVisMenu, setShowVisMenu] = useState(false)
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

  return (
    <AnimatePresence>
      {selectedCount > 0 && (
        <motion.div
          initial={{ y: 100, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 100, opacity: 0 }}
          transition={{ type: 'spring', damping: 25, stiffness: 300 }}
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50"
        >
          <div className={cn(
            'flex items-center gap-3 px-5 py-3',
            'bg-white dark:bg-slate-900 rounded-2xl shadow-2xl',
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
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-all"
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
                    {VISIBILITY_OPTIONS.map(opt => {
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

            <button
              onClick={onDelete}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-medium text-red-500 hover:bg-red-500/10 transition-all"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete ({selectedCount})
            </button>

            <div className="w-px h-5 bg-glass-border" />

            <button
              onClick={onClearSelection}
              className="p-1.5 rounded-xl text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-all"
              title="Clear selection"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
