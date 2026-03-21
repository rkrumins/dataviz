import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import type { GraphSchemaStats } from '@/providers/GraphDataProvider'
import { formatCount } from '../../lib/ontology-parsers'
import type { CoverageState } from '../../lib/ontology-types'

// ---------------------------------------------------------------------------
// CoveragePanel — gap analysis (renamed from CoverageTab)
// ---------------------------------------------------------------------------

export function CoveragePanel({
  coverage,
  graphStats,
  isLocked,
  onDefineEntity,
  onDefineRel,
}: {
  coverage: CoverageState | null
  graphStats: GraphSchemaStats | null
  isLocked: boolean
  onDefineEntity: (typeId: string) => void
  onDefineRel: (typeId: string) => void
}) {
  if (!graphStats) {
    return (
      <div className="text-center py-16 text-ink-muted">
        <LucideIcons.Loader2 className="w-6 h-6 mx-auto mb-3 animate-spin opacity-50" />
        <p className="text-sm">Loading graph data...</p>
      </div>
    )
  }

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
                {/* Background circle */}
                <circle
                  cx="50" cy="50" r="42"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="10"
                  className="text-black/5 dark:text-white/5"
                />
                {/* Progress arc */}
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

              {/* Mini breakdown */}
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

          {/* Progress bar underneath */}
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
