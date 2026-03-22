/**
 * OverviewPanel — high-level overview of an ontology with key metrics,
 * purpose documentation, and quick-action cards.
 */
import {
  Box,
  GitBranch,
  Calendar,
  Shield,
  PenLine,
  CheckCircle2,
  Layers,
  FolderTree,
  Route,
  Users,
  FileText,
  Download,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import type { GraphSchemaStats } from '@/providers/GraphDataProvider'
import type { CoverageState } from '../../lib/ontology-types'
import { OntologyStatusBadge } from '../OntologyStatusBadge'
import { formatCount } from '../../lib/ontology-parsers'

interface OverviewPanelProps {
  ontology: OntologyDefinitionResponse
  graphStats: GraphSchemaStats | null
  coverage: CoverageState | null
  assignmentCount: number
  onNavigateTab: (tab: string) => void
  onExport: () => void
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
        'p-4 rounded-2xl border border-glass-border bg-canvas-elevated/50 transition-all',
        onClick && 'hover:shadow-md hover:border-glass-border-hover cursor-pointer text-left w-full',
      )}
    >
      <div className="flex items-center gap-3">
        <div className={cn('w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0', accent)}>
          <Icon className="w-5 h-5" />
        </div>
        <div>
          <p className="text-2xl font-bold text-ink tracking-tight">{value}</p>
          <p className="text-xs text-ink-muted font-medium">{label}</p>
        </div>
      </div>
    </Wrapper>
  )
}

export function OverviewPanel({
  ontology,
  graphStats,
  coverage,
  assignmentCount,
  onNavigateTab,
  onExport,
}: OverviewPanelProps) {
  const entityCount = Object.keys(ontology.entityTypeDefinitions ?? {}).length
  const relCount = Object.keys(ontology.relationshipTypeDefinitions ?? {}).length
  const containmentCount = (ontology.containmentEdgeTypes ?? []).length
  const lineageCount = (ontology.lineageEdgeTypes ?? []).length
  const rootTypes = (ontology.rootEntityTypes ?? []).length

  const createdDate = new Date(ontology.createdAt).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
  })
  const updatedDate = new Date(ontology.updatedAt).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })

  return (
    <div className="space-y-6">
      {/* Hero card — ontology identity */}
      <div className="rounded-2xl border border-glass-border bg-gradient-to-br from-canvas-elevated/80 to-canvas-elevated/40 overflow-hidden">
        <div className="p-6">
          <div className="flex items-start justify-between">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-3 mb-2">
                <h2 className="text-2xl font-bold text-ink tracking-tight">{ontology.name}</h2>
                <OntologyStatusBadge ontology={ontology} />
              </div>

              {ontology.description ? (
                <p className="text-sm text-ink-secondary leading-relaxed max-w-2xl">
                  {ontology.description}
                </p>
              ) : (
                <p className="text-sm text-ink-muted/60 italic">
                  No description provided. Add one in Settings to document this semantic layer's purpose.
                </p>
              )}

              {/* Meta row */}
              <div className="flex items-center gap-4 mt-4 flex-wrap">
                <div className="flex items-center gap-1.5 text-xs text-ink-muted">
                  <Shield className="w-3.5 h-3.5" />
                  <span>v{ontology.version}</span>
                </div>
                <div className="flex items-center gap-1.5 text-xs text-ink-muted">
                  <Calendar className="w-3.5 h-3.5" />
                  <span>Created {createdDate}{ontology.createdBy ? ` by ${ontology.createdBy}` : ''}</span>
                </div>
                <div className="flex items-center gap-1.5 text-xs text-ink-muted">
                  <PenLine className="w-3.5 h-3.5" />
                  <span>Updated {updatedDate}{ontology.updatedBy ? ` by ${ontology.updatedBy}` : ''}</span>
                </div>
                {ontology.publishedAt && (
                  <div className="flex items-center gap-1.5 text-xs text-ink-muted">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                    <span>
                      Published {new Date(ontology.publishedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}
                      {ontology.publishedBy ? ` by ${ontology.publishedBy}` : ''}
                    </span>
                  </div>
                )}
                <div className="flex items-center gap-1.5 text-xs text-ink-muted">
                  <Layers className="w-3.5 h-3.5" />
                  <span>{ontology.scope}</span>
                </div>
              </div>
            </div>

            {/* Export button */}
            <button
              onClick={onExport}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold text-ink-secondary border border-glass-border hover:border-indigo-300 hover:bg-indigo-50/50 dark:hover:bg-indigo-950/20 hover:text-indigo-600 transition-all flex-shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
              Export JSON
            </button>
          </div>
        </div>

        {/* Evolution policy bar */}
        <div className="px-6 py-2.5 border-t border-glass-border/50 bg-black/[0.015] dark:bg-white/[0.015] flex items-center gap-4">
          <span className="text-[10px] text-ink-muted uppercase tracking-wider font-bold">Evolution Policy</span>
          <span className="text-xs font-semibold text-ink px-2 py-0.5 rounded-md bg-black/5 dark:bg-white/5 capitalize">
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
              Published &amp; Immutable
            </span>
          )}
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
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
          icon={Users}
          label="Assignments"
          value={assignmentCount}
          accent="bg-amber-50 dark:bg-amber-950/30 text-amber-500"
          onClick={() => onNavigateTab('usage')}
        />
        <StatCard
          icon={FileText}
          label="Coverage"
          value={coverage ? `${Math.round(coverage.coveragePercent)}%` : '—'}
          accent="bg-emerald-50 dark:bg-emerald-950/30 text-emerald-500"
          onClick={() => onNavigateTab('coverage')}
        />
      </div>

      {/* Structure breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Hierarchy summary */}
        <div className="rounded-2xl border border-glass-border bg-canvas-elevated/50 p-5">
          <div className="flex items-center gap-2 mb-4">
            <FolderTree className="w-4 h-4 text-indigo-500" />
            <h3 className="text-sm font-bold text-ink">Hierarchy Structure</h3>
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-ink-muted">Root types</span>
              <span className="text-sm font-bold text-ink">{rootTypes}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-ink-muted">Containment edges</span>
              <span className="text-sm font-bold text-ink">{containmentCount}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-ink-muted">Hierarchy levels</span>
              <span className="text-sm font-bold text-ink">
                {entityCount > 0
                  ? (() => {
                      const defs = ontology.entityTypeDefinitions as Record<string, Record<string, unknown>>
                      const levels = new Set(Object.values(defs).map(d => {
                        const h = d?.hierarchy as Record<string, unknown> | undefined
                        return (h?.level as number) ?? 0
                      }))
                      return levels.size
                    })()
                  : 0}
              </span>
            </div>
          </div>
          <button
            onClick={() => onNavigateTab('hierarchy')}
            className="mt-4 w-full text-center text-xs font-semibold text-indigo-500 hover:text-indigo-600 transition-colors"
          >
            View Hierarchy Map &rarr;
          </button>
        </div>

        {/* Data flow summary */}
        <div className="rounded-2xl border border-glass-border bg-canvas-elevated/50 p-5">
          <div className="flex items-center gap-2 mb-4">
            <Route className="w-4 h-4 text-green-500" />
            <h3 className="text-sm font-bold text-ink">Data Flow</h3>
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-ink-muted">Lineage edge types</span>
              <span className="text-sm font-bold text-ink">{lineageCount}</span>
            </div>
            {graphStats && (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-ink-muted">Graph nodes</span>
                  <span className="text-sm font-bold text-ink">{formatCount(graphStats.totalNodes)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-ink-muted">Graph edges</span>
                  <span className="text-sm font-bold text-ink">{formatCount(graphStats.totalEdges)}</span>
                </div>
              </>
            )}
            {!graphStats && (
              <p className="text-xs text-ink-muted/60 italic">Connect a data source to see graph statistics</p>
            )}
          </div>
          <button
            onClick={() => onNavigateTab('coverage')}
            className="mt-4 w-full text-center text-xs font-semibold text-green-500 hover:text-green-600 transition-colors"
          >
            View Coverage Analysis &rarr;
          </button>
        </div>
      </div>

      {/* Uncovered types warning */}
      {coverage && (coverage.uncoveredEntityTypes.length > 0 || coverage.uncoveredRelationshipTypes.length > 0) && (
        <div className="rounded-2xl border border-amber-200 dark:border-amber-800/50 bg-amber-50/50 dark:bg-amber-950/20 p-5">
          <div className="flex items-center gap-2 mb-3">
            <Box className="w-4 h-4 text-amber-500" />
            <h3 className="text-sm font-bold text-amber-800 dark:text-amber-300">Uncovered Graph Types</h3>
          </div>
          <p className="text-xs text-amber-700/80 dark:text-amber-400/70 mb-3">
            These types exist in your graph but are not defined in this semantic layer. Define them for full coverage.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {coverage.uncoveredEntityTypes.map(t => (
              <span key={t} className="px-2 py-1 rounded-lg text-xs font-medium bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800/40">
                {t}
              </span>
            ))}
            {coverage.uncoveredRelationshipTypes.map(t => (
              <span key={t} className="px-2 py-1 rounded-lg text-xs font-medium bg-amber-100/50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 border border-amber-200/50 dark:border-amber-800/30 italic">
                {t}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
