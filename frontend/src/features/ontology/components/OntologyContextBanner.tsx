/**
 * OntologyContextBanner — shows the active workspace/data source context
 * and the ontology assignment status. Makes it crystal clear whether an
 * ontology is assigned and provides a modern picker to change it.
 *
 * When re-assigning, fetches impacted views and shows a confirmation
 * dialog before committing.
 */
import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import {
  Layers,
  ChevronRight,
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
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import type { WorkspaceResponse, DataSourceResponse } from '@/services/workspaceService'
import { workspaceService } from '@/services/workspaceService'
import type { GraphSchemaStats } from '@/providers/GraphDataProvider'
import { OntologyStatusBadge } from './OntologyStatusBadge'
import { formatCount } from '../lib/ontology-parsers'

interface ImpactedView {
  id: string
  name: string
  type: string
}

interface OntologyContextBannerProps {
  workspace: WorkspaceResponse | null
  dataSource: DataSourceResponse | null
  ontologies: OntologyDefinitionResponse[]
  selectedOntology: OntologyDefinitionResponse | null
  graphStats: GraphSchemaStats | null
  isAssigning: boolean
  onAssign: (ontologyId: string | undefined) => void
}

export function OntologyContextBanner({
  workspace,
  dataSource,
  ontologies,
  selectedOntology,
  graphStats,
  isAssigning,
  onAssign,
}: OntologyContextBannerProps) {
  const [showPicker, setShowPicker] = useState(false)
  const [search, setSearch] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const pickerRef = useRef<HTMLDivElement>(null)

  // Confirmation dialog state
  const [confirmTarget, setConfirmTarget] = useState<{ ontologyId: string | undefined; ontologyName: string } | null>(null)
  const [impactedViews, setImpactedViews] = useState<ImpactedView[]>([])
  const [loadingImpact, setLoadingImpact] = useState(false)

  const assignedOntology = dataSource?.ontologyId
    ? ontologies.find(o => o.id === dataSource.ontologyId) ?? null
    : null

  const isViewingDifferent = selectedOntology && selectedOntology.id !== (assignedOntology?.id ?? null)

  // Focus search when picker opens
  useEffect(() => {
    if (showPicker) {
      setTimeout(() => searchRef.current?.focus(), 50)
    } else {
      setSearch('')
    }
  }, [showPicker])

  // Close picker on outside click
  useEffect(() => {
    if (!showPicker) return
    function handleClick(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowPicker(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showPicker])

  // Filter ontologies by search
  const filteredOntologies = useMemo(() => {
    if (!search.trim()) return ontologies
    const q = search.toLowerCase()
    return ontologies.filter(o =>
      o.name.toLowerCase().includes(q) ||
      o.scope?.toLowerCase().includes(q)
    )
  }, [ontologies, search])

  // Fetch impacted views and show confirmation
  const initiateAssign = useCallback(async (ontologyId: string | undefined, ontologyName: string) => {
    if (!workspace || !dataSource) return

    // If there's already an assigned ontology, fetch impact before confirming
    if (assignedOntology) {
      setLoadingImpact(true)
      setConfirmTarget({ ontologyId, ontologyName })
      try {
        const impact = await workspaceService.getDataSourceImpact(workspace.id, dataSource.id)
        setImpactedViews(impact.views ?? [])
      } catch {
        setImpactedViews([])
      } finally {
        setLoadingImpact(false)
      }
    } else {
      // No ontology assigned yet, just assign directly (no views to impact)
      onAssign(ontologyId)
    }

    setShowPicker(false)
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
  }

  // No workspace state
  if (!workspace) {
    return (
      <div className="mb-4 px-5 py-4 rounded-2xl border border-amber-200/60 dark:border-amber-800/40 bg-gradient-to-r from-amber-50/80 to-orange-50/50 dark:from-amber-950/20 dark:to-orange-950/10">
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-lg bg-amber-100 dark:bg-amber-900/40 border border-amber-200/50 dark:border-amber-800/50 flex items-center justify-center flex-shrink-0">
            <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400" />
          </div>
          <div>
            <p className="text-sm font-semibold text-ink">No workspace active</p>
            <p className="text-xs text-ink-muted mt-0.5">
              Set up a workspace in the{' '}
              <a href="/admin/registry?tab=workspaces" className="text-indigo-500 hover:text-indigo-600 font-medium hover:underline transition-colors">
                Registry
              </a>
              {' '}to manage ontologies and assign them to data sources.
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="mb-4">
      <div className="rounded-2xl border border-glass-border bg-canvas-elevated/60 backdrop-blur-sm overflow-hidden">
        {/* Main row */}
        <div className="flex items-center justify-between gap-4 px-5 py-3">
          {/* Left: breadcrumb context */}
          <div className="flex items-center gap-2 min-w-0">
            {/* Workspace */}
            <div className="flex items-center gap-1.5 min-w-0">
              <div className="w-6 h-6 rounded-md bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200/40 dark:border-indigo-800/40 flex items-center justify-center flex-shrink-0">
                <Layers className="w-3 h-3 text-indigo-500" />
              </div>
              <span className="text-sm font-semibold text-ink truncate">{workspace.name}</span>
            </div>

            {dataSource && (
              <>
                <ChevronRight className="w-3 h-3 text-ink-muted/40 flex-shrink-0" />
                <div className="flex items-center gap-1.5 min-w-0">
                  <Database className="w-3.5 h-3.5 text-ink-muted/60 flex-shrink-0" />
                  <span className="text-sm text-ink-secondary truncate">{dataSource.label || 'Data Source'}</span>
                </div>
              </>
            )}

            {/* Graph stats pill */}
            {graphStats && (
              <>
                <div className="w-px h-4 bg-glass-border/60 flex-shrink-0 mx-1" />
                <div className="flex items-center gap-2 text-[10px] text-ink-muted font-mono tracking-wide flex-shrink-0">
                  <span>{graphStats.entityTypeStats.length} types</span>
                  <span className="opacity-30">·</span>
                  <span>{formatCount(graphStats.totalNodes)} nodes</span>
                  <span className="opacity-30">·</span>
                  <span>{formatCount(graphStats.totalEdges)} edges</span>
                </div>
              </>
            )}
          </div>

          {/* Right: ontology assignment area */}
          <div className="flex items-center gap-2 flex-shrink-0" ref={pickerRef}>
            {assignedOntology ? (
              /* Assigned: show compact badge + action buttons */
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-emerald-50/80 dark:bg-emerald-950/20 border border-emerald-200/50 dark:border-emerald-800/40">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />
                  <span className="text-xs font-semibold text-ink">{assignedOntology.name}</span>
                  <span className="text-[10px] text-ink-muted font-mono">v{assignedOntology.version}</span>
                  <OntologyStatusBadge ontology={assignedOntology} size="xs" />
                </div>

                {isViewingDifferent && selectedOntology && (
                  <button
                    onClick={() => initiateAssign(selectedOntology.id, selectedOntology.name)}
                    disabled={isAssigning}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] font-semibold bg-amber-500 text-white hover:bg-amber-600 transition-all shadow-sm shadow-amber-500/20 disabled:opacity-50"
                    title="Re-assign this data source to the ontology you're currently viewing"
                  >
                    {isAssigning ? <Loader2 className="w-3 h-3 animate-spin" /> : <AlertTriangle className="w-3 h-3" />}
                    Re-assign to Current
                  </button>
                )}

                {dataSource && (
                  <button
                    onClick={() => setShowPicker(!showPicker)}
                    disabled={isAssigning}
                    className={cn(
                      'flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] font-semibold transition-all',
                      showPicker
                        ? 'bg-indigo-500 text-white shadow-md shadow-indigo-500/20'
                        : 'bg-indigo-500/10 border border-indigo-500/20 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500 hover:text-white hover:shadow-md hover:shadow-indigo-500/20',
                    )}
                  >
                    {isAssigning ? <Loader2 className="w-3 h-3 animate-spin" /> : <Layers className="w-3 h-3" />}
                    Change Ontology
                  </button>
                )}
              </div>
            ) : dataSource ? (
              /* Not assigned: prominent CTA */
              <button
                onClick={() => setShowPicker(!showPicker)}
                disabled={isAssigning}
                className={cn(
                  'flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all',
                  showPicker
                    ? 'bg-indigo-500 text-white shadow-lg shadow-indigo-500/25'
                    : 'bg-indigo-500 text-white hover:bg-indigo-600 shadow-md shadow-indigo-500/20 hover:shadow-lg hover:shadow-indigo-500/30',
                )}
              >
                {isAssigning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Layers className="w-3.5 h-3.5" />}
                Assign Ontology
              </button>
            ) : null}

            {/* ── Ontology Picker Dropdown ── */}
            {showPicker && dataSource && (
              <div className="absolute right-4 top-full mt-2 w-[420px] bg-canvas-elevated border border-glass-border rounded-2xl shadow-2xl shadow-black/15 dark:shadow-black/40 z-50 overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200">
                {/* Header */}
                <div className="px-4 pt-4 pb-3 border-b border-glass-border">
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <h3 className="text-sm font-bold text-ink">
                        {assignedOntology ? 'Change Ontology Assignment' : 'Assign Ontology'}
                      </h3>
                      <p className="text-[11px] text-ink-muted mt-0.5">
                        Select an ontology for <span className="font-medium text-ink-secondary">{dataSource.label || 'this data source'}</span>
                      </p>
                    </div>
                    <button
                      onClick={() => setShowPicker(false)}
                      className="p-1 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>

                  {/* Warning: changing will affect views */}
                  {assignedOntology && (
                    <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-50/80 dark:bg-amber-950/20 border border-amber-200/40 dark:border-amber-800/30 mb-3">
                      <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-0.5" />
                      <p className="text-[11px] text-amber-700 dark:text-amber-400">
                        Changing the ontology may affect views built on this data source. You'll be asked to confirm before the change is applied.
                      </p>
                    </div>
                  )}

                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted" />
                    <input
                      ref={searchRef}
                      type="text"
                      value={search}
                      onChange={e => setSearch(e.target.value)}
                      placeholder="Search ontologies..."
                      className="w-full pl-9 pr-3 py-2 rounded-xl bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border text-sm text-ink placeholder:text-ink-muted/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500/20 transition-all"
                    />
                  </div>
                </div>

                {/* Options list */}
                <div className="max-h-[360px] overflow-y-auto custom-scrollbar p-2 space-y-1">
                  {/* None option */}
                  <button
                    onClick={() => initiateAssign(undefined, 'None (system defaults)')}
                    className={cn(
                      'w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left transition-all group',
                      !dataSource.ontologyId
                        ? 'bg-indigo-500/[0.06] border border-indigo-500/15 ring-1 ring-indigo-500/10'
                        : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.03] border border-transparent',
                    )}
                  >
                    <div className="w-9 h-9 rounded-xl bg-black/[0.04] dark:bg-white/[0.06] border border-glass-border flex items-center justify-center flex-shrink-0">
                      <X className="w-4 h-4 text-ink-muted" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-ink">No ontology</div>
                      <div className="text-[11px] text-ink-muted mt-0.5">Use system defaults — views cannot be created</div>
                    </div>
                    {!dataSource.ontologyId && (
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-900/50 text-indigo-500">CURRENT</span>
                      </div>
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
                        onClick={() => {
                          if (isCurrentlyAssigned) return // already assigned, no-op
                          initiateAssign(o.id, o.name)
                        }}
                        disabled={isCurrentlyAssigned}
                        className={cn(
                          'w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left transition-all group',
                          isCurrentlyAssigned
                            ? 'bg-emerald-500/[0.06] border border-emerald-500/15 ring-1 ring-emerald-500/10'
                            : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.03] border border-transparent cursor-pointer',
                        )}
                      >
                        {/* Icon */}
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

                        {/* Details */}
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
                            {o.scope && (
                              <span className="text-ink-muted/60">{o.scope}</span>
                            )}
                          </div>
                        </div>

                        {/* Currently assigned indicator */}
                        {isCurrentlyAssigned && (
                          <div className="flex items-center gap-1.5 flex-shrink-0">
                            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/50 text-emerald-600 dark:text-emerald-400">ASSIGNED</span>
                          </div>
                        )}
                      </button>
                    )
                  })}

                  {filteredOntologies.length === 0 && (
                    <div className="px-4 py-8 text-center">
                      <Search className="w-5 h-5 text-ink-muted/40 mx-auto mb-2" />
                      <p className="text-sm text-ink-muted">No ontologies match "{search}"</p>
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
                    Manage ontologies in the editor
                  </a>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Warning bar: no ontology assigned */}
        {!assignedOntology && dataSource && (
          <div className="px-5 py-2.5 border-t border-amber-200/40 dark:border-amber-800/30 bg-gradient-to-r from-amber-50/60 to-orange-50/30 dark:from-amber-950/15 dark:to-orange-950/10">
            <div className="flex items-center gap-2.5">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
              <p className="text-[11px] text-amber-700 dark:text-amber-400">
                <span className="font-semibold">No ontology assigned.</span>{' '}
                An ontology must be assigned to this data source before you can create views.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* ── Re-assignment Confirmation Dialog ── */}
      {confirmTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={handleCancelAssign} />

          <div className="relative w-full max-w-lg mx-4 rounded-2xl border border-glass-border bg-canvas-elevated shadow-2xl animate-in fade-in slide-in-from-bottom-4 duration-200">
            {/* Close */}
            <button
              onClick={handleCancelAssign}
              className="absolute top-4 right-4 p-1 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>

            {/* Header */}
            <div className="px-6 pt-6 pb-4">
              <div className="flex items-start gap-4">
                <div className="w-10 h-10 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200/50 dark:border-amber-800/50 flex items-center justify-center flex-shrink-0">
                  <AlertTriangle className="w-5 h-5 text-amber-500" />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="text-base font-bold text-ink">Confirm Ontology Change</h3>
                  <p className="text-sm text-ink-muted mt-1">
                    You are changing the ontology on{' '}
                    <span className="font-semibold text-ink">{dataSource?.label || 'this data source'}</span>{' '}
                    from <span className="font-semibold text-ink">{assignedOntology?.name}</span>{' '}
                    to <span className="font-semibold text-ink">{confirmTarget.ontologyName}</span>.
                  </p>
                </div>
              </div>
            </div>

            {/* Impacted views section */}
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
                    <p className="text-[11px] text-amber-600/80 dark:text-amber-400/70 mt-0.5">
                      These views were built using the current ontology and may behave differently after the change.
                    </p>
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

            {/* Footer */}
            <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-glass-border bg-black/[0.01] dark:bg-white/[0.01] rounded-b-2xl">
              <button
                onClick={handleCancelAssign}
                className="px-4 py-2 rounded-lg text-sm font-medium text-ink-secondary border border-glass-border hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmAssign}
                disabled={loadingImpact || isAssigning}
                className={cn(
                  'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all',
                  impactedViews.length > 0
                    ? 'bg-amber-500 text-white hover:bg-amber-600 shadow-sm shadow-amber-500/20'
                    : 'bg-indigo-500 text-white hover:bg-indigo-600 shadow-sm shadow-indigo-500/20',
                  (loadingImpact || isAssigning) && 'opacity-50 cursor-not-allowed',
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
