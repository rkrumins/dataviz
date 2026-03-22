/**
 * DeleteConfirmDialog — proper confirmation UI for deleting an ontology.
 * Replaces window.confirm with a polished, branded dialog.
 */
import { useState, useRef, useEffect } from 'react'
import { AlertTriangle, Trash2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'

interface DeleteConfirmDialogProps {
  ontology: OntologyDefinitionResponse
  assignmentCount: number
  onConfirm: () => void
  onClose: () => void
}

export function DeleteConfirmDialog({
  ontology,
  assignmentCount,
  onConfirm,
  onClose,
}: DeleteConfirmDialogProps) {
  const [confirmText, setConfirmText] = useState('')
  const [isDeleting, setIsDeleting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const nameMatch = confirmText.trim().toLowerCase() === ontology.name.trim().toLowerCase()

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const blocked = ontology.isSystem || assignmentCount > 0

  async function handleDelete() {
    if (blocked || !nameMatch) return
    setIsDeleting(true)
    onConfirm()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />

      {/* Dialog */}
      <div className="relative w-full max-w-md mx-4 rounded-2xl border border-glass-border bg-canvas-elevated shadow-2xl animate-in fade-in slide-in-from-bottom-4 duration-200">
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-1 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
        >
          <X className="w-4 h-4" />
        </button>

        {/* Header with warning icon */}
        <div className="px-6 pt-6 pb-4">
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200/50 dark:border-red-800/50 flex items-center justify-center flex-shrink-0">
              <AlertTriangle className="w-5 h-5 text-red-500" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-base font-bold text-ink">Delete Semantic Layer</h3>
              <p className="text-sm text-ink-muted mt-1">
                You are about to delete <span className="font-semibold text-ink">"{ontology.name}"</span> (v{ontology.version}).
                You can undo this action briefly after deletion.
              </p>
            </div>
          </div>
        </div>

        {/* Blockers */}
        {blocked && (
          <div className="mx-6 mb-4 rounded-xl border border-red-200 dark:border-red-800/50 bg-red-50/50 dark:bg-red-950/20 p-4">
            <p className="text-xs font-semibold text-red-700 dark:text-red-400 mb-2">Cannot delete this semantic layer:</p>
            <ul className="space-y-1.5">
              {ontology.isSystem && (
                <li className="flex items-center gap-2 text-xs text-red-600 dark:text-red-400">
                  <div className="w-1 h-1 rounded-full bg-red-500" />
                  System semantic layers cannot be deleted
                </li>
              )}
              {assignmentCount > 0 && (
                <li className="flex items-center gap-2 text-xs text-red-600 dark:text-red-400">
                  <div className="w-1 h-1 rounded-full bg-red-500" />
                  Assigned to {assignmentCount} data source{assignmentCount !== 1 ? 's' : ''} — unassign first
                </li>
              )}
            </ul>
          </div>
        )}

        {/* Confirmation input */}
        {!blocked && (
          <div className="px-6 pb-4">
            <div className="rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] p-4">
              <label className="block text-xs font-medium text-ink-secondary mb-2">
                Type <span className="font-mono font-bold text-ink">{ontology.name}</span> to confirm
              </label>
              <input
                ref={inputRef}
                type="text"
                value={confirmText}
                onChange={e => setConfirmText(e.target.value)}
                placeholder={ontology.name}
                className="w-full px-3 py-2 rounded-lg bg-canvas border border-glass-border text-sm text-ink placeholder:text-ink-muted/40 focus:outline-none focus:ring-2 focus:ring-red-500/40 focus:border-red-500/30 transition-all"
                onKeyDown={e => e.key === 'Enter' && nameMatch && handleDelete()}
              />
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-glass-border bg-black/[0.01] dark:bg-white/[0.01] rounded-b-2xl">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm font-medium text-ink-secondary border border-glass-border hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleDelete}
            disabled={blocked || !nameMatch || isDeleting}
            className={cn(
              'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all',
              blocked || !nameMatch
                ? 'bg-red-100 dark:bg-red-950/30 text-red-300 dark:text-red-700 cursor-not-allowed'
                : 'bg-red-500 text-white hover:bg-red-600 shadow-sm shadow-red-500/20',
            )}
          >
            <Trash2 className="w-3.5 h-3.5" />
            {isDeleting ? 'Deleting...' : 'Delete Semantic Layer'}
          </button>
        </div>
      </div>
    </div>
  )
}
