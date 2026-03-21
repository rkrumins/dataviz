/**
 * UsagePanel — shows which workspaces, data sources, and views use this ontology.
 * Groups assignments by workspace so the hierarchy is crystal clear.
 * Also fetches and displays impacted views per data source.
 */
import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Layers, Database, Loader2, Unlink, ExternalLink, ChevronDown, Box, GitBranch, Eye, FileText } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import { listViews, type View } from '@/services/viewApiService'
import { useOntologyAssignments } from '../../hooks/useOntologies'

interface UsagePanelProps {
  ontology: OntologyDefinitionResponse
}

export function UsagePanel({ ontology }: UsagePanelProps) {
  const { data: assignments, isLoading } = useOntologyAssignments(ontology.id)
  const navigate = useNavigate()

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
          <div className="text-2xl font-bold text-ink">{totalWorkspaces}</div>
          <div className="text-[11px] text-ink-muted mt-0.5">Workspaces</div>
        </div>
        <div className="border border-glass-border rounded-xl p-4 bg-canvas-elevated/50">
          <div className="text-2xl font-bold text-ink">{totalDataSources}</div>
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
        <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wider mb-3 flex items-center gap-2">
          <Layers className="w-3.5 h-3.5" />
          Assigned Workspaces, Data Sources &amp; Views
          {assignments && (
            <span className="px-2 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-900/50 text-indigo-600 dark:text-indigo-400 text-[10px] font-bold">
              {totalWorkspaces} workspace{totalWorkspaces !== 1 ? 's' : ''} · {totalDataSources} source{totalDataSources !== 1 ? 's' : ''} · {loadingViews ? '...' : totalViews} view{totalViews !== 1 ? 's' : ''}
            </span>
          )}
        </h3>

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
              Assign this ontology to a data source from the context banner at the top of the page, or from the workspace settings.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {workspaceGroups.map((ws) => (
              <WorkspaceUsageCard
                key={ws.workspaceId}
                workspace={ws}
                loadingViews={loadingViews}
                onNavigate={(path) => navigate(path)}
              />
            ))}
          </div>
        )}
      </div>
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
  onNavigate: (path: string) => void
}

function WorkspaceUsageCard({ workspace: ws, loadingViews, onNavigate }: WorkspaceUsageCardProps) {
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

      {/* Data sources */}
      <div className="px-4 py-2.5 flex items-center gap-2 flex-wrap">
        {ws.dataSources.map(ds => (
          <span
            key={ds.id}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-black/[0.03] dark:bg-white/[0.04] text-xs text-ink-secondary border border-glass-border/40"
          >
            <Database className="w-3 h-3 text-ink-muted" />
            {ds.label || ds.id.slice(0, 12)}
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
