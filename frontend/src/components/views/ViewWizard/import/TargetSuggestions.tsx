/**
 * "Suggested for this file": the data sources here most likely to be the one the view was built
 * on, ranked by what the file says about its source (same kind of database, same graph, same
 * semantic layer) and then MEASURED: a sample of the view's own entities is looked up in each,
 * so "found 49 of 50 here" is evidence, not a guess.
 *
 * For a view with its data, only a data source under version control can take it: the others
 * are shown, but can't be chosen.
 */
import { createElement } from 'react'
import { Check, GitBranch, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getProviderLogo } from '@/components/admin/ProviderLogos'
import type { TargetSuggestion } from '@/services/viewTransferApiService'
import { percent } from '@/features/view-transfer/format'

export function TargetSuggestions({ suggestions, selectedDataSourceId, onSelect, requireVersioned = false }: {
  suggestions: TargetSuggestion[]
  selectedDataSourceId: string | null
  onSelect: (workspaceId: string, dataSourceId: string) => void
  /** Only data sources under version control can be chosen (a view with its data). */
  requireVersioned?: boolean
}) {
  const top = suggestions.slice(0, 3)
  if (top.length === 0) return null
  return (
    <div className="rounded-2xl border border-indigo-200/70 dark:border-indigo-900/60 bg-gradient-to-br from-indigo-50/70 to-violet-50/40 dark:from-indigo-950/25 dark:to-violet-950/10 p-4">
      <div className="flex items-center gap-2 mb-3">
        <Sparkles className="w-4 h-4 text-indigo-500" />
        <p className="text-xs font-bold text-ink">Suggested for this file</p>
        <p className="text-[11px] text-ink-muted">Checked with a sample of the view’s own entities</p>
      </div>
      <div className={cn('grid gap-2.5', top.length === 1 ? 'grid-cols-1' : top.length === 2 ? 'grid-cols-2' : 'grid-cols-3')}>
        {top.map((s, i) => {
          const active = s.dataSourceId === selectedDataSourceId
          const hit = s.sampleHitRate
          const found = hit !== null ? Math.round(hit * s.sampleSize) : null
          const unavailable = requireVersioned && s.versioned === false
          return (
            <button key={s.dataSourceId} type="button" onClick={() => onSelect(s.workspaceId, s.dataSourceId)}
              aria-pressed={active} disabled={unavailable}
              title={unavailable ? 'Not under version control, so it can’t take the data' : undefined}
              className={cn('text-left rounded-xl border-2 bg-canvas-elevated px-3 py-2.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
                active ? 'border-indigo-500 shadow-sm shadow-indigo-500/15' : 'border-transparent hover:border-indigo-200 dark:hover:border-indigo-800')}>
              <div className="flex items-center gap-2 min-w-0">
                {s.providerType ? createElement(getProviderLogo(s.providerType), { className: 'w-4 h-4 shrink-0' }) : null}
                <span className="text-xs font-semibold text-ink truncate flex-1">{s.label || s.graphName || 'Data source'}</span>
                {active ? <Check className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
                  : i === 0 && <span className="text-[9px] font-bold uppercase tracking-wider text-indigo-600 dark:text-indigo-400 shrink-0">Best match</span>}
              </div>
              <p className="text-[10px] text-ink-muted truncate mt-0.5">{s.workspaceName ?? 'Workspace'}{s.graphName ? ` · ${s.graphName}` : ''}</p>
              {hit !== null ? (
                <div className="mt-2">
                  <div className="flex items-baseline justify-between">
                    <span className={cn('text-sm font-bold tabular-nums', hit >= 0.9 ? 'text-emerald-600 dark:text-emerald-400' : hit >= 0.5 ? 'text-amber-600 dark:text-amber-400' : 'text-rose-600 dark:text-rose-400')}>
                      {percent(hit, 0)}
                    </span>
                    <span className="text-[10px] text-ink-muted">{found} of {s.sampleSize} found</span>
                  </div>
                  <div className="h-1 rounded-full bg-black/[0.06] dark:bg-white/[0.08] mt-1 overflow-hidden">
                    <div className={cn('h-full rounded-full', hit >= 0.9 ? 'bg-emerald-500' : hit >= 0.5 ? 'bg-amber-500' : 'bg-rose-500')}
                      style={{ width: `${Math.max(2, hit * 100)}%` }} />
                  </div>
                </div>
              ) : (
                <p className="text-[10px] text-ink-muted mt-2">Not sampled</p>
              )}
              {(s.reasons.length > 0 || requireVersioned) && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {requireVersioned && (
                    <span className={cn('inline-flex items-center gap-0.5 text-[9px] font-semibold px-1.5 py-0.5 rounded',
                      s.versioned ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-black/[0.04] dark:bg-white/[0.06] text-ink-muted')}>
                      <GitBranch className="w-2.5 h-2.5" /> {s.versioned ? 'Version control' : 'No version control'}
                    </span>
                  )}
                  {s.reasons.map(r => (
                    <span key={r} className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-black/[0.04] dark:bg-white/[0.06] text-ink-secondary">{r}</span>
                  ))}
                </div>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
