/**
 * UnassignConfirmDialog — confirmation before removing an ontology
 * assignment from a data source.
 *
 * Shows which ontology will be removed, which data source is affected,
 * and warns about downstream impact (views, hierarchy, etc.).
 */
import { Unlink, AlertTriangle, Database, Layers } from 'lucide-react'
import { cn } from '@/lib/utils'

interface UnassignConfirmDialogProps {
  dataSourceLabel: string
  workspaceName: string
  ontologyName: string | null
  onConfirm: () => void
  onCancel: () => void
  isLoading?: boolean
}

export function UnassignConfirmDialog({
  dataSourceLabel,
  workspaceName,
  ontologyName,
  onConfirm,
  onCancel,
  isLoading = false,
}: UnassignConfirmDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={isLoading ? undefined : onCancel} />
      <div className="relative w-full max-w-sm mx-4 rounded-2xl border border-glass-border bg-canvas-elevated shadow-lg animate-in fade-in zoom-in-95 duration-200 overflow-hidden">
        {/* Red accent bar */}
        <div className="h-1 bg-gradient-to-r from-red-500 to-orange-500" />

        <div className="p-6">
          {/* Icon + title */}
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-red-500/15 flex items-center justify-center flex-shrink-0">
              <Unlink className="w-5 h-5 text-red-500" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-ink">Unassign Semantic Layer?</h3>
              <p className="text-[11px] text-ink-muted mt-0.5">This action can be reversed</p>
            </div>
          </div>

          {/* What's being unassigned */}
          <div className="rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] p-3.5 mb-4">
            <div className="flex items-center gap-3 mb-2">
              <Database className="w-4 h-4 text-ink-muted flex-shrink-0" />
              <div className="min-w-0">
                <p className="text-[10px] text-ink-muted uppercase tracking-wider font-bold">Data Source</p>
                <p className="text-xs font-semibold text-ink truncate">{dataSourceLabel}</p>
                <p className="text-[10px] text-ink-muted">in {workspaceName}</p>
              </div>
            </div>
            {ontologyName && (
              <div className="flex items-center gap-3 mt-2 pt-2 border-t border-glass-border/50">
                <Layers className="w-4 h-4 text-ink-muted flex-shrink-0" />
                <div className="min-w-0">
                  <p className="text-[10px] text-ink-muted uppercase tracking-wider font-bold">Current Ontology</p>
                  <p className="text-xs font-semibold text-ink truncate">{ontologyName}</p>
                </div>
              </div>
            )}
          </div>

          {/* Warning */}
          <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-amber-50/60 dark:bg-amber-950/15 border border-amber-200/40 dark:border-amber-800/30 mb-5">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-0.5" />
            <p className="text-[11px] text-amber-700 dark:text-amber-300 leading-relaxed">
              Removing the ontology will disable type hierarchy, semantic search, and any ontology-driven views for this data source.
            </p>
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={onCancel}
              disabled={isLoading}
              className="px-4 py-2 rounded-xl text-xs font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              disabled={isLoading}
              className={cn(
                'flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold transition-colors shadow-sm',
                'bg-red-500 text-white hover:bg-red-600',
                isLoading && 'opacity-60 cursor-not-allowed',
              )}
            >
              <Unlink className="w-3.5 h-3.5" />
              {isLoading ? 'Removing...' : 'Unassign'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
