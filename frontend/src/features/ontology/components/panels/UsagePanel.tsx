/**
 * UsagePanel — shows which workspaces, data sources, and views use this ontology.
 * Groups assignments by workspace so the hierarchy is crystal clear.
 * Also fetches and displays impacted views per data source.
 */
import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Layers, Database, Loader2, Unlink, ExternalLink, ChevronRight, ChevronDown, Box, GitBranch, Eye, FileText } from 'lucide-react'
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

  // Fetch views for all assigned data sources
  const [viewsByDs, setViewsByDs] = useState<Record<string, View[]>>({})
  const [loadingViews, setLoadingViews] = useState(false)

  useEffect(() => {
    if (!assignments || assignments.length === 0) {
      setViewsByDs({})
      return
    }

    let cancelled = false
    setLoadingViews(true)

    Promise.all(
      assignments.map(async (a) => {
        try {
          const views = await listViews({ workspaceId: a.workspaceId, dataSourceId: a.dataSourceId })
          return { dsId: a.dataSourceId, views }
        } catch {
          return { dsId: a.dataSourceId, views: [] as View[] }
        }
      })
    ).then(results => {
      if (cancelled) return
      const map: Record<string, View[]> = {}
      for (const r of results) map[r.dsId] = r.views
      setViewsByDs(map)
      setLoadingViews(false)
    })

    return () => { cancelled = true }
  }, [assignments])

  // Group assignments by workspace, include views
  const workspaceGroups = useMemo(() => {
    if (!assignments) return []
    const map = new Map<string, {
      workspaceId: string
      workspaceName: string
      dataSources: Array<{ id: string; label: string; views: View[] }>
    }>()
    for (const a of assignments) {
      let group = map.get(a.workspaceId)
      if (!group) {
        group = { workspaceId: a.workspaceId, workspaceName: a.workspaceName, dataSources: [] }
        map.set(a.workspaceId, group)
      }
      group.dataSources.push({
        id: a.dataSourceId,
        label: a.dataSourceLabel,
        views: viewsByDs[a.dataSourceId] ?? [],
      })
    }
    return Array.from(map.values())
  }, [assignments, viewsByDs])

  const totalDataSources = assignments?.length ?? 0
  const totalWorkspaces = workspaceGroups.length
  const totalViews = Object.values(viewsByDs).reduce((sum, views) => sum + views.length, 0)
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
// Workspace card with collapsible data sources and views
// ─────────────────────────────────────────────────────────────────

interface WorkspaceUsageCardProps {
  workspace: {
    workspaceId: string
    workspaceName: string
    dataSources: Array<{ id: string; label: string; views: View[] }>
  }
  loadingViews: boolean
  onNavigate: (path: string) => void
}

function WorkspaceUsageCard({ workspace: ws, loadingViews, onNavigate }: WorkspaceUsageCardProps) {
  const totalViews = ws.dataSources.reduce((sum, ds) => sum + ds.views.length, 0)

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
              {loadingViews ? '...' : totalViews} view{totalViews !== 1 ? 's' : ''}
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

      {/* Data sources with views */}
      <div className="divide-y divide-glass-border/40">
        {ws.dataSources.map((ds) => (
          <DataSourceRow
            key={ds.id}
            dataSource={ds}
            loadingViews={loadingViews}
            onNavigateToView={(viewId) => onNavigate(`/views/${viewId}`)}
          />
        ))}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
// Data source row with expandable views
// ─────────────────────────────────────────────────────────────────

interface DataSourceRowProps {
  dataSource: { id: string; label: string; views: View[] }
  loadingViews: boolean
  onNavigateToView: (viewId: string) => void
}

function DataSourceRow({ dataSource: ds, loadingViews, onNavigateToView }: DataSourceRowProps) {
  const [expanded, setExpanded] = useState(false)
  const hasViews = ds.views.length > 0

  return (
    <div>
      {/* Data source row */}
      <div
        className={cn(
          'flex items-center gap-3 px-4 py-2.5 pl-8 transition-colors',
          hasViews ? 'cursor-pointer hover:bg-black/[0.015] dark:hover:bg-white/[0.015]' : '',
        )}
        onClick={() => hasViews && setExpanded(!expanded)}
      >
        {hasViews ? (
          <ChevronDown className={cn(
            'w-3 h-3 text-ink-muted/50 flex-shrink-0 transition-transform',
            !expanded && '-rotate-90',
          )} />
        ) : (
          <ChevronRight className="w-3 h-3 text-ink-muted/30 flex-shrink-0" />
        )}
        <Database className="w-3.5 h-3.5 text-ink-muted flex-shrink-0" />
        <span className="text-sm text-ink-secondary flex-1 truncate">{ds.label || ds.id.slice(0, 12)}</span>

        {/* View count badge */}
        {loadingViews ? (
          <Loader2 className="w-3 h-3 text-ink-muted/40 animate-spin flex-shrink-0" />
        ) : hasViews ? (
          <span className="flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-900/50 text-indigo-600 dark:text-indigo-400 flex-shrink-0">
            <Eye className="w-2.5 h-2.5" />
            {ds.views.length}
          </span>
        ) : (
          <span className="text-[10px] text-ink-muted/50 flex-shrink-0">no views</span>
        )}

        <span className="text-[10px] text-ink-muted font-mono flex-shrink-0">{ds.id.slice(0, 12)}…</span>
      </div>

      {/* Expanded views list */}
      {expanded && hasViews && (
        <div className="bg-black/[0.015] dark:bg-white/[0.01] border-t border-glass-border/30">
          {ds.views.map(view => (
            <button
              key={view.id}
              onClick={(e) => { e.stopPropagation(); onNavigateToView(view.id) }}
              className="w-full flex items-center gap-2.5 px-4 py-2 pl-16 text-left hover:bg-indigo-500/[0.04] transition-colors group"
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
  )
}
