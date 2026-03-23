/**
 * OverviewPanel — high-level overview of an ontology.
 *
 * Layout:
 *   1. Schema composition — entity types, relationships, coverage
 *   2. Usage & adoption — workspaces, data sources, views
 *   3. Structure breakdown — hierarchy + data flow cards
 *   4. Uncovered types warning (if applicable)
 *
 * Self-contained: fetches graph stats, coverage, and view counts.
 * Metadata (created/updated/published) lives in the page header, not here.
 */
import { useState, useEffect, useMemo } from 'react'
import {
  Box,
  GitBranch,
  CheckCircle2,
  FolderTree,
  Route,
  Users,
  Eye,
  BarChart3,
  Database,
  AlertTriangle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import { ontologyDefinitionService as ontologyService } from '@/services/ontologyDefinitionService'
import type { GraphSchemaStats } from '@/providers/GraphDataProvider'
import type { CoverageState } from '../../lib/ontology-types'
import { fetchSchemaStats } from '../../lib/ontology-utils'
import { useOntologyAssignments } from '../../hooks/useOntologies'
import { listViews } from '@/services/viewApiService'
import { formatCount } from '../../lib/ontology-parsers'

interface OverviewPanelProps {
  ontology: OntologyDefinitionResponse
  workspaceId: string | null
  dataSourceId: string | null
  assignmentCount: number
  onNavigateTab: (tab: string) => void
}

function StatCard({ icon: Icon, label, value, accent, onClick }: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string | number
  accent: string
  onClick?: () => void
}) {
  const Wrapper = onClick ? 'button' : 'div'
  return (
    <Wrapper
      onClick={onClick}
      className={cn(
        'flex items-center gap-4 p-4 rounded-2xl border border-glass-border bg-canvas-elevated/50 transition-all',
        onClick && 'hover:shadow-sm hover:border-glass-border-hover cursor-pointer text-left w-full',
      )}
    >
      <div className={cn('w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0', accent)}>
        <Icon className="w-5 h-5" />
      </div>
      <div>
        <p className="text-2xl font-bold text-ink tracking-tight leading-none">{value}</p>
        <p className="text-xs text-ink-muted font-medium mt-0.5">{label}</p>
      </div>
    </Wrapper>
  )
}

export function OverviewPanel({
  ontology,
  workspaceId,
  dataSourceId,
  assignmentCount,
  onNavigateTab,
}: OverviewPanelProps) {
  // Self-contained: fetch graph stats + coverage when workspace context exists
  const [graphStats, setGraphStats] = useState<GraphSchemaStats | null>(null)
  const [coverage, setCoverage] = useState<CoverageState | null>(null)

  useEffect(() => {
    if (!workspaceId || !dataSourceId) {
      setGraphStats(null)
      setCoverage(null)
      return
    }

    let cancelled = false
    ;(async () => {
      try {
        const stats = await fetchSchemaStats(workspaceId, dataSourceId)
        if (cancelled) return
        setGraphStats(stats)

        const c = await ontologyService.coverage(
          ontology.id,
          stats as unknown as Record<string, unknown>,
        )
        if (cancelled) return
        setCoverage({
          uncoveredEntityTypes: c.uncoveredEntityTypes,
          uncoveredRelationshipTypes: c.uncoveredRelationshipTypes,
          coveragePercent: c.coveragePercent,
        })
      } catch {
        if (!cancelled) {
          setGraphStats(null)
          setCoverage(null)
        }
      }
    })()

    return () => { cancelled = true }
  }, [workspaceId, dataSourceId, ontology.id])

  // Fetch assignment + view data
  const { data: assignments } = useOntologyAssignments(ontology.id)

  const [viewCount, setViewCount] = useState<number | null>(null)
  const [loadingViews, setLoadingViews] = useState(false)

  useEffect(() => {
    if (!assignments || assignments.length === 0) {
      setViewCount(0)
      return
    }

    let cancelled = false
    setLoadingViews(true)

    const uniqueWsIds = [...new Set(assignments.map(a => a.workspaceId))]

    Promise.all(
      uniqueWsIds.map(async (wsId) => {
        try {
          const views = await listViews({ workspaceId: wsId })
          return views.length
        } catch {
          return 0
        }
      })
    ).then(counts => {
      if (cancelled) return
      setViewCount(counts.reduce((sum, c) => sum + c, 0))
      setLoadingViews(false)
    })

    return () => { cancelled = true }
  }, [assignments])

  const workspaceCount = useMemo(() => {
    if (!assignments) return 0
    return new Set(assignments.map(a => a.workspaceId)).size
  }, [assignments])

  const entityCount = Object.keys(ontology.entityTypeDefinitions ?? {}).length
  const relCount = Object.keys(ontology.relationshipTypeDefinitions ?? {}).length
  const containmentCount = (ontology.containmentEdgeTypes ?? []).length
  const lineageCount = (ontology.lineageEdgeTypes ?? []).length
  const rootTypes = (ontology.rootEntityTypes ?? []).length

  const hierarchyLevels = useMemo(() => {
    if (entityCount === 0) return 0
    const defs = ontology.entityTypeDefinitions as Record<string, Record<string, unknown>>
    const levels = new Set(Object.values(defs).map(d => {
      const h = d?.hierarchy as Record<string, unknown> | undefined
      return (h?.level as number) ?? 0
    }))
    return levels.size
  }, [ontology.entityTypeDefinitions, entityCount])

  const totalGaps = coverage
    ? coverage.uncoveredEntityTypes.length + coverage.uncoveredRelationshipTypes.length
    : null

  return (
    <div className="space-y-8">
      {/* ── Schema Composition ───────────────────────────────────── */}
      <section>
        <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wider mb-3">
          Schema Composition
        </h3>
        <div className="grid grid-cols-3 gap-3">
          <StatCard
            icon={Box}
            label="Entity Types"
            value={entityCount}
            accent="bg-indigo-50 dark:bg-indigo-950/30 text-indigo-500"
            onClick={() => onNavigateTab('entities')}
          />
          <StatCard
            icon={GitBranch}
            label="Relationships"
            value={relCount}
            accent="bg-purple-50 dark:bg-purple-950/30 text-purple-500"
            onClick={() => onNavigateTab('relationships')}
          />
          <StatCard
            icon={BarChart3}
            label="Coverage"
            value={coverage ? `${Math.round(coverage.coveragePercent)}%` : '—'}
            accent="bg-emerald-50 dark:bg-emerald-950/30 text-emerald-500"
            onClick={() => onNavigateTab('coverage')}
          />
        </div>
      </section>

      {/* ── Usage & Adoption ─────────────────────────────────────── */}
      <section>
        <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wider mb-3">
          Usage &amp; Adoption
        </h3>
        <div className="grid grid-cols-3 gap-3">
          <StatCard
            icon={Database}
            label="Data Sources"
            value={assignmentCount}
            accent="bg-amber-50 dark:bg-amber-950/30 text-amber-500"
            onClick={() => onNavigateTab('usage')}
          />
          <StatCard
            icon={Users}
            label="Workspaces"
            value={workspaceCount}
            accent="bg-rose-50 dark:bg-rose-950/30 text-rose-500"
            onClick={() => onNavigateTab('usage')}
          />
          <StatCard
            icon={Eye}
            label="Views"
            value={loadingViews ? '...' : (viewCount ?? '—')}
            accent="bg-sky-50 dark:bg-sky-950/30 text-sky-500"
            onClick={() => onNavigateTab('usage')}
          />
        </div>
      </section>

      {/* ── Structure Breakdown ──────────────────────────────────── */}
      <section>
        <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wider mb-3">
          Structure
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Hierarchy */}
          <button
            onClick={() => onNavigateTab('hierarchy')}
            className="rounded-2xl border border-glass-border bg-canvas-elevated/50 p-4 text-left hover:shadow-sm hover:border-glass-border-hover transition-all group"
          >
            <div className="flex items-center gap-2 mb-3">
              <FolderTree className="w-4 h-4 text-indigo-500" />
              <span className="text-sm font-bold text-ink">Hierarchy</span>
              <span className="ml-auto text-[10px] text-ink-muted opacity-0 group-hover:opacity-100 transition-opacity">&rarr;</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <p className="text-lg font-bold text-ink">{rootTypes}</p>
                <p className="text-[10px] text-ink-muted">Root types</p>
              </div>
              <div>
                <p className="text-lg font-bold text-ink">{containmentCount}</p>
                <p className="text-[10px] text-ink-muted">Containment</p>
              </div>
              <div>
                <p className="text-lg font-bold text-ink">{hierarchyLevels}</p>
                <p className="text-[10px] text-ink-muted">Levels</p>
              </div>
            </div>
          </button>

          {/* Data flow */}
          <button
            onClick={() => onNavigateTab('coverage')}
            className="rounded-2xl border border-glass-border bg-canvas-elevated/50 p-4 text-left hover:shadow-sm hover:border-glass-border-hover transition-all group"
          >
            <div className="flex items-center gap-2 mb-3">
              <Route className="w-4 h-4 text-green-500" />
              <span className="text-sm font-bold text-ink">Data Flow</span>
              <span className="ml-auto text-[10px] text-ink-muted opacity-0 group-hover:opacity-100 transition-opacity">&rarr;</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <p className="text-lg font-bold text-ink">{lineageCount}</p>
                <p className="text-[10px] text-ink-muted">Lineage edges</p>
              </div>
              {graphStats ? (
                <>
                  <div>
                    <p className="text-lg font-bold text-ink">{formatCount(graphStats.totalNodes)}</p>
                    <p className="text-[10px] text-ink-muted">Graph nodes</p>
                  </div>
                  <div>
                    <p className="text-lg font-bold text-ink">{formatCount(graphStats.totalEdges)}</p>
                    <p className="text-[10px] text-ink-muted">Graph edges</p>
                  </div>
                </>
              ) : (
                <div className="col-span-2 flex items-center">
                  <p className="text-[10px] text-ink-muted/60 italic">Select a data source for graph stats</p>
                </div>
              )}
            </div>
          </button>
        </div>
      </section>

      {/* ── Evolution Policy ─────────────────────────────────────── */}
      <section>
        <div className="flex items-center gap-3 px-1">
          <span className="text-xs font-semibold text-ink-muted uppercase tracking-wider">Evolution Policy</span>
          <span className="text-xs font-semibold text-ink px-2.5 py-1 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] capitalize">
            {ontology.evolutionPolicy || 'reject'}
          </span>
          {ontology.isSystem && (
            <span className="text-[10px] text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/30 px-2 py-0.5 rounded-md font-semibold">
              System
            </span>
          )}
          {ontology.isPublished && (
            <span className="text-[10px] text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/30 px-2 py-0.5 rounded-md font-semibold flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3" />
              Immutable
            </span>
          )}
        </div>
      </section>

      {/* ── Uncovered Types Warning ──────────────────────────────── */}
      {coverage && (coverage.uncoveredEntityTypes.length > 0 || coverage.uncoveredRelationshipTypes.length > 0) && (
        <section className="rounded-2xl border border-amber-200 dark:border-amber-800/50 bg-amber-50/50 dark:bg-amber-950/20 p-4">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="w-4 h-4 text-amber-500" />
            <h3 className="text-sm font-bold text-amber-800 dark:text-amber-300">
              {totalGaps} Uncovered Type{totalGaps !== 1 ? 's' : ''}
            </h3>
            <button
              onClick={() => onNavigateTab('coverage')}
              className="ml-auto text-[10px] font-semibold text-amber-600 dark:text-amber-400 hover:underline"
            >
              View Coverage &rarr;
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {coverage.uncoveredEntityTypes.map(t => (
              <span key={t} className="px-2 py-0.5 rounded-md text-[11px] font-medium bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300">
                {t}
              </span>
            ))}
            {coverage.uncoveredRelationshipTypes.map(t => (
              <span key={t} className="px-2 py-0.5 rounded-md text-[11px] font-medium bg-amber-100/50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 italic">
                {t}
              </span>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
