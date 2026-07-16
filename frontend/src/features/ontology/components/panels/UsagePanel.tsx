/**
 * UsagePanel — READ-ONLY view of which workspaces, data sources, and views use
 * this ontology, grouped by workspace. All assignment WRITES live in the
 * Assignment Manager dialog (single write surface) — the "Manage assignments"
 * button opens it.
 */
import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Layers, Database, Loader2, Unlink, ExternalLink, ChevronDown, Box, GitBranch, Eye, FileText, Settings2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import type { WorkspaceResponse } from '@/services/workspaceService'
import { listViews } from '@/services/viewApiService'
import { useOntologyAssignments } from '../../hooks/useOntologies'
import { EducationalCallout } from '../EducationalCallout'
import { TablePagination } from '@/components/ui/TablePagination'

const GROUPS_PAGE_SIZE = 8

interface UsagePanelProps {
  ontology: OntologyDefinitionResponse
  workspaces: WorkspaceResponse[]
  ontologies: OntologyDefinitionResponse[]
  /** Opens the Assignment Manager dialog — the single assignment write surface. */
  onManageAssignments?: () => void
}

export function UsagePanel({ ontology, onManageAssignments }: UsagePanelProps) {
  const { data: assignments, isLoading } = useOntologyAssignments(ontology.id)
  const navigate = useNavigate()
  const [page, setPage] = useState(0)

  // Group assignments by workspace. Views are fetched lazily PER CARD when
  // its Views section is expanded (see WorkspaceUsageCard) — no up-front
  // one-request-per-workspace fan-out.
  const workspaceGroups = useMemo(() => {
    if (!assignments) return []
    const map = new Map<string, {
      workspaceId: string
      workspaceName: string
      dataSources: Array<{ id: string; label: string }>
    }>()
    for (const a of assignments) {
      let group = map.get(a.workspaceId)
      if (!group) {
        group = {
          workspaceId: a.workspaceId,
          workspaceName: a.workspaceName,
          dataSources: [],
        }
        map.set(a.workspaceId, group)
      }
      group.dataSources.push({
        id: a.dataSourceId,
        label: a.dataSourceLabel,
      })
    }
    return Array.from(map.values())
  }, [assignments])

  // Clamp the page if the group list shrinks (e.g. after unassigning).
  useEffect(() => {
    const maxPage = Math.max(0, Math.ceil(workspaceGroups.length / GROUPS_PAGE_SIZE) - 1)
    if (page > maxPage) setPage(maxPage)
  }, [workspaceGroups.length, page])

  const pagedGroups = workspaceGroups.slice(page * GROUPS_PAGE_SIZE, (page + 1) * GROUPS_PAGE_SIZE)

  const totalDataSources = assignments?.length ?? 0
  const totalWorkspaces = workspaceGroups.length
  const entityCount = Object.keys(ontology.entityTypeDefinitions ?? {}).length
  const relCount = Object.keys(ontology.relationshipTypeDefinitions ?? {}).length

  return (
    <div className="space-y-6">
      <EducationalCallout
        id="edu-usage-assignment"
        title="What assigning this ontology does"
        description="Assigning this ontology to a data source makes it the lens for that source's graph — nodes and edges are read, nested, and validated against these declared types, and any versioned graph built here is written with them. Sources without an assignment fall back to the platform's default schema. Check the Health tab to confirm each source's real graph actually matches."
        variant="info"
      />

      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
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
                {totalWorkspaces} workspace{totalWorkspaces !== 1 ? 's' : ''} · {totalDataSources} source{totalDataSources !== 1 ? 's' : ''}
              </span>
            )}
          </h3>

          {onManageAssignments && (
            <button
              onClick={onManageAssignments}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/[0.06] transition-all"
            >
              <Settings2 className="w-3.5 h-3.5" />
              Manage assignments
            </button>
          )}
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
              Use “Manage assignments” above to connect this semantic layer to a data source.
            </p>
          </div>
        ) : (
          <>
            <div className="space-y-3">
              {pagedGroups.map((ws) => (
                <WorkspaceUsageCard
                  key={ws.workspaceId}
                  workspace={ws}
                  onNavigate={(path) => navigate(path)}
                />
              ))}
            </div>
            <div className="flex items-center justify-between mt-3">
              {workspaceGroups.length > GROUPS_PAGE_SIZE && (
                <span className="text-[11px] text-ink-muted tabular-nums">
                  Showing {page * GROUPS_PAGE_SIZE + 1}–{Math.min((page + 1) * GROUPS_PAGE_SIZE, workspaceGroups.length)} of {workspaceGroups.length} workspaces
                </span>
              )}
              <TablePagination
                page={page}
                pageSize={GROUPS_PAGE_SIZE}
                total={workspaceGroups.length}
                onPageChange={setPage}
                className="ml-auto"
              />
            </div>
          </>
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
  }
  onNavigate: (path: string) => void
}

function WorkspaceUsageCard({ workspace: ws, onNavigate }: WorkspaceUsageCardProps) {
  const [viewsExpanded, setViewsExpanded] = useState(false)

  // Lazy: the workspace's views load only when this section is expanded, so a
  // fleet of N workspaces costs zero view requests until the user asks.
  const { data: views, isLoading: loadingViews } = useQuery({
    queryKey: ['views', 'ws', ws.workspaceId],
    queryFn: async () => (await listViews({ workspaceId: ws.workspaceId })).items,
    enabled: viewsExpanded,
    staleTime: 60_000,
  })

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

      {/* Views section — loads on demand */}
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
          {viewsExpanded && loadingViews ? (
            <Loader2 className="w-3 h-3 text-ink-muted/40 animate-spin flex-shrink-0" />
          ) : views ? (
            <span className="flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-900/50 text-indigo-600 dark:text-indigo-400 flex-shrink-0">
              {views.length}
            </span>
          ) : (
            <span className="text-[10px] text-ink-muted/60 flex-shrink-0">show</span>
          )}
        </button>

        {viewsExpanded && views && views.length === 0 && (
          <p className="px-4 pb-3 pl-10 text-[11px] text-ink-muted italic">No views in this workspace yet.</p>
        )}

        {viewsExpanded && views && views.length > 0 && (
          <div className="bg-black/[0.015] dark:bg-white/[0.01] border-t border-glass-border/30">
            {views.map(view => (
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
    </div>
  )
}
