import { X, Copy, ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { OntologyMatchResult } from '@/services/ontologyDefinitionService'

interface SuggestDialogProps {
  matches: OntologyMatchResult[]
  suggestedName: string
  onUseExisting: (ontologyId: string) => void
  onCloneExisting: (ontologyId: string) => void
  onCreateNew: () => void
  onClose: () => void
}

export function SuggestDialog({
  matches,
  suggestedName: _suggestedName,
  onUseExisting,
  onCloneExisting,
  onCreateNew,
  onClose,
}: SuggestDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-canvas-elevated border border-glass-border rounded-2xl shadow-2xl w-full max-w-lg mx-4 p-6 animate-in zoom-in-95 fade-in duration-200">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-lg font-bold text-ink">Existing Ontologies Match Your Graph</h3>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-ink-muted">
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-sm text-ink-muted mb-5">
          We found ontologies that already cover some of your graph types.
        </p>

        {/* Match list */}
        <div className="space-y-3 max-h-72 overflow-y-auto pr-1">
          {matches.map(match => {
            const totalTypes = match.coveredEntityTypes.length + match.uncoveredEntityTypes.length
            const coveragePct = totalTypes > 0 ? Math.round((match.coveredEntityTypes.length / totalTypes) * 100) : 0

            return (
              <div
                key={match.ontologyId}
                className="border border-glass-border rounded-xl p-4"
              >
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <p className="text-sm font-semibold text-ink">{match.ontologyName}</p>
                    <p className="text-xs text-ink-muted">v{match.version}</p>
                  </div>
                  <span className="text-xs font-semibold text-ink-muted">
                    {match.coveredEntityTypes.length}/{totalTypes} types
                  </span>
                </div>

                {/* Coverage bar */}
                <div className="w-full h-1.5 rounded-full bg-black/5 dark:bg-white/5 mb-2">
                  <div
                    className={cn(
                      'h-full rounded-full transition-all',
                      coveragePct >= 80 ? 'bg-emerald-500' : coveragePct >= 50 ? 'bg-amber-500' : 'bg-red-400'
                    )}
                    style={{ width: `${coveragePct}%` }}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div className="flex-1 min-w-0 mr-3">
                    {match.uncoveredEntityTypes.length > 0 && (
                      <p className="text-[11px] text-ink-muted truncate">
                        Missing: {match.uncoveredEntityTypes.join(', ')}
                      </p>
                    )}
                    {match.uncoveredEntityTypes.length === 0 && (
                      <p className="text-[11px] text-emerald-600 dark:text-emerald-400">Full coverage</p>
                    )}
                  </div>
                  <div className="flex gap-2 flex-shrink-0">
                    <button
                      onClick={() => onCloneExisting(match.ontologyId)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-ink-muted border border-glass-border hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                    >
                      <Copy className="w-3 h-3" />
                      Clone & Extend
                    </button>
                    <button
                      onClick={() => onUseExisting(match.ontologyId)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-indigo-500 hover:bg-indigo-600 transition-colors"
                    >
                      <ArrowRight className="w-3 h-3" />
                      Use This
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        {/* Divider + create new */}
        <div className="relative my-5">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-glass-border" />
          </div>
          <div className="relative flex justify-center text-xs">
            <span className="bg-canvas-elevated px-3 text-ink-muted">Or create a new draft from scratch</span>
          </div>
        </div>

        <div className="flex justify-center">
          <button
            onClick={onCreateNew}
            className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted border border-glass-border hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
          >
            Create New Draft
          </button>
        </div>
      </div>
    </div>
  )
}
