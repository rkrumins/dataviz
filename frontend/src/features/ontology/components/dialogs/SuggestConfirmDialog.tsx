/**
 * SuggestConfirmDialog — confirmation before generating a semantic layer
 * from the active data source's graph schema.
 */
import { X, Sparkles, Database, Loader2, Box, GitBranch } from 'lucide-react'
import { cn } from '@/lib/utils'

interface SuggestConfirmDialogProps {
  dataSourceLabel: string | null
  onConfirm: () => void
  onClose: () => void
  isLoading: boolean
}

export function SuggestConfirmDialog({
  dataSourceLabel,
  onConfirm,
  onClose,
  isLoading,
}: SuggestConfirmDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={isLoading ? undefined : onClose} />
      <div className="relative bg-canvas-elevated border border-glass-border rounded-2xl shadow-2xl w-full max-w-md mx-4 animate-in zoom-in-95 fade-in duration-200 overflow-hidden">
        {/* Header */}
        <div className="border-b border-glass-border/50 px-6 pt-6 pb-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500/20 to-purple-500/20 border border-indigo-500/20 flex items-center justify-center">
                <Sparkles className="w-5 h-5 text-indigo-500" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-ink">Suggest from Graph</h3>
                <p className="text-[11px] text-ink-muted mt-0.5">Auto-generate a semantic layer</p>
              </div>
            </div>
            {!isLoading && (
              <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-ink-muted transition-colors">
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        <div className="px-6 py-5 space-y-4">
          {/* Description */}
          <p className="text-sm text-ink-secondary leading-relaxed">
            This will analyze the entity and relationship types in your active data source
            and create a new <span className="font-semibold text-ink">draft semantic layer</span> with
            matching type definitions.
          </p>

          {/* Data source context */}
          {dataSourceLabel && (
            <div className="rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] p-3.5">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200/50 dark:border-emerald-800/40 flex items-center justify-center flex-shrink-0">
                  <Database className="w-4 h-4 text-emerald-500" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] text-ink-muted uppercase tracking-wider font-bold">Data Source</p>
                  <p className="text-sm font-semibold text-ink truncate">{dataSourceLabel}</p>
                </div>
              </div>
            </div>
          )}

          {/* What gets generated */}
          <div className="rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] p-4">
            <p className="text-[10px] text-ink-muted uppercase tracking-wider font-bold mb-2.5">What will be generated</p>
            <div className="space-y-2">
              <div className="flex items-center gap-2.5">
                <Box className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />
                <span className="text-xs text-ink-secondary">Entity types for each node label found</span>
              </div>
              <div className="flex items-center gap-2.5">
                <GitBranch className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />
                <span className="text-xs text-ink-secondary">Relationship types for each edge type found</span>
              </div>
              <div className="flex items-center gap-2.5">
                <Sparkles className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />
                <span className="text-xs text-ink-secondary">Default visual styles and hierarchy hints</span>
              </div>
            </div>
          </div>

          {/* Loading state */}
          {isLoading && (
            <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-indigo-50/50 dark:bg-indigo-950/20 border border-indigo-200/50 dark:border-indigo-800/30">
              <Loader2 className="w-4 h-4 text-indigo-500 animate-spin flex-shrink-0" />
              <p className="text-xs text-indigo-600 dark:text-indigo-400 font-medium">
                Analyzing graph schema and generating definitions...
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-glass-border/50 bg-black/[0.01] dark:bg-white/[0.01]">
          <button
            onClick={onClose}
            disabled={isLoading}
            className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={isLoading}
            className={cn(
              'flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold transition-all shadow-sm disabled:opacity-60',
              'bg-gradient-to-r from-indigo-500 to-purple-500 text-white',
              'hover:from-indigo-600 hover:to-purple-600 shadow-indigo-500/25',
            )}
          >
            {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            {isLoading ? 'Generating...' : 'Generate Draft'}
          </button>
        </div>
      </div>
    </div>
  )
}
