/**
 * DeploymentDashboardPanel — cross-workspace deployment command center.
 *
 * Three view modes:
 *   - workspace: list workspaces, each showing its data sources + ontology assignment
 *   - ontology:  invert — list ontologies, each showing the data sources using it
 *   - matrix:    compact workspaces × ontologies grid, color-coded by status
 *
 * Premium polish layer on top of the wiring: coverage rings, health bars,
 * palette accents, skeletons, quick filter pills, and bulk selection.
 * Clicking into a data source jumps to Explorer scoped to that workspace
 * + data source; workspace "Explore Views" button does the same at
 * workspace scope.
 */
import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Database, Layers, AlertTriangle, ArrowRight, Search,
  Shield, CheckCircle2, PenLine, Unlink, Sparkles,
  GitBranch, ChevronDown, ChevronUp, ChevronRight, X,
  Plus, BookOpen, Eye, HelpCircle, Compass, MoreHorizontal,
  Grid3x3, LayoutList, Network, CircleDot, Check, Trash2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { WorkspaceResponse } from '@/services/workspaceService'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import { useDeploymentMatrix } from '../../hooks/useDeploymentMatrix'
import { useWorkspaceViewCounts } from '../../hooks/useWorkspaceViewCounts'
import type { DeploymentEntry } from '../../lib/ontology-types'
import { useWorkspacesStore } from '@/store/workspaces'
import { WORKSPACE_PALETTES } from '@/components/dashboard/dashboard-constants'

// ---------------------------------------------------------------------------
// Stagger CSS (matches ExplorerPage / WorkspacesPage pattern)
// ---------------------------------------------------------------------------

const STAGGER_STYLE = `
@keyframes ws-group-in {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
}
.ws-group-stagger { animation: ws-group-in 0.3s ease-out both; }

@keyframes ws-skel-shimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}
.ws-skeleton {
  background: linear-gradient(90deg,
    rgba(0,0,0,0.04) 0%, rgba(0,0,0,0.10) 50%, rgba(0,0,0,0.04) 100%);
  background-size: 200% 100%;
  animation: ws-skel-shimmer 1.4s ease-in-out infinite;
}
.dark .ws-skeleton {
  background: linear-gradient(90deg,
    rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.10) 50%, rgba(255,255,255,0.04) 100%);
  background-size: 200% 100%;
}

@keyframes ws-bar-in {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
}
.ws-bar-in { animation: ws-bar-in 0.2s ease-out both; }
`

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

const STATUS_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  system: Shield, published: CheckCircle2, draft: PenLine,
}

const STATUS_STYLES: Record<string, { text: string; bg: string; border: string; dot: string }> = {
  system:    { text: 'text-indigo-600 dark:text-indigo-400',  bg: 'bg-indigo-500/10',  border: 'border-indigo-500/20',  dot: 'bg-indigo-500'  },
  published: { text: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20', dot: 'bg-emerald-500' },
  draft:     { text: 'text-amber-600 dark:text-amber-400',    bg: 'bg-amber-500/10',   border: 'border-amber-500/20',   dot: 'bg-amber-500'   },
}

function paletteForWorkspace(wsId: string) {
  let hash = 0
  for (let i = 0; i < wsId.length; i++) hash = (hash * 31 + wsId.charCodeAt(i)) | 0
  return WORKSPACE_PALETTES[Math.abs(hash) % WORKSPACE_PALETTES.length]
}

// ---------------------------------------------------------------------------
// View mode & filter types
// ---------------------------------------------------------------------------

type ViewMode = 'workspace' | 'ontology' | 'matrix'
type QuickFilter = 'unassigned' | 'drift' | 'drafts' | 'active'

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface DeploymentDashboardPanelProps {
  workspaces: WorkspaceResponse[]
  ontologies: OntologyDefinitionResponse[]
  onNavigateToOntology: (ontologyId: string) => void
  onAssign: (workspaceId: string, dataSourceId: string) => void
  onUnassign: (workspaceId: string, dataSourceId: string) => void
  onSuggest: (workspaceId: string, dataSourceId: string) => void
  onCreateDraft?: () => void
  onSuggestFromGraph?: () => void
  isAssigning: boolean
  isLoading?: boolean
}

export function DeploymentDashboardPanel({
  workspaces,
  ontologies,
  onNavigateToOntology,
  onUnassign,
  onSuggest,
  onCreateDraft,
  onSuggestFromGraph,
  isAssigning,
  isLoading = false,
}: DeploymentDashboardPanelProps) {
  const { entries, orphans, versionMismatches, stats } = useDeploymentMatrix(workspaces, ontologies)
  const { counts: viewCounts } = useWorkspaceViewCounts()

  const navigate = useNavigate()
  const setActiveWorkspace = useWorkspacesStore(s => s.setActiveWorkspace)
  const setActiveDataSource = useWorkspacesStore(s => s.setActiveDataSource)
  const activeWorkspaceId = useWorkspacesStore(s => s.activeWorkspaceId)

  const goToExplorer = useCallback((wsId: string, dsId?: string) => {
    setActiveWorkspace(wsId)
    if (dsId) setActiveDataSource(dsId)
    const params = new URLSearchParams({ workspace: wsId })
    if (dsId) params.set('dataSource', dsId)
    navigate(`/explorer?${params.toString()}`)
  }, [navigate, setActiveWorkspace, setActiveDataSource])

  const [guideExpanded, setGuideExpanded] = useState(false)
  const [search, setSearch] = useState('')
  const [searchFocused, setSearchFocused] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('workspace')
  const [quickFilters, setQuickFilters] = useState<Set<QuickFilter>>(new Set())
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [collapsedWs, setCollapsedWs] = useState<Set<string>>(() =>
    workspaces.length <= 5 ? new Set() : new Set(workspaces.map(w => w.id)),
  )

  // Entries inside a version-drift group (for "drift" filter + ring slice).
  const driftKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const mm of versionMismatches) {
      for (const e of mm.entries) keys.add(`${e.workspaceId}:${e.dataSourceId}`)
    }
    return keys
  }, [versionMismatches])

  const toggleQuickFilter = (f: QuickFilter) => {
    setQuickFilters(prev => {
      const next = new Set(prev)
      if (next.has(f)) next.delete(f); else next.add(f)
      return next
    })
  }

  const statusCounts = useMemo(() => {
    const counts = { system: 0, published: 0, draft: 0 }
    for (const o of ontologies) {
      if (o.isSystem) counts.system++
      else if (o.isPublished) counts.published++
      else counts.draft++
    }
    return counts
  }, [ontologies])

  // ─── Entry filtering (search + quick filters) ─────────────────────────
  const filteredEntries = useMemo(() => {
    const q = search.trim().toLowerCase()
    return entries.filter(e => {
      if (q) {
        const hay = `${e.dataSourceLabel} ${e.workspaceName} ${e.ontologyName ?? ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      if (quickFilters.has('unassigned') && e.ontologyId) return false
      if (quickFilters.has('drafts') && e.ontologyStatus !== 'draft') return false
      if (quickFilters.has('drift') && !driftKeys.has(`${e.workspaceId}:${e.dataSourceId}`)) return false
      if (quickFilters.has('active') && e.workspaceId !== activeWorkspaceId) return false
      return true
    })
  }, [entries, search, quickFilters, driftKeys, activeWorkspaceId])

  // ─── By-Workspace grouping ───────────────────────────────────────────
  const groupedByWorkspace = useMemo(() => {
    const map = new Map<string, { workspace: WorkspaceResponse; entries: DeploymentEntry[] }>()
    for (const entry of filteredEntries) {
      let group = map.get(entry.workspaceId)
      if (!group) {
        const ws = workspaces.find(w => w.id === entry.workspaceId)
        if (!ws) continue
        group = { workspace: ws, entries: [] }
        map.set(entry.workspaceId, group)
      }
      group.entries.push(entry)
    }
    return Array.from(map.values())
  }, [filteredEntries, workspaces])

  // ─── By-Ontology grouping ────────────────────────────────────────────
  const groupedByOntology = useMemo(() => {
    const map = new Map<string, {
      ontology: OntologyDefinitionResponse | null
      key: string  // ontologyId or "__unassigned__"
      entries: DeploymentEntry[]
    }>()
    for (const entry of filteredEntries) {
      const key = entry.ontologyId ?? '__unassigned__'
      let group = map.get(key)
      if (!group) {
        const ont = entry.ontologyId ? ontologies.find(o => o.id === entry.ontologyId) ?? null : null
        group = { ontology: ont, key, entries: [] }
        map.set(key, group)
      }
      group.entries.push(entry)
    }
    return Array.from(map.values())
      .sort((a, b) => {
        if (a.key === '__unassigned__') return 1
        if (b.key === '__unassigned__') return -1
        return (a.ontology?.name ?? '').localeCompare(b.ontology?.name ?? '')
      })
  }, [filteredEntries, ontologies])

  function toggleWorkspace(wsId: string) {
    setCollapsedWs(prev => {
      const next = new Set(prev)
      if (next.has(wsId)) next.delete(wsId)
      else next.add(wsId)
      return next
    })
  }

  function expandAll() { setCollapsedWs(new Set()) }
  function collapseAll() { setCollapsedWs(new Set(workspaces.map(w => w.id))) }

  function uniqueOntologyCount(wsEntries: DeploymentEntry[]): number {
    return new Set(wsEntries.filter(e => e.ontologyId).map(e => e.ontologyId)).size
  }

  // ─── Selection helpers ───────────────────────────────────────────────
  const keyOf = (e: DeploymentEntry) => `${e.workspaceId}:${e.dataSourceId}`
  const toggleSelect = (e: DeploymentEntry) => {
    setSelectedKeys(prev => {
      const next = new Set(prev)
      const k = keyOf(e)
      if (next.has(k)) next.delete(k); else next.add(k)
      return next
    })
  }
  const selectAllIn = (wsEntries: DeploymentEntry[]) => {
    setSelectedKeys(prev => {
      const next = new Set(prev)
      const keys = wsEntries.map(keyOf)
      const allSelected = keys.every(k => next.has(k))
      if (allSelected) keys.forEach(k => next.delete(k))
      else keys.forEach(k => next.add(k))
      return next
    })
  }
  const clearSelection = () => setSelectedKeys(new Set())

  const selectedEntries = useMemo(
    () => entries.filter(e => selectedKeys.has(keyOf(e))),
    [entries, selectedKeys],
  )

  const runBulkUnassign = () => {
    selectedEntries.forEach(e => onUnassign(e.workspaceId, e.dataSourceId))
    clearSelection()
  }
  const runBulkSuggest = () => {
    selectedEntries.forEach(e => onSuggest(e.workspaceId, e.dataSourceId))
    clearSelection()
  }

  const filterPillActive = (f: QuickFilter) => quickFilters.has(f)
  const hasAnyFilter = search.trim().length > 0 || quickFilters.size > 0

  // ────────────────────────────────────────────────────────────────────
  // Render
  // ────────────────────────────────────────────────────────────────────
  return (
    <div className="p-8 animate-in fade-in duration-500">
      <style>{STAGGER_STYLE}</style>

      {/* ── Hero section ─────────────────────────────────────────── */}
      <div className="mb-8">
        <div className="flex items-start justify-between gap-6">
          <div className="flex-1">
            <h1 className="text-3xl font-bold tracking-tight text-ink">Semantic Layers</h1>
            <p className="text-sm text-ink-muted mt-2 max-w-2xl leading-relaxed">
              A semantic layer defines the vocabulary for your knowledge graph — entity types, relationships,
              and hierarchy rules that give structure and meaning to raw graph data.
            </p>
          </div>

          {(onCreateDraft || onSuggestFromGraph) && (
            <div className="flex items-center gap-2 flex-shrink-0 pt-1">
              {onSuggestFromGraph && (
                <button onClick={onSuggestFromGraph}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold border border-glass-border text-ink-secondary hover:text-indigo-600 hover:border-indigo-300 hover:bg-indigo-500/[0.04] transition-all">
                  <Sparkles className="w-4 h-4" />
                  Suggest from Graph
                </button>
              )}
              {onCreateDraft && (
                <button onClick={onCreateDraft}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold bg-gradient-to-r from-indigo-500 to-violet-600 text-white shadow-lg shadow-indigo-500/20 hover:shadow-xl hover:-translate-y-0.5 transition-all duration-200">
                  <Plus className="w-4 h-4" />
                  New Semantic Layer
                </button>
              )}
            </div>
          )}
        </div>

        {/* Getting started guide — original rich layout with collapse toggle */}
        {ontologies.length <= 5 && (
          <div className="mt-6">
            <button
              onClick={() => setGuideExpanded(!guideExpanded)}
              className="flex items-center gap-2 mb-4 text-left group"
            >
              <div className="w-7 h-7 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center flex-shrink-0">
                <HelpCircle className="w-3.5 h-3.5 text-indigo-500" />
              </div>
              <span className="text-xs font-bold text-ink-secondary group-hover:text-ink transition-colors">Getting Started Guide</span>
              {guideExpanded
                ? <ChevronUp className="w-3.5 h-3.5 text-ink-muted" />
                : <ChevronDown className="w-3.5 h-3.5 text-ink-muted" />}
            </button>

            <div
              className="grid transition-[grid-template-rows] duration-300 ease-out"
              style={{ gridTemplateRows: guideExpanded ? '1fr' : '0fr' }}
            >
              <div className="overflow-hidden">
                <div className="space-y-4 pb-2">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div className="flex items-start gap-3 p-4 rounded-xl border border-glass-border bg-canvas-elevated/50">
                      <div className="w-9 h-9 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                        <BookOpen className="w-4 h-4 text-indigo-500" />
                      </div>
                      <div>
                        <p className="text-xs font-bold text-ink mb-1">1. Define your schema</p>
                        <p className="text-[11px] text-ink-muted leading-relaxed">
                          Create a semantic layer with entity types (Person, Company) and relationships (WORKS_AT, OWNS) that describe your graph.
                        </p>
                      </div>
                    </div>
                    <div className="flex items-start gap-3 p-4 rounded-xl border border-glass-border bg-canvas-elevated/50">
                      <div className="w-9 h-9 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                        <Database className="w-4 h-4 text-emerald-500" />
                      </div>
                      <div>
                        <p className="text-xs font-bold text-ink mb-1">2. Assign to data sources</p>
                        <p className="text-[11px] text-ink-muted leading-relaxed">
                          Connect a semantic layer to one or more data sources. This tells the system how to interpret each graph's nodes and edges.
                        </p>
                      </div>
                    </div>
                    <div className="flex items-start gap-3 p-4 rounded-xl border border-glass-border bg-canvas-elevated/50">
                      <div className="w-9 h-9 rounded-lg bg-violet-500/10 border border-violet-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                        <Eye className="w-4 h-4 text-violet-500" />
                      </div>
                      <div>
                        <p className="text-xs font-bold text-ink mb-1">3. Build views &amp; explore</p>
                        <p className="text-[11px] text-ink-muted leading-relaxed">
                          Once assigned, create views with type-aware features — expandable hierarchy, semantic search, and structured filters.
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Why it matters — original card with amber gradient bar */}
                  <div className="rounded-2xl border border-glass-border bg-canvas-elevated overflow-hidden">
                    <div className="h-0.5 w-full bg-gradient-to-r from-amber-500 via-orange-500 to-rose-500" />
                    <div className="p-5">
                      <div className="flex items-center gap-2 mb-3">
                        <Sparkles className="w-4 h-4 text-amber-500" />
                        <h3 className="text-sm font-bold text-ink">Why semantic layers matter</h3>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs text-ink-muted leading-relaxed">
                        <div className="flex items-start gap-2.5">
                          <div className="w-1.5 h-1.5 rounded-full bg-indigo-400 mt-1.5 flex-shrink-0" />
                          <div>
                            <span className="font-semibold text-ink">Type-aware views</span> — Without a semantic layer, views treat all nodes and edges as generic. With one, the system knows that a "Person" should render differently from a "Document", enabling icons, colors, and labels per type.
                          </div>
                        </div>
                        <div className="flex items-start gap-2.5">
                          <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 mt-1.5 flex-shrink-0" />
                          <div>
                            <span className="font-semibold text-ink">Hierarchy navigation</span> — Containment rules (e.g., Organization contains Department contains Team) power expand/collapse, breadcrumb trails, and drill-down exploration.
                          </div>
                        </div>
                        <div className="flex items-start gap-2.5">
                          <div className="w-1.5 h-1.5 rounded-full bg-violet-400 mt-1.5 flex-shrink-0" />
                          <div>
                            <span className="font-semibold text-ink">Semantic search</span> — Entity type definitions enable scoped searches like "find all People" or "show Documents connected to this Company" instead of raw node/edge queries.
                          </div>
                        </div>
                        <div className="flex items-start gap-2.5">
                          <div className="w-1.5 h-1.5 rounded-full bg-amber-400 mt-1.5 flex-shrink-0" />
                          <div>
                            <span className="font-semibold text-ink">Consistency across teams</span> — Publishing a semantic layer creates an immutable contract. All data sources using it share the same type definitions, ensuring consistent behavior across workspaces and views.
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Summary banner / skeleton ────────────────────────────── */}
      {isLoading ? (
        <SummaryBannerSkeleton />
      ) : entries.length > 0 && (
        <div className="rounded-2xl border border-glass-border bg-canvas-elevated overflow-hidden mb-6">
          <div className="h-1 w-full bg-gradient-to-r from-indigo-500 via-violet-500 to-cyan-500" />
          <div className="p-5">
            <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
              <SummaryStat icon={Layers} iconClass="bg-indigo-500/10 border-indigo-500/20 text-indigo-500" value={stats.ontologyCount} label="Semantic Layers" />
              <SummaryStat icon={Database} iconClass="bg-sky-500/10 border-sky-500/20 text-sky-500" value={stats.totalDs} label="Data Sources" />
              <SummaryStat
                icon={stats.orphanDs > 0 ? AlertTriangle : CheckCircle2}
                iconClass={stats.orphanDs > 0 ? 'bg-red-500/10 border-red-500/20 text-red-500' : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-500'}
                value={stats.orphanDs}
                label="Unassigned"
              />
              {versionMismatches.length > 0 && (
                <SummaryStat icon={GitBranch} iconClass="bg-amber-500/10 border-amber-500/20 text-amber-500" value={versionMismatches.length} label="Version Mismatches" />
              )}
              <SummaryStat icon={Eye} iconClass="bg-violet-500/10 border-violet-500/20 text-violet-500" value={viewCounts.total} label="Views" />

              <div className="w-px h-10 bg-glass-border hidden lg:block" />
              <div>
                <div className="text-[10px] text-ink-muted uppercase tracking-wider mb-1.5">Ontology Status</div>
                <div className="flex items-center gap-3">
                  {statusCounts.system > 0 && (
                    <span className="flex items-center gap-1.5 text-xs text-ink-secondary">
                      <span className="w-2 h-2 rounded-full bg-indigo-400" />
                      <span className="font-bold text-ink">{statusCounts.system}</span> system
                    </span>
                  )}
                  {statusCounts.published > 0 && (
                    <span className="flex items-center gap-1.5 text-xs text-ink-secondary">
                      <span className="w-2 h-2 rounded-full bg-emerald-400" />
                      <span className="font-bold text-ink">{statusCounts.published}</span> published
                    </span>
                  )}
                  {statusCounts.draft > 0 && (
                    <span className="flex items-center gap-1.5 text-xs text-ink-secondary">
                      <span className="w-2 h-2 rounded-full bg-amber-400" />
                      <span className="font-bold text-ink">{statusCounts.draft}</span> draft
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="mt-4 pt-4 border-t border-glass-border/50 flex items-center gap-2">
              <Sparkles className="w-3.5 h-3.5 text-amber-500 shrink-0" />
              <p className="text-xs text-ink-muted">
                <span className="font-semibold text-ink">{stats.assignedDs}</span> of <span className="font-semibold text-ink">{stats.totalDs}</span> data sources have a semantic layer assigned
                {stats.orphanDs > 0 && (
                  <span> — <span className="text-red-500 font-medium">{stats.orphanDs} need attention</span></span>
                )}
                {stats.orphanDs === 0 && <span className="text-emerald-500 font-medium"> — all covered</span>}.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ── Orphan Alert (only in workspace mode, no filters hide it) ── */}
      {viewMode === 'workspace' && orphans.length > 0 && !quickFilters.has('unassigned') && (
        <div className="mb-6 p-5 rounded-2xl border border-red-200/60 dark:border-red-800/40 bg-red-50/30 dark:bg-red-950/10">
          <div className="flex items-center justify-between gap-3 mb-3">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-red-500" />
              <h3 className="text-sm font-bold text-red-700 dark:text-red-300">
                {orphans.length} Data Source{orphans.length !== 1 ? 's' : ''} Without a Semantic Layer
              </h3>
            </div>
            <button
              onClick={() => toggleQuickFilter('unassigned')}
              className="text-[11px] font-semibold text-red-600 dark:text-red-400 hover:underline"
            >
              Show only unassigned →
            </button>
          </div>
          <p className="text-xs text-red-600/70 dark:text-red-400/70 mb-4">
            These data sources won't have access to ontology-driven features.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {orphans.slice(0, 6).map(o => (
              <div key={`${o.workspaceId}-${o.dataSourceId}`}
                className="flex items-center gap-3 p-3 rounded-xl border border-red-200/40 dark:border-red-800/30 bg-white/50 dark:bg-black/10">
                <Database className="w-4 h-4 text-red-400 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-ink truncate">{o.dataSourceLabel}</p>
                  <p className="text-[10px] text-ink-muted">in {o.workspaceName}</p>
                </div>
                <button onClick={() => onSuggest(o.workspaceId, o.dataSourceId)} disabled={isAssigning}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[10px] font-semibold bg-indigo-500 text-white hover:bg-indigo-600 transition-colors flex-shrink-0 disabled:opacity-50 shadow-sm shadow-indigo-500/20">
                  <Sparkles className="w-3 h-3" /> Suggest
                </button>
              </div>
            ))}
            {orphans.length > 6 && (
              <p className="text-[10px] text-red-500/70 col-span-full text-center py-1">
                +{orphans.length - 6} more — scroll sections below
              </p>
            )}
          </div>
        </div>
      )}

      {/* ── Version Mismatches ────────────────────────────────────────── */}
      {versionMismatches.length > 0 && viewMode === 'workspace' && !quickFilters.has('drift') && (
        <div className="mb-6 p-5 rounded-2xl border border-amber-200/60 dark:border-amber-800/40 bg-amber-50/30 dark:bg-amber-950/10">
          <div className="flex items-center justify-between gap-3 mb-3">
            <div className="flex items-center gap-2">
              <GitBranch className="w-4 h-4 text-amber-500" />
              <h3 className="text-sm font-bold text-amber-700 dark:text-amber-300">Version Mismatches Detected</h3>
            </div>
            <button
              onClick={() => toggleQuickFilter('drift')}
              className="text-[11px] font-semibold text-amber-600 dark:text-amber-400 hover:underline"
            >
              Show only drift →
            </button>
          </div>
          <p className="text-xs text-amber-600/70 dark:text-amber-400/70 mb-3">
            Data sources using different versions of the same ontology lineage.
          </p>
          {versionMismatches.map(mm => {
            const versions = [...new Set(mm.entries.map(e => e.ontologyVersion).filter(Boolean))]
            return (
              <div key={mm.schemaId} className="mb-2 last:mb-0 p-3 rounded-xl bg-white/50 dark:bg-black/10 border border-amber-200/30 dark:border-amber-800/20">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-xs font-semibold text-ink">{mm.schemaName}</span>
                  <span className="text-[10px] text-amber-600 dark:text-amber-400 font-medium">versions: {versions.sort().join(', ')}</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {mm.entries.map(e => (
                    <span key={`${e.workspaceId}-${e.dataSourceId}`} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] bg-amber-100/50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 border border-amber-200/40 dark:border-amber-800/30">
                      <Database className="w-2.5 h-2.5" /> {e.dataSourceLabel} <span className="text-amber-500 font-semibold">v{e.ontologyVersion}</span>
                    </span>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* ── Toolbar: view mode + search + controls ───────────────────── */}
      <div className="flex items-center gap-3 mb-4">
        {/* View mode segmented control */}
        <ViewModeToggle mode={viewMode} onChange={setViewMode} />

        {entries.length > 4 && (
          <div className="relative flex-1">
            <div className={cn(
              'relative flex items-center rounded-xl border bg-canvas-elevated overflow-hidden',
              'transition-[border-color,box-shadow] duration-200',
              searchFocused
                ? 'border-accent-lineage/50 shadow-[0_0_0_3px_rgba(var(--accent-lineage-rgb,99,102,241),0.08)]'
                : 'border-glass-border',
            )}>
              <Search className={cn(
                'w-4 h-4 ml-3.5 shrink-0 transition-colors duration-150',
                searchFocused ? 'text-accent-lineage' : 'text-ink-muted',
              )} />
              <input
                ref={searchRef}
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setSearchFocused(false)}
                placeholder="Search data sources, workspaces, or ontologies..."
                className="w-full bg-transparent py-2.5 px-3 text-sm text-ink outline-none placeholder:text-ink-muted/50 font-medium"
              />
              {search && (
                <button onClick={() => setSearch('')}
                  className="mr-1.5 p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04] transition-colors duration-150">
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        )}

        {viewMode === 'workspace' && workspaces.length > 1 && (
          <div className="flex items-center gap-1 shrink-0">
            <button onClick={expandAll}
              className="px-3 py-2 rounded-lg text-xs font-medium text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04] transition-colors">
              Expand All
            </button>
            <button onClick={collapseAll}
              className="px-3 py-2 rounded-lg text-xs font-medium text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04] transition-colors">
              Collapse All
            </button>
          </div>
        )}
      </div>

      {/* ── Quick filter pills ───────────────────────────────────────── */}
      <div className="flex items-center gap-1.5 mb-5 flex-wrap">
        <span className="text-[11px] font-semibold text-ink-muted uppercase tracking-wider mr-1">Filter</span>
        <FilterPill active={quickFilters.size === 0} onClick={() => setQuickFilters(new Set())} label="All" />
        <FilterPill
          active={filterPillActive('unassigned')}
          onClick={() => toggleQuickFilter('unassigned')}
          label="Unassigned"
          count={orphans.length}
          tone="red"
        />
        <FilterPill
          active={filterPillActive('drift')}
          onClick={() => toggleQuickFilter('drift')}
          label="Version drift"
          count={driftKeys.size}
          tone="amber"
        />
        <FilterPill
          active={filterPillActive('drafts')}
          onClick={() => toggleQuickFilter('drafts')}
          label="Drafts"
          count={statusCounts.draft}
          tone="amber"
        />
        {activeWorkspaceId && (
          <FilterPill
            active={filterPillActive('active')}
            onClick={() => toggleQuickFilter('active')}
            label="Active workspace"
            tone="indigo"
          />
        )}
        {hasAnyFilter && (
          <button
            onClick={() => { setSearch(''); setQuickFilters(new Set()) }}
            className="ml-1 flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-medium text-ink-muted hover:text-ink"
          >
            <X className="w-3 h-3" /> Clear
          </button>
        )}
      </div>

      {/* ── Section header (conditional to mode) ─────────────────────── */}
      {viewMode === 'workspace' && (
        <div className="flex items-center gap-2 mb-4">
          <div className="w-7 h-7 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center">
            <Layers className="w-3.5 h-3.5 text-indigo-500" />
          </div>
          <h2 className="text-sm font-bold text-ink">Deployment by Workspace</h2>
          <span className="text-[11px] text-ink-muted">{groupedByWorkspace.length} workspace{groupedByWorkspace.length !== 1 ? 's' : ''}</span>
        </div>
      )}
      {viewMode === 'ontology' && (
        <div className="flex items-center gap-2 mb-4">
          <div className="w-7 h-7 rounded-lg bg-violet-500/10 border border-violet-500/20 flex items-center justify-center">
            <Network className="w-3.5 h-3.5 text-violet-500" />
          </div>
          <h2 className="text-sm font-bold text-ink">Deployment by Ontology</h2>
          <span className="text-[11px] text-ink-muted">{groupedByOntology.length} group{groupedByOntology.length !== 1 ? 's' : ''}</span>
        </div>
      )}
      {viewMode === 'matrix' && (
        <div className="flex items-center gap-2 mb-4">
          <div className="w-7 h-7 rounded-lg bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center">
            <Grid3x3 className="w-3.5 h-3.5 text-cyan-500" />
          </div>
          <h2 className="text-sm font-bold text-ink">Coverage Matrix</h2>
          <span className="text-[11px] text-ink-muted">Workspaces × Ontologies</span>
        </div>
      )}

      {/* ── Main content (mode-specific) ─────────────────────────────── */}
      {isLoading ? (
        <div className="space-y-3">
          <WorkspaceGroupSkeleton />
          <WorkspaceGroupSkeleton />
        </div>
      ) : viewMode === 'workspace' ? (
        <div className="space-y-3">
          {groupedByWorkspace.map(({ workspace, entries: wsEntries }, groupIdx) => {
            const wsOrphans = wsEntries.filter(e => !e.ontologyId).length
            const wsAssigned = wsEntries.length - wsOrphans
            const wsDrift = wsEntries.filter(e => driftKeys.has(`${e.workspaceId}:${e.dataSourceId}`)).length
            const wsOntologies = uniqueOntologyCount(wsEntries)
            const isCollapsed = collapsedWs.has(workspace.id)
            const palette = paletteForWorkspace(workspace.id)
            const wsViewCount = viewCounts.byWorkspace[workspace.id] ?? 0
            const allSelected = wsEntries.length > 0 && wsEntries.every(e => selectedKeys.has(keyOf(e)))
            const anySelected = wsEntries.some(e => selectedKeys.has(keyOf(e)))

            return (
              <div
                key={workspace.id}
                className="ws-group-stagger rounded-2xl border border-glass-border bg-canvas-elevated overflow-hidden"
                style={{ animationDelay: `${Math.min(groupIdx * 40, 300)}ms` }}
              >
                <div className={cn('h-1 w-full', palette.accent, 'opacity-80')} />

                <div className={cn(
                  'flex items-stretch gap-0',
                  isCollapsed ? 'hover:bg-black/[0.02] dark:hover:bg-white/[0.02]' : 'border-b border-glass-border/40 bg-gradient-to-r from-canvas-elevated/80 to-transparent',
                )}>
                  {/* Select-all checkbox */}
                  <button
                    onClick={() => selectAllIn(wsEntries)}
                    title={allSelected ? 'Deselect all' : 'Select all in workspace'}
                    className={cn(
                      'w-10 flex items-center justify-center border-r border-glass-border/30 transition-colors',
                      anySelected ? 'opacity-100' : 'opacity-0 hover:opacity-100 group-hover:opacity-100',
                    )}
                  >
                    <span className={cn(
                      'w-4 h-4 rounded border flex items-center justify-center transition-colors',
                      allSelected
                        ? 'bg-accent-lineage border-accent-lineage'
                        : anySelected
                          ? 'bg-accent-lineage/30 border-accent-lineage/50'
                          : 'border-ink-muted/40 hover:border-accent-lineage',
                    )}>
                      {allSelected && <Check className="w-3 h-3 text-white" />}
                      {!allSelected && anySelected && <span className="w-2 h-0.5 bg-accent-lineage rounded" />}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => toggleWorkspace(workspace.id)}
                    className="flex-1 flex items-center gap-3 px-5 py-3.5 text-left"
                  >
                    {isCollapsed
                      ? <ChevronRight className="w-4 h-4 text-ink-muted flex-shrink-0" />
                      : <ChevronDown className="w-4 h-4 text-ink-muted flex-shrink-0" />}

                    <CoverageRing
                      total={wsEntries.length}
                      assigned={wsAssigned}
                      drift={wsDrift}
                      size={36}
                    />

                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold text-ink">{workspace.name}</p>
                      <p className="text-[11px] text-ink-muted mt-0.5">
                        {wsEntries.length === 0 ? 'No data sources' : `${wsAssigned}/${wsEntries.length} assigned`}
                      </p>
                    </div>

                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <StatPill count={wsEntries.length} label="total" tone="sky" />
                      <StatPill count={wsAssigned} label="assigned" tone="emerald" />
                      {wsOrphans > 0 && <StatPill count={wsOrphans} label="unassigned" tone="red" />}
                      <StatPill count={wsOntologies} label={wsOntologies === 1 ? 'ontology' : 'ontologies'} tone="indigo" />
                      {wsViewCount > 0 && <StatPill count={wsViewCount} label="view" pluralize tone="violet" icon={Eye} />}
                    </div>
                  </button>

                  <button
                    onClick={(e) => { e.stopPropagation(); goToExplorer(workspace.id) }}
                    className="flex items-center gap-1.5 px-4 mr-2 my-2 rounded-xl text-xs font-semibold border border-glass-border text-ink-secondary hover:text-accent-lineage hover:border-accent-lineage/40 hover:bg-accent-lineage/[0.04] transition-all"
                    title={`Explore ${wsViewCount} view${wsViewCount !== 1 ? 's' : ''} in ${workspace.name}`}
                  >
                    <Compass className="w-3.5 h-3.5" />
                    Explore Views
                    <ArrowRight className="w-3 h-3" />
                  </button>
                </div>

                {/* Health bar */}
                {wsEntries.length > 0 && (
                  <div className="h-0.5 bg-glass-border relative">
                    <div
                      className="absolute inset-y-0 left-0 bg-gradient-to-r from-emerald-500 to-red-500 transition-all duration-500"
                      style={{
                        width: `${(wsAssigned / wsEntries.length) * 100}%`,
                        background: wsOrphans === 0
                          ? 'linear-gradient(to right, rgb(16 185 129), rgb(16 185 129))'
                          : 'linear-gradient(to right, rgb(16 185 129), rgb(239 68 68))',
                      }}
                    />
                  </div>
                )}

                {/* Data source rows */}
                {!isCollapsed && (
                  <div className="divide-y divide-glass-border/30">
                    {wsEntries.length === 0 && (
                      <div className="px-5 py-6 text-center text-xs text-ink-muted italic">
                        No data sources configured in this workspace yet.
                      </div>
                    )}
                    {wsEntries.map(entry => (
                      <DataSourceRow
                        key={entry.dataSourceId}
                        entry={entry}
                        isSelected={selectedKeys.has(keyOf(entry))}
                        onToggleSelect={() => toggleSelect(entry)}
                        viewCount={viewCounts.byDataSource[entry.dataSourceId] ?? 0}
                        isDrift={driftKeys.has(`${entry.workspaceId}:${entry.dataSourceId}`)}
                        isAssigning={isAssigning}
                        onRowClick={() => goToExplorer(entry.workspaceId, entry.dataSourceId)}
                        onNavigateToOntology={onNavigateToOntology}
                        onSuggest={onSuggest}
                        onUnassign={onUnassign}
                        onNavigateSchemaTab={(ontId, tab) => navigate(`/schema/${ontId}?tab=${tab}`)}
                      />
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      ) : viewMode === 'ontology' ? (
        <div className="space-y-3">
          {groupedByOntology.map((group, groupIdx) => (
            <OntologyGroupCard
              key={group.key}
              group={group}
              index={groupIdx}
              viewCounts={viewCounts.byDataSource}
              driftKeys={driftKeys}
              selectedKeys={selectedKeys}
              onToggleSelect={toggleSelect}
              onNavigateToOntology={onNavigateToOntology}
              onRowClick={goToExplorer}
              onSuggest={onSuggest}
              onUnassign={onUnassign}
              onNavigateSchemaTab={(ontId, tab) => navigate(`/schema/${ontId}?tab=${tab}`)}
              keyOf={keyOf}
              isAssigning={isAssigning}
            />
          ))}
        </div>
      ) : (
        <CoverageMatrix
          workspaces={workspaces}
          ontologies={ontologies}
          entries={filteredEntries}
          onCellClick={(ontId, wsId) => {
            const params = new URLSearchParams({ workspaceId: wsId })
            navigate(`/schema/${ontId}?${params.toString()}`)
          }}
        />
      )}

      {/* Empty state */}
      {!isLoading && entries.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 border-2 border-dashed border-glass-border rounded-2xl">
          <Database className="w-12 h-12 text-ink-muted mb-4" />
          <h3 className="text-lg font-bold text-ink mb-1">No data sources found</h3>
          <p className="text-sm text-ink-muted">Create a workspace and add data sources to get started.</p>
        </div>
      )}
      {!isLoading && entries.length > 0 && filteredEntries.length === 0 && (
        <div className="flex flex-col items-center justify-center py-12 border-2 border-dashed border-glass-border rounded-2xl">
          <Search className="w-8 h-8 text-ink-muted mb-3" />
          <p className="text-sm font-semibold text-ink mb-1">No matches</p>
          <p className="text-xs text-ink-muted">Try clearing filters or adjusting your search.</p>
          {hasAnyFilter && (
            <button
              onClick={() => { setSearch(''); setQuickFilters(new Set()) }}
              className="mt-3 px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-accent-lineage/10 text-accent-lineage hover:bg-accent-lineage/15"
            >
              Clear filters
            </button>
          )}
        </div>
      )}

      {/* Bulk selection bar */}
      <BulkSelectionBar
        count={selectedEntries.length}
        onClear={clearSelection}
        onSuggest={runBulkSuggest}
        onUnassign={runBulkUnassign}
        isAssigning={isAssigning}
      />
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════
// Subcomponents
// ═══════════════════════════════════════════════════════════════════════

function SummaryStat({
  icon: Icon, iconClass, value, label,
}: { icon: React.ComponentType<{ className?: string }>; iconClass: string; value: number; label: string }) {
  return (
    <div className="flex items-center gap-3">
      <div className={cn('w-10 h-10 rounded-xl border flex items-center justify-center', iconClass)}>
        <Icon className="w-5 h-5" />
      </div>
      <div>
        <div className="text-lg font-bold text-ink">{value}</div>
        <div className="text-[10px] text-ink-muted uppercase tracking-wider">{label}</div>
      </div>
    </div>
  )
}

function ViewModeToggle({ mode, onChange }: { mode: ViewMode; onChange: (m: ViewMode) => void }) {
  const opts: Array<{ value: ViewMode; label: string; icon: React.ComponentType<{ className?: string }> }> = [
    { value: 'workspace', label: 'By Workspace', icon: LayoutList },
    { value: 'ontology',  label: 'By Ontology',  icon: Network },
    { value: 'matrix',    label: 'Matrix',       icon: Grid3x3 },
  ]
  return (
    <div className="inline-flex items-center rounded-xl border border-glass-border bg-canvas-elevated p-0.5 shrink-0">
      {opts.map(opt => {
        const Icon = opt.icon
        const active = mode === opt.value
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors',
              active
                ? 'bg-accent-lineage/12 text-accent-lineage'
                : 'text-ink-muted hover:text-ink',
            )}
            title={opt.label}
          >
            <Icon className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">{opt.label}</span>
          </button>
        )
      })}
    </div>
  )
}

function FilterPill({
  active, onClick, label, count, tone = 'indigo',
}: {
  active: boolean
  onClick: () => void
  label: string
  count?: number
  tone?: 'indigo' | 'red' | 'amber' | 'violet'
}) {
  const tones = {
    indigo: { bg: 'bg-accent-lineage/12', text: 'text-accent-lineage', border: 'border-accent-lineage/30' },
    red:    { bg: 'bg-red-500/12',        text: 'text-red-600 dark:text-red-400', border: 'border-red-500/30' },
    amber:  { bg: 'bg-amber-500/12',      text: 'text-amber-600 dark:text-amber-400', border: 'border-amber-500/30' },
    violet: { bg: 'bg-violet-500/12',     text: 'text-violet-600 dark:text-violet-400', border: 'border-violet-500/30' },
  }[tone]

  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-colors',
        active
          ? cn(tones.bg, tones.text, tones.border)
          : 'border-glass-border text-ink-muted hover:text-ink hover:border-ink-muted/40',
      )}
    >
      {label}
      {count !== undefined && count > 0 && (
        <span className={cn(
          'inline-flex items-center justify-center min-w-[18px] h-[16px] px-1 rounded-full text-[9px] font-bold tabular-nums',
          active ? 'bg-white/20' : 'bg-black/5 dark:bg-white/5',
        )}>
          {count}
        </span>
      )}
    </button>
  )
}

function StatPill({
  count, label, tone, pluralize, icon: Icon,
}: {
  count: number
  label: string
  tone: 'sky' | 'emerald' | 'red' | 'indigo' | 'violet'
  pluralize?: boolean
  icon?: React.ComponentType<{ className?: string }>
}) {
  const tones = {
    sky:     'bg-sky-500/8 text-sky-600 dark:text-sky-400 border-sky-500/15',
    emerald: 'bg-emerald-500/8 text-emerald-600 dark:text-emerald-400 border-emerald-500/15',
    red:     'bg-red-500/8 text-red-600 dark:text-red-400 border-red-500/15',
    indigo:  'bg-indigo-500/8 text-indigo-600 dark:text-indigo-400 border-indigo-500/15',
    violet:  'bg-violet-500/8 text-violet-600 dark:text-violet-400 border-violet-500/15',
  }[tone]
  const suffix = pluralize && count !== 1 ? 's' : ''
  return (
    <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-semibold border', tones)}>
      {Icon && <Icon className="w-2.5 h-2.5" />}
      {count} <span className="font-normal opacity-70">{label}{suffix}</span>
    </span>
  )
}

// ───────────────────────────────────────────────────────────────────────
// Coverage Ring — SVG donut showing assigned/drift/orphan proportions
// ───────────────────────────────────────────────────────────────────────
function CoverageRing({
  total, assigned, drift, size = 36,
}: { total: number; assigned: number; drift: number; size?: number }) {
  if (total === 0) {
    return (
      <div
        className="rounded-full border-2 border-dashed border-ink-muted/30 flex items-center justify-center text-[9px] font-bold text-ink-muted/50"
        style={{ width: size, height: size }}
      >
        —
      </div>
    )
  }
  const orphan = total - assigned
  const clean = Math.max(0, assigned - drift)
  const r = (size - 6) / 2
  const cx = size / 2, cy = size / 2
  const circumference = 2 * Math.PI * r
  const cleanLen = (clean / total) * circumference
  const driftLen = (drift / total) * circumference
  const orphanLen = (orphan / total) * circumference

  const cleanStart = 0
  const driftStart = cleanLen
  const orphanStart = cleanLen + driftLen

  return (
    <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="currentColor" strokeWidth="3" className="text-glass-border" />
        {clean > 0 && (
          <circle
            cx={cx} cy={cy} r={r}
            fill="none" stroke="rgb(16 185 129)" strokeWidth="3"
            strokeDasharray={`${cleanLen} ${circumference}`}
            strokeDashoffset={-cleanStart}
            strokeLinecap="round"
          />
        )}
        {drift > 0 && (
          <circle
            cx={cx} cy={cy} r={r}
            fill="none" stroke="rgb(245 158 11)" strokeWidth="3"
            strokeDasharray={`${driftLen} ${circumference}`}
            strokeDashoffset={-driftStart}
            strokeLinecap="round"
          />
        )}
        {orphan > 0 && (
          <circle
            cx={cx} cy={cy} r={r}
            fill="none" stroke="rgb(239 68 68)" strokeWidth="3"
            strokeDasharray={`${orphanLen} ${circumference}`}
            strokeDashoffset={-orphanStart}
            strokeLinecap="round"
          />
        )}
      </svg>
      <div className="absolute inset-0 flex items-center justify-center text-[9px] font-black text-ink tabular-nums leading-none">
        {assigned}<span className="opacity-40">/{total}</span>
      </div>
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────────
// Data source row — shared between workspace & ontology modes
// ───────────────────────────────────────────────────────────────────────
function DataSourceRow({
  entry, isSelected, onToggleSelect, viewCount, isDrift, isAssigning,
  onRowClick, onNavigateToOntology, onSuggest, onUnassign, onNavigateSchemaTab,
}: {
  entry: DeploymentEntry
  isSelected: boolean
  onToggleSelect: () => void
  viewCount: number
  isDrift: boolean
  isAssigning: boolean
  onRowClick: () => void
  onNavigateToOntology: (ontId: string) => void
  onSuggest: (wsId: string, dsId: string) => void
  onUnassign: (wsId: string, dsId: string) => void
  onNavigateSchemaTab: (ontId: string, tab: 'adoption' | 'history') => void
}) {
  const style = entry.ontologyStatus ? STATUS_STYLES[entry.ontologyStatus] : null
  const StatusIcon = entry.ontologyStatus ? STATUS_ICON[entry.ontologyStatus] : null
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuOpen])

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onRowClick}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onRowClick()
        }
      }}
      className={cn(
        'flex items-center gap-3 px-5 py-3 transition-colors group cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
        !entry.ontologyId
          ? 'bg-red-50/20 dark:bg-red-950/5 hover:bg-red-50/40 dark:hover:bg-red-950/10'
          : 'hover:bg-black/[0.02] dark:hover:bg-white/[0.02]',
        isSelected && 'bg-accent-lineage/5 hover:bg-accent-lineage/8',
      )}
    >
      {/* Selection checkbox */}
      <button
        onClick={e => { e.stopPropagation(); onToggleSelect() }}
        className={cn(
          'w-4 h-4 rounded border flex items-center justify-center transition-colors flex-shrink-0',
          isSelected
            ? 'bg-accent-lineage border-accent-lineage opacity-100'
            : 'border-ink-muted/40 hover:border-accent-lineage opacity-0 group-hover:opacity-100',
        )}
        title={isSelected ? 'Deselect' : 'Select'}
      >
        {isSelected && <Check className="w-3 h-3 text-white" />}
      </button>

      <Database className={cn('w-4 h-4 flex-shrink-0', entry.ontologyId ? 'text-ink-muted' : 'text-red-400')} />

      <div className="w-[180px] min-w-[120px] flex-shrink-0">
        <p className="text-xs font-semibold text-ink truncate">{entry.dataSourceLabel}</p>
        <p className="text-[10px] text-ink-muted truncate">in {entry.workspaceName}</p>
      </div>

      <ArrowRight className="w-3 h-3 text-ink-muted/30 flex-shrink-0" />

      <div className="flex-1 min-w-0 flex items-center gap-2">
        {entry.ontologyId && style && StatusIcon ? (
          <>
            <button
              onClick={e => { e.stopPropagation(); onNavigateToOntology(entry.ontologyId!) }}
              className="inline-flex items-center gap-2 group/ont"
            >
              <span className={cn(
                'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold border transition-colors',
                style.bg, style.border, style.text, 'group-hover/ont:shadow-sm',
              )}>
                <StatusIcon className="w-3 h-3" />
                {entry.ontologyName}
                <span className="text-[9px] opacity-60 font-medium ml-0.5">v{entry.ontologyVersion}</span>
              </span>
            </button>
            {isDrift && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
                <GitBranch className="w-2.5 h-2.5" /> drift
              </span>
            )}

            <div className="relative" ref={menuRef}>
              <button
                onClick={e => { e.stopPropagation(); setMenuOpen(v => !v) }}
                className={cn(
                  'p-1 rounded-md text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-all',
                  menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                )}
                title="More actions"
              >
                <MoreHorizontal className="w-3.5 h-3.5" />
              </button>
              {menuOpen && (
                <div
                  className="absolute top-full left-0 mt-1 w-48 rounded-xl border border-glass-border bg-canvas-elevated shadow-xl z-20 overflow-hidden ws-bar-in"
                  onClick={e => e.stopPropagation()}
                >
                  <MenuItem
                    icon={ArrowRight}
                    label="Open schema"
                    onClick={() => { setMenuOpen(false); onNavigateToOntology(entry.ontologyId!) }}
                  />
                  <MenuItem
                    icon={Network}
                    label="View adoption"
                    onClick={() => { setMenuOpen(false); onNavigateSchemaTab(entry.ontologyId!, 'adoption') }}
                  />
                  <MenuItem
                    icon={GitBranch}
                    label="View lineage"
                    onClick={() => { setMenuOpen(false); onNavigateSchemaTab(entry.ontologyId!, 'history') }}
                  />
                  <div className="h-px bg-glass-border/50 my-1" />
                  <MenuItem
                    icon={Unlink}
                    label="Unassign"
                    onClick={() => { setMenuOpen(false); onUnassign(entry.workspaceId, entry.dataSourceId) }}
                    danger
                  />
                </div>
              )}
            </div>
          </>
        ) : (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium text-red-500 bg-red-500/5 border border-red-500/10">
            <Unlink className="w-3 h-3" /> No semantic layer assigned
          </span>
        )}
      </div>

      {/* Views pill */}
      <span
        className={cn(
          'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border flex-shrink-0',
          viewCount > 0
            ? 'bg-violet-500/8 text-violet-600 dark:text-violet-400 border-violet-500/15'
            : 'bg-transparent text-ink-muted/50 border-glass-border',
        )}
        title={viewCount > 0 ? `${viewCount} view${viewCount !== 1 ? 's' : ''} using this data source` : 'No views yet'}
      >
        <Eye className="w-2.5 h-2.5" />
        {viewCount > 0 ? `${viewCount} view${viewCount !== 1 ? 's' : ''}` : 'No views'}
      </span>

      {!entry.ontologyId ? (
        <button
          onClick={e => { e.stopPropagation(); onSuggest(entry.workspaceId, entry.dataSourceId) }}
          disabled={isAssigning}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[10px] font-semibold bg-indigo-500 text-white hover:bg-indigo-600 transition-colors flex-shrink-0 disabled:opacity-50 shadow-sm shadow-indigo-500/20"
        >
          <Sparkles className="w-3 h-3" /> Suggest
        </button>
      ) : (
        <button
          onClick={e => { e.stopPropagation(); onUnassign(entry.workspaceId, entry.dataSourceId) }}
          disabled={isAssigning}
          className="flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-medium text-ink-muted hover:text-red-500 hover:bg-red-500/5 transition-all flex-shrink-0 opacity-0 group-hover:opacity-100 disabled:opacity-50"
          title="Unassign"
        >
          <Unlink className="w-3 h-3" />
        </button>
      )}
    </div>
  )
}

function MenuItem({
  icon: Icon, label, onClick, danger,
}: { icon: React.ComponentType<{ className?: string }>; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-2 px-3 py-2 text-left text-xs font-medium transition-colors',
        danger
          ? 'text-red-500 hover:bg-red-500/10'
          : 'text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04]',
      )}
    >
      <Icon className="w-3.5 h-3.5" />
      {label}
    </button>
  )
}

// ───────────────────────────────────────────────────────────────────────
// By-Ontology group card
// ───────────────────────────────────────────────────────────────────────
function OntologyGroupCard({
  group, index, viewCounts, driftKeys, selectedKeys, onToggleSelect,
  onNavigateToOntology, onRowClick, onSuggest, onUnassign, onNavigateSchemaTab, keyOf, isAssigning,
}: {
  group: {
    ontology: OntologyDefinitionResponse | null
    key: string
    entries: DeploymentEntry[]
  }
  index: number
  viewCounts: Record<string, number>
  driftKeys: Set<string>
  selectedKeys: Set<string>
  onToggleSelect: (e: DeploymentEntry) => void
  onNavigateToOntology: (ontId: string) => void
  onRowClick: (wsId: string, dsId: string) => void
  onSuggest: (wsId: string, dsId: string) => void
  onUnassign: (wsId: string, dsId: string) => void
  onNavigateSchemaTab: (ontId: string, tab: 'adoption' | 'history') => void
  keyOf: (e: DeploymentEntry) => string
  isAssigning: boolean
}) {
  const isUnassigned = group.key === '__unassigned__'
  const ont = group.ontology
  const status: 'system' | 'published' | 'draft' | null = ont
    ? (ont.isSystem ? 'system' : ont.isPublished ? 'published' : 'draft')
    : null
  const style = status ? STATUS_STYLES[status] : null
  const StatusIcon = status ? STATUS_ICON[status] : null
  const versions = [...new Set(group.entries.map(e => e.ontologyVersion).filter(Boolean))]
  const hasDrift = versions.length > 1

  return (
    <div
      className="ws-group-stagger rounded-2xl border border-glass-border bg-canvas-elevated overflow-hidden"
      style={{ animationDelay: `${Math.min(index * 40, 300)}ms` }}
    >
      <div className={cn(
        'h-1 w-full',
        isUnassigned ? 'bg-red-500/60' : status === 'draft' ? 'bg-amber-500/80' : status === 'system' ? 'bg-indigo-500/80' : 'bg-emerald-500/80',
      )} />
      <div className="flex items-center gap-4 px-5 py-4 border-b border-glass-border/40 bg-gradient-to-r from-canvas-elevated/80 to-transparent">
        <div className={cn(
          'w-10 h-10 rounded-xl border flex items-center justify-center flex-shrink-0',
          isUnassigned ? 'bg-red-500/10 border-red-500/20 text-red-500' : style
            ? cn(style.bg, style.border, style.text)
            : 'bg-glass-border/30',
        )}>
          {isUnassigned ? <Unlink className="w-5 h-5" /> : StatusIcon ? <StatusIcon className="w-5 h-5" /> : <Layers className="w-5 h-5" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-bold text-ink truncate">
              {isUnassigned ? 'Unassigned data sources' : ont?.name ?? group.key}
            </p>
            {!isUnassigned && ont && (
              <span className="text-[10px] text-ink-muted font-mono">v{ont.version}</span>
            )}
            {hasDrift && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
                <GitBranch className="w-2.5 h-2.5" /> {versions.length} versions live
              </span>
            )}
          </div>
          <p className="text-[11px] text-ink-muted mt-0.5">
            {group.entries.length} data source{group.entries.length !== 1 ? 's' : ''}
            {!isUnassigned && ont?.description && ` · ${ont.description}`}
          </p>
        </div>
        {!isUnassigned && ont && (
          <button
            onClick={() => onNavigateToOntology(ont.id)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border border-glass-border text-ink-secondary hover:text-accent-lineage hover:border-accent-lineage/40 hover:bg-accent-lineage/[0.04] transition-all"
          >
            Open schema
            <ArrowRight className="w-3 h-3" />
          </button>
        )}
      </div>

      <div className="divide-y divide-glass-border/30">
        {group.entries.map(entry => (
          <DataSourceRow
            key={`${entry.workspaceId}:${entry.dataSourceId}`}
            entry={entry}
            isSelected={selectedKeys.has(keyOf(entry))}
            onToggleSelect={() => onToggleSelect(entry)}
            viewCount={viewCounts[entry.dataSourceId] ?? 0}
            isDrift={driftKeys.has(`${entry.workspaceId}:${entry.dataSourceId}`)}
            isAssigning={isAssigning}
            onRowClick={() => onRowClick(entry.workspaceId, entry.dataSourceId)}
            onNavigateToOntology={onNavigateToOntology}
            onSuggest={onSuggest}
            onUnassign={onUnassign}
            onNavigateSchemaTab={onNavigateSchemaTab}
          />
        ))}
      </div>
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────────
// Coverage Matrix — workspaces × ontologies grid
// ───────────────────────────────────────────────────────────────────────
function CoverageMatrix({
  workspaces, ontologies, entries, onCellClick,
}: {
  workspaces: WorkspaceResponse[]
  ontologies: OntologyDefinitionResponse[]
  entries: DeploymentEntry[]
  onCellClick: (ontId: string, wsId: string) => void
}) {
  // Build lookup: wsId -> ontId -> count
  const cellMap = useMemo(() => {
    const m = new Map<string, Map<string, DeploymentEntry[]>>()
    for (const e of entries) {
      if (!e.ontologyId) continue
      let byOnt = m.get(e.workspaceId)
      if (!byOnt) { byOnt = new Map(); m.set(e.workspaceId, byOnt) }
      const list = byOnt.get(e.ontologyId) ?? []
      list.push(e)
      byOnt.set(e.ontologyId, list)
    }
    return m
  }, [entries])

  const orphansByWs = useMemo(() => {
    const m = new Map<string, number>()
    for (const e of entries) if (!e.ontologyId) m.set(e.workspaceId, (m.get(e.workspaceId) ?? 0) + 1)
    return m
  }, [entries])

  const activeWs = workspaces.filter(w =>
    entries.some(e => e.workspaceId === w.id),
  )
  const activeOnts = ontologies.filter(o =>
    entries.some(e => e.ontologyId === o.id),
  )

  if (activeWs.length === 0 || activeOnts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 border-2 border-dashed border-glass-border rounded-2xl">
        <Grid3x3 className="w-8 h-8 text-ink-muted mb-3" />
        <p className="text-sm font-semibold text-ink mb-1">Not enough data for the matrix</p>
        <p className="text-xs text-ink-muted">Assign a few ontologies to see coverage.</p>
      </div>
    )
  }

  return (
    <div className="rounded-2xl border border-glass-border bg-canvas-elevated overflow-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-canvas-elevated/80">
            <th className="sticky left-0 z-10 bg-canvas-elevated text-left text-[10px] font-bold text-ink-muted uppercase tracking-wider px-4 py-3 border-b border-r border-glass-border/50">
              Workspace
            </th>
            {activeOnts.map(o => {
              const status: 'system' | 'published' | 'draft' =
                o.isSystem ? 'system' : o.isPublished ? 'published' : 'draft'
              return (
                <th key={o.id} className="text-left text-[10px] font-bold text-ink px-3 py-3 border-b border-glass-border/50 min-w-[120px]">
                  <div className="flex items-center gap-1.5">
                    <span className={cn('w-2 h-2 rounded-full', STATUS_STYLES[status].dot)} />
                    <span className="truncate">{o.name}</span>
                    <span className="text-[9px] opacity-50">v{o.version}</span>
                  </div>
                </th>
              )
            })}
            <th className="text-left text-[10px] font-bold text-red-500 uppercase tracking-wider px-3 py-3 border-b border-l border-glass-border/50 min-w-[100px]">
              Unassigned
            </th>
          </tr>
        </thead>
        <tbody>
          {activeWs.map(ws => {
            const byOnt = cellMap.get(ws.id)
            const orphanCount = orphansByWs.get(ws.id) ?? 0
            const palette = paletteForWorkspace(ws.id)
            return (
              <tr key={ws.id} className="hover:bg-black/[0.02] dark:hover:bg-white/[0.02]">
                <td className="sticky left-0 z-10 bg-canvas-elevated text-xs font-semibold text-ink px-4 py-3 border-r border-glass-border/50">
                  <div className="flex items-center gap-2">
                    <span className={cn('w-2 h-2 rounded-full', palette.accent)} />
                    <span className="truncate">{ws.name}</span>
                  </div>
                </td>
                {activeOnts.map(o => {
                  const cell = byOnt?.get(o.id)
                  const count = cell?.length ?? 0
                  const status: 'system' | 'published' | 'draft' =
                    o.isSystem ? 'system' : o.isPublished ? 'published' : 'draft'
                  return (
                    <td key={o.id} className="px-3 py-2 border-b border-glass-border/30">
                      {count > 0 ? (
                        <button
                          onClick={() => onCellClick(o.id, ws.id)}
                          className={cn(
                            'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold border transition-all hover:shadow-sm hover:-translate-y-0.5',
                            STATUS_STYLES[status].bg, STATUS_STYLES[status].border, STATUS_STYLES[status].text,
                          )}
                          title={`${count} data source${count !== 1 ? 's' : ''} in ${ws.name} using ${o.name}`}
                        >
                          <CircleDot className="w-3 h-3" />
                          {count}
                        </button>
                      ) : (
                        <span className="inline-block w-5 h-5 rounded-full border border-dashed border-ink-muted/20" title="Not used" />
                      )}
                    </td>
                  )
                })}
                <td className="px-3 py-2 border-l border-glass-border/50 border-b border-glass-border/30">
                  {orphanCount > 0 ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20">
                      <AlertTriangle className="w-2.5 h-2.5" />
                      {orphanCount}
                    </span>
                  ) : (
                    <span className="inline-block w-5 h-5 rounded-full border border-dashed border-ink-muted/20" />
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────────
// Bulk selection bar
// ───────────────────────────────────────────────────────────────────────
function BulkSelectionBar({
  count, onClear, onSuggest, onUnassign, isAssigning,
}: {
  count: number
  onClear: () => void
  onSuggest: () => void
  onUnassign: () => void
  isAssigning: boolean
}) {
  if (count === 0) return null
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 ws-bar-in">
      <div className="flex items-center gap-3 px-5 py-3 bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-glass-border">
        <span className="text-sm font-semibold text-ink">
          {count} data source{count !== 1 ? 's' : ''} selected
        </span>
        <div className="w-px h-5 bg-glass-border" />
        <button
          onClick={onSuggest}
          disabled={isAssigning}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-semibold bg-indigo-500 text-white hover:bg-indigo-600 transition-colors disabled:opacity-50 shadow-sm shadow-indigo-500/20"
        >
          <Sparkles className="w-3.5 h-3.5" />
          Suggest for all
        </button>
        <button
          onClick={onUnassign}
          disabled={isAssigning}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-medium text-red-500 hover:bg-red-500/10 transition-all disabled:opacity-50"
        >
          <Trash2 className="w-3.5 h-3.5" />
          Unassign
        </button>
        <div className="w-px h-5 bg-glass-border" />
        <button
          onClick={onClear}
          className="p-1.5 rounded-xl text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-all"
          title="Clear selection"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────────
// Skeletons
// ───────────────────────────────────────────────────────────────────────
function SummaryBannerSkeleton() {
  return (
    <div className="rounded-2xl border border-glass-border bg-canvas-elevated overflow-hidden mb-6">
      <div className="h-1 w-full bg-gradient-to-r from-indigo-500 via-violet-500 to-cyan-500 opacity-30" />
      <div className="p-5 flex flex-wrap items-center gap-x-8 gap-y-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl ws-skeleton" />
            <div className="space-y-1.5">
              <div className="w-10 h-4 ws-skeleton rounded" />
              <div className="w-20 h-2.5 ws-skeleton rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function WorkspaceGroupSkeleton() {
  return (
    <div className="rounded-2xl border border-glass-border bg-canvas-elevated overflow-hidden">
      <div className="h-1 w-full ws-skeleton opacity-40" />
      <div className="flex items-center gap-3 px-5 py-4">
        <div className="w-9 h-9 rounded-full ws-skeleton" />
        <div className="flex-1 space-y-2">
          <div className="w-40 h-3.5 ws-skeleton rounded" />
          <div className="w-20 h-2.5 ws-skeleton rounded" />
        </div>
        <div className="w-24 h-6 ws-skeleton rounded-full" />
      </div>
      <div className="divide-y divide-glass-border/30">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-5 py-3">
            <div className="w-4 h-4 ws-skeleton rounded" />
            <div className="w-40 h-3 ws-skeleton rounded" />
            <div className="flex-1" />
            <div className="w-20 h-5 ws-skeleton rounded-lg" />
          </div>
        ))}
      </div>
    </div>
  )
}
