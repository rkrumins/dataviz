/**
 * UnsavedChangesDialog — shown when the user tries to navigate away with pending changes.
 */
import { AlertTriangle, Save, Trash2 } from 'lucide-react'

interface UnsavedChangesDialogProps {
  onSave: () => void
  onDiscard: () => void
  onCancel: () => void
  isSaving?: boolean
}

export function UnsavedChangesDialog({
  onSave,
  onDiscard,
  onCancel,
  isSaving,
}: UnsavedChangesDialogProps) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onCancel} />
      <div className="relative bg-canvas-elevated rounded-2xl shadow-lg border border-glass-border w-full max-w-md mx-4 overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="px-6 pt-6 pb-4">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500/10 flex items-center justify-center flex-shrink-0">
              <AlertTriangle className="w-5 h-5 text-amber-500" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-ink">Unsaved changes</h3>
              <p className="text-sm text-ink-muted mt-0.5">
                You have pending changes that haven't been saved yet.
              </p>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="px-6 pb-6 flex items-center gap-2">
          <button
            onClick={onDiscard}
            className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-sm font-medium text-red-600 hover:bg-red-50 dark:hover:bg-red-950/20 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Discard
          </button>
          <div className="flex-1" />
          <button
            onClick={onCancel}
            className="px-4 py-2.5 rounded-xl text-sm font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onSave}
            disabled={isSaving}
            className="flex items-center gap-1.5 px-5 py-2.5 rounded-xl text-sm font-semibold bg-indigo-500 text-white hover:bg-indigo-600 transition-colors shadow-sm shadow-indigo-500/20 disabled:opacity-50"
          >
            <Save className="w-3.5 h-3.5" />
            {isSaving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  )
}
