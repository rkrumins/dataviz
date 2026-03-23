/**
 * UsagePanel — shows which workspaces, data sources, and views use this ontology.
 * Groups assignments by workspace so the hierarchy is crystal clear.
 * Also fetches and displays impacted views per data source.
 * Supports assigning/unassigning directly from this panel.
 */
import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Layers, Database, Loader2, Unlink, ExternalLink, ChevronDown, Box, GitBranch, Eye, FileText, Plus, X, Search, AlertTriangle } from 'lucide-react'
import * as Popover from '@radix-ui/react-popover'
import { cn } from '@/lib/utils'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import type { WorkspaceResponse } from '@/services/workspaceService'
import { workspaceService } from '@/services/workspaceService'
import { listViews, type View } from '@/services/viewApiService'
import { useOntologyAssignments } from '../../hooks/useOntologies'
import { useWorkspacesStore } from '@/store/workspaces'

interface ConfirmTarget {
  workspaceId: string
  workspaceName: string
  dataSourceId: string
  dataSourceLabel: string
  currentOntologyName: string
  viewCount: number | null
}

interface UsagePanelProps {
  ontology: OntologyDefinitionResponse
  workspaces: WorkspaceResponse[]
  ontologies: OntologyDefinitionResponse[]
}

export function UsagePanel({ ontology, workspaces, ontologies }: UsagePanelProps) {
  const { data: assignments, isLoading, refetch: refetchAssignments } = useOntologyAssignments(ontology.id)
  const navigate = useNavigate()
  const loadWorkspaces = useWorkspacesStore(s => s.loadWorkspaces)

  // Assign/unassign state
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [assignOpen, setAssignOpen] = useState(false)
  const [assignSearch, setAssignSearch] = useState('')
  const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget | null>(null)
  const [loadingImpact, setLoadingImpact] = useState(false)

  // Fetch views for all assigned workspaces (not filtered by data source —
  // views belong to the workspace and use whichever data source is active,
  // matching how SidebarNav shows all views in the current workspace).
  const [viewsByWs, setViewsByWs] = useState<Record<string, View[]>>({})
  const [loadingViews, setLoadingViews] = useState(false)

  useEffect(() => {
    if (!assignments || assignments.length === 0) {
      setViewsByWs({})
      return
    }

    let cancelled = false
    setLoadingViews(true)

    // Deduplicate by workspace — multiple data sources in same workspace
    // should only trigger one fetch
    const uniqueWorkspaces = [...new Map(
      assignments.map(a => [a.workspaceId, a])
    ).values()]

    Promise.all(
      uniqueWorkspaces.map(async (a) => {
        try {
          const views = await listViews({ workspaceId: a.workspaceId })
          return { wsId: a.workspaceId, views }
        } catch {
          return { wsId: a.workspaceId, views: [] as View[] }
        }
      })
    ).then(results => {
      if (cancelled) return
      const map: Record<string, View[]> = {}
      for (const r of results) map[r.wsId] = r.views
      setViewsByWs(map)
      setLoadingViews(false)
    })

    return () => { cancelled = true }
  }, [assignments])

  // Group assignments by workspace, include views at workspace level
  const workspaceGroups = useMemo(() => {
    if (!assignments) return []
    const map = new Map<string, {
      workspaceId: string
      workspaceName: string
      dataSources: Array<{ id: string; label: string }>
      views: View[]
    }>()
    for (const a of assignments) {
      let group = map.get(a.workspaceId)
      if (!group) {
        group = {
          workspaceId: a.workspaceId,
          workspaceName: a.workspaceName,
          dataSources: [],
          views: viewsByWs[a.workspaceId] ?? [],
        }
        map.set(a.workspaceId, group)
      }
      group.dataSources.push({
        id: a.dataSourceId,
        label: a.dataSourceLabel,
      })
    }
    return Array.from(map.values())
  }, [assignments, viewsByWs])

  // Build ontology name lookup
  const ontologyNameMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const o of ontologies) map.set(o.id, o.name)
    return map
  }, [ontologies])

  // Unassigned data sources (not using this ontology) — includes info about current ontology
  const unassignedDataSources = useMemo(() => {
    const assignedIds = new Set(assignments?.map(a => a.dataSourceId) ?? [])
    const results: Array<{
      workspaceId: string
      workspaceName: string
      dataSourceId: string
      dataSourceLabel: string
      currentOntologyId?: string
    }> = []
    for (const ws of workspaces) {
      for (const ds of ws.dataSources ?? []) {
        if (!assignedIds.has(ds.id)) {
          results.push({
            workspaceId: ws.id,
            workspaceName: ws.name,
            dataSourceId: ds.id,
            dataSourceLabel: ds.label || ds.id,
            currentOntologyId: ds.ontologyId,
          })
        }
      }
    }
    return results
  }, [workspaces, assignments])

  const filteredUnassigned = useMemo(() => {
    if (!assignSearch) return unassignedDataSources
    const q = assignSearch.toLowerCase()
    return unassignedDataSources.filter(ds =>
      ds.dataSourceLabel.toLowerCase().includes(q) ||
      ds.workspaceName.toLowerCase().includes(q)
    )
  }, [unassignedDataSources, assignSearch])

  // Initiate assign — checks for existing ontology and shows confirmation if needed
  async function initiateAssign(ds: typeof unassignedDataSources[number]) {
    if (ds.currentOntologyId) {
      // Data source already has an ontology — show confirmation with impact
      setLoadingImpact(true)
      setAssignOpen(false)

      let viewCountForDs: number | null = null
      try {
        const views = await listViews({ workspaceId: ds.workspaceId })
        viewCountForDs = views.length
      } catch {
        viewCountForDs = null
      }

      setConfirmTarget({
        workspaceId: ds.workspaceId,
        workspaceName: ds.workspaceName,
        dataSourceId: ds.dataSourceId,
        dataSourceLabel: ds.dataSourceLabel,
        currentOntologyName: ontologyNameMap.get(ds.currentOntologyId!) ?? ds.currentOntologyId!,
        viewCount: viewCountForDs,
      })
      setLoadingImpact(false)
    } else {
      // No existing ontology — assign directly
      await executeAssign(ds.workspaceId, ds.dataSourceId)
    }
  }

  async function executeAssign(wsId: string, dsId: string) {
    setActionLoading(dsId)
    try {
      await workspaceService.updateDataSource(wsId, dsId, { ontologyId: ontology.id })
      await Promise.all([loadWorkspaces(), refetchAssignments()])
      setAssignOpen(false)
      setAssignSearch('')
      setConfirmTarget(null)
    } catch {
      // silently fail — user will see the state didn't change
    } finally {
      setActionLoading(null)
    }
  }

  async function handleUnassign(wsId: string, dsId: string) {
    setActionLoading(dsId)
    try {
      await workspaceService.updateDataSource(wsId, dsId, { ontologyId: '' })
      await Promise.all([loadWorkspaces(), refetchAssignments()])
    } catch {
      // silently fail
    } finally {
      setActionLoading(null)
    }
  }

  const totalDataSources = assignments?.length ?? 0
  const totalWorkspaces = workspaceGroups.length
  const totalViews = Object.values(viewsByWs).reduce((sum, views) => sum + views.length, 0)
  const entityCount = Object.keys(ontology.entityTypeDefinitions ?? {}).length
  const relCount = Object.keys(ontology.relationshipTypeDefinitions ?? {}).length

  return (
    <div className="space-y-6">
      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <div className="border border-glass-border rounded-xl p-4 bg-canvas-elevated/50">
          <div className="flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5 text-rose-500" />
            <span className="text-2xl font-bold text-ink">{totalWorkspaces}</span>
          </div>
          <div className="text-[11px] text-ink-muted mt-0.5">Workspaces</div>
        </div>
        <div className="border border-glass-border rounded-xl p-4 bg-canvas-elevated/50">
          <div className="flex items-center gap-1.5">
            <Database className="w-3.5 h-3.5 text-amber-500" />
            <span className="text-2xl font-bold text-ink">{totalDataSources}</span>
          </div>
          <div className="text-[11px] text-ink-muted mt-0.5">Data Sources</div>
        </div>
        <div className="border border-glass-border rounded-xl p-4 bg-canvas-elevated/50">
          <div className="flex items-center gap-1.5">
            <Eye className="w-3.5 h-3.5 text-indigo-500" />
            <span className="text-2xl font-bold text-ink">{loadingViews ? '—' : totalViews}</span>
          </div>
          <div className="text-[11px] text-ink-muted mt-0.5">Views</div>
        </div>
        <div className="border border-glass-border rounded-xl p-4 bg-canvas-elevated/50">
          <div className="flex items-center gap-1.5">
            <Box className="w-3.5 h-3.5 text-indigo-500" />
            <span className="text-2xl font-bold text-ink">{entityCount}</span>
          </div>
          <div className="text-[11px] text-ink-muted mt-0.5">Entity Types</div>
        </div>
        <div className="border border-glass-border rounded-xl p-4 bg-canvas-elevated/50">
          <div className="flex items-center gap-1.5">
            <GitBranch className="w-3.5 h-3.5 text-indigo-500" />
            <span className="text-2xl font-bold text-ink">{relCount}</span>
          </div>
          <div className="text-[11px] text-ink-muted mt-0.5">Relationship Types</div>
        </div>
      </div>

      {/* Assignments by workspace */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wider flex items-center gap-2">
            <Layers className="w-3.5 h-3.5" />
            Assigned Workspaces, Data Sources &amp; Views
            {assignments && (
              <span className="px-2 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-900/50 text-indigo-600 dark:text-indigo-400 text-[10px] font-bold">
                {totalWorkspaces} workspace{totalWorkspaces !== 1 ? 's' : ''} · {totalDataSources} source{totalDataSources !== 1 ? 's' : ''} · {loadingViews ? '...' : totalViews} view{totalViews !== 1 ? 's' : ''}
              </span>
            )}
          </h3>

          {/* Assign button */}
          <Popover.Root open={assignOpen} onOpenChange={(open) => { setAssignOpen(open); if (!open) setAssignSearch('') }}>
            <Popover.Trigger asChild>
              <button
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/[0.06] transition-all"
              >
                <Plus className="w-3.5 h-3.5" />
                Assign
              </button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content
                side="bottom"
                align="end"
                sideOffset={6}
                className="w-[360px] bg-white dark:bg-gray-900 rounded-xl border border-glass-border shadow-xl z-50 overflow-hidden animate-in fade-in slide-in-from-top-1 duration-150"
              >
                {/* Search */}
                <div className="p-3 border-b border-glass-border/50">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted/50" />
                    <input
                      type="text"
                      value={assignSearch}
                      onChange={e => setAssignSearch(e.target.value)}
                      placeholder="Search data sources..."
                      className="w-full pl-9 pr-3 py-2 rounded-lg bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border/50 text-xs text-ink placeholder:text-ink-muted/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
                      autoFocus
                    />
                  </div>
                </div>

                {/* List */}
                <div className="max-h-64 overflow-y-auto p-2">
                  {filteredUnassigned.length === 0 ? (
                    <div className="text-center py-6">
                      <p className="text-xs text-ink-muted">
                        {unassignedDataSources.length === 0
                          ? 'All data sources are already assigned'
                          : 'No matching data sources'}
                      </p>
                    </div>
                  ) : (
                    filteredUnassigned.map(ds => (
                      <button
                        key={`${ds.workspaceId}-${ds.dataSourceId}`}
                        onClick={() => initiateAssign(ds)}
                        disabled={actionLoading === ds.dataSourceId || loadingImpact}
                        className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left hover:bg-indigo-500/[0.06] transition-colors group"
                      >
                        <Database className="w-3.5 h-3.5 text-ink-muted flex-shrink-0 group-hover:text-indigo-500" />
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-medium text-ink truncate">{ds.dataSourceLabel}</div>
                          <div className="text-[10px] text-ink-muted truncate">
                            {ds.workspaceName}
                            {ds.currentOntologyId && (
                              <span className="ml-1.5 text-amber-500">
                                — has existing layer
                              </span>
                            )}
                          </div>
                        </div>
                        {actionLoading === ds.dataSourceId ? (
                          <Loader2 className="w-3.5 h-3.5 text-ink-muted animate-spin flex-shrink-0" />
                        ) : ds.currentOntologyId ? (
                          <AlertTriangle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                        ) : (
                          <Plus className="w-3.5 h-3.5 text-ink-muted/30 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                        )}
                      </button>
                    ))
                  )}
                </div>
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 py-12 justify-center text-ink-muted">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-sm">Loading assignments...</span>
          </div>
        ) : workspaceGroups.length === 0 ? (
          <div className="border border-dashed border-glass-border rounded-xl py-12 text-center">
            <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-gradient-to-br from-indigo-500/10 to-purple-500/10 flex items-center justify-center">
              <Unlink className="w-5 h-5 text-ink-muted/50" />
            </div>
            <p className="text-sm font-medium text-ink-secondary">Not assigned to any data sources</p>
            <p className="text-xs text-ink-muted mt-1 max-w-xs mx-auto">
              Use the Assign button above to connect this semantic layer to a data source.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {workspaceGroups.map((ws) => (
              <WorkspaceUsageCard
                key={ws.workspaceId}
                workspace={ws}
                loadingViews={loadingViews}
                actionLoading={actionLoading}
                onNavigate={(path) => navigate(path)}
                onUnassign={(dsId) => handleUnassign(ws.workspaceId, dsId)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Reassignment confirmation dialog */}
      {confirmTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 dark:bg-black/60 animate-in fade-in duration-150">
          <div className="bg-white dark:bg-gray-900 rounded-2xl border border-glass-border shadow-2xl w-full max-w-md mx-4 overflow-hidden animate-in zoom-in-95 duration-200">
            <div className="p-6">
              <div className="flex items-start gap-3 mb-4">
                <div className="w-10 h-10 rounded-xl bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center flex-shrink-0">
                  <AlertTriangle className="w-5 h-5 text-amber-500" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-ink">Replace existing semantic layer?</h3>
                  <p className="text-sm text-ink-muted mt-1">
                    <span className="font-medium text-ink">{confirmTarget.dataSourceLabel}</span>
                    {' '}in <span className="font-medium text-ink">{confirmTarget.workspaceName}</span>
                    {' '}already has a semantic layer assigned.
                  </p>
                </div>
              </div>

              <div className="rounded-xl border border-amber-200/60 dark:border-amber-800/40 bg-amber-50/50 dark:bg-amber-950/20 p-4 mb-4 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-ink-muted">Current layer</span>
                  <span className="font-mono font-medium text-amber-700 dark:text-amber-300">
                    {confirmTarget.currentOntologyName}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-ink-muted">Will be replaced with</span>
                  <span className="font-semibold text-indigo-600 dark:text-indigo-400">{ontology.name}</span>
                </div>
                {confirmTarget.viewCount !== null && confirmTarget.viewCount > 0 && (
                  <div className="flex items-center justify-between text-xs pt-1 border-t border-amber-200/40 dark:border-amber-800/30">
                    <span className="text-ink-muted flex items-center gap-1">
                      <Eye className="w-3 h-3" />
                      Impacted views
                    </span>
                    <span className="font-bold text-amber-600 dark:text-amber-400">{confirmTarget.viewCount}</span>
                  </div>
                )}
              </div>

              <p className="text-xs text-ink-muted mb-4">
                All views in this workspace will use the new semantic layer. This change takes effect immediately.
              </p>
            </div>

            <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-glass-border/50 bg-black/[0.015] dark:bg-white/[0.015]">
              <button
                onClick={() => setConfirmTarget(null)}
                className="px-4 py-2 rounded-xl text-xs font-semibold text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => executeAssign(confirmTarget.workspaceId, confirmTarget.dataSourceId)}
                disabled={actionLoading === confirmTarget.dataSourceId}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-amber-500 text-white hover:bg-amber-600 transition-colors shadow-sm"
              >
                {actionLoading === confirmTarget.dataSourceId ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <AlertTriangle className="w-3.5 h-3.5" />
                )}
                Replace &amp; Assign
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
// Workspace card with data sources and views
// ─────────────────────────────────────────────────────────────────

interface WorkspaceUsageCardProps {
  workspace: {
    workspaceId: string
    workspaceName: string
    dataSources: Array<{ id: string; label: string }>
    views: View[]
  }
  loadingViews: boolean
  actionLoading: string | null
  onNavigate: (path: string) => void
  onUnassign: (dataSourceId: string) => void
}

function WorkspaceUsageCard({ workspace: ws, loadingViews, actionLoading, onNavigate, onUnassign }: WorkspaceUsageCardProps) {
  const [viewsExpanded, setViewsExpanded] = useState(false)
  const hasViews = ws.views.length > 0

  return (
    <div className="border border-glass-border rounded-xl bg-canvas-elevated/50 overflow-hidden">
      {/* Workspace header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-glass-border/50 bg-black/[0.02] dark:bg-white/[0.02]">
        <div className="w-8 h-8 rounded-lg bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200/50 dark:border-indigo-800/50 flex items-center justify-center flex-shrink-0">
          <Layers className="w-4 h-4 text-indigo-500" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-ink truncate">{ws.workspaceName}</div>
          <div className="text-[10px] text-ink-muted flex items-center gap-2">
            <span>{ws.dataSources.length} data source{ws.dataSources.length !== 1 ? 's' : ''}</span>
            <span className="opacity-30">·</span>
            <span className="flex items-center gap-1">
              <Eye className="w-2.5 h-2.5" />
              {loadingViews ? '...' : ws.views.length} view{ws.views.length !== 1 ? 's' : ''}
            </span>
          </div>
        </div>
        <button
          onClick={() => onNavigate(`/workspaces/${ws.workspaceId}`)}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-ink-muted hover:text-indigo-600 hover:bg-indigo-500/[0.06] transition-all"
        >
          <ExternalLink className="w-3 h-3" />
          Open
        </button>
      </div>

      {/* Data sources with unassign */}
      <div className="px-4 py-2.5 flex items-center gap-2 flex-wrap">
        {ws.dataSources.map(ds => (
          <span
            key={ds.id}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-black/[0.03] dark:bg-white/[0.04] text-xs text-ink-secondary border border-glass-border/40 group"
          >
            <Database className="w-3 h-3 text-ink-muted" />
            {ds.label || ds.id.slice(0, 12)}
            <button
              onClick={() => onUnassign(ds.id)}
              disabled={actionLoading === ds.id}
              className="ml-0.5 p-0.5 rounded hover:bg-red-500/10 text-ink-muted/40 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100"
              title="Unassign from this data source"
            >
              {actionLoading === ds.id ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <X className="w-3 h-3" />
              )}
            </button>
          </span>
        ))}
      </div>

      {/* Views section */}
      {(hasViews || loadingViews) && (
        <div className="border-t border-glass-border/40">
          <button
            onClick={() => setViewsExpanded(!viewsExpanded)}
            className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-black/[0.015] dark:hover:bg-white/[0.015] transition-colors"
          >
            <ChevronDown className={cn(
              'w-3 h-3 text-ink-muted/50 flex-shrink-0 transition-transform',
              !viewsExpanded && '-rotate-90',
            )} />
            <Eye className="w-3.5 h-3.5 text-indigo-500 flex-shrink-0" />
            <span className="text-xs font-medium text-ink-secondary flex-1">Views</span>
            {loadingViews ? (
              <Loader2 className="w-3 h-3 text-ink-muted/40 animate-spin flex-shrink-0" />
            ) : (
              <span className="flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-900/50 text-indigo-600 dark:text-indigo-400 flex-shrink-0">
                {ws.views.length}
              </span>
            )}
          </button>

          {viewsExpanded && hasViews && (
            <div className="bg-black/[0.015] dark:bg-white/[0.01] border-t border-glass-border/30">
              {ws.views.map(view => (
                <button
                  key={view.id}
                  onClick={() => onNavigate(`/views/${view.id}`)}
                  className="w-full flex items-center gap-2.5 px-4 py-2 pl-10 text-left hover:bg-indigo-500/[0.04] transition-colors group"
                >
                  <FileText className="w-3 h-3 text-ink-muted/40 flex-shrink-0 group-hover:text-indigo-500" />
                  <span className="text-[13px] text-ink-secondary truncate group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">{view.name}</span>
                  <span className="text-[9px] text-ink-muted font-mono ml-auto flex-shrink-0">{view.viewType || 'view'}</span>
                  <ExternalLink className="w-2.5 h-2.5 text-ink-muted/30 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
