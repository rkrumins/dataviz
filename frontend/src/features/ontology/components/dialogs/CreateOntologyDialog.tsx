import { useState } from 'react'
import { X, FileEdit, Sparkles, PenLine } from 'lucide-react'
import { cn } from '@/lib/utils'

interface CreateOntologyDialogProps {
  hasGraphContext: boolean
  onClose: () => void
  onCreate: (name: string, prePopulate: boolean) => void
}

export function CreateOntologyDialog({
  hasGraphContext,
  onClose,
  onCreate,
}: CreateOntologyDialogProps) {
  const [name, setName] = useState('New Semantic Layer')
  const [mode, setMode] = useState<'empty' | 'graph'>(hasGraphContext ? 'graph' : 'empty')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-canvas-elevated border border-glass-border rounded-2xl shadow-2xl w-full max-w-md mx-4 animate-in zoom-in-95 fade-in duration-200 overflow-hidden">
        {/* Header with accent bar */}
        <div className="border-b border-glass-border/50 px-6 pt-6 pb-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-indigo-50 dark:bg-indigo-950/30 flex items-center justify-center">
                <PenLine className="w-5 h-5 text-indigo-500" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-ink">Create Semantic Layer</h3>
                <p className="text-[11px] text-ink-muted mt-0.5">Define how your graph data is structured and displayed</p>
              </div>
            </div>
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-ink-muted transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="px-6 py-5">
          {/* Name input */}
          <div className="mb-5">
            <label className="block text-xs font-medium text-ink-secondary mb-1.5">Name</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g., Data Catalog Schema"
              autoFocus
              className="w-full px-4 py-2.5 rounded-xl bg-black/[0.03] dark:bg-white/[0.03] border border-glass-border text-sm text-ink placeholder:text-ink-muted/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500/40 transition-all"
            />
            <p className="text-[11px] text-ink-muted mt-1.5">Choose a descriptive name. You can change it later.</p>
          </div>

          {/* Starting point selection — visual option cards */}
          <div className="mb-2">
            <label className="block text-xs font-medium text-ink-secondary mb-2">Starting Point</label>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => setMode('empty')}
                className={cn(
                  'text-left p-4 rounded-xl border-2 transition-all',
                  mode === 'empty'
                    ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/20 shadow-sm shadow-indigo-500/10'
                    : 'border-glass-border hover:border-glass-border-hover'
                )}
              >
                <div className={cn(
                  'w-10 h-10 rounded-lg flex items-center justify-center mb-3',
                  mode === 'empty' ? 'bg-indigo-100 dark:bg-indigo-900/50' : 'bg-black/5 dark:bg-white/5'
                )}>
                  <FileEdit className={cn('w-5 h-5', mode === 'empty' ? 'text-indigo-500' : 'text-ink-muted')} />
                </div>
                <p className="text-sm font-semibold text-ink">Empty Draft</p>
                <p className="text-[11px] text-ink-muted mt-0.5 leading-relaxed">Start from scratch and manually define types</p>
              </button>

              <button
                onClick={() => setMode('graph')}
                disabled={!hasGraphContext}
                className={cn(
                  'text-left p-4 rounded-xl border-2 transition-all',
                  !hasGraphContext && 'opacity-50 cursor-not-allowed',
                  mode === 'graph'
                    ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/20 shadow-sm shadow-indigo-500/10'
                    : 'border-glass-border hover:border-glass-border-hover'
                )}
              >
                <div className={cn(
                  'w-10 h-10 rounded-lg flex items-center justify-center mb-3',
                  mode === 'graph' ? 'bg-indigo-100 dark:bg-indigo-900/50' : 'bg-black/5 dark:bg-white/5'
                )}>
                  <Sparkles className={cn('w-5 h-5', mode === 'graph' ? 'text-indigo-500' : 'text-ink-muted')} />
                </div>
                <p className="text-sm font-semibold text-ink">From Graph</p>
                <p className="text-[11px] text-ink-muted mt-0.5 leading-relaxed">
                  {hasGraphContext
                    ? 'Auto-detect types from your active data source'
                    : 'No active data source available'}
                </p>
              </button>
            </div>
          </div>
        </div>

        {/* Actions footer */}
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-glass-border/50 bg-black/[0.01] dark:bg-white/[0.01]">
          <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
            Cancel
          </button>
          <button
            onClick={() => onCreate(name.trim() || 'New Semantic Layer', mode === 'graph')}
            disabled={!name.trim()}
            className="flex items-center gap-2 px-5 py-2 rounded-xl bg-indigo-500 text-white text-sm font-semibold hover:bg-indigo-600 transition-colors disabled:opacity-50 shadow-sm"
          >
            {mode === 'graph' && <Sparkles className="w-3.5 h-3.5" />}
            {mode === 'graph' ? 'Create & Populate' : 'Create Draft'}
          </button>
        </div>
      </div>
    </div>
  )
}
