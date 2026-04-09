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
  BarChart3,
  Database,
  AlertTriangle,
  PenLine,
  Shield,
  Lock,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import { ontologyDefinitionService as ontologyService } from '@/services/ontologyDefinitionService'
import type { GraphSchemaStats } from '@/providers/GraphDataProvider'
import type { CoverageState } from '../../lib/ontology-types'
import { fetchSchemaStats } from '../../lib/ontology-utils'
import { formatCount, entityDefToSchema, relDefToSchema } from '../../lib/ontology-parsers'
import { SchemaMinimapSVG } from '../SchemaMinimapSVG'

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

  // Build minimap data from ontology definitions
  const minimapData = useMemo(() => {
    const entityDefs = ontology.entityTypeDefinitions as Record<string, Record<string, unknown>> ?? {}
    const relDefs = ontology.relationshipTypeDefinitions as Record<string, Record<string, unknown>> ?? {}

    const entities = Object.entries(entityDefs).map(([id, def]) => {
      const schema = entityDefToSchema(id, def)
      return { id: schema.id, name: schema.name, color: schema.visual.color }
    })

    const rels = Object.entries(relDefs).map(([id, def]) => {
      const schema = relDefToSchema(id, def)
      const source = schema.sourceTypes[0] ?? ''
      const target = schema.targetTypes[0] ?? ''
      return { source, target, name: schema.name }
    }).filter(r => r.source && r.target)

    return { entities, rels }
  }, [ontology.entityTypeDefinitions, ontology.relationshipTypeDefinitions])

  // Status banner text
  const statusBanner = useMemo(() => {
    if (ontology.isSystem) return {
      icon: Shield,
      text: 'System-provided schema — clone it to customize for your needs',
      color: 'bg-indigo-50/60 dark:bg-indigo-950/20 border-indigo-200/50 dark:border-indigo-800/30 text-indigo-700 dark:text-indigo-300',
      iconColor: 'text-indigo-500',
    }
    if (ontology.isPublished) return {
      icon: Lock,
      text: `Published and active on ${assignmentCount} data source${assignmentCount !== 1 ? 's' : ''}`,
      color: 'bg-emerald-50/60 dark:bg-emerald-950/20 border-emerald-200/50 dark:border-emerald-800/30 text-emerald-700 dark:text-emerald-300',
      iconColor: 'text-emerald-500',
    }
    return {
      icon: PenLine,
      text: 'This schema is a draft — edit entity types and relationships, then publish when ready',
      color: 'bg-amber-50/60 dark:bg-amber-950/20 border-amber-200/50 dark:border-amber-800/30 text-amber-700 dark:text-amber-300',
      iconColor: 'text-amber-500',
    }
  }, [ontology.isSystem, ontology.isPublished, assignmentCount])

  const StatusIcon = statusBanner.icon

  return (
    <div className="space-y-8">
      {/* ── Status Banner + Schema Minimap ───────────────────────── */}
      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Status banner */}
        <div className={cn(
          'rounded-2xl border p-4 flex items-start gap-3',
          statusBanner.color,
        )}>
          <StatusIcon className={cn('w-5 h-5 flex-shrink-0 mt-0.5', statusBanner.iconColor)} />
          <div>
            <p className="text-sm font-semibold leading-snug">{statusBanner.text}</p>
            {ontology.description && (
              <p className="text-xs mt-2 opacity-70 leading-relaxed">{ontology.description}</p>
            )}
          </div>
        </div>

        {/* Schema minimap */}
        <div className="rounded-2xl border border-glass-border bg-canvas-elevated/30 p-3 flex items-center justify-center">
          <SchemaMinimapSVG
            entityTypes={minimapData.entities}
            relationships={minimapData.rels}
          />
        </div>
      </section>

      {/* ── Key Metrics ─────────────────────────────────────────── */}
      <section>
        <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wider mb-3">
          Key Metrics
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard
            icon={Box}
            label="Entity Types"
            value={entityCount}
            accent="bg-indigo-50 dark:bg-indigo-950/30 text-indigo-500"
            onClick={() => onNavigateTab('schema')}
          />
          <StatCard
            icon={GitBranch}
            label="Relationships"
            value={relCount}
            accent="bg-purple-50 dark:bg-purple-950/30 text-purple-500"
            onClick={() => onNavigateTab('schema')}
          />
          <StatCard
            icon={BarChart3}
            label="Coverage"
            value={coverage ? `${Math.round(coverage.coveragePercent)}%` : '—'}
            accent="bg-emerald-50 dark:bg-emerald-950/30 text-emerald-500"
            onClick={() => onNavigateTab('coverage')}
          />
          <StatCard
            icon={Database}
            label="Data Sources"
            value={assignmentCount}
            accent="bg-amber-50 dark:bg-amber-950/30 text-amber-500"
            onClick={() => onNavigateTab('adoption')}
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
            onClick={() => onNavigateTab('schema')}
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
