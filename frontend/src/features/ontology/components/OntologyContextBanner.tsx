/**
 * OntologyContextBanner — shows the active workspace/data source context
 * and the ontology assignment status.
 *
 * Layout (top → bottom):
 *   Row 1: [ENVIRONMENT]  Workspace > Data Source picker  |  [ASSIGNED LAYER]  badge + actions
 *   Row 2 (conditional): Mismatch warning OR no-assignment warning
 *
 * Uses Radix Popover for dropdowns (portal-rendered, never clipped).
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
  Lock,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import type { WorkspaceResponse, DataSourceResponse } from '@/services/workspaceService'
import { listViews, type View } from '@/services/viewApiService'
import { OntologyStatusBadge } from './OntologyStatusBadge'

// ---------------------------------------------------------------------------
// QuickAssignmentBar — compact bar showing current assignments as chips
// with ability to assign to any data source across all workspaces.
// ---------------------------------------------------------------------------

function QuickAssignmentBar({
  workspaces,
  selectedOntologyId,
  isAssigning,
  onAssignToDataSource,
  onUnassignFromDataSource,
  onRollOutToWorkspace,
}: {
  workspaces: WorkspaceResponse[]
  selectedOntologyId: string
  isAssigning: boolean
  onAssignToDataSource: (wsId: string, dsId: string) => void
  onUnassignFromDataSource?: (wsId: string, dsId: string) => void
  onRollOutToWorkspace?: (wsId: string) => void
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerSearch, setPickerSearch] = useState('')

  // Find all data sources currently using this ontology
  const assignments = useMemo(() => {
    const result: Array<{ wsId: string; wsName: string; dsId: string; dsLabel: string }> = []
    for (const ws of workspaces) {
      for (const ds of ws.dataSources ?? []) {
        if (ds.ontologyId === selectedOntologyId) {
          result.push({ wsId: ws.id, wsName: ws.name, dsId: ds.id, dsLabel: ds.label || ds.id })
        }
      }
    }
    return result
  }, [workspaces, selectedOntologyId])

  // All data sources for the assignment picker
  const allDataSources = useMemo(() => {
    const q = pickerSearch.toLowerCase()
    return workspaces.map(ws => ({
      ...ws,
      filteredDs: (ws.dataSources ?? []).filter(ds => {
        if (!q) return true
        return (ds.label || ds.id).toLowerCase().includes(q) || ws.name.toLowerCase().includes(q)
      }),
    })).filter(ws => ws.filteredDs.length > 0)
  }, [workspaces, pickerSearch])

  return (
    <div className="flex items-center gap-2 px-5 py-2 border-t border-glass-border/40 bg-black/[0.01] dark:bg-white/[0.01]">
      <span className="text-[10px] font-semibold text-ink-muted uppercase tracking-wider flex-shrink-0">
        Assigned to
      </span>

      {/* Assignment chips */}
      <div className="flex items-center gap-1.5 flex-wrap flex-1 min-w-0">
        {assignments.length === 0 && (
          <span className="text-[11px] text-ink-muted/50 italic">No data sources</span>
        )}
        {assignments.map(a => (
          <span
            key={`${a.wsId}-${a.dsId}`}
            className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-[10px] font-semibold text-emerald-700 dark:text-emerald-400 group"
          >
            <Database className="w-2.5 h-2.5 opacity-60" />
            <span className="truncate max-w-[120px]" title={`${a.wsName} / ${a.dsLabel}`}>
              {a.dsLabel}
            </span>
            {onUnassignFromDataSource && (
              <button
                onClick={() => onUnassignFromDataSource(a.wsId, a.dsId)}
                disabled={isAssigning}
                className="p-0.5 rounded-full hover:bg-red-500/20 text-emerald-500 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100 disabled:opacity-30"
                title="Unassign"
              >
                <X className="w-2.5 h-2.5" />
              </button>
            )}
          </span>
        ))}
      </div>

      {/* Assign button with picker */}
      <Popover.Root open={pickerOpen} onOpenChange={setPickerOpen}>
        <Popover.Trigger asChild>
          <button
            disabled={isAssigning}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-semibold text-indigo-600 dark:text-indigo-400 bg-indigo-500/[0.08] hover:bg-indigo-500/[0.15] border border-indigo-500/20 transition-all disabled:opacity-50 flex-shrink-0"
          >
            {isAssigning ? <Loader2 className="w-3 h-3 animate-spin" /> : <Layers className="w-3 h-3" />}
            Assign
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            className="w-[320px] bg-canvas-elevated border border-glass-border rounded-xl shadow-2xl overflow-hidden z-50 animate-in fade-in zoom-in-95"
            sideOffset={6}
            align="end"
          >
            {/* Search */}
            <div className="p-3 border-b border-glass-border/50">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted/50" />
                <input
                  type="text"
                  value={pickerSearch}
                  onChange={e => setPickerSearch(e.target.value)}
                  placeholder="Search data sources..."
                  className="w-full pl-9 pr-3 py-2 rounded-lg bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border/60 text-xs text-ink placeholder:text-ink-muted/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 transition-all"
                  autoFocus
                />
              </div>
            </div>

            {/* Workspace/DataSource tree */}
            <div className="max-h-[300px] overflow-y-auto p-2">
              {allDataSources.map(ws => (
                <div key={ws.id} className="mb-1">
                  <div className="flex items-center justify-between px-2 py-1.5">
                    <span className="text-[10px] font-semibold text-ink-muted uppercase tracking-wider truncate">
                      {ws.name}
                    </span>
                    {onRollOutToWorkspace && (
                      <button
                        onClick={() => { onRollOutToWorkspace(ws.id); setPickerOpen(false) }}
                        disabled={isAssigning}
                        className="text-[9px] font-semibold text-indigo-500 hover:text-indigo-600 transition-colors disabled:opacity-50"
                      >
                        Assign all
                      </button>
                    )}
                  </div>
                  {ws.filteredDs.map(ds => {
                    const isAssigned = ds.ontologyId === selectedOntologyId
                    const hasOtherOntology = !!ds.ontologyId && !isAssigned
                    return (
                      <button
                        key={ds.id}
                        onClick={() => {
                          if (!isAssigned) {
                            onAssignToDataSource(ws.id, ds.id)
                            setPickerOpen(false)
                          }
                        }}
                        disabled={isAssigning || isAssigned}
                        className={cn(
                          'w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-all',
                          isAssigned
                            ? 'bg-emerald-500/[0.06] text-emerald-700 dark:text-emerald-400'
                            : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.03] text-ink-secondary',
                          (isAssigning || isAssigned) && 'cursor-default',
                        )}
                      >
                        <Database className={cn('w-3.5 h-3.5 flex-shrink-0', isAssigned ? 'text-emerald-500' : 'text-ink-muted/50')} />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium truncate">{ds.label || ds.id}</p>
                          {hasOtherOntology && (
                            <p className="text-[10px] text-amber-500 mt-0.5">Currently uses another schema</p>
                          )}
                        </div>
                        {isAssigned && <Check className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />}
                      </button>
                    )
                  })}
                </div>
              ))}
              {allDataSources.length === 0 && (
                <p className="text-center text-xs text-ink-muted py-6">No data sources found</p>
              )}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  )
}

// ---------------------------------------------------------------------------

interface ImpactedView {
  id: string
  name: string
  type: string
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
  /** Assign the current ontology to any data source (ontology-centric) */
  onAssignToDataSource?: (workspaceId: string, dataSourceId: string) => void
  /** Unassign the current ontology from a data source */
  onUnassignFromDataSource?: (workspaceId: string, dataSourceId: string) => void
  /** Roll out the current ontology to all data sources in a workspace */
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
  const [assignOpen, setAssignOpen] = useState(false)
  const [assignSearch, setAssignSearch] = useState('')
  const assignSearchRef = useRef<HTMLInputElement>(null)

  // Confirmation dialog state
  const [confirmTarget, setConfirmTarget] = useState<{ ontologyId: string | undefined; ontologyName: string } | null>(null)
  const [impactedViews, setImpactedViews] = useState<ImpactedView[]>([])
  const [loadingImpact, setLoadingImpact] = useState(false)
  const [confirmText, setConfirmText] = useState('')

  // Data sources that use the currently selected ontology
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

  // All data sources across workspaces
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

  const assignedOntology = dataSource?.ontologyId
    ? ontologies.find(o => o.id === dataSource.ontologyId) ?? null
    : null

  const isViewingAssigned = selectedOntology && assignedOntology && selectedOntology.id === assignedOntology.id
  const isViewingDifferent = selectedOntology && assignedOntology && selectedOntology.id !== assignedOntology.id

  // Focus assign search when picker opens
  useEffect(() => {
    if (assignOpen) setTimeout(() => assignSearchRef.current?.focus(), 50)
    else setAssignSearch('')
  }, [assignOpen])

  // Filter ontologies for assignment picker
  const filteredOntologies = useMemo(() => {
    if (!assignSearch.trim()) return ontologies
    const q = assignSearch.toLowerCase()
    return ontologies.filter(o =>
      o.name.toLowerCase().includes(q) ||
      o.scope?.toLowerCase().includes(q)
    )
  }, [ontologies, assignSearch])

  // Fetch impacted views and show confirmation
  const initiateAssign = useCallback(async (ontologyId: string | undefined, ontologyName: string) => {
    if (!workspace || !dataSource) return

    if (assignedOntology) {
      setLoadingImpact(true)
      setConfirmTarget({ ontologyId, ontologyName })
      try {
        const views = await listViews({ workspaceId: workspace.id })
        setImpactedViews(views.map((v: View) => ({ id: v.id, name: v.name, type: v.viewType ?? 'view' })))
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

  const handleConfirmAssign = () => {
    if (!confirmTarget) return
    onAssign(confirmTarget.ontologyId)
    setConfirmTarget(null)
    setImpactedViews([])
  }

  const handleCancelAssign = () => {
    setConfirmTarget(null)
    setImpactedViews([])
    setConfirmText('')
  }

  // ── No environment selected ─────────────────────────────────────
  if (!workspace || !dataSource) {
    return (
      <div className="mb-4">
        <div className="rounded-2xl border border-dashed border-glass-border bg-canvas-elevated/30">
          <div className="flex items-center gap-3 px-5 py-3.5">
            <div className="w-8 h-8 rounded-lg bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border flex items-center justify-center flex-shrink-0">
              <Database className="w-4 h-4 text-ink-muted/50" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-ink-secondary">No environment selected</p>
              <p className="text-[11px] text-ink-muted mt-0.5">Select a data source to evaluate coverage, view graph stats, and use the Suggest feature.</p>
            </div>

            <Popover.Root open={envOpen} onOpenChange={(open) => { setEnvOpen(open); if (!open) setEnvSearch('') }}>
              <Popover.Trigger asChild>
                <button className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold border border-glass-border hover:border-indigo-300 hover:bg-indigo-500/[0.06] text-ink-secondary hover:text-indigo-600 transition-all">
                  <Database className="w-3.5 h-3.5" />
                  Select Environment
                  <ChevronDown className={cn('w-3 h-3 text-ink-muted/40 transition-transform', envOpen && 'rotate-180')} />
                </button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  side="bottom"
                  align="end"
                  sideOffset={6}
                  className="w-[380px] bg-canvas-elevated border border-glass-border rounded-2xl shadow-2xl shadow-black/15 dark:shadow-black/40 z-50 overflow-hidden animate-in fade-in zoom-in-95 data-[side=bottom]:slide-in-from-top-2"
                >
                  <div className="p-3 border-b border-glass-border">
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted" />
                      <input
                        type="text"
                        value={envSearch}
                        onChange={e => setEnvSearch(e.target.value)}
                        placeholder="Search environments..."
                        autoFocus
                        className="w-full pl-9 pr-3 py-2 rounded-xl bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border text-sm text-ink placeholder:text-ink-muted/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 transition-all"
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
                    onSelect={(wsId, dsId) => {
                      onSwitchEnvironment(wsId, dsId)
                      setEnvOpen(false)
                    }}
                  />
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          </div>
        </div>
      </div>
    )
  }

  // ── Environment selected ────────────────────────────────────────
  // Key on dataSource.id to trigger a subtle re-render animation on switch
  return (
    <div className="mb-4">
      <div
        key={dataSource.id}
        className="rounded-2xl border border-glass-border bg-canvas-elevated/60 backdrop-blur-sm animate-in fade-in duration-300"
      >
        {/* Main row — two labeled sections, equal height */}
        <div className="flex items-stretch divide-x divide-glass-border/60">

          {/* ── Left: Environment ── */}
          <div className="flex-1 min-w-0 px-5 py-3 flex flex-col justify-center">
            <div className="text-[10px] font-bold text-ink-muted/60 uppercase tracking-widest mb-1.5">Environment</div>
            <div className="flex items-center gap-2 min-w-0">
              {/* Workspace */}
              <div className="flex items-center gap-1.5 min-w-0 flex-shrink-0">
                <div className="w-6 h-6 rounded-md bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200/40 dark:border-indigo-800/40 flex items-center justify-center flex-shrink-0">
                  <Layers className="w-3 h-3 text-indigo-500" />
                </div>
                <span className="text-sm font-semibold text-ink truncate">{workspace.name}</span>
              </div>

              <ChevronRight className="w-3 h-3 text-ink-muted/40 flex-shrink-0" />

              {/* Data source switcher */}
              <Popover.Root open={envOpen} onOpenChange={(open) => { setEnvOpen(open); if (!open) setEnvSearch('') }}>
                <Popover.Trigger asChild>
                  <button className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg hover:bg-black/[0.04] dark:hover:bg-white/[0.04] transition-colors min-w-0">
                    <Database className="w-3.5 h-3.5 text-indigo-500/70 flex-shrink-0" />
                    <span className="text-sm font-medium text-ink truncate max-w-[200px]">
                      {dataSource.label || 'Data Source'}
                    </span>
                    <ChevronDown className={cn(
                      'w-3 h-3 text-ink-muted/40 flex-shrink-0 transition-transform',
                      envOpen && 'rotate-180',
                    )} />
                    {ontologyDataSources.length > 1 && (
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-900/50 text-indigo-500 flex-shrink-0">
                        {ontologyDataSources.length}
                      </span>
                    )}
                  </button>
                </Popover.Trigger>

                <Popover.Portal>
                  <Popover.Content
                    side="bottom"
                    align="start"
                    sideOffset={6}
                    className="w-[380px] bg-canvas-elevated border border-glass-border rounded-2xl shadow-2xl shadow-black/15 dark:shadow-black/40 z-50 overflow-hidden animate-in fade-in zoom-in-95 data-[side=bottom]:slide-in-from-top-2"
                  >
                    <div className="p-3 border-b border-glass-border">
                      <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted" />
                        <input
                          type="text"
                          value={envSearch}
                          onChange={e => setEnvSearch(e.target.value)}
                          placeholder="Search environments..."
                          autoFocus
                          className="w-full pl-9 pr-3 py-2 rounded-xl bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border text-sm text-ink placeholder:text-ink-muted/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 transition-all"
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
                      onSelect={(wsId, dsId) => {
                        onSwitchEnvironment(wsId, dsId)
                        setEnvOpen(false)
                      }}
                    />
                  </Popover.Content>
                </Popover.Portal>
              </Popover.Root>
            </div>
          </div>

          {/* ── Right: Assigned Layer ── */}
          <div className="flex-shrink-0 px-5 py-3 flex flex-col justify-center">
            <div className="text-[10px] font-bold text-ink-muted/60 uppercase tracking-widest mb-1.5">Assigned Layer</div>
            <div className="flex items-center gap-2">
              {assignedOntology ? (
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-emerald-50/80 dark:bg-emerald-950/20 border border-emerald-200/50 dark:border-emerald-800/40">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />
                  <span className="text-xs font-semibold text-ink">{assignedOntology.name}</span>
                  <span className={cn(
                    'inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-[10px] font-bold font-mono border',
                    assignedOntology.isPublished || assignedOntology.isSystem
                      ? 'bg-emerald-100/60 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 border-emerald-200/40 dark:border-emerald-800/30'
                      : 'bg-amber-100/60 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 border-amber-200/40 dark:border-amber-800/30',
                  )}>
                    {assignedOntology.isPublished || assignedOntology.isSystem
                      ? <Lock className="w-2.5 h-2.5" />
                      : <PenLine className="w-2.5 h-2.5" />}
                    v{assignedOntology.version}
                  </span>
                </div>
              ) : (
                /* Not assigned: ontology assignment picker */
                <Popover.Root open={assignOpen} onOpenChange={setAssignOpen}>
                  <Popover.Trigger asChild>
                    <button
                      disabled={isAssigning}
                      className={cn(
                        'flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all',
                        'bg-indigo-500 text-white hover:bg-indigo-600 shadow-md shadow-indigo-500/20 hover:shadow-lg hover:shadow-indigo-500/30',
                      )}
                    >
                      {isAssigning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Layers className="w-3.5 h-3.5" />}
                      Assign Semantic Layer
                    </button>
                  </Popover.Trigger>

                  <Popover.Portal>
                    <Popover.Content
                      side="bottom"
                      align="end"
                      sideOffset={6}
                      className="w-[420px] bg-canvas-elevated border border-glass-border rounded-2xl shadow-2xl shadow-black/15 dark:shadow-black/40 z-50 overflow-hidden animate-in fade-in zoom-in-95 data-[side=bottom]:slide-in-from-top-2"
                    >
                      {/* Header */}
                      <div className="px-4 pt-4 pb-3 border-b border-glass-border">
                        <h3 className="text-sm font-bold text-ink mb-1">Assign Semantic Layer</h3>
                        <p className="text-[11px] text-ink-muted">
                          Select a semantic layer for <span className="font-medium text-ink-secondary">{dataSource.label || 'this data source'}</span>
                        </p>
                        <div className="relative mt-3">
                          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted" />
                          <input
                            ref={assignSearchRef}
                            type="text"
                            value={assignSearch}
                            onChange={e => setAssignSearch(e.target.value)}
                            placeholder="Search semantic layers..."
                            className="w-full pl-9 pr-3 py-2 rounded-xl bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border text-sm text-ink placeholder:text-ink-muted/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 transition-all"
                          />
                        </div>
                      </div>

                      {/* Options */}
                      <div className="max-h-[360px] overflow-y-auto custom-scrollbar p-2 space-y-1">
                        {/* None option */}
                        <button
                          onClick={() => initiateAssign(undefined, 'None (system defaults)')}
                          className={cn(
                            'w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left transition-all',
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
                              onClick={() => !isCurrentlyAssigned && initiateAssign(o.id, o.name)}
                              disabled={isCurrentlyAssigned}
                              className={cn(
                                'w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left transition-all',
                                isCurrentlyAssigned
                                  ? 'bg-emerald-500/[0.06] border border-emerald-500/15'
                                  : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.03] border border-transparent cursor-pointer',
                              )}
                            >
                              <div className={cn(
                                'w-9 h-9 rounded-xl border flex items-center justify-center flex-shrink-0',
                                o.isSystem
                                  ? 'bg-blue-50 dark:bg-blue-950/30 border-blue-200/50 dark:border-blue-800/40'
                                  : o.isPublished
                                  ? 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200/50 dark:border-emerald-800/40'
                                  : 'bg-amber-50 dark:bg-amber-950/30 border-amber-200/50 dark:border-amber-800/40',
                              )}>
                                <StatusIcon className={cn(
                                  'w-4 h-4',
                                  o.isSystem ? 'text-blue-500' : o.isPublished ? 'text-emerald-500' : 'text-amber-500',
                                )} />
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-semibold text-ink truncate">{o.name}</span>
                                  <span className="text-[10px] text-ink-muted font-mono flex-shrink-0">v{o.version}</span>
                                  <OntologyStatusBadge ontology={o} size="xs" />
                                </div>
                                <div className="flex items-center gap-3 text-[11px] text-ink-muted mt-1">
                                  <span className="flex items-center gap-1">
                                    <Box className="w-2.5 h-2.5" />
                                    {entityCount} entit{entityCount === 1 ? 'y' : 'ies'}
                                  </span>
                                  <span className="flex items-center gap-1">
                                    <GitBranch className="w-2.5 h-2.5" />
                                    {relCount} rel{relCount === 1 ? '' : 's'}
                                  </span>
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

                      {/* Footer */}
                      <div className="px-4 py-3 border-t border-glass-border bg-black/[0.02] dark:bg-white/[0.02]">
                        <a
                          href="/schema"
                          className="flex items-center gap-1.5 text-[11px] font-medium text-indigo-500 hover:text-indigo-600 transition-colors"
                        >
                          <ExternalLink className="w-3 h-3" />
                          Manage semantic layers
                        </a>
                      </div>
                    </Popover.Content>
                  </Popover.Portal>
                </Popover.Root>
              )}
            </div>
          </div>
        </div>

        {/* ── Status row: mismatch / no assignment / in-sync ── */}

        {/* Mismatch: viewing ontology X but data source uses ontology Y */}
        {isViewingDifferent && selectedOntology && (
          <div className="px-5 py-2.5 border-t border-amber-200/40 dark:border-amber-800/30 bg-gradient-to-r from-amber-50/60 to-orange-50/30 dark:from-amber-950/15 dark:to-orange-950/10 rounded-b-2xl">
            <div className="flex items-center gap-3">
              <ArrowRightLeft className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
              <p className="text-[11px] text-amber-700 dark:text-amber-400 flex-1">
                <span className="font-semibold">Viewing &ldquo;{selectedOntology.name}&rdquo;</span>
                {' '}but this data source uses{' '}
                <span className="font-semibold">&ldquo;{assignedOntology!.name}&rdquo;</span>.
                {' '}Coverage and graph stats reflect the selected environment, not this layer.
              </p>
              <button
                onClick={() => initiateAssign(selectedOntology.id, selectedOntology.name)}
                disabled={isAssigning}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-amber-500 text-white hover:bg-amber-600 transition-all shadow-sm shadow-amber-500/20 disabled:opacity-50 flex-shrink-0"
              >
                {isAssigning ? <Loader2 className="w-3 h-3 animate-spin" /> : <ArrowRightLeft className="w-3 h-3" />}
                Re-assign
              </button>
            </div>
          </div>
        )}

        {/* No ontology assigned at all */}
        {!assignedOntology && (
          <div className="px-5 py-2.5 border-t border-amber-200/40 dark:border-amber-800/30 bg-gradient-to-r from-amber-50/60 to-orange-50/30 dark:from-amber-950/15 dark:to-orange-950/10 rounded-b-2xl">
            <div className="flex items-center gap-2.5">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
              <p className="text-[11px] text-amber-700 dark:text-amber-400">
                <span className="font-semibold">No semantic layer assigned.</span>{' '}
                A semantic layer must be assigned to this data source before you can create views.
              </p>
            </div>
          </div>
        )}

        {/* In sync: viewing the same ontology that's assigned */}
        {isViewingAssigned && (
          <div className="px-5 py-2 border-t border-emerald-200/30 dark:border-emerald-800/20 bg-emerald-50/30 dark:bg-emerald-950/10 rounded-b-2xl">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-3 h-3 text-emerald-500 flex-shrink-0" />
              <p className="text-[11px] text-emerald-700 dark:text-emerald-400">
                This layer is assigned to the selected data source. Coverage and graph stats reflect live data.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* ── Quick Assignment Chips (ontology-centric) ── */}
      {selectedOntology && onAssignToDataSource && (
        <QuickAssignmentBar
          workspaces={workspaces}
          selectedOntologyId={selectedOntology.id}
          isAssigning={isAssigning}
          onAssignToDataSource={onAssignToDataSource}
          onUnassignFromDataSource={onUnassignFromDataSource}
          onRollOutToWorkspace={onRollOutToWorkspace}
        />
      )}

      {/* ── Re-assignment Confirmation Dialog ── */}
      {confirmTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={handleCancelAssign} />

          <div className="relative w-full max-w-lg mx-4 rounded-2xl border border-glass-border bg-canvas-elevated shadow-2xl animate-in fade-in slide-in-from-bottom-4 duration-200">
            <button
              onClick={handleCancelAssign}
              className="absolute top-4 right-4 p-1 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            >
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
                    to <span className="font-semibold text-ink">{confirmTarget.ontologyName}</span>.
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
                    <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
                      No existing views will be affected by this change.
                    </span>
                  </div>
                </div>
              )}
            </div>

            {impactedViews.length > 0 && !loadingImpact && (
              <div className="mx-6 mb-4">
                <div className="rounded-xl border border-red-200 dark:border-red-800/50 bg-red-50/50 dark:bg-red-950/20 p-4">
                  <p className="text-xs font-semibold text-red-700 dark:text-red-400 mb-2">
                    This action may break {impactedViews.length} existing view{impactedViews.length !== 1 ? 's' : ''}. This cannot be undone.
                  </p>
                  <p className="text-[11px] text-red-600/70 dark:text-red-400/60 mb-3">
                    Type <span className="font-mono font-bold">change</span> to confirm.
                  </p>
                  <input
                    type="text"
                    value={confirmText}
                    onChange={e => setConfirmText(e.target.value)}
                    placeholder='Type "change" to confirm'
                    className="w-full px-3 py-2 rounded-lg bg-white dark:bg-black/20 border border-red-200 dark:border-red-800/50 text-sm text-ink placeholder:text-ink-muted/50 focus:outline-none focus:ring-2 focus:ring-red-500/30 transition-all"
                  />
                </div>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-glass-border bg-black/[0.01] dark:bg-white/[0.01] rounded-b-2xl">
              <button
                onClick={handleCancelAssign}
                className="px-4 py-2 rounded-xl text-sm font-medium text-ink-secondary border border-glass-border hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmAssign}
                disabled={loadingImpact || isAssigning || (impactedViews.length > 0 && confirmText.toLowerCase() !== 'change')}
                className={cn(
                  'flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all',
                  impactedViews.length > 0
                    ? 'bg-red-500 text-white hover:bg-red-600 shadow-sm shadow-red-500/20'
                    : 'bg-indigo-500 text-white hover:bg-indigo-600 shadow-sm shadow-indigo-500/20',
                  (loadingImpact || isAssigning || (impactedViews.length > 0 && confirmText.toLowerCase() !== 'change')) && 'opacity-50 cursor-not-allowed',
                )}
              >
                {isAssigning ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : impactedViews.length > 0 ? (
                  <AlertTriangle className="w-3.5 h-3.5" />
                ) : (
                  <CheckCircle2 className="w-3.5 h-3.5" />
                )}
                {impactedViews.length > 0
                  ? `Change Anyway (${impactedViews.length} view${impactedViews.length !== 1 ? 's' : ''} affected)`
                  : 'Confirm Change'}
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
      {/* Data sources using this ontology */}
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
                      isActive
                        ? 'bg-indigo-500/[0.08] text-indigo-600 dark:text-indigo-400'
                        : 'text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 hover:text-ink',
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

      {/* Other data sources */}
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
