/**
 * ExplorerBulkActions — Floating action bar shown when views are selected.
 */
import { motion, AnimatePresence } from 'framer-motion'
import { Trash2, Eye, X } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ExplorerBulkActionsProps {
  selectedCount: number
  onDelete: () => void
  onChangeVisibility: () => void
  onClearSelection: () => void
}

export function ExplorerBulkActions({
  selectedCount,
  onDelete,
  onChangeVisibility,
  onClearSelection,
}: ExplorerBulkActionsProps) {
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
            'bg-canvas/95 backdrop-blur-2xl rounded-2xl shadow-2xl',
            'border border-glass-border',
          )}>
            <span className="text-sm font-semibold text-ink">
              {selectedCount} view{selectedCount !== 1 ? 's' : ''} selected
            </span>

            <div className="w-px h-5 bg-glass-border" />

            <button
              onClick={onChangeVisibility}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-all"
            >
              <Eye className="w-3.5 h-3.5" />
              Change Visibility
            </button>

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
