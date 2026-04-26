/**
 * OntologyContextBanner — compact unified bar showing environment context
 * and deployment status in a single row.
 *
 * Layout:
 *   [CONTEXT  Workspace > DataSource ▾]  |  [DEPLOYED TO  N data sources  Manage ▾]  [inline warnings]
 *
 * Replaces the previous multi-row layout (Environment + Assigned Layer + QuickAssignmentBar + status rows)
 * with a single ontology-centric bar.
 */
import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import * as Popover from '@radix-ui/react-popover'
import {
  Layers,
  ChevronRight,
  ChevronDown,
  Database,
  CheckCircle2,
  Loader2,
  AlertTriangle,
  Search,
  Shield,
  PenLine,
  X,
  Box,
  GitBranch,
  ExternalLink,
  Eye,
  FileText,
  Check,
  ArrowRightLeft,
  Settings2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import type { WorkspaceResponse, DataSourceResponse } from '@/services/workspaceService'
import { listViews, type View } from '@/services/viewApiService'
import { OntologyStatusBadge } from './OntologyStatusBadge'

// ---------------------------------------------------------------------------

interface ImpactedView {
  id: string
  name: string
  type: string
}

interface AssignConfirmTarget {
  wsId: string
  wsName: string
  dsId: string
  dsLabel: string
  currentOntologyName: string | null
  viewCount: number | null
  loading: boolean
}

interface OntologyContextBannerProps {
  workspace: WorkspaceResponse | null
  dataSource: DataSourceResponse | null
  workspaces: WorkspaceResponse[]
  selectedOntologyId: string | null
  ontologies: OntologyDefinitionResponse[]
  selectedOntology: OntologyDefinitionResponse | null
  isAssigning: boolean
  onAssign: (ontologyId: string | undefined) => void
  onSwitchEnvironment: (workspaceId: string, dataSourceId: string) => void
  onAssignToDataSource?: (workspaceId: string, dataSourceId: string) => void
  onUnassignFromDataSource?: (workspaceId: string, dataSourceId: string) => void
  onRollOutToWorkspace?: (workspaceId: string) => void
}

export function OntologyContextBanner({
  workspace,
  dataSource,
  workspaces,
  selectedOntologyId,
  ontologies,
  selectedOntology,
  isAssigning,
  onAssign,
  onSwitchEnvironment,
  onAssignToDataSource,
  onUnassignFromDataSource,
  onRollOutToWorkspace,
}: OntologyContextBannerProps) {
  const [envOpen, setEnvOpen] = useState(false)
  const [envSearch, setEnvSearch] = useState('')
  const [manageOpen, setManageOpen] = useState(false)
  const [manageSearch, setManageSearch] = useState('')
  const [assignOpen, setAssignOpen] = useState(false)
  const [assignSearch, setAssignSearch] = useState('')
  const assignSearchRef = useRef<HTMLInputElement>(null)

  // Confirmation dialog state (for deployment popover reassignment)
  const [confirmTarget, setConfirmTarget] = useState<AssignConfirmTarget | null>(null)
  const [unassignTarget, setUnassignTarget] = useState<{ wsId: string; dsId: string; dsLabel: string } | null>(null)

  // Confirmation dialog state (for data-source-centric reassignment from banner)
  const [bannerConfirmTarget, setBannerConfirmTarget] = useState<{ ontologyId: string | undefined; ontologyName: string } | null>(null)
  const [impactedViews, setImpactedViews] = useState<ImpactedView[]>([])
  const [loadingImpact, setLoadingImpact] = useState(false)
  const [confirmText, setConfirmText] = useState('')

  // Data sources using the currently viewed ontology
  const ontologyDataSources = useMemo(() => {
    if (!selectedOntologyId) return []
    const results: Array<{ workspaceId: string; workspaceName: string; dataSourceId: string; dataSourceLabel: string }> = []
    for (const ws of workspaces) {
      for (const ds of ws.dataSources ?? []) {
        if (ds.ontologyId === selectedOntologyId) {
          results.push({
            workspaceId: ws.id,
            workspaceName: ws.name,
            dataSourceId: ds.id,
            dataSourceLabel: ds.label || ds.catalogItemId || 'Data Source',
          })
        }
      }
    }
    return results
  }, [workspaces, selectedOntologyId])

  // All data sources across workspaces (for environment picker)
  const allDataSources = useMemo(() => {
    const results: Array<{ workspaceId: string; workspaceName: string; dataSourceId: string; dataSourceLabel: string; ontologyId?: string }> = []
    for (const ws of workspaces) {
      for (const ds of ws.dataSources ?? []) {
        results.push({
          workspaceId: ws.id,
          workspaceName: ws.name,
          dataSourceId: ds.id,
          dataSourceLabel: ds.label || ds.catalogItemId || 'Data Source',
          ontologyId: ds.ontologyId,
        })
      }
    }
    return results
  }, [workspaces])

  // Ontology name lookup
  const ontologyNameMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const o of ontologies) m.set(o.id, o.name)
    return m
  }, [ontologies])

  // Assignment status
  const assignedOntology = dataSource?.ontologyId
    ? ontologies.find(o => o.id === dataSource.ontologyId) ?? null
    : null
  const isViewingAssigned = !!(selectedOntology && assignedOntology && selectedOntology.id === assignedOntology.id)
  const isViewingDifferent = !!(selectedOntology && assignedOntology && selectedOntology.id !== assignedOntology.id)

  // All data sources for the deployment manage popover
  const manageDataSources = useMemo(() => {
    const q = manageSearch.toLowerCase()
    return workspaces.map(ws => ({
      ...ws,
      filteredDs: (ws.dataSources ?? []).filter(ds => {
        if (!q) return true
        return (ds.label || ds.id).toLowerCase().includes(q) || ws.name.toLowerCase().includes(q)
      }),
    })).filter(ws => ws.filteredDs.length > 0)
  }, [workspaces, manageSearch])

  // Focus assign search when picker opens
  useEffect(() => {
    if (assignOpen) setTimeout(() => assignSearchRef.current?.focus(), 50)
    else setAssignSearch('')
  }, [assignOpen])

  // Filter ontologies for assignment picker (data-source-centric)
  const filteredOntologies = useMemo(() => {
    if (!assignSearch.trim()) return ontologies
    const q = assignSearch.toLowerCase()
    return ontologies.filter(o =>
      o.name.toLowerCase().includes(q) ||
      o.scope?.toLowerCase().includes(q)
    )
  }, [ontologies, assignSearch])

  // ── Deployment popover: assign with confirmation ──
  const initiateDeployAssign = useCallback(async (wsId: string, wsName: string, dsId: string, dsLabel: string, currentOntologyId: string | null) => {
    setManageOpen(false)
    if (!currentOntologyId || !onAssignToDataSource) {
      onAssignToDataSource?.(wsId, dsId)
      return
    }
    const target: AssignConfirmTarget = {
      wsId, wsName, dsId, dsLabel,
      currentOntologyName: ontologyNameMap.get(currentOntologyId) ?? currentOntologyId,
      viewCount: null,
      loading: true,
    }
    setConfirmTarget(target)
    try {
      const { total } = await listViews({ workspaceId: wsId, limit: 1 })
      setConfirmTarget(prev => prev ? { ...prev, viewCount: total, loading: false } : null)
    } catch {
      setConfirmTarget(prev => prev ? { ...prev, viewCount: null, loading: false } : null)
    }
  }, [onAssignToDataSource, ontologyNameMap])

  // ── Banner: data-source-centric assign with confirmation ──
  const initiateBannerAssign = useCallback(async (ontologyId: string | undefined, ontologyName: string) => {
    if (!workspace || !dataSource) return
    if (assignedOntology) {
      setLoadingImpact(true)
      setBannerConfirmTarget({ ontologyId, ontologyName })
      try {
        const { items } = await listViews({ workspaceId: workspace.id })
        setImpactedViews(items.map((v: View) => ({ id: v.id, name: v.name, type: v.viewType ?? 'view' })))
      } catch {
        setImpactedViews([])
      } finally {
        setLoadingImpact(false)
      }
    } else {
      onAssign(ontologyId)
    }
    setAssignOpen(false)
  }, [workspace, dataSource, assignedOntology, onAssign])

  const handleConfirmBannerAssign = () => {
    if (!bannerConfirmTarget) return
    onAssign(bannerConfirmTarget.ontologyId)
    setBannerConfirmTarget(null)
    setImpactedViews([])
  }

  const handleCancelBannerAssign = () => {
    setBannerConfirmTarget(null)
    setImpactedViews([])
    setConfirmText('')
  }

  // ── No environment selected ─────────────────────────────────────
  if (!workspace || !dataSource) {
    return (
      <div className="mb-3">
        <div className="flex items-center gap-3 px-4 py-2.5 rounded-xl border border-dashed border-glass-border bg-canvas-elevated/30">
          <Database className="w-4 h-4 text-ink-muted/50 flex-shrink-0" />
          <p className="text-xs text-ink-muted flex-1">
            <span className="font-medium text-ink-secondary">No environment selected</span>
            <span className="ml-1.5">— select a data source for coverage, stats, and Suggest.</span>
          </p>

          <Popover.Root open={envOpen} onOpenChange={(open) => { setEnvOpen(open); if (!open) setEnvSearch('') }}>
            <Popover.Trigger asChild>
              <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-glass-border hover:border-indigo-300 hover:bg-indigo-500/[0.06] text-ink-secondary hover:text-indigo-600 transition-colors duration-150 flex-shrink-0">
                <Database className="w-3 h-3" />
                Select
                <ChevronDown className={cn('w-3 h-3 text-ink-muted/40 transition-transform', envOpen && 'rotate-180')} />
              </button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content
                side="bottom" align="end" sideOffset={6}
                className="w-[380px] bg-canvas-elevated border border-glass-border rounded-2xl shadow-lg z-50 overflow-hidden animate-in fade-in zoom-in-95"
              >
                <div className="p-3 border-b border-glass-border">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted" />
                    <input
                      type="text" value={envSearch} onChange={e => setEnvSearch(e.target.value)}
                      placeholder="Search environments..." autoFocus
                      className="w-full pl-9 pr-3 py-2 rounded-xl bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border text-sm text-ink placeholder:text-ink-muted/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 transition-colors duration-150"
                    />
                  </div>
                </div>
                <EnvironmentList
                  envSearch={envSearch}
                  ontologyDataSources={ontologyDataSources}
                  allDataSources={allDataSources}
                  selectedOntologyId={selectedOntologyId}
                  activeWorkspaceId={null}
                  activeDataSourceId={null}
                  onSelect={(wsId, dsId) => { onSwitchEnvironment(wsId, dsId); setEnvOpen(false) }}
                />
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        </div>
      </div>
    )
  }

  // ── Environment selected — compact unified bar ──────────────────
  const deploymentCount = ontologyDataSources.length

  return (
    <div className="mb-3">
      <div
        key={dataSource.id}
        className="rounded-xl border border-glass-border bg-canvas-elevated/60 backdrop-blur-sm animate-in fade-in duration-300"
      >
        <div className="flex items-center gap-0 px-1 py-1">

          {/* ── Left: Context selector ── */}
          <div className="flex items-center gap-2 min-w-0 px-3 py-1.5">
            <span className="text-[9px] font-bold text-ink-muted/50 uppercase tracking-widest flex-shrink-0">Context</span>
            <div className="flex items-center gap-1.5 min-w-0">
              <Layers className="w-3 h-3 text-indigo-500/60 flex-shrink-0" />
              <span className="text-xs font-medium text-ink-secondary truncate max-w-[140px]">{workspace.name}</span>
            </div>
            <ChevronRight className="w-2.5 h-2.5 text-ink-muted/30 flex-shrink-0" />
            <Popover.Root open={envOpen} onOpenChange={(open) => { setEnvOpen(open); if (!open) setEnvSearch('') }}>
              <Popover.Trigger asChild>
                <button className="flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-black/[0.04] dark:hover:bg-white/[0.04] transition-colors min-w-0">
                  <Database className="w-3 h-3 text-indigo-500/70 flex-shrink-0" />
                  <span className="text-xs font-semibold text-ink truncate max-w-[160px]">
                    {dataSource.label || 'Data Source'}
                  </span>
                  <ChevronDown className={cn('w-3 h-3 text-ink-muted/40 flex-shrink-0 transition-transform', envOpen && 'rotate-180')} />
                </button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  side="bottom" align="start" sideOffset={6}
                  className="w-[380px] bg-canvas-elevated border border-glass-border rounded-2xl shadow-lg z-50 overflow-hidden animate-in fade-in zoom-in-95"
                >
                  <div className="p-3 border-b border-glass-border">
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted" />
                      <input
                        type="text" value={envSearch} onChange={e => setEnvSearch(e.target.value)}
                        placeholder="Search environments..." autoFocus
                        className="w-full pl-9 pr-3 py-2 rounded-xl bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border text-sm text-ink placeholder:text-ink-muted/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 transition-colors duration-150"
                      />
                    </div>
                  </div>
                  <EnvironmentList
                    envSearch={envSearch}
                    ontologyDataSources={ontologyDataSources}
                    allDataSources={allDataSources}
                    selectedOntologyId={selectedOntologyId}
                    activeWorkspaceId={workspace.id}
                    activeDataSourceId={dataSource.id}
                    onSelect={(wsId, dsId) => { onSwitchEnvironment(wsId, dsId); setEnvOpen(false) }}
                  />
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          </div>

          {/* Separator */}
          <div className="w-px h-5 bg-glass-border/60 flex-shrink-0" />

          {/* ── Right: Deployment status + manage ── */}
          <div className="flex items-center gap-2 px-3 py-1.5 flex-1 min-w-0">
            <span className="text-[9px] font-bold text-ink-muted/50 uppercase tracking-widest flex-shrink-0">Deployed to</span>

            {selectedOntology && onAssignToDataSource ? (
              <>
                {/* Deployment count badge + manage popover */}
                <Popover.Root open={manageOpen} onOpenChange={(open) => { setManageOpen(open); if (!open) setManageSearch('') }}>
                  <Popover.Trigger asChild>
                    <button className={cn(
                      'flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors duration-150 flex-shrink-0',
                      deploymentCount > 0
                        ? 'text-emerald-700 dark:text-emerald-400 bg-emerald-500/[0.08] hover:bg-emerald-500/[0.15] border border-emerald-500/20'
                        : 'text-ink-muted bg-black/[0.03] dark:bg-white/[0.04] hover:bg-black/[0.06] dark:hover:bg-white/[0.06] border border-glass-border',
                    )}>
                      {deploymentCount > 0 ? (
                        <>
                          <CheckCircle2 className="w-3 h-3" />
                          {deploymentCount} data source{deploymentCount !== 1 ? 's' : ''}
                        </>
                      ) : (
                        <>
                          <AlertTriangle className="w-3 h-3 text-amber-500" />
                          Not deployed
                        </>
                      )}
                      <Settings2 className="w-3 h-3 opacity-50 ml-0.5" />
                    </button>
                  </Popover.Trigger>
                  <Popover.Portal>
                    <Popover.Content
                      className="w-[380px] bg-canvas-elevated border border-glass-border rounded-xl shadow-lg overflow-hidden z-50 animate-in fade-in zoom-in-95"
                      sideOffset={6} align="start"
                    >
                      {/* Header */}
                      <div className="px-4 pt-3 pb-2 border-b border-glass-border/50">
                        <div className="flex items-center justify-between mb-2">
                          <h3 className="text-xs font-bold text-ink">Manage Deployments</h3>
                          <span className="text-[10px] text-ink-muted">
                            {deploymentCount} assigned
                          </span>
                        </div>
                        <div className="relative">
                          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3 h-3 text-ink-muted/50" />
                          <input
                            type="text" value={manageSearch} onChange={e => setManageSearch(e.target.value)}
                            placeholder="Search data sources..." autoFocus
                            className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border/60 text-xs text-ink placeholder:text-ink-muted/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 transition-colors duration-150"
                          />
                        </div>
                      </div>

                      {/* Data source list */}
                      <div className="max-h-[320px] overflow-y-auto p-2">
                        {manageDataSources.map(ws => (
                          <div key={ws.id} className="mb-1.5">
                            <div className="flex items-center justify-between px-2 py-1.5">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <Layers className="w-3 h-3 text-ink-muted/50 flex-shrink-0" />
                                <span className="text-[10px] font-semibold text-ink-muted uppercase tracking-wider truncate">
                                  {ws.name}
                                </span>
                              </div>
                              {onRollOutToWorkspace && (
                                <button
                                  onClick={() => { onRollOutToWorkspace(ws.id); setManageOpen(false) }}
                                  disabled={isAssigning}
                                  className="text-[9px] font-semibold text-indigo-500 hover:text-indigo-600 transition-colors disabled:opacity-50 flex-shrink-0"
                                >
                                  Assign all
                                </button>
                              )}
                            </div>
                            {ws.filteredDs.map(ds => {
                              const isAssigned = ds.ontologyId === selectedOntologyId
                              const hasOtherOntology = !!ds.ontologyId && !isAssigned
                              const otherName = hasOtherOntology ? ontologyNameMap.get(ds.ontologyId!) : null
                              return (
                                <div
                                  key={ds.id}
                                  className={cn(
                                    'flex items-center gap-2.5 px-3 py-2 rounded-lg group transition-colors duration-150',
                                    isAssigned
                                      ? 'bg-emerald-500/[0.06]'
                                      : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.03]',
                                  )}
                                >
                                  <Database className={cn('w-3.5 h-3.5 flex-shrink-0', isAssigned ? 'text-emerald-500' : hasOtherOntology ? 'text-amber-400' : 'text-ink-muted/50')} />
                                  <div className="flex-1 min-w-0">
                                    <p className="text-xs font-medium text-ink truncate">{ds.label || ds.id}</p>
                                    {hasOtherOntology && (
                                      <p className="text-[10px] text-amber-500 mt-0.5 flex items-center gap-1">
                                        <AlertTriangle className="w-2.5 h-2.5" />
                                        Uses &ldquo;{otherName || 'another schema'}&rdquo;
                                      </p>
                                    )}
                                  </div>
                                  {isAssigned ? (
                                    <div className="flex items-center gap-1.5">
                                      <Check className="w-3 h-3 text-emerald-500" />
                                      {onUnassignFromDataSource && (
                                        <button
                                          onClick={() => setUnassignTarget({ wsId: ws.id, dsId: ds.id, dsLabel: ds.label || ds.id })}
                                          disabled={isAssigning}
                                          className="p-0.5 rounded-full hover:bg-red-500/20 text-ink-muted hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100 disabled:opacity-30"
                                          title="Unassign"
                                        >
                                          <X className="w-3 h-3" />
                                        </button>
                                      )}
                                    </div>
                                  ) : (
                                    <button
                                      onClick={() => initiateDeployAssign(ws.id, ws.name, ds.id, ds.label || ds.id, hasOtherOntology ? ds.ontologyId! : null)}
                                      disabled={isAssigning}
                                      className="text-[10px] font-semibold text-indigo-500 hover:text-indigo-600 opacity-0 group-hover:opacity-100 transition-colors duration-150 disabled:opacity-30 flex-shrink-0"
                                    >
                                      Assign
                                    </button>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                        ))}
                        {manageDataSources.length === 0 && (
                          <p className="text-center text-xs text-ink-muted py-6">No data sources found</p>
                        )}
                      </div>
                    </Popover.Content>
                  </Popover.Portal>
                </Popover.Root>

                {/* Inline mismatch warning */}
                {isViewingDifferent && selectedOntology && (
                  <div className="flex items-center gap-1.5 min-w-0">
                    <ArrowRightLeft className="w-3 h-3 text-amber-500 flex-shrink-0" />
                    <span className="text-[10px] text-amber-600 dark:text-amber-400 truncate">
                      Context uses &ldquo;{assignedOntology!.name}&rdquo;
                    </span>
                    <button
                      onClick={() => initiateBannerAssign(selectedOntology.id, selectedOntology.name)}
                      disabled={isAssigning}
                      className="text-[10px] font-semibold text-amber-600 dark:text-amber-400 hover:text-amber-700 dark:hover:text-amber-300 underline underline-offset-2 flex-shrink-0 disabled:opacity-50"
                    >
                      Re-assign
                    </button>
                  </div>
                )}

                {/* Inline no-assignment warning */}
                {!assignedOntology && (
                  <div className="flex items-center gap-1.5 min-w-0">
                    <AlertTriangle className="w-3 h-3 text-amber-500 flex-shrink-0" />
                    <span className="text-[10px] text-amber-600 dark:text-amber-400">
                      Context data source has no schema
                    </span>
                  </div>
                )}

                {/* In sync indicator */}
                {isViewingAssigned && (
                  <div className="flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3 text-emerald-500 flex-shrink-0" />
                    <span className="text-[10px] text-emerald-600 dark:text-emerald-400">In sync</span>
                  </div>
                )}
              </>
            ) : (
              /* No ontology selected or no assign callback — show assigned layer for current DS */
              <div className="flex items-center gap-2">
                {assignedOntology ? (
                  <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-emerald-50/80 dark:bg-emerald-950/20 border border-emerald-200/50 dark:border-emerald-800/40 text-xs font-medium text-ink">
                    <CheckCircle2 className="w-3 h-3 text-emerald-500" />
                    {assignedOntology.name}
                    <span className="text-[10px] text-ink-muted font-mono">v{assignedOntology.version}</span>
                  </span>
                ) : (
                  <Popover.Root open={assignOpen} onOpenChange={setAssignOpen}>
                    <Popover.Trigger asChild>
                      <button
                        disabled={isAssigning}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-500 text-white hover:bg-indigo-600 shadow-sm shadow-indigo-500/20 transition-colors duration-150 disabled:opacity-50"
                      >
                        {isAssigning ? <Loader2 className="w-3 h-3 animate-spin" /> : <Layers className="w-3 h-3" />}
                        Assign Schema
                      </button>
                    </Popover.Trigger>
                    <Popover.Portal>
                      <Popover.Content
                        side="bottom" align="end" sideOffset={6}
                        className="w-[420px] bg-canvas-elevated border border-glass-border rounded-2xl shadow-lg z-50 overflow-hidden animate-in fade-in zoom-in-95"
                      >
                        <div className="px-4 pt-4 pb-3 border-b border-glass-border">
                          <h3 className="text-sm font-bold text-ink mb-1">Assign Semantic Layer</h3>
                          <p className="text-[11px] text-ink-muted">
                            Select a semantic layer for <span className="font-medium text-ink-secondary">{dataSource.label || 'this data source'}</span>
                          </p>
                          <div className="relative mt-3">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted" />
                            <input
                              ref={assignSearchRef} type="text" value={assignSearch}
                              onChange={e => setAssignSearch(e.target.value)}
                              placeholder="Search semantic layers..."
                              className="w-full pl-9 pr-3 py-2 rounded-xl bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border text-sm text-ink placeholder:text-ink-muted/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 transition-colors duration-150"
                            />
                          </div>
                        </div>
                        <div className="max-h-[360px] overflow-y-auto custom-scrollbar p-2 space-y-1">
                          <button
                            onClick={() => initiateBannerAssign(undefined, 'None (system defaults)')}
                            className={cn(
                              'w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left transition-colors duration-150',
                              !dataSource.ontologyId
                                ? 'bg-indigo-500/[0.06] border border-indigo-500/15'
                                : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.03] border border-transparent',
                            )}
                          >
                            <div className="w-9 h-9 rounded-xl bg-black/[0.04] dark:bg-white/[0.06] border border-glass-border flex items-center justify-center flex-shrink-0">
                              <X className="w-4 h-4 text-ink-muted" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium text-ink">No semantic layer</div>
                              <div className="text-[11px] text-ink-muted mt-0.5">Use system defaults</div>
                            </div>
                            {!dataSource.ontologyId && (
                              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-900/50 text-indigo-500 flex-shrink-0">CURRENT</span>
                            )}
                          </button>
                          {filteredOntologies.map(o => {
                            const isCurrentlyAssigned = o.id === dataSource.ontologyId
                            const entityCount = Object.keys(o.entityTypeDefinitions ?? {}).length
                            const relCount = Object.keys(o.relationshipTypeDefinitions ?? {}).length
                            const StatusIcon = o.isSystem ? Shield : o.isPublished ? CheckCircle2 : PenLine
                            return (
                              <button
                                key={o.id}
                                onClick={() => !isCurrentlyAssigned && initiateBannerAssign(o.id, o.name)}
                                disabled={isCurrentlyAssigned}
                                className={cn(
                                  'w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left transition-colors duration-150',
                                  isCurrentlyAssigned
                                    ? 'bg-emerald-500/[0.06] border border-emerald-500/15'
                                    : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.03] border border-transparent cursor-pointer',
                                )}
                              >
                                <div className={cn(
                                  'w-9 h-9 rounded-xl border flex items-center justify-center flex-shrink-0',
                                  o.isSystem ? 'bg-blue-50 dark:bg-blue-950/30 border-blue-200/50 dark:border-blue-800/40'
                                    : o.isPublished ? 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200/50 dark:border-emerald-800/40'
                                    : 'bg-amber-50 dark:bg-amber-950/30 border-amber-200/50 dark:border-amber-800/40',
                                )}>
                                  <StatusIcon className={cn('w-4 h-4', o.isSystem ? 'text-blue-500' : o.isPublished ? 'text-emerald-500' : 'text-amber-500')} />
                                </div>
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2">
                                    <span className="text-sm font-semibold text-ink truncate">{o.name}</span>
                                    <span className="text-[10px] text-ink-muted font-mono flex-shrink-0">v{o.version}</span>
                                    <OntologyStatusBadge ontology={o} size="xs" />
                                  </div>
                                  <div className="flex items-center gap-3 text-[11px] text-ink-muted mt-1">
                                    <span className="flex items-center gap-1"><Box className="w-2.5 h-2.5" />{entityCount} entit{entityCount === 1 ? 'y' : 'ies'}</span>
                                    <span className="flex items-center gap-1"><GitBranch className="w-2.5 h-2.5" />{relCount} rel{relCount === 1 ? '' : 's'}</span>
                                  </div>
                                </div>
                                {isCurrentlyAssigned && (
                                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/50 text-emerald-600 dark:text-emerald-400 flex-shrink-0">ASSIGNED</span>
                                )}
                              </button>
                            )
                          })}
                          {filteredOntologies.length === 0 && (
                            <div className="px-4 py-8 text-center">
                              <Search className="w-5 h-5 text-ink-muted/40 mx-auto mb-2" />
                              <p className="text-sm text-ink-muted">No semantic layers match &ldquo;{assignSearch}&rdquo;</p>
                            </div>
                          )}
                        </div>
                        <div className="px-4 py-3 border-t border-glass-border bg-black/[0.02] dark:bg-white/[0.02]">
                          <a href="/schema" className="flex items-center gap-1.5 text-[11px] font-medium text-indigo-500 hover:text-indigo-600 transition-colors">
                            <ExternalLink className="w-3 h-3" />
                            Manage semantic layers
                          </a>
                        </div>
                      </Popover.Content>
                    </Popover.Portal>
                  </Popover.Root>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Deployment reassignment confirmation ── */}
      {confirmTarget && onAssignToDataSource && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setConfirmTarget(null)} />
          <div className="relative w-full max-w-md mx-4 rounded-2xl border border-glass-border bg-canvas-elevated shadow-lg animate-in fade-in zoom-in-95 p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-amber-500/15 flex items-center justify-center">
                <AlertTriangle className="w-5 h-5 text-amber-500" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-ink">Replace existing schema?</h3>
                <p className="text-[11px] text-ink-muted mt-0.5">
                  {confirmTarget.dsLabel} in {confirmTarget.wsName}
                </p>
              </div>
            </div>
            <div className="rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] p-3 mb-4">
              <div className="flex items-center gap-2 text-xs">
                <span className="text-ink-muted">Current:</span>
                <span className="font-semibold text-ink">{confirmTarget.currentOntologyName}</span>
                <ArrowRightLeft className="w-3 h-3 text-ink-muted mx-1" />
                <span className="text-ink-muted">New:</span>
                <span className="font-semibold text-indigo-600 dark:text-indigo-400">This schema</span>
              </div>
            </div>
            {confirmTarget.loading ? (
              <div className="flex items-center gap-2 text-xs text-ink-muted py-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Checking for impacted views...
              </div>
            ) : confirmTarget.viewCount && confirmTarget.viewCount > 0 ? (
              <div className="rounded-xl border border-amber-200/50 dark:border-amber-800/30 bg-amber-50/50 dark:bg-amber-950/15 p-3 mb-4">
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  <span className="font-semibold">{confirmTarget.viewCount} view{confirmTarget.viewCount !== 1 ? 's' : ''}</span>
                  {' '}in this workspace may be affected.
                </p>
              </div>
            ) : null}
            <div className="flex items-center justify-end gap-2 mt-4">
              <button onClick={() => setConfirmTarget(null)} className="px-4 py-2 rounded-xl text-xs font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors">Cancel</button>
              <button
                onClick={() => { onAssignToDataSource(confirmTarget.wsId, confirmTarget.dsId); setConfirmTarget(null) }}
                disabled={isAssigning || confirmTarget.loading}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-amber-500 text-white hover:bg-amber-600 transition-colors shadow-sm disabled:opacity-50"
              >Replace & Assign</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Unassign confirmation ── */}
      {unassignTarget && onUnassignFromDataSource && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setUnassignTarget(null)} />
          <div className="relative w-full max-w-sm mx-4 rounded-2xl border border-glass-border bg-canvas-elevated shadow-lg animate-in fade-in zoom-in-95 p-6">
            <h3 className="text-sm font-bold text-ink mb-2">Unassign schema?</h3>
            <p className="text-xs text-ink-muted mb-4">
              Remove this schema from <span className="font-semibold text-ink">{unassignTarget.dsLabel}</span>?
              Views using this data source may stop working correctly.
            </p>
            <div className="flex items-center justify-end gap-2">
              <button onClick={() => setUnassignTarget(null)} className="px-4 py-2 rounded-xl text-xs font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors">Cancel</button>
              <button
                onClick={() => { onUnassignFromDataSource(unassignTarget.wsId, unassignTarget.dsId); setUnassignTarget(null) }}
                disabled={isAssigning}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-red-500 text-white hover:bg-red-600 transition-colors shadow-sm disabled:opacity-50"
              >Unassign</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Banner re-assignment confirmation dialog ── */}
      {bannerConfirmTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={handleCancelBannerAssign} />
          <div className="relative w-full max-w-lg mx-4 rounded-2xl border border-glass-border bg-canvas-elevated shadow-lg animate-in fade-in slide-in-from-bottom-4 duration-200">
            <button onClick={handleCancelBannerAssign} className="absolute top-4 right-4 p-1 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
              <X className="w-4 h-4" />
            </button>
            <div className="px-6 pt-6 pb-4">
              <div className="flex items-start gap-4">
                <div className="w-10 h-10 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200/50 dark:border-amber-800/50 flex items-center justify-center flex-shrink-0">
                  <AlertTriangle className="w-5 h-5 text-amber-500" />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="text-base font-bold text-ink">Confirm Assignment Change</h3>
                  <p className="text-sm text-ink-muted mt-1">
                    You are changing the semantic layer on{' '}
                    <span className="font-semibold text-ink">{dataSource?.label || 'this data source'}</span>{' '}
                    from <span className="font-semibold text-ink">{assignedOntology?.name}</span>{' '}
                    to <span className="font-semibold text-ink">{bannerConfirmTarget.ontologyName}</span>.
                  </p>
                </div>
              </div>
            </div>
            <div className="mx-6 mb-4">
              {loadingImpact ? (
                <div className="flex items-center gap-2 py-6 justify-center text-ink-muted">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span className="text-sm">Checking impacted views...</span>
                </div>
              ) : impactedViews.length > 0 ? (
                <div className="rounded-xl border border-amber-200 dark:border-amber-800/50 bg-amber-50/50 dark:bg-amber-950/20 overflow-hidden">
                  <div className="px-4 py-2.5 border-b border-amber-200/60 dark:border-amber-800/40 bg-amber-100/30 dark:bg-amber-900/20">
                    <div className="flex items-center gap-2">
                      <Eye className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                      <span className="text-xs font-bold text-amber-700 dark:text-amber-400">
                        {impactedViews.length} view{impactedViews.length !== 1 ? 's' : ''} will be affected
                      </span>
                    </div>
                  </div>
                  <div className="max-h-[200px] overflow-y-auto custom-scrollbar divide-y divide-amber-200/40 dark:divide-amber-800/30">
                    {impactedViews.map(v => (
                      <div key={v.id} className="flex items-center gap-2.5 px-4 py-2">
                        <FileText className="w-3.5 h-3.5 text-amber-500/70 flex-shrink-0" />
                        <span className="text-sm text-ink-secondary truncate">{v.name}</span>
                        <span className="text-[10px] text-ink-muted font-mono ml-auto flex-shrink-0">{v.type || 'view'}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-emerald-200 dark:border-emerald-800/50 bg-emerald-50/50 dark:bg-emerald-950/20 px-4 py-3">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                    <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400">No existing views will be affected.</span>
                  </div>
                </div>
              )}
            </div>
            {impactedViews.length > 0 && !loadingImpact && (
              <div className="mx-6 mb-4">
                <div className="rounded-xl border border-red-200 dark:border-red-800/50 bg-red-50/50 dark:bg-red-950/20 p-4">
                  <p className="text-xs font-semibold text-red-700 dark:text-red-400 mb-2">
                    This action may break {impactedViews.length} existing view{impactedViews.length !== 1 ? 's' : ''}.
                  </p>
                  <p className="text-[11px] text-red-600/70 dark:text-red-400/60 mb-3">
                    Type <span className="font-mono font-bold">change</span> to confirm.
                  </p>
                  <input
                    type="text" value={confirmText} onChange={e => setConfirmText(e.target.value)}
                    placeholder='Type "change" to confirm'
                    className="w-full px-3 py-2 rounded-lg bg-white dark:bg-black/20 border border-red-200 dark:border-red-800/50 text-sm text-ink placeholder:text-ink-muted/50 focus:outline-none focus:ring-2 focus:ring-red-500/30 transition-colors duration-150"
                  />
                </div>
              </div>
            )}
            <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-glass-border bg-black/[0.01] dark:bg-white/[0.01] rounded-b-2xl">
              <button onClick={handleCancelBannerAssign} className="px-4 py-2 rounded-xl text-sm font-medium text-ink-secondary border border-glass-border hover:bg-black/5 dark:hover:bg-white/5 transition-colors">Cancel</button>
              <button
                onClick={handleConfirmBannerAssign}
                disabled={loadingImpact || isAssigning || (impactedViews.length > 0 && confirmText.toLowerCase() !== 'change')}
                className={cn(
                  'flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-colors duration-150',
                  impactedViews.length > 0 ? 'bg-red-500 text-white hover:bg-red-600 shadow-sm shadow-red-500/20' : 'bg-indigo-500 text-white hover:bg-indigo-600 shadow-sm shadow-indigo-500/20',
                  (loadingImpact || isAssigning || (impactedViews.length > 0 && confirmText.toLowerCase() !== 'change')) && 'opacity-50 cursor-not-allowed',
                )}
              >
                {isAssigning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : impactedViews.length > 0 ? <AlertTriangle className="w-3.5 h-3.5" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                {impactedViews.length > 0 ? `Change Anyway (${impactedViews.length} view${impactedViews.length !== 1 ? 's' : ''} affected)` : 'Confirm Change'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
// Shared environment list used by the Radix Popover
// ─────────────────────────────────────────────────────────────────

function groupByWorkspace<T extends { workspaceId: string }>(items: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const group = groups.get(item.workspaceId) ?? []
    group.push(item)
    groups.set(item.workspaceId, group)
  }
  return groups
}

interface EnvironmentListProps {
  envSearch: string
  ontologyDataSources: Array<{ workspaceId: string; workspaceName: string; dataSourceId: string; dataSourceLabel: string }>
  allDataSources: Array<{ workspaceId: string; workspaceName: string; dataSourceId: string; dataSourceLabel: string; ontologyId?: string }>
  selectedOntologyId: string | null
  activeWorkspaceId: string | null
  activeDataSourceId: string | null
  onSelect: (workspaceId: string, dataSourceId: string) => void
}

function EnvironmentList({
  envSearch,
  ontologyDataSources,
  allDataSources,
  selectedOntologyId,
  activeWorkspaceId,
  activeDataSourceId,
  onSelect,
}: EnvironmentListProps) {
  const filteredOntologySources = envSearch
    ? ontologyDataSources.filter(e =>
        e.workspaceName.toLowerCase().includes(envSearch.toLowerCase()) ||
        e.dataSourceLabel.toLowerCase().includes(envSearch.toLowerCase())
      )
    : ontologyDataSources

  const filteredOtherSources = (envSearch
    ? allDataSources.filter(e =>
        e.workspaceName.toLowerCase().includes(envSearch.toLowerCase()) ||
        e.dataSourceLabel.toLowerCase().includes(envSearch.toLowerCase())
      )
    : allDataSources
  ).filter(e => !selectedOntologyId || e.ontologyId !== selectedOntologyId)

  const ontologyGroups = groupByWorkspace(filteredOntologySources)
  const otherGroups = groupByWorkspace(filteredOtherSources)

  return (
    <div className="max-h-[50vh] overflow-y-auto custom-scrollbar p-2 space-y-1">
      {ontologyDataSources.length > 0 && filteredOntologySources.length > 0 && (
        <div>
          <div className="px-2 py-1.5 flex items-center gap-1.5">
            <span className="text-[10px] font-bold text-ink-muted uppercase tracking-wider">Using this semantic layer</span>
            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-900/50 text-indigo-500">{ontologyDataSources.length}</span>
          </div>
          {[...ontologyGroups.entries()].map(([wsId, envs]) => (
            <div key={wsId} className="mb-1">
              <div className="px-2 pb-0.5 flex items-center gap-1.5">
                <Layers className="w-3 h-3 text-ink-muted/50" />
                <span className="text-[11px] font-semibold text-ink-muted truncate">{envs[0].workspaceName}</span>
              </div>
              {envs.map(env => {
                const isActive = env.workspaceId === activeWorkspaceId && env.dataSourceId === activeDataSourceId
                return (
                  <button
                    key={env.dataSourceId}
                    onClick={() => onSelect(env.workspaceId, env.dataSourceId)}
                    className={cn(
                      'w-full flex items-center gap-2 px-3 py-2 ml-2 rounded-lg text-left transition-colors',
                      isActive ? 'bg-indigo-500/[0.08] text-indigo-600 dark:text-indigo-400' : 'text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 hover:text-ink',
                    )}
                  >
                    <Database className={cn('w-3.5 h-3.5 flex-shrink-0', isActive ? 'text-indigo-500' : 'text-ink-muted')} />
                    <span className="text-sm font-medium truncate">{env.dataSourceLabel}</span>
                    {isActive && <Check className="w-3.5 h-3.5 text-indigo-500 ml-auto flex-shrink-0" />}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      )}
      {filteredOtherSources.length > 0 && (
        <div>
          {ontologyDataSources.length > 0 && filteredOntologySources.length > 0 && (
            <div className="mx-2 my-2 border-t border-glass-border/60" />
          )}
          <div className="px-2 py-1.5">
            <span className="text-[10px] font-bold text-ink-muted uppercase tracking-wider">Other environments</span>
          </div>
          {[...otherGroups.entries()].map(([wsId, envs]) => (
            <div key={wsId} className="mb-1">
              <div className="px-2 pb-0.5 flex items-center gap-1.5">
                <Layers className="w-3 h-3 text-ink-muted/50" />
                <span className="text-[11px] font-semibold text-ink-muted truncate">{envs[0].workspaceName}</span>
              </div>
              {envs.map(env => (
                <button
                  key={env.dataSourceId}
                  onClick={() => onSelect(env.workspaceId, env.dataSourceId)}
                  className="w-full flex items-center gap-2 px-3 py-2 ml-2 rounded-lg text-left text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 hover:text-ink transition-colors"
                >
                  <Database className="w-3.5 h-3.5 text-ink-muted flex-shrink-0" />
                  <span className="text-sm font-medium truncate">{env.dataSourceLabel}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
      {filteredOntologySources.length === 0 && filteredOtherSources.length === 0 && (
        <div className="px-4 py-6 text-center text-xs text-ink-muted">
          {envSearch ? 'No environments match your search' : 'No data sources available'}
        </div>
      )}
    </div>
  )
}
