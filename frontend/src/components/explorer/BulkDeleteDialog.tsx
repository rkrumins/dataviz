/**
 * BulkDeleteDialog — Confirmation dialog for deleting multiple views.
 * Renders via portal so it layers correctly above all overlays.
 */
import { useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Trash2, AlertCircle, ListFilter } from 'lucide-react'
import { useQueries } from '@tanstack/react-query'
import { cn } from '@/lib/utils'
import { deleteView } from '@/services/viewApiService'
import { listSubsets, SUBSETS_QUERY_KEY } from '@/services/searchViewsApi'
import { useFeature } from '@/store/features'
import { Backdrop } from '@/components/ui/Backdrop'

interface BulkDeleteDialogProps {
  viewIds: string[]
  isOpen: boolean
  onClose: () => void
  onDeleted: () => void
  /** When true, permanently removes from DB instead of soft-delete. */
  permanent?: boolean
}

/** The most views whose subsets the dialog asks about, one request each. */
const SUBSET_CHECK_MAX = 50

export function BulkDeleteDialog({
  viewIds,
  isOpen,
  onClose,
  onDeleted,
  permanent,
}: BulkDeleteDialogProps) {
  const [confirmText, setConfirmText] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const count = viewIds.length
  const confirmPhrase = `delete ${count}`
  const canDelete = confirmText.toLowerCase() === confirmPhrase
  // Subset views made from these show nothing once they're gone: say how many first.
  // Asked per view, so only for a selection small enough to ask about.
  const searchViewsOn = useFeature('searchViewsEnabled')
  const askSubsets = isOpen && searchViewsOn && count <= SUBSET_CHECK_MAX
  const subsetLists = useQueries({
    queries: viewIds.map((id) => ({
      queryKey: [SUBSETS_QUERY_KEY, id],
      queryFn: () => listSubsets(id),
      enabled: askSubsets,
      staleTime: 30_000,
    })),
  })
  // Subsets deleted along with their base aren't left behind.
  const leftBehind = askSubsets
    ? subsetLists.reduce((sum, q) => sum + (q.data
      ? q.data.count - q.data.items.filter((item) => viewIds.includes(item.viewId)).length : 0), 0)
    : 0

  const handleDelete = useCallback(async () => {
    if (!canDelete) return
    setDeleting(true)
    setError(null)
    try {
      await Promise.all(viewIds.map(id => deleteView(id, !!permanent)))
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
    <>
      <Backdrop open={isOpen} onClick={handleClose} zClassName="z-[80]" className="bg-black/60" />
      <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 pointer-events-none">
      <AnimatePresence>
        <motion.div
          initial={{ scale: 0.95, opacity: 0, y: 8 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.95, opacity: 0, y: 8 }}
          transition={{ type: 'spring', damping: 25, stiffness: 350 }}
          onClick={e => e.stopPropagation()}
          className="pointer-events-auto w-full max-w-md bg-white dark:bg-slate-900 rounded-2xl shadow-lg shadow-black/20 overflow-hidden"
        >
          {/* Header — red accent strip */}
          <div className="relative">
            <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-red-500 to-rose-500" />
            <div className="flex items-center gap-3.5 px-6 pt-6 pb-4">
              <div className="w-11 h-11 rounded-xl bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 flex items-center justify-center">
                <Trash2 className="w-5 h-5 text-red-500" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-lg font-bold text-slate-900 dark:text-white">{permanent ? 'Permanently Delete' : 'Delete'} {count} View{count !== 1 ? 's' : ''}</h3>
                <p className="text-sm text-slate-500 dark:text-slate-400">{permanent ? 'This action is irreversible' : 'You can restore them later from the Deleted tab'}</p>
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
                  <>This will <strong className="font-semibold">permanently remove {count} view{count !== 1 ? 's' : ''}</strong> from the database. This cannot be undone.</>
                ) : (
                  <>This will delete <strong className="font-semibold">{count} view{count !== 1 ? 's' : ''}</strong>. You can restore them later from the Deleted tab.</>
                )}
              </p>
            </div>
            {leftBehind > 0 && (
              <div className="flex items-start gap-2.5 px-4 py-3 rounded-xl bg-amber-50 dark:bg-amber-500/[0.08] border border-amber-200 dark:border-amber-500/20">
                <ListFilter className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" aria-hidden />
                <span className="text-xs font-medium text-amber-700 dark:text-amber-400">
                  {leftBehind.toLocaleString()} subset {leftBehind === 1 ? 'view is' : 'views are'} made from these views.{' '}
                  {permanent ? 'Once they’re gone' : 'Until they’re restored'}, {leftBehind === 1 ? 'it shows' : 'those show'} nothing.
                </span>
              </div>
            )}

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
                  Delete {count} View{count !== 1 ? 's' : ''}
                </span>
              )}
            </button>
          </div>
        </motion.div>
      </AnimatePresence>
      </div>
    </>
  )

  return createPortal(dialog, document.body)
}
