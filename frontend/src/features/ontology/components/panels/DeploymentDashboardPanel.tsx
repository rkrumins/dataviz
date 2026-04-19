/**
 * DeploymentDashboardPanel — global cross-workspace deployment view.
 *
 * UI aligned with WorkspacesPage summary banner + ExplorerPage search patterns.
 * Collapsible workspace sections with inline stat pills.
 */
import { useState, useMemo, useRef } from 'react'
import {
  Database, Layers, AlertTriangle, ArrowRight, Search,
  Shield, CheckCircle2, PenLine, Unlink, Sparkles,
  GitBranch, ChevronDown, ChevronRight, X,
  Plus, BookOpen, Eye,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { WorkspaceResponse } from '@/services/workspaceService'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import { useDeploymentMatrix } from '../../hooks/useDeploymentMatrix'
import type { DeploymentEntry } from '../../lib/ontology-types'
// EducationalCallout replaced by inline hero section for the landing page

// ---------------------------------------------------------------------------
// Stagger CSS (matches ExplorerPage / WorkspacesPage pattern)
// ---------------------------------------------------------------------------

const STAGGER_STYLE = `
@keyframes ws-group-in {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
}
.ws-group-stagger { animation: ws-group-in 0.3s ease-out both; }
`

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

const STATUS_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  system: Shield, published: CheckCircle2, draft: PenLine,
}

const STATUS_STYLES: Record<string, { text: string; bg: string; border: string }> = {
  system: { text: 'text-indigo-600 dark:text-indigo-400', bg: 'bg-indigo-500/10', border: 'border-indigo-500/20' },
  published: { text: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20' },
  draft: { text: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-500/10', border: 'border-amber-500/20' },
}

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
}: DeploymentDashboardPanelProps) {
  const { entries, orphans, versionMismatches, stats } = useDeploymentMatrix(workspaces, ontologies)
  const [search, setSearch] = useState('')
  const [searchFocused, setSearchFocused] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const [collapsedWs, setCollapsedWs] = useState<Set<string>>(() =>
    workspaces.length <= 5 ? new Set() : new Set(workspaces.map(w => w.id)),
  )

  const statusCounts = useMemo(() => {
    const counts = { system: 0, published: 0, draft: 0 }
    for (const o of ontologies) {
      if (o.isSystem) counts.system++
      else if (o.isPublished) counts.published++
      else counts.draft++
    }
    return counts
  }, [ontologies])

  const groupedByWorkspace = useMemo(() => {
    const map = new Map<string, { workspace: WorkspaceResponse; entries: DeploymentEntry[] }>()
    for (const entry of entries) {
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
  }, [entries, workspaces])

  const filteredGroups = useMemo(() => {
    if (!search.trim()) return groupedByWorkspace
    const q = search.toLowerCase()
    return groupedByWorkspace
      .map(g => ({
        ...g,
        entries: g.entries.filter(e =>
          e.dataSourceLabel.toLowerCase().includes(q) ||
          e.workspaceName.toLowerCase().includes(q) ||
          e.ontologyName?.toLowerCase().includes(q),
        ),
      }))
      .filter(g => g.entries.length > 0)
  }, [groupedByWorkspace, search])

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

          {/* Primary CTAs */}
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

        {/* How it works — 3-step guide */}
        {ontologies.length <= 5 && (
          <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-3">
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
        )}

        {/* Why it matters — impact explanation */}
        {ontologies.length <= 5 && (
          <div className="mt-4 rounded-2xl border border-glass-border bg-canvas-elevated overflow-hidden">
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
        )}
      </div>

      {/* ── Summary banner (WorkspacesPage pattern: horizontal stats + gradient bar) ─── */}
      {entries.length > 0 && (
        <div className="rounded-2xl border border-glass-border bg-canvas-elevated overflow-hidden mb-6">
          <div className="h-1 w-full bg-gradient-to-r from-indigo-500 via-violet-500 to-cyan-500" />
          <div className="p-5">
            <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center">
                  <Layers className="w-5 h-5 text-indigo-500" />
                </div>
                <div>
                  <div className="text-lg font-bold text-ink">{stats.ontologyCount}</div>
                  <div className="text-[10px] text-ink-muted uppercase tracking-wider">Semantic Layers</div>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-sky-500/10 border border-sky-500/20 flex items-center justify-center">
                  <Database className="w-5 h-5 text-sky-500" />
                </div>
                <div>
                  <div className="text-lg font-bold text-ink">{stats.totalDs}</div>
                  <div className="text-[10px] text-ink-muted uppercase tracking-wider">Data Sources</div>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <div className={cn('w-10 h-10 rounded-xl border flex items-center justify-center',
                  stats.orphanDs > 0 ? 'bg-red-500/10 border-red-500/20' : 'bg-emerald-500/10 border-emerald-500/20')}>
                  {stats.orphanDs > 0
                    ? <AlertTriangle className="w-5 h-5 text-red-500" />
                    : <CheckCircle2 className="w-5 h-5 text-emerald-500" />}
                </div>
                <div>
                  <div className="text-lg font-bold text-ink">{stats.orphanDs}</div>
                  <div className="text-[10px] text-ink-muted uppercase tracking-wider">Unassigned</div>
                </div>
              </div>

              {versionMismatches.length > 0 && (
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
                    <GitBranch className="w-5 h-5 text-amber-500" />
                  </div>
                  <div>
                    <div className="text-lg font-bold text-ink">{versionMismatches.length}</div>
                    <div className="text-[10px] text-ink-muted uppercase tracking-wider">Version Mismatches</div>
                  </div>
                </div>
              )}

              {/* Separator + ontology status breakdown */}
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

            {/* Tagline (WorkspacesPage pattern) */}
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

      {/* ── Orphan Alert ─────────────────────────────────────────────── */}
      {orphans.length > 0 && (
        <div className="mb-6 p-5 rounded-2xl border border-red-200/60 dark:border-red-800/40 bg-red-50/30 dark:bg-red-950/10">
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle className="w-4 h-4 text-red-500" />
            <h3 className="text-sm font-bold text-red-700 dark:text-red-300">
              {orphans.length} Data Source{orphans.length !== 1 ? 's' : ''} Without a Semantic Layer
            </h3>
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
                +{orphans.length - 6} more — scroll workspace sections below
              </p>
            )}
          </div>
        </div>
      )}

      {/* ── Version Mismatches ────────────────────────────────────────── */}
      {versionMismatches.length > 0 && (
        <div className="mb-6 p-5 rounded-2xl border border-amber-200/60 dark:border-amber-800/40 bg-amber-50/30 dark:bg-amber-950/10">
          <div className="flex items-center gap-2 mb-3">
            <GitBranch className="w-4 h-4 text-amber-500" />
            <h3 className="text-sm font-bold text-amber-700 dark:text-amber-300">Version Mismatches Detected</h3>
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

      {/* ── Search + controls toolbar (ExplorerPage pattern) ──────────── */}
      <div className="flex items-center gap-3 mb-5">
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

        {workspaces.length > 1 && (
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

      {/* ── Section header ───────────────────────────────────────────── */}
      <div className="flex items-center gap-2 mb-4">
        <div className="w-7 h-7 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center">
          <Layers className="w-3.5 h-3.5 text-indigo-500" />
        </div>
        <h2 className="text-sm font-bold text-ink">Deployment by Workspace</h2>
        <span className="text-[11px] text-ink-muted">{filteredGroups.length} workspace{filteredGroups.length !== 1 ? 's' : ''}</span>
      </div>

      {/* ── Workspace groups with stagger ────────────────────────────── */}
      <div className="space-y-3">
        {filteredGroups.map(({ workspace, entries: wsEntries }, groupIdx) => {
          const wsOrphans = wsEntries.filter(e => !e.ontologyId).length
          const wsAssigned = wsEntries.length - wsOrphans
          const wsOntologies = uniqueOntologyCount(wsEntries)
          const isCollapsed = collapsedWs.has(workspace.id)

          return (
            <div
              key={workspace.id}
              className="ws-group-stagger rounded-2xl border border-glass-border bg-canvas-elevated overflow-hidden"
              style={{ animationDelay: `${Math.min(groupIdx * 40, 300)}ms` }}
            >
              {/* Workspace header */}
              <button
                type="button"
                onClick={() => toggleWorkspace(workspace.id)}
                className={cn(
                  'w-full flex items-center gap-3 px-5 py-3.5 text-left transition-colors',
                  isCollapsed
                    ? 'hover:bg-black/[0.02] dark:hover:bg-white/[0.02]'
                    : 'border-b border-glass-border/40 bg-gradient-to-r from-canvas-elevated/80 to-transparent',
                )}
              >
                {isCollapsed
                  ? <ChevronRight className="w-4 h-4 text-ink-muted flex-shrink-0" />
                  : <ChevronDown className="w-4 h-4 text-ink-muted flex-shrink-0" />}

                <div className="w-8 h-8 rounded-lg bg-indigo-500/10 flex items-center justify-center flex-shrink-0">
                  <Layers className="w-4 h-4 text-indigo-500" />
                </div>

                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-ink">{workspace.name}</p>
                </div>

                {/* Inline stat pills — always visible */}
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-semibold border bg-sky-500/8 text-sky-600 dark:text-sky-400 border-sky-500/15">
                    {wsEntries.length} <span className="font-normal opacity-70">total</span>
                  </span>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-semibold border bg-emerald-500/8 text-emerald-600 dark:text-emerald-400 border-emerald-500/15">
                    {wsAssigned} <span className="font-normal opacity-70">assigned</span>
                  </span>
                  {wsOrphans > 0 && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-semibold border bg-red-500/8 text-red-600 dark:text-red-400 border-red-500/15">
                      {wsOrphans} <span className="font-normal opacity-70">unassigned</span>
                    </span>
                  )}
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-semibold border bg-indigo-500/8 text-indigo-600 dark:text-indigo-400 border-indigo-500/15">
                    {wsOntologies} <span className="font-normal opacity-70">{wsOntologies === 1 ? 'ontology' : 'ontologies'}</span>
                  </span>
                </div>
              </button>

              {/* Data source rows */}
              {!isCollapsed && (
                <div className="divide-y divide-glass-border/30">
                  {wsEntries.map(entry => {
                    const style = entry.ontologyStatus ? STATUS_STYLES[entry.ontologyStatus] : null
                    const StatusIcon = entry.ontologyStatus ? STATUS_ICON[entry.ontologyStatus] : null

                    return (
                      <div key={entry.dataSourceId}
                        className={cn(
                          'flex items-center gap-4 px-5 py-3 transition-colors group',
                          !entry.ontologyId
                            ? 'bg-red-50/20 dark:bg-red-950/5'
                            : 'hover:bg-black/[0.015] dark:hover:bg-white/[0.015]',
                        )}>
                        <Database className={cn('w-4 h-4 flex-shrink-0', entry.ontologyId ? 'text-ink-muted' : 'text-red-400')} />
                        <div className="w-[180px] min-w-[120px] flex-shrink-0">
                          <p className="text-xs font-semibold text-ink truncate">{entry.dataSourceLabel}</p>
                        </div>

                        <ArrowRight className="w-3 h-3 text-ink-muted/30 flex-shrink-0" />

                        <div className="flex-1 min-w-0">
                          {entry.ontologyId && style && StatusIcon ? (
                            <button onClick={() => onNavigateToOntology(entry.ontologyId!)} className="inline-flex items-center gap-2 group/ont">
                              <span className={cn(
                                'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold border transition-colors',
                                style.bg, style.border, style.text, 'group-hover/ont:shadow-sm',
                              )}>
                                <StatusIcon className="w-3 h-3" />
                                {entry.ontologyName}
                                <span className="text-[9px] opacity-60 font-medium ml-0.5">v{entry.ontologyVersion}</span>
                              </span>
                              <ArrowRight className="w-3 h-3 text-ink-muted opacity-0 group-hover/ont:opacity-100 transition-opacity" />
                            </button>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium text-red-500 bg-red-500/5 border border-red-500/10">
                              <Unlink className="w-3 h-3" /> No semantic layer assigned
                            </span>
                          )}
                        </div>

                        {!entry.ontologyId ? (
                          <button onClick={() => onSuggest(entry.workspaceId, entry.dataSourceId)} disabled={isAssigning}
                            className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[10px] font-semibold bg-indigo-500 text-white hover:bg-indigo-600 transition-colors flex-shrink-0 disabled:opacity-50 shadow-sm shadow-indigo-500/20">
                            <Sparkles className="w-3 h-3" /> Suggest
                          </button>
                        ) : (
                          <button onClick={() => onUnassign(entry.workspaceId, entry.dataSourceId)} disabled={isAssigning}
                            className="flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-medium text-ink-muted hover:text-red-500 hover:bg-red-500/5 transition-all flex-shrink-0 opacity-0 group-hover:opacity-100 disabled:opacity-50"
                            title="Unassign">
                            <Unlink className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Empty state */}
      {entries.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 border-2 border-dashed border-glass-border rounded-2xl">
          <Database className="w-12 h-12 text-ink-muted mb-4" />
          <h3 className="text-lg font-bold text-ink mb-1">No data sources found</h3>
          <p className="text-sm text-ink-muted">Create a workspace and add data sources to get started.</p>
        </div>
      )}
    </div>
  )
}
