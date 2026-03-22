/**
 * DeleteViewDialog — Enterprise-grade delete confirmation with type-to-confirm.
 * Pattern reused from DeleteConfirmDialog in the ontology feature.
 */
import { useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, AlertTriangle, Heart } from 'lucide-react'
import { cn } from '@/lib/utils'
import { deleteView } from '@/services/viewApiService'

interface DeleteViewDialogProps {
  viewId: string
  viewName: string
  favouriteCount: number
  isOpen: boolean
  onClose: () => void
  onDeleted: () => void
}

export function DeleteViewDialog({
  viewId,
  viewName,
  favouriteCount,
  isOpen,
  onClose,
  onDeleted,
}: DeleteViewDialogProps) {
  const [confirmText, setConfirmText] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canDelete = confirmText === viewName

  const handleDelete = useCallback(async () => {
    if (!canDelete) return
    setDeleting(true)
    setError(null)
    try {
      await deleteView(viewId)
      onDeleted()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete view')
    } finally {
      setDeleting(false)
    }
  }, [viewId, canDelete, onDeleted, onClose])

  const handleClose = useCallback(() => {
    if (deleting) return
    setConfirmText('')
    setError(null)
    onClose()
  }, [deleting, onClose])

  if (!isOpen) return null

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
        onClick={handleClose}
      >
        <motion.div
          initial={{ scale: 0.95, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.95, opacity: 0 }}
          onClick={e => e.stopPropagation()}
          className="w-full max-w-md bg-canvas/98 backdrop-blur-2xl rounded-2xl shadow-2xl border border-glass-border overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center gap-3 px-6 py-5 border-b border-glass-border/50">
            <div className="w-10 h-10 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center">
              <AlertTriangle className="w-5 h-5 text-red-500" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-lg font-bold text-ink">Delete View</h3>
              <p className="text-sm text-ink-muted truncate">{viewName}</p>
            </div>
            <button
              onClick={handleClose}
              className="p-2 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-all"
            >
              <X className="w-5 h-5 text-ink-muted" />
            </button>
          </div>

          {/* Body */}
          <div className="px-6 py-5 space-y-4">
            <p className="text-sm text-ink-muted leading-relaxed">
              This will permanently delete the view <strong className="text-ink font-semibold">{viewName}</strong>.
              This action cannot be undone.
            </p>

            {/* Impact warning */}
            {favouriteCount > 0 && (
              <div className="flex items-center gap-2.5 px-4 py-3 rounded-xl bg-amber-500/10 border border-amber-500/20">
                <Heart className="w-4 h-4 text-amber-500 shrink-0" />
                <span className="text-xs font-medium text-amber-600 dark:text-amber-400">
                  This view has {favouriteCount} favourite{favouriteCount !== 1 ? 's' : ''} across the organization
                </span>
              </div>
            )}

            {/* Type to confirm */}
            <div>
              <label className="block text-sm font-medium text-ink-muted mb-2">
                Type <strong className="text-ink font-semibold">{viewName}</strong> to confirm
              </label>
              <input
                type="text"
                value={confirmText}
                onChange={e => setConfirmText(e.target.value)}
                placeholder={viewName}
                className={cn(
                  'w-full px-4 py-2.5 rounded-xl border text-sm text-ink font-medium',
                  'bg-black/[0.03] dark:bg-white/[0.03]',
                  'placeholder:text-ink-muted/40',
                  'outline-none transition-all duration-200',
                  confirmText === viewName
                    ? 'border-red-500/50 focus:border-red-500'
                    : 'border-glass-border focus:border-glass-border/80'
                )}
                autoFocus
              />
            </div>

            {error && (
              <p className="text-xs font-medium text-red-500">{error}</p>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-glass-border/50">
            <button
              onClick={handleClose}
              disabled={deleting}
              className="px-4 py-2.5 rounded-xl text-sm font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-all"
            >
              Cancel
            </button>
            <button
              onClick={handleDelete}
              disabled={!canDelete || deleting}
              className={cn(
                'px-5 py-2.5 rounded-xl text-sm font-semibold transition-all duration-200',
                canDelete && !deleting
                  ? 'bg-red-500 text-white hover:bg-red-600 shadow-lg shadow-red-500/25 hover:shadow-xl hover:-translate-y-0.5'
                  : 'bg-black/5 dark:bg-white/5 text-ink-muted cursor-not-allowed'
              )}
            >
              {deleting ? 'Deleting...' : 'Delete View'}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}
