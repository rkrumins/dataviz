/**
 * QuickRecommendBanner — shown in OverviewPanel when an ontology has
 * zero assignments. Lazily checks all unassigned data sources for the
 * best coverage fit and surfaces a one-click assign suggestion.
 */
import { useState, useEffect, useRef } from 'react'
import { Sparkles, ArrowRight, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import { ontologyDefinitionService } from '@/services/ontologyDefinitionService'
import type { WorkspaceResponse } from '@/services/workspaceService'
import { fetchSchemaStats } from '../lib/ontology-utils'

interface QuickRecommendBannerProps {
  ontology: OntologyDefinitionResponse
  workspaces: WorkspaceResponse[]
  onAssign: (workspaceId: string, dataSourceId: string) => void
  onViewDetails: () => void
}

interface BestMatch {
  workspaceId: string
  workspaceName: string
  dataSourceId: string
  dataSourceLabel: string
  coveragePercent: number
}

export function QuickRecommendBanner({
  ontology,
  workspaces,
  onAssign,
  onViewDetails,
}: QuickRecommendBannerProps) {
  const [bestMatch, setBestMatch] = useState<BestMatch | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [dismissed, setDismissed] = useState(false)
  const cancelledRef = useRef(false)

  useEffect(() => {
    cancelledRef.current = false
    setBestMatch(null)
    setIsLoading(true)
    setDismissed(false)

    // Gather unassigned data sources
    const unassigned: Array<{ wsId: string; wsName: string; dsId: string; dsLabel: string }> = []
    for (const ws of workspaces) {
      for (const ds of ws.dataSources ?? []) {
        if (!ds.ontologyId) {
          unassigned.push({ wsId: ws.id, wsName: ws.name, dsId: ds.id, dsLabel: ds.label || ds.id })
        }
      }
    }

    if (unassigned.length === 0) {
      setIsLoading(false)
      return
    }

    // Check coverage on the first few unassigned DSs (max 5 to stay fast)
    ;(async () => {
      let best: BestMatch | null = null
      for (const item of unassigned.slice(0, 5)) {
        if (cancelledRef.current) return
        try {
          const stats = await fetchSchemaStats(item.wsId, item.dsId)
          if (cancelledRef.current) return
          const cov = await ontologyDefinitionService.coverage(
            ontology.id,
            stats as unknown as Record<string, unknown>,
          )
          if (cancelledRef.current) return
          if (cov.coveragePercent > (best?.coveragePercent ?? 0)) {
            best = {
              workspaceId: item.wsId,
              workspaceName: item.wsName,
              dataSourceId: item.dsId,
              dataSourceLabel: item.dsLabel,
              coveragePercent: cov.coveragePercent,
            }
          }
        } catch {
          // Skip failures silently
        }
      }
      if (!cancelledRef.current) {
        setBestMatch(best)
        setIsLoading(false)
      }
    })()

    return () => { cancelledRef.current = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ontology.id])

  if (dismissed || (!isLoading && !bestMatch)) return null
  if (!isLoading && bestMatch && bestMatch.coveragePercent < 30) return null

  return (
    <div className="rounded-xl border border-indigo-200/50 dark:border-indigo-800/30 bg-gradient-to-r from-indigo-50/40 to-purple-50/40 dark:from-indigo-950/15 dark:to-purple-950/15 p-4">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-indigo-500/10 flex items-center justify-center flex-shrink-0">
          <Sparkles className="w-4 h-4 text-indigo-500" />
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 flex-1">
            <Loader2 className="w-3.5 h-3.5 text-indigo-400 animate-spin" />
            <p className="text-xs text-ink-muted">Checking for compatible data sources...</p>
          </div>
        ) : bestMatch ? (
          <div className="flex-1 min-w-0">
            <p className="text-xs text-ink-secondary">
              <span className="font-semibold text-ink">Good fit found</span> —{' '}
              <span className="font-medium">{bestMatch.dataSourceLabel}</span>{' '}
              <span className="text-ink-muted">in {bestMatch.workspaceName}</span>{' '}
              has <span className={cn(
                'font-bold',
                bestMatch.coveragePercent >= 80 ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400',
              )}>{Math.round(bestMatch.coveragePercent)}%</span> coverage
            </p>
          </div>
        ) : null}

        {bestMatch && (
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <button
              onClick={() => onAssign(bestMatch.workspaceId, bestMatch.dataSourceId)}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-indigo-500 text-white hover:bg-indigo-600 transition-colors shadow-sm shadow-indigo-500/20"
            >
              <ArrowRight className="w-3 h-3" />
              Assign
            </button>
            <button
              onClick={onViewDetails}
              className="px-2.5 py-1.5 rounded-lg text-[11px] font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            >
              Details
            </button>
            <button
              onClick={() => setDismissed(true)}
              className="px-1.5 py-1.5 rounded-lg text-[11px] text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            >
              ✕
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
