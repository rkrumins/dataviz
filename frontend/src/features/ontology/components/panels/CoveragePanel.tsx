import { useState, useEffect } from 'react'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import type { GraphSchemaStats } from '@/providers/GraphDataProvider'
import { ontologyDefinitionService } from '@/services/ontologyDefinitionService'
import { useWorkspacesStore } from '@/store/workspaces'
import { fetchSchemaStats } from '../../lib/ontology-utils'
import { formatCount } from '../../lib/ontology-parsers'
import type { CoverageState } from '../../lib/ontology-types'
import { EducationalCallout } from '../EducationalCallout'

// ---------------------------------------------------------------------------
// CoveragePanel — self-contained gap analysis with data source context
// ---------------------------------------------------------------------------

export function CoveragePanel({
  ontologyId,
  workspaceId,
  dataSourceId,
  isLocked,
  onDefineEntity,
  onDefineRel,
  onChangeEvalTarget,
}: {
  ontologyId: string
  workspaceId: string | null
  dataSourceId: string | null
  isLocked: boolean
  onDefineEntity: (typeId: string) => void
  onDefineRel: (typeId: string) => void
  /** Propagate data source override to page level (for Suggest from Graph etc.) */
  onChangeEvalTarget?: (wsId: string, dsId: string) => void
}) {
  const workspaces = useWorkspacesStore(s => s.workspaces)

  // Optional data source override — lets user compare against a different data source
  const [overrideWsId, setOverrideWsId] = useState<string | null>(null)
  const [overrideDsId, setOverrideDsId] = useState<string | null>(null)
  const [showPicker, setShowPicker] = useState(false)

  const effectiveWsId = overrideWsId ?? workspaceId
  const effectiveDsId = overrideDsId ?? dataSourceId

  // Find active workspace/data source names for display
  const activeWs = workspaces.find(w => w.id === effectiveWsId)
  const activeDs = activeWs?.dataSources?.find(ds => ds.id === effectiveDsId)

  // Self-contained data fetching
  const [graphStats, setGraphStats] = useState<GraphSchemaStats | null>(null)
  const [coverage, setCoverage] = useState<CoverageState | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!effectiveWsId || !effectiveDsId || !ontologyId) {
      setGraphStats(null)
      setCoverage(null)
      return
    }

    let cancelled = false
    setIsLoading(true)
    setError(null)

    ;(async () => {
      try {
        const stats = await fetchSchemaStats(effectiveWsId, effectiveDsId)
        if (cancelled) return
        setGraphStats(stats)

        const c = await ontologyDefinitionService.coverage(
          ontologyId,
          stats as unknown as Record<string, unknown>,
        )
        if (cancelled) return
        setCoverage({
          uncoveredEntityTypes: c.uncoveredEntityTypes,
          uncoveredRelationshipTypes: c.uncoveredRelationshipTypes,
          coveragePercent: c.coveragePercent,
        })
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load coverage')
          setGraphStats(null)
          setCoverage(null)
        }
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    })()

    return () => { cancelled = true }
  }, [effectiveWsId, effectiveDsId, ontologyId])

  // ── No data source selected ──────────────────────────────────────
  if (!effectiveWsId || !effectiveDsId) {
    return (
      <div>
        <div className="text-center py-16">
          <div className="relative mx-auto mb-5 w-16 h-16 flex items-center justify-center">
            <div className="absolute inset-0 rounded-full bg-gradient-to-br from-indigo-500/10 to-purple-500/10" />
            <LucideIcons.BarChart3 className="w-8 h-8 relative z-10 text-indigo-400 opacity-60" />
          </div>
          <p className="text-sm font-semibold text-ink-secondary mb-1">No data source selected</p>
          <p className="text-xs text-ink-muted max-w-sm mx-auto mb-6">
            Select a data source from the environment switcher to see how well this semantic layer covers your graph.
          </p>

          {/* Quick-pick from available data sources */}
          {workspaces.length > 0 && (
            <div className="max-w-md mx-auto">
              <p className="text-[10px] font-bold text-ink-muted uppercase tracking-wider mb-3">Or pick a data source to analyze</p>
              <div className="space-y-1 text-left">
                {workspaces.flatMap(ws =>
                  (ws.dataSources ?? []).map(ds => (
                    <button
                      key={`${ws.id}-${ds.id}`}
                      onClick={() => {
                        setOverrideWsId(ws.id)
                        setOverrideDsId(ds.id)
                        onChangeEvalTarget?.(ws.id, ds.id)
                      }}
                      className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-left hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                    >
                      <LucideIcons.Database className="w-3.5 h-3.5 text-ink-muted flex-shrink-0" />
                      <span className="font-medium text-ink">{ds.label || ds.id}</span>
                      <span className="text-ink-muted">in {ws.name}</span>
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    )
  }

  // ── Loading state ────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="text-center py-16 text-ink-muted">
        <LucideIcons.Loader2 className="w-6 h-6 mx-auto mb-3 animate-spin opacity-50" />
        <p className="text-sm">Analyzing coverage against {activeDs?.label || 'data source'}...</p>
      </div>
    )
  }

  // ── Error state ──────────────────────────────────────────────────
  if (error) {
    return (
      <div className="text-center py-16">
        <LucideIcons.AlertTriangle className="w-6 h-6 mx-auto mb-3 text-red-400 opacity-60" />
        <p className="text-sm text-red-600 dark:text-red-400 mb-1">Coverage analysis failed</p>
        <p className="text-xs text-ink-muted">{error}</p>
      </div>
    )
  }

  if (!graphStats) return null

  const uncoveredEntities = coverage?.uncoveredEntityTypes ?? []
  const uncoveredRels = coverage?.uncoveredRelationshipTypes ?? []
  const percent = coverage?.coveragePercent ?? null
  const totalGaps = uncoveredEntities.length + uncoveredRels.length

  // Compute covered counts
  const totalEntityTypesInGraph = graphStats.entityTypeStats.length
  const totalRelTypesInGraph = graphStats.edgeTypeStats.length
  const coveredEntities = totalEntityTypesInGraph - uncoveredEntities.length
  const coveredRels = totalRelTypesInGraph - uncoveredRels.length
  const totalInGraph = totalEntityTypesInGraph + totalRelTypesInGraph
  const totalCovered = coveredEntities + coveredRels

  return (
    <div>
      <EducationalCallout
        id="edu-coverage"
        title="Understanding Coverage"
        description="Coverage measures how well this semantic layer describes the actual data in your graph. 100% means every entity and relationship type has a definition. Gaps mean some types exist in your data but aren't defined, which can lead to missing features in views and search."
        variant="tip"
      />

      {/* Data source context bar */}
      <div className="flex items-center justify-between mb-4 px-1">
        <div className="flex items-center gap-2 text-xs text-ink-muted">
          <LucideIcons.Database className="w-3.5 h-3.5" />
          <span>Analyzing coverage against</span>
          <span className="font-semibold text-ink">{activeDs?.label || effectiveDsId}</span>
          {activeWs && <span className="text-ink-muted">in {activeWs.name}</span>}
        </div>
        <button
          onClick={() => setShowPicker(!showPicker)}
          className="text-xs text-indigo-500 hover:text-indigo-600 font-medium transition-colors"
        >
          {showPicker ? 'Hide' : 'Change'}
        </button>
      </div>

      {/* Data source picker (collapsed by default) */}
      {showPicker && (
        <div className="mb-6 p-3 rounded-xl border border-glass-border bg-canvas-elevated/50">
          <p className="text-[10px] font-bold text-ink-muted uppercase tracking-wider mb-2">Select a different data source</p>
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {workspaces.map(ws => (
              <div key={ws.id}>
                <p className="text-[10px] font-bold text-ink-muted uppercase tracking-wider px-2 py-1">{ws.name}</p>
                {(ws.dataSources ?? []).map(ds => {
                  const isActive = ws.id === effectiveWsId && ds.id === effectiveDsId
                  return (
                    <button
                      key={ds.id}
                      onClick={() => {
                        setOverrideWsId(ws.id)
                        setOverrideDsId(ds.id)
                        setShowPicker(false)
                        onChangeEvalTarget?.(ws.id, ds.id)
                      }}
                      className={cn(
                        'w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs text-left transition-colors',
                        isActive
                          ? 'bg-indigo-50 dark:bg-indigo-950/30 text-indigo-600 dark:text-indigo-400'
                          : 'hover:bg-black/5 dark:hover:bg-white/5',
                      )}
                    >
                      <LucideIcons.Database className="w-3 h-3 flex-shrink-0" />
                      <span className="font-medium">{ds.label || ds.id}</span>
                      {isActive && <LucideIcons.Check className="w-3 h-3 ml-auto" />}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Coverage summary with prominent progress ring */}
      {percent !== null && (
        <div className={cn(
          'p-6 rounded-xl border mb-6',
          totalGaps === 0
            ? 'bg-green-50/50 dark:bg-green-950/20 border-green-200 dark:border-green-800'
            : 'bg-amber-50/50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800'
        )}>
          <div className="flex items-center gap-6">
            {/* Thick progress ring */}
            <div className="relative w-24 h-24 flex-shrink-0">
              <svg className="w-24 h-24 -rotate-90" viewBox="0 0 100 100">
                <circle
                  cx="50" cy="50" r="42"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="10"
                  className="text-black/5 dark:text-white/5"
                />
                <circle
                  cx="50" cy="50" r="42"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="10"
                  strokeLinecap="round"
                  strokeDasharray={`${Math.round(percent * 2.64)} 264`}
                  className={cn(
                    'transition-all duration-700',
                    totalGaps === 0 ? 'text-green-500' : 'text-amber-500'
                  )}
                />
              </svg>
              <div className="absolute inset-0 flex items-center justify-center">
                <span className={cn(
                  'text-2xl font-bold',
                  totalGaps === 0 ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'
                )}>
                  {Math.round(percent)}%
                </span>
              </div>
            </div>

            {/* Summary text */}
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1">
                {totalGaps === 0
                  ? <LucideIcons.CheckCircle2 className="w-5 h-5 text-green-500" />
                  : <LucideIcons.AlertTriangle className="w-5 h-5 text-amber-500" />}
                <h3 className={cn(
                  'text-lg font-bold',
                  totalGaps === 0 ? 'text-green-700 dark:text-green-300' : 'text-amber-700 dark:text-amber-300'
                )}>
                  {totalGaps === 0 ? 'Full Coverage' : `${totalGaps} Undefined Type${totalGaps > 1 ? 's' : ''}`}
                </h3>
              </div>
              <p className="text-sm text-ink-secondary mb-3">
                {totalCovered} of {totalInGraph} types in your graph are covered by this ontology
              </p>

              <div className="flex items-center gap-4 text-xs text-ink-muted">
                <div className="flex items-center gap-1.5">
                  <LucideIcons.Box className="w-3.5 h-3.5" />
                  <span>{coveredEntities} of {totalEntityTypesInGraph} entity types</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <LucideIcons.GitBranch className="w-3.5 h-3.5" />
                  <span>{coveredRels} of {totalRelTypesInGraph} relationship types</span>
                </div>
              </div>
            </div>
          </div>

          <div className="w-full bg-black/5 dark:bg-white/5 rounded-full h-2.5 mt-5">
            <div
              className={cn(
                'h-2.5 rounded-full transition-all duration-700',
                totalGaps === 0 ? 'bg-green-500' : 'bg-amber-500'
              )}
              style={{ width: `${Math.min(percent, 100)}%` }}
            />
          </div>
        </div>
      )}

      {/* Uncovered entity types */}
      {uncoveredEntities.length > 0 && (
        <div className="mb-6">
          <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wider mb-3 flex items-center gap-2">
            <LucideIcons.Box className="w-3.5 h-3.5" />
            Undefined Entity Types
            <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-amber-100 dark:bg-amber-900/50 text-amber-600 dark:text-amber-400">
              {uncoveredEntities.length}
            </span>
          </h3>
          <div className="space-y-2">
            {uncoveredEntities.map(typeId => {
              const stat = graphStats.entityTypeStats.find(s => s.id === typeId)
              return (
                <div
                  key={typeId}
                  className="flex items-center justify-between p-4 rounded-xl border border-amber-200/80 dark:border-amber-800/40 bg-amber-50/30 dark:bg-amber-950/10 hover:bg-amber-50/60 dark:hover:bg-amber-950/20 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-9 h-9 rounded-lg bg-amber-100/50 dark:bg-amber-900/30 flex items-center justify-center flex-shrink-0">
                      <LucideIcons.AlertTriangle className="w-4 h-4 text-amber-500" />
                    </div>
                    <div>
                      <code className="text-sm font-mono font-semibold text-amber-700 dark:text-amber-300">{typeId}</code>
                      {stat && (
                        <p className="text-[11px] text-ink-muted mt-0.5">
                          <span className="font-medium">{formatCount(stat.count)} nodes</span> in graph
                          {stat.sampleNames?.length > 0 && (
                            <span className="text-ink-muted/60"> (e.g., {stat.sampleNames.slice(0, 2).join(', ')})</span>
                          )}
                        </p>
                      )}
                    </div>
                  </div>
                  {!isLocked && (
                    <button
                      onClick={() => onDefineEntity(typeId)}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold bg-amber-500 text-white hover:bg-amber-600 transition-colors flex-shrink-0 ml-3 shadow-sm"
                    >
                      <LucideIcons.Plus className="w-3.5 h-3.5" />
                      Define
                    </button>
                  )}
                  {isLocked && (
                    <span className="flex items-center gap-1 text-[10px] text-ink-muted px-2 py-1 rounded bg-black/5 dark:bg-white/5">
                      <LucideIcons.Lock className="w-3 h-3" />
                      Locked
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Uncovered relationship types */}
      {uncoveredRels.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wider mb-3 flex items-center gap-2">
            <LucideIcons.GitBranch className="w-3.5 h-3.5" />
            Undefined Relationship Types
            <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-amber-100 dark:bg-amber-900/50 text-amber-600 dark:text-amber-400">
              {uncoveredRels.length}
            </span>
          </h3>
          <div className="space-y-2">
            {uncoveredRels.map(typeId => {
              const stat = graphStats.edgeTypeStats.find(s => s.id === typeId)
              return (
                <div
                  key={typeId}
                  className="flex items-center justify-between p-4 rounded-xl border border-amber-200/80 dark:border-amber-800/40 bg-amber-50/30 dark:bg-amber-950/10 hover:bg-amber-50/60 dark:hover:bg-amber-950/20 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-9 h-9 rounded-lg bg-amber-100/50 dark:bg-amber-900/30 flex items-center justify-center flex-shrink-0">
                      <LucideIcons.AlertTriangle className="w-4 h-4 text-amber-500" />
                    </div>
                    <div>
                      <code className="text-sm font-mono font-semibold text-amber-700 dark:text-amber-300">{typeId}</code>
                      {stat && (
                        <p className="text-[11px] text-ink-muted mt-0.5">
                          <span className="font-medium">{formatCount(stat.count)} edges</span>
                          {stat.sourceTypes?.length > 0 && (
                            <span className="text-ink-muted/60"> ({stat.sourceTypes.join(', ')} -&gt; {stat.targetTypes?.join(', ')})</span>
                          )}
                        </p>
                      )}
                    </div>
                  </div>
                  {!isLocked && (
                    <button
                      onClick={() => onDefineRel(typeId)}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold bg-amber-500 text-white hover:bg-amber-600 transition-colors flex-shrink-0 ml-3 shadow-sm"
                    >
                      <LucideIcons.Plus className="w-3.5 h-3.5" />
                      Define
                    </button>
                  )}
                  {isLocked && (
                    <span className="flex items-center gap-1 text-[10px] text-ink-muted px-2 py-1 rounded bg-black/5 dark:bg-white/5">
                      <LucideIcons.Lock className="w-3 h-3" />
                      Locked
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Full coverage celebration */}
      {totalGaps === 0 && percent !== null && (
        <div className="text-center py-8">
          <LucideIcons.PartyPopper className="w-8 h-8 mx-auto mb-3 text-green-500 opacity-60" />
          <p className="text-sm text-ink-muted">Every type in your graph is defined. Your ontology has complete coverage.</p>
        </div>
      )}
    </div>
  )
}
