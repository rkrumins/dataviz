/**
 * DeleteViewDialog — Enterprise-grade delete confirmation with type-to-confirm.
 * Renders via portal so it layers correctly above drawers and other overlays.
 */
import { useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Trash2, Heart, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { deleteView } from '@/services/viewApiService'

interface DeleteViewDialogProps {
  viewId: string
  viewName: string
  favouriteCount: number
  isOpen: boolean
  onClose: () => void
  onDeleted: () => void
  /** When true, permanently removes from DB instead of soft-delete. */
  permanent?: boolean
}

export function DeleteViewDialog({
  viewId,
  viewName,
  favouriteCount,
  isOpen,
  onClose,
  onDeleted,
  permanent,
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
      await deleteView(viewId, !!permanent)
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

  const dialog = (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/60"
        onClick={handleClose}
      >
        <motion.div
          initial={{ scale: 0.95, opacity: 0, y: 8 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.95, opacity: 0, y: 8 }}
          transition={{ type: 'spring', damping: 25, stiffness: 350 }}
          onClick={e => e.stopPropagation()}
          className="w-full max-w-md bg-white dark:bg-slate-900 rounded-2xl shadow-lg shadow-black/20 overflow-hidden"
        >
          {/* Header — red accent strip */}
          <div className="relative">
            <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-red-500 to-rose-500" />
            <div className="flex items-center gap-3.5 px-6 pt-6 pb-4">
              <div className="w-11 h-11 rounded-xl bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 flex items-center justify-center">
                <Trash2 className="w-5 h-5 text-red-500" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-lg font-bold text-slate-900 dark:text-white">{permanent ? 'Permanently Delete View' : 'Delete View'}</h3>
                <p className="text-sm text-slate-500 dark:text-slate-400 truncate">{viewName}</p>
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
                {permanent ? (
                  <>This will <strong className="font-semibold">permanently remove</strong> the view{' '}
                  <strong className="font-semibold">"{viewName}"</strong> from the database.
                  This action is <strong className="font-semibold">irreversible</strong> — the view cannot be restored.</>
                ) : (
                  <>This will delete the view{' '}
                  <strong className="font-semibold">"{viewName}"</strong>.
                  You can restore it later from the Deleted tab.</>
                )}
              </p>
            </div>

            {/* Impact warning */}
            {favouriteCount > 0 && (
              <div className="flex items-center gap-2.5 px-4 py-3 rounded-xl bg-amber-50 dark:bg-amber-500/[0.08] border border-amber-200 dark:border-amber-500/20">
                <Heart className="w-4 h-4 text-amber-500 shrink-0" fill="currentColor" />
                <span className="text-xs font-medium text-amber-700 dark:text-amber-400">
                  This view has {favouriteCount} favourite{favouriteCount !== 1 ? 's' : ''} across the organization
                </span>
              </div>
            )}

            {/* Type to confirm */}
            <div>
              <label className="block text-sm font-medium text-slate-600 dark:text-slate-400 mb-2">
                Type <code className="px-1.5 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200 text-xs font-mono font-bold">{viewName}</code> to confirm
              </label>
              <input
                type="text"
                value={confirmText}
                onChange={e => setConfirmText(e.target.value)}
                placeholder={viewName}
                className={cn(
                  'w-full px-4 py-3 rounded-xl border text-sm font-medium',
                  'bg-slate-50 dark:bg-slate-800/50 text-slate-900 dark:text-white',
                  'placeholder:text-slate-300 dark:placeholder:text-slate-600',
                  'outline-none transition-colors duration-150 duration-200',
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
                'px-5 py-2.5 rounded-xl text-sm font-semibold transition-colors duration-150 duration-200',
                canDelete && !deleting
                  ? 'bg-red-500 text-white hover:bg-red-600 shadow-md hover:shadow-xl hover:-translate-y-0.5 active:translate-y-0'
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
                  Delete View
                </span>
              )}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )

  // Render via portal to layer correctly above drawers and other overlays
  return createPortal(dialog, document.body)
}
