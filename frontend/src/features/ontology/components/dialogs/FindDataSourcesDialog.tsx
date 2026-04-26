/**
 * FindDataSourcesDialog — reverse-suggest flow.
 *
 * Given the currently selected ontology, analyzes ALL data sources across
 * all workspaces and ranks them by coverage score. Users can then assign
 * the ontology to the best-fit data sources directly from this dialog.
 */
import { useState, useEffect, useRef } from 'react'
import {
  X, Database, Loader2, CheckCircle2,
  AlertTriangle, ArrowRight, Search, BarChart3,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import { ontologyDefinitionService } from '@/services/ontologyDefinitionService'
import type { WorkspaceResponse } from '@/services/workspaceService'
import { fetchSchemaStats } from '../../lib/ontology-utils'

interface RankedDataSource {
  workspaceId: string
  workspaceName: string
  dataSourceId: string
  dataSourceLabel: string
  coveragePercent: number | null
  status: 'loading' | 'done' | 'error'
  currentOntologyId: string | null
  currentOntologyName: string | null
}

interface FindDataSourcesDialogProps {
  ontology: OntologyDefinitionResponse
  workspaces: WorkspaceResponse[]
  ontologies: OntologyDefinitionResponse[]
  onAssign: (workspaceId: string, dataSourceId: string) => void
  onClose: () => void
  isAssigning: boolean
}

export function FindDataSourcesDialog({
  ontology,
  workspaces,
  ontologies,
  onAssign,
  onClose,
  isAssigning,
}: FindDataSourcesDialogProps) {
  const [results, setResults] = useState<RankedDataSource[]>([])
  const [search, setSearch] = useState('')
  const [isAnalyzing, setIsAnalyzing] = useState(true)
  const cancelledRef = useRef(false)

  // Build ontology lookup
  const ontologyMap = new Map(ontologies.map(o => [o.id, o]))

  // Analyze all data sources on mount
  useEffect(() => {
    cancelledRef.current = false

    const allDs: RankedDataSource[] = []
    for (const ws of workspaces) {
      for (const ds of ws.dataSources ?? []) {
        const currentOnt = ds.ontologyId ? ontologyMap.get(ds.ontologyId) ?? null : null
        allDs.push({
          workspaceId: ws.id,
          workspaceName: ws.name,
          dataSourceId: ds.id,
          dataSourceLabel: ds.label || ds.id,
          coveragePercent: null,
          status: 'loading',
          currentOntologyId: ds.ontologyId ?? null,
          currentOntologyName: currentOnt?.name ?? null,
        })
      }
    }

    setResults(allDs)

    // Sequentially fetch coverage for each DS (avoid overwhelming backend)
    ;(async () => {
      for (let i = 0; i < allDs.length; i++) {
        if (cancelledRef.current) return
        const entry = allDs[i]
        try {
          const stats = await fetchSchemaStats(entry.workspaceId, entry.dataSourceId)
          if (cancelledRef.current) return
          const coverage = await ontologyDefinitionService.coverage(
            ontology.id,
            stats as unknown as Record<string, unknown>,
          )
          if (cancelledRef.current) return

          setResults(prev => prev.map((r, idx) =>
            idx === i ? { ...r, coveragePercent: coverage.coveragePercent, status: 'done' as const } : r
          ))
        } catch {
          if (cancelledRef.current) return
          setResults(prev => prev.map((r, idx) =>
            idx === i ? { ...r, status: 'error' as const } : r
          ))
        }
      }
      setIsAnalyzing(false)
    })()

    return () => { cancelledRef.current = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ontology.id])

  // Sort by coverage (highest first), errors at bottom
  const sorted = [...results].sort((a, b) => {
    if (a.status === 'error' && b.status !== 'error') return 1
    if (b.status === 'error' && a.status !== 'error') return -1
    if (a.status === 'loading' && b.status !== 'loading') return 1
    if (b.status === 'loading' && a.status !== 'loading') return -1
    return (b.coveragePercent ?? 0) - (a.coveragePercent ?? 0)
  })

  const filtered = search.trim()
    ? sorted.filter(r => {
        const q = search.toLowerCase()
        return r.dataSourceLabel.toLowerCase().includes(q) || r.workspaceName.toLowerCase().includes(q)
      })
    : sorted

  const doneCount = results.filter(r => r.status === 'done').length

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={isAssigning ? undefined : onClose} />
      <div className="relative bg-canvas-elevated border border-glass-border rounded-2xl shadow-lg w-full max-w-xl mx-4 max-h-[80vh] flex flex-col animate-in zoom-in-95 fade-in duration-200 overflow-hidden">

        {/* Header */}
        <div className="border-b border-glass-border/50 px-6 pt-6 pb-4 flex-shrink-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500/20 to-indigo-500/20 border border-emerald-500/20 flex items-center justify-center">
                <BarChart3 className="w-5 h-5 text-emerald-500" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-ink">Find Matching Data Sources</h3>
                <p className="text-[11px] text-ink-muted mt-0.5">
                  Analyzing coverage of <span className="font-semibold text-ink">{ontology.name}</span> v{ontology.version} across all data sources
                </p>
              </div>
            </div>
            {!isAssigning && (
              <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-ink-muted transition-colors">
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* Progress + search */}
        <div className="px-6 pt-4 pb-2 flex-shrink-0">
          {isAnalyzing && (
            <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-indigo-50/50 dark:bg-indigo-950/20 border border-indigo-200/40 dark:border-indigo-800/30 mb-3">
              <Loader2 className="w-3.5 h-3.5 text-indigo-500 animate-spin flex-shrink-0" />
              <p className="text-[11px] text-indigo-600 dark:text-indigo-400 font-medium">
                Analyzing {doneCount} of {results.length} data sources...
              </p>
              <div className="flex-1 h-1 rounded-full bg-indigo-500/10 ml-2">
                <div
                  className="h-1 rounded-full bg-indigo-500 transition-all duration-300"
                  style={{ width: results.length > 0 ? `${(doneCount / results.length) * 100}%` : '0%' }}
                />
              </div>
            </div>
          )}

          {results.length > 4 && (
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted/60" />
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search data sources..."
                className="w-full pl-9 pr-3 py-2 rounded-xl bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border/60 text-xs text-ink placeholder:text-ink-muted/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500/30 transition-colors duration-150"
              />
            </div>
          )}
        </div>

        {/* Results list */}
        <div className="flex-1 overflow-y-auto px-6 pb-4">
          {filtered.length === 0 && (
            <div className="text-center py-10">
              <Database className="w-8 h-8 mx-auto mb-3 text-ink-muted opacity-40" />
              <p className="text-sm text-ink-muted">
                {search ? 'No data sources match your search' : 'No data sources available'}
              </p>
            </div>
          )}

          <div className="space-y-2">
            {filtered.map(r => {
              const isAlreadyAssigned = r.currentOntologyId === ontology.id
              const coveragePct = r.coveragePercent ?? 0
              const coverageColor = coveragePct >= 80 ? 'emerald' : coveragePct >= 50 ? 'amber' : 'red'

              return (
                <div
                  key={`${r.workspaceId}-${r.dataSourceId}`}
                  className={cn(
                    'p-4 rounded-xl border transition-colors duration-150',
                    isAlreadyAssigned
                      ? 'border-emerald-500/30 bg-emerald-50/20 dark:bg-emerald-950/10'
                      : 'border-glass-border hover:border-glass-border-hover',
                  )}
                >
                  <div className="flex items-center gap-3">
                    {/* Coverage ring or loading */}
                    <div className="w-12 h-12 flex-shrink-0">
                      {r.status === 'loading' ? (
                        <div className="w-12 h-12 rounded-full border-2 border-glass-border flex items-center justify-center">
                          <Loader2 className="w-4 h-4 text-ink-muted animate-spin" />
                        </div>
                      ) : r.status === 'error' ? (
                        <div className="w-12 h-12 rounded-full border-2 border-red-200 dark:border-red-800 flex items-center justify-center">
                          <AlertTriangle className="w-4 h-4 text-red-400" />
                        </div>
                      ) : (
                        <div className="relative w-12 h-12">
                          <svg className="w-12 h-12 -rotate-90" viewBox="0 0 48 48">
                            <circle cx="24" cy="24" r="20" fill="none" strokeWidth="4"
                              className="text-black/5 dark:text-white/5" stroke="currentColor" />
                            <circle cx="24" cy="24" r="20" fill="none" strokeWidth="4" strokeLinecap="round"
                              strokeDasharray={`${Math.round(coveragePct * 1.26)} 126`}
                              className={cn(
                                coverageColor === 'emerald' ? 'text-emerald-500' :
                                coverageColor === 'amber' ? 'text-amber-500' : 'text-red-400',
                              )}
                              stroke="currentColor" />
                          </svg>
                          <div className="absolute inset-0 flex items-center justify-center">
                            <span className={cn(
                              'text-[11px] font-bold',
                              coverageColor === 'emerald' ? 'text-emerald-600 dark:text-emerald-400' :
                              coverageColor === 'amber' ? 'text-amber-600 dark:text-amber-400' :
                              'text-red-500',
                            )}>{Math.round(coveragePct)}%</span>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <p className="text-sm font-semibold text-ink truncate">{r.dataSourceLabel}</p>
                        {isAlreadyAssigned && (
                          <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                            <CheckCircle2 className="w-2.5 h-2.5" /> Assigned
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-ink-muted">
                        in <span className="font-medium">{r.workspaceName}</span>
                        {r.currentOntologyName && !isAlreadyAssigned && (
                          <> &middot; currently uses <span className="font-medium">{r.currentOntologyName}</span></>
                        )}
                      </p>
                    </div>

                    {/* Action */}
                    {r.status === 'done' && !isAlreadyAssigned && (
                      <button
                        onClick={() => onAssign(r.workspaceId, r.dataSourceId)}
                        disabled={isAssigning}
                        className={cn(
                          'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors duration-150 flex-shrink-0',
                          coveragePct >= 50
                            ? 'bg-indigo-500 text-white hover:bg-indigo-600 shadow-sm shadow-indigo-500/20'
                            : 'border border-glass-border text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5',
                          isAssigning && 'opacity-50 cursor-not-allowed',
                        )}
                      >
                        <ArrowRight className="w-3 h-3" />
                        {r.currentOntologyId ? 'Replace' : 'Assign'}
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-glass-border/50 px-6 py-3 flex items-center justify-between flex-shrink-0">
          <p className="text-[11px] text-ink-muted">
            {!isAnalyzing && (
              <>
                {results.filter(r => r.status === 'done' && (r.coveragePercent ?? 0) >= 50).length} of {results.length} data source{results.length !== 1 ? 's' : ''} have ≥50% coverage
              </>
            )}
          </p>
          <button
            onClick={onClose}
            disabled={isAssigning}
            className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
