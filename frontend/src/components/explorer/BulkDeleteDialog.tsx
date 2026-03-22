/**
 * BulkDeleteDialog — Confirmation dialog for deleting multiple views.
 * Renders via portal so it layers correctly above all overlays.
 */
import { useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Trash2, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { deleteView } from '@/services/viewApiService'

interface BulkDeleteDialogProps {
  viewIds: string[]
  isOpen: boolean
  onClose: () => void
  onDeleted: () => void
}

export function BulkDeleteDialog({
  viewIds,
  isOpen,
  onClose,
  onDeleted,
}: BulkDeleteDialogProps) {
  const [confirmText, setConfirmText] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const count = viewIds.length
  const confirmPhrase = `delete ${count}`
  const canDelete = confirmText.toLowerCase() === confirmPhrase

  const handleDelete = useCallback(async () => {
    if (!canDelete) return
    setDeleting(true)
    setError(null)
    try {
      await Promise.all(viewIds.map(id => deleteView(id)))
      onDeleted()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Some views could not be deleted')
    } finally {
      setDeleting(false)
    }
  }, [viewIds, canDelete, onDeleted, onClose])

  const handleClose = useCallback(() => {
    if (deleting) return
    setConfirmText('')
    setError(null)
    onClose()
  }, [deleting, onClose])

  if (!isOpen || count === 0) return null

  const dialog = (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
        onClick={handleClose}
      >
        <motion.div
          initial={{ scale: 0.95, opacity: 0, y: 8 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.95, opacity: 0, y: 8 }}
          transition={{ type: 'spring', damping: 25, stiffness: 350 }}
          onClick={e => e.stopPropagation()}
          className="w-full max-w-md bg-white dark:bg-slate-900 rounded-2xl shadow-2xl shadow-black/20 overflow-hidden"
        >
          {/* Header — red accent strip */}
          <div className="relative">
            <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-red-500 to-rose-500" />
            <div className="flex items-center gap-3.5 px-6 pt-6 pb-4">
              <div className="w-11 h-11 rounded-xl bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 flex items-center justify-center">
                <Trash2 className="w-5 h-5 text-red-500" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-lg font-bold text-slate-900 dark:text-white">Delete {count} View{count !== 1 ? 's' : ''}</h3>
                <p className="text-sm text-slate-500 dark:text-slate-400">This action cannot be undone</p>
              </div>
              <button
                onClick={handleClose}
                className="p-2 rounded-xl text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors duration-150"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Body */}
          <div className="px-6 pb-5 space-y-4">
            {/* Warning box */}
            <div className="rounded-xl bg-red-50 dark:bg-red-500/[0.08] border border-red-200 dark:border-red-500/20 px-4 py-3.5">
              <p className="text-sm text-red-800 dark:text-red-300 leading-relaxed">
                This will <strong className="font-semibold">permanently delete {count} view{count !== 1 ? 's' : ''}</strong>.
                All favourites and sharing settings for these views will be lost.
              </p>
            </div>

            {/* Type to confirm */}
            <div>
              <label className="block text-sm font-medium text-slate-600 dark:text-slate-400 mb-2">
                Type <code className="px-1.5 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200 text-xs font-mono font-bold">{confirmPhrase}</code> to confirm
              </label>
              <input
                type="text"
                value={confirmText}
                onChange={e => setConfirmText(e.target.value)}
                placeholder={confirmPhrase}
                className={cn(
                  'w-full px-4 py-3 rounded-xl border text-sm font-medium',
                  'bg-slate-50 dark:bg-slate-800/50 text-slate-900 dark:text-white',
                  'placeholder:text-slate-300 dark:placeholder:text-slate-600',
                  'outline-none transition-all duration-200',
                  canDelete
                    ? 'border-red-400 dark:border-red-500/50 ring-2 ring-red-100 dark:ring-red-500/10'
                    : 'border-slate-200 dark:border-slate-700 focus:border-slate-400 dark:focus:border-slate-500 focus:ring-2 focus:ring-slate-100 dark:focus:ring-slate-500/10'
                )}
                autoFocus
                onKeyDown={e => { if (e.key === 'Enter' && canDelete) handleDelete() }}
              />
            </div>

            {error && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20">
                <AlertCircle className="w-3.5 h-3.5 text-red-500 shrink-0" />
                <p className="text-xs font-medium text-red-600 dark:text-red-400">{error}</p>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30">
            <button
              onClick={handleClose}
              disabled={deleting}
              className="px-4 py-2.5 rounded-xl text-sm font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors duration-150"
            >
              Cancel
            </button>
            <button
              onClick={handleDelete}
              disabled={!canDelete || deleting}
              className={cn(
                'px-5 py-2.5 rounded-xl text-sm font-semibold transition-all duration-200',
                canDelete && !deleting
                  ? 'bg-red-500 text-white hover:bg-red-600 shadow-lg shadow-red-500/25 hover:shadow-xl hover:-translate-y-0.5 active:translate-y-0'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-600 cursor-not-allowed'
              )}
            >
              {deleting ? (
                <span className="flex items-center gap-2">
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Deleting...
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <Trash2 className="w-3.5 h-3.5" />
                  Delete {count} View{count !== 1 ? 's' : ''}
                </span>
              )}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )

  return createPortal(dialog, document.body)
}
