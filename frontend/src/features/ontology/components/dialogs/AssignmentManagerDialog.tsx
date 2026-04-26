/**
 * AssignmentManagerDialog — full modal for managing ontology-to-data-source
 * assignments with tooltips, replace confirmation, and workspace grouping.
 */
import { useState, useMemo } from 'react'
import {
  X, Database, Layers, Search, CheckCircle2, AlertTriangle,
  ArrowRight, Loader2, Unlink, Shield, ChevronDown, ChevronRight,
  HelpCircle, RefreshCw,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import type { WorkspaceResponse } from '@/services/workspaceService'

// ---------------------------------------------------------------------------
// Tooltip — lightweight hover tooltip (no portal, just CSS positioning)
// ---------------------------------------------------------------------------

function Tooltip({ children, text }: { children: React.ReactNode; text: string }) {
  return (
    <span className="relative group/tip inline-flex">
      {children}
      <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2.5 py-1.5 rounded-lg bg-ink text-[10px] font-medium text-white whitespace-nowrap opacity-0 pointer-events-none group-hover/tip:opacity-100 transition-opacity duration-150 shadow-lg z-20 max-w-[200px] text-center leading-snug">
        {text}
        <span className="absolute top-full left-1/2 -translate-x-1/2 -mt-[1px] border-4 border-transparent border-t-ink" />
      </span>
    </span>
  )
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CategorizedDs {
  wsId: string
  wsName: string
  dsId: string
  dsLabel: string
  otherOntologyName?: string
}

interface AssignmentManagerDialogProps {
  ontology: OntologyDefinitionResponse
  workspaces: WorkspaceResponse[]
  ontologies: OntologyDefinitionResponse[]
  isAssigning: boolean
  onAssign: (workspaceId: string, dataSourceId: string) => void
  onUnassign: (workspaceId: string, dataSourceId: string) => void
  onRollOutToWorkspace: (workspaceId: string) => void
  onClose: () => void
}

type TabId = 'all' | 'assigned' | 'unassigned' | 'other'

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AssignmentManagerDialog({
  ontology,
  workspaces,
  ontologies,
  isAssigning,
  onAssign,
  onUnassign,
  onRollOutToWorkspace,
  onClose,
}: AssignmentManagerDialogProps) {
  const [search, setSearch] = useState('')
  const [searchFocused, setSearchFocused] = useState(false)
  const [activeTab, setActiveTab] = useState<TabId>('all')
  const [collapsedWs, setCollapsedWs] = useState<Set<string>>(new Set())
  const [confirmRollout, setConfirmRollout] = useState<{ wsId: string; wsName: string; dsCount: number } | null>(null)
  // Replace confirmation state
  const [confirmReplace, setConfirmReplace] = useState<CategorizedDs | null>(null)

  const ontologyNames = useMemo(() => {
    const m = new Map<string, string>()
    for (const o of ontologies) m.set(o.id, o.name)
    return m
  }, [ontologies])

  const { assignedToThis, unassigned, assignedToOther } = useMemo(() => {
    const assigned: CategorizedDs[] = []
    const none: CategorizedDs[] = []
    const other: CategorizedDs[] = []
    for (const ws of workspaces) {
      for (const ds of ws.dataSources ?? []) {
        const entry: CategorizedDs = { wsId: ws.id, wsName: ws.name, dsId: ds.id, dsLabel: ds.label || ds.id }
        if (ds.ontologyId === ontology.id) {
          assigned.push(entry)
        } else if (ds.ontologyId) {
          other.push({ ...entry, otherOntologyName: ontologyNames.get(ds.ontologyId) || ds.ontologyId })
        } else {
          none.push(entry)
        }
      }
    }
    return { assignedToThis: assigned, unassigned: none, assignedToOther: other }
  }, [workspaces, ontology.id, ontologyNames])

  const totalDs = assignedToThis.length + unassigned.length + assignedToOther.length

  const filterList = (list: CategorizedDs[]) => {
    if (!search.trim()) return list
    const q = search.toLowerCase()
    return list.filter(d => d.dsLabel.toLowerCase().includes(q) || d.wsName.toLowerCase().includes(q))
  }

  const filteredAssigned = filterList(assignedToThis)
  const filteredUnassigned = filterList(unassigned)
  const filteredOther = filterList(assignedToOther)

  function groupByWorkspace(list: CategorizedDs[]) {
    const map = new Map<string, { wsName: string; items: CategorizedDs[] }>()
    for (const d of list) {
      let group = map.get(d.wsId)
      if (!group) { group = { wsName: d.wsName, items: [] }; map.set(d.wsId, group) }
      group.items.push(d)
    }
    return Array.from(map.entries())
  }

  function toggleWs(wsId: string) {
    setCollapsedWs(prev => {
      const next = new Set(prev)
      if (next.has(wsId)) next.delete(wsId)
      else next.add(wsId)
      return next
    })
  }

  const TABS: Array<{ id: TabId; label: string; count: number; tooltip: string }> = [
    { id: 'all', label: 'All', count: totalDs, tooltip: 'Show all data sources across all workspaces' },
    { id: 'assigned', label: 'Assigned', count: assignedToThis.length, tooltip: 'Data sources currently using this ontology' },
    { id: 'unassigned', label: 'Unassigned', count: unassigned.length, tooltip: 'Data sources with no ontology — assign to enable features' },
    { id: 'other', label: 'Other Schema', count: assignedToOther.length, tooltip: 'Data sources using a different ontology — replace to switch' },
  ]

  // Render a data source row
  function DsRow({ d, variant }: { d: CategorizedDs; variant: 'assigned' | 'unassigned' | 'other' }) {
    const colors = {
      assigned: { icon: 'text-emerald-500', bg: 'hover:bg-emerald-500/[0.03]', badge: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20' },
      unassigned: { icon: 'text-red-400', bg: 'hover:bg-red-500/[0.03]', badge: '' },
      other: { icon: 'text-amber-400', bg: 'hover:bg-amber-500/[0.03]', badge: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20' },
    }[variant]

    return (
      <div className={cn('flex items-center gap-3 px-4 py-2.5 group transition-colors', colors.bg)}>
        <Tooltip text={
          variant === 'assigned' ? `This data source is using "${ontology.name}"` :
          variant === 'unassigned' ? 'No ontology assigned — limited functionality' :
          `Currently using "${d.otherOntologyName}"`
        }>
          <Database className={cn('w-4 h-4 flex-shrink-0', colors.icon)} />
        </Tooltip>

        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-ink truncate">{d.dsLabel}</p>
          <p className="text-[10px] text-ink-muted">{d.wsName}</p>
        </div>

        {variant === 'assigned' && (
          <>
            <Tooltip text="This data source is actively using this semantic layer">
              <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-bold border cursor-default', colors.badge)}>
                <CheckCircle2 className="w-2.5 h-2.5" /> Active
              </span>
            </Tooltip>
            <Tooltip text="Remove this ontology from the data source">
              <button onClick={() => onUnassign(d.wsId, d.dsId)} disabled={isAssigning}
                className="p-1.5 rounded-lg text-ink-muted hover:text-red-500 hover:bg-red-500/10 transition-colors duration-150 opacity-0 group-hover:opacity-100 disabled:opacity-30">
                <Unlink className="w-3.5 h-3.5" />
              </button>
            </Tooltip>
          </>
        )}

        {variant === 'unassigned' && (
          <Tooltip text={`Assign "${ontology.name}" to this data source to enable ontology-driven features`}>
            <button onClick={() => onAssign(d.wsId, d.dsId)} disabled={isAssigning}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-indigo-500 text-white hover:bg-indigo-600 transition-colors shadow-sm shadow-indigo-500/20 disabled:opacity-50 flex-shrink-0">
              <ArrowRight className="w-3 h-3" /> Assign
            </button>
          </Tooltip>
        )}

        {variant === 'other' && (
          <>
            <Tooltip text={`This data source currently uses "${d.otherOntologyName}"`}>
              <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-bold border max-w-[140px] cursor-default', colors.badge)}>
                <Shield className="w-2.5 h-2.5 flex-shrink-0" />
                <span className="truncate">{d.otherOntologyName}</span>
              </span>
            </Tooltip>
            <Tooltip text={`Replace "${d.otherOntologyName}" with "${ontology.name}" on this data source`}>
              <button onClick={() => setConfirmReplace(d)} disabled={isAssigning}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold text-amber-600 dark:text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 transition-colors disabled:opacity-50 flex-shrink-0 border border-amber-500/20">
                <RefreshCw className="w-3 h-3" /> Replace
              </button>
            </Tooltip>
          </>
        )}
      </div>
    )
  }

  // Render a section (with workspace grouping)
  function Section({ title, list, variant, icon: Icon, dotColor, emptyMsg, helpText }: {
    title: string
    list: CategorizedDs[]
    variant: 'assigned' | 'unassigned' | 'other'
    icon: React.ComponentType<{ className?: string }>
    dotColor: string
    emptyMsg: string
    helpText: string
  }) {
    const grouped = groupByWorkspace(list)
    if (list.length === 0) {
      return (
        <div className="px-4 py-6 text-center">
          <Icon className="w-5 h-5 text-ink-muted/30 mx-auto mb-1.5" />
          <p className="text-[11px] text-ink-muted">{emptyMsg}</p>
        </div>
      )
    }

    return (
      <div>
        <div className="flex items-center gap-2 px-4 pt-3 pb-1.5 sticky top-0 bg-canvas-elevated z-10">
          <span className={cn('w-2.5 h-2.5 rounded-full flex-shrink-0', dotColor)} />
          <span className="text-[10px] font-bold uppercase tracking-wider text-ink-muted">{title} ({list.length})</span>
          <Tooltip text={helpText}>
            <HelpCircle className="w-3 h-3 text-ink-muted/40 hover:text-ink-muted cursor-help transition-colors" />
          </Tooltip>

          {variant === 'unassigned' && grouped.length > 0 && (
            <div className="flex items-center gap-1 ml-auto">
              {grouped.map(([wsId, { wsName, items }]) => (
                <Tooltip key={wsId} text={`Assign "${ontology.name}" to all ${items.length} data source${items.length !== 1 ? 's' : ''} in ${wsName}`}>
                  <button
                    onClick={() => setConfirmRollout({ wsId, wsName, dsCount: items.length })}
                    disabled={isAssigning}
                    className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[9px] font-semibold text-indigo-600 dark:text-indigo-400 bg-indigo-500/[0.06] hover:bg-indigo-500/[0.12] border border-indigo-500/15 transition-colors duration-150 disabled:opacity-50">
                    <Layers className="w-2.5 h-2.5" /> All in {wsName}
                  </button>
                </Tooltip>
              ))}
            </div>
          )}
        </div>

        {grouped.map(([wsId, { wsName, items }]) => {
          const isCollapsed = collapsedWs.has(`${variant}-${wsId}`)
          const showWsHeader = grouped.length > 1 || items.length > 3

          return (
            <div key={wsId}>
              {showWsHeader && (
                <button onClick={() => toggleWs(`${variant}-${wsId}`)}
                  className="w-full flex items-center gap-1.5 px-4 py-1.5 text-left hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors">
                  {isCollapsed ? <ChevronRight className="w-3 h-3 text-ink-muted" /> : <ChevronDown className="w-3 h-3 text-ink-muted" />}
                  <Layers className="w-3 h-3 text-ink-muted/50" />
                  <span className="text-[10px] font-semibold text-ink-muted">{wsName}</span>
                  <span className="text-[9px] text-ink-muted/50">{items.length}</span>
                </button>
              )}
              {!isCollapsed && items.map(d => <DsRow key={`${d.wsId}-${d.dsId}`} d={d} variant={variant} />)}
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={isAssigning ? undefined : onClose} />
      <div className="relative bg-canvas-elevated border border-glass-border rounded-2xl shadow-lg w-full max-w-2xl mx-4 max-h-[85vh] flex flex-col animate-in zoom-in-95 fade-in duration-200 overflow-hidden">

        <div className="h-1 w-full bg-gradient-to-r from-emerald-500 via-indigo-500 to-purple-500 flex-shrink-0" />

        {/* Header */}
        <div className="px-6 pt-5 pb-4 flex-shrink-0">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500/20 to-indigo-500/20 border border-emerald-500/20 flex items-center justify-center">
                <Database className="w-5 h-5 text-emerald-500" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-ink">Assign Data Sources</h3>
                <p className="text-[11px] text-ink-muted mt-0.5">
                  Manage which data sources use <span className="font-semibold text-ink">{ontology.name}</span> v{ontology.version}
                </p>
              </div>
            </div>
            {!isAssigning && (
              <Tooltip text="Close assignment manager">
                <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-ink-muted transition-colors">
                  <X className="w-4 h-4" />
                </button>
              </Tooltip>
            )}
          </div>

          {/* Summary stats */}
          <div className="flex items-center gap-6 mb-4">
            <Tooltip text="Data sources actively using this ontology">
              <div className="flex items-center gap-2 cursor-default">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
                <span className="text-xs text-ink-secondary">
                  <span className="font-bold text-ink">{assignedToThis.length}</span> assigned
                </span>
              </div>
            </Tooltip>
            <Tooltip text="Data sources with no ontology — assign to enable semantic features">
              <div className="flex items-center gap-2 cursor-default">
                <span className="w-2.5 h-2.5 rounded-full bg-red-400" />
                <span className="text-xs text-ink-secondary">
                  <span className="font-bold text-ink">{unassigned.length}</span> unassigned
                </span>
              </div>
            </Tooltip>
            <Tooltip text="Data sources using a different ontology — can be replaced">
              <div className="flex items-center gap-2 cursor-default">
                <span className="w-2.5 h-2.5 rounded-full bg-amber-500" />
                <span className="text-xs text-ink-secondary">
                  <span className="font-bold text-ink">{assignedToOther.length}</span> other schema
                </span>
              </div>
            </Tooltip>
            <span className="text-[10px] text-ink-muted ml-auto">{totalDs} total across {workspaces.length} workspace{workspaces.length !== 1 ? 's' : ''}</span>
          </div>

          {/* Search */}
          <div className={cn(
            'relative flex items-center rounded-xl border bg-canvas-elevated overflow-hidden transition-[border-color,box-shadow] duration-200',
            searchFocused
              ? 'border-accent-lineage/50 shadow-[0_0_0_3px_rgba(var(--accent-lineage-rgb,99,102,241),0.08)]'
              : 'border-glass-border',
          )}>
            <Search className={cn('w-4 h-4 ml-3.5 shrink-0 transition-colors duration-150', searchFocused ? 'text-accent-lineage' : 'text-ink-muted')} />
            <input type="text" value={search} onChange={e => setSearch(e.target.value)}
              onFocus={() => setSearchFocused(true)} onBlur={() => setSearchFocused(false)}
              placeholder="Search data sources or workspaces..."
              className="w-full bg-transparent py-2 px-3 text-sm text-ink outline-none placeholder:text-ink-muted/50 font-medium" />
            {search && (
              <button onClick={() => setSearch('')} className="mr-1.5 p-1 rounded-lg text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04] transition-colors">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-0.5 px-6 pb-2 flex-shrink-0">
          {TABS.map(t => (
            <Tooltip key={t.id} text={t.tooltip}>
              <button
                onClick={() => setActiveTab(t.id)}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-colors duration-150',
                  activeTab === t.id
                    ? 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 ring-1 ring-indigo-500/20'
                    : 'text-ink-muted hover:text-ink hover:bg-black/[0.03] dark:hover:bg-white/[0.03]',
                )}
              >
                {t.label}
                <span className={cn(
                  'px-1.5 py-0.5 rounded-full text-[9px] font-bold',
                  activeTab === t.id ? 'bg-indigo-500/15' : 'bg-black/[0.05] dark:bg-white/[0.06]',
                )}>
                  {t.count}
                </span>
              </button>
            </Tooltip>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto min-h-0 border-t border-glass-border/50">
          {(activeTab === 'all' || activeTab === 'assigned') && filteredAssigned.length > 0 && (
            <Section title="Using this schema" list={filteredAssigned} variant="assigned"
              icon={CheckCircle2} dotColor="bg-emerald-500" emptyMsg=""
              helpText="These data sources are actively using this semantic layer for type resolution, hierarchy, and views" />
          )}

          {(activeTab === 'all' || activeTab === 'unassigned') && (
            <Section title="No schema assigned" list={filteredUnassigned} variant="unassigned"
              icon={AlertTriangle} dotColor="bg-red-400" emptyMsg="All data sources have a schema assigned"
              helpText="These data sources have no ontology. Assign one to enable type hierarchy, semantic search, and structured views" />
          )}

          {(activeTab === 'all' || activeTab === 'other') && filteredOther.length > 0 && (
            <Section title="Using another schema" list={filteredOther} variant="other"
              icon={Shield} dotColor="bg-amber-500" emptyMsg=""
              helpText="These data sources use a different ontology. Replace to switch them to this one" />
          )}

          {activeTab === 'all' && filteredAssigned.length === 0 && filteredUnassigned.length === 0 && filteredOther.length === 0 && (
            <div className="px-4 py-12 text-center">
              <Database className="w-6 h-6 text-ink-muted/30 mx-auto mb-2" />
              <p className="text-xs text-ink-muted">{search ? 'No data sources match your search' : 'No data sources available'}</p>
            </div>
          )}

          {activeTab === 'assigned' && filteredAssigned.length === 0 && (
            <div className="px-4 py-12 text-center">
              <Database className="w-6 h-6 text-ink-muted/30 mx-auto mb-2" />
              <p className="text-xs text-ink-muted">{search ? 'No assigned data sources match' : 'This ontology is not assigned to any data source'}</p>
            </div>
          )}

          {activeTab === 'other' && filteredOther.length === 0 && (
            <div className="px-4 py-12 text-center">
              <Database className="w-6 h-6 text-ink-muted/30 mx-auto mb-2" />
              <p className="text-xs text-ink-muted">{search ? 'No matching data sources' : 'No data sources use a different schema'}</p>
            </div>
          )}

          {activeTab === 'unassigned' && filteredUnassigned.length === 0 && (
            <div className="px-4 py-12 text-center">
              <CheckCircle2 className="w-6 h-6 text-emerald-400/30 mx-auto mb-2" />
              <p className="text-xs text-ink-muted">{search ? 'No matching data sources' : 'All data sources have a schema assigned'}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-glass-border/50 px-6 py-3 flex items-center justify-between flex-shrink-0 bg-black/[0.01] dark:bg-white/[0.01]">
          <p className="text-[11px] text-ink-muted">
            {assignedToThis.length} of {totalDs} data source{totalDs !== 1 ? 's' : ''} using this schema
          </p>
          <button onClick={onClose} disabled={isAssigning}
            className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50">
            Done
          </button>
        </div>
      </div>

      {/* ── Replace Confirmation Dialog ──────────────────────────── */}
      {confirmReplace && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/30" onClick={() => setConfirmReplace(null)} />
          <div className="relative w-full max-w-sm mx-4 rounded-2xl border border-glass-border bg-canvas-elevated shadow-lg animate-in fade-in zoom-in-95 overflow-hidden">
            <div className="h-1 w-full bg-gradient-to-r from-amber-500 to-orange-500" />
            <div className="p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-xl bg-amber-500/15 flex items-center justify-center">
                  <RefreshCw className="w-5 h-5 text-amber-500" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-ink">Replace Semantic Layer?</h3>
                  <p className="text-[11px] text-ink-muted mt-0.5">{confirmReplace.dsLabel}</p>
                </div>
              </div>

              {/* What will change */}
              <div className="rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] p-3.5 mb-4">
                <div className="flex items-center gap-3 mb-2.5">
                  <div className="flex-1 min-w-0">
                    <p className="text-[10px] text-ink-muted uppercase tracking-wider font-bold">Current</p>
                    <p className="text-xs font-semibold text-amber-600 dark:text-amber-400 truncate">{confirmReplace.otherOntologyName}</p>
                  </div>
                  <ArrowRight className="w-4 h-4 text-ink-muted/40 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-[10px] text-ink-muted uppercase tracking-wider font-bold">New</p>
                    <p className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 truncate">{ontology.name} v{ontology.version}</p>
                  </div>
                </div>
                <p className="text-[10px] text-ink-muted">in workspace <span className="font-medium text-ink">{confirmReplace.wsName}</span></p>
              </div>

              {/* Warning */}
              <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-amber-50/60 dark:bg-amber-950/15 border border-amber-200/40 dark:border-amber-800/30 mb-5">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-0.5" />
                <p className="text-[11px] text-amber-700 dark:text-amber-300 leading-relaxed">
                  Replacing the ontology will change how this data source interprets its graph. Existing views may behave differently if the new ontology defines types differently.
                </p>
              </div>

              <div className="flex items-center justify-end gap-2">
                <button onClick={() => setConfirmReplace(null)}
                  className="px-4 py-2 rounded-xl text-xs font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                  Cancel
                </button>
                <button
                  onClick={() => { onAssign(confirmReplace.wsId, confirmReplace.dsId); setConfirmReplace(null) }}
                  disabled={isAssigning}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-amber-500 text-white hover:bg-amber-600 transition-colors shadow-sm disabled:opacity-50">
                  {isAssigning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                  Replace Schema
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Assign-All Confirmation ──────────────────────────────── */}
      {confirmRollout && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/30" onClick={() => setConfirmRollout(null)} />
          <div className="relative w-full max-w-sm mx-4 rounded-2xl border border-glass-border bg-canvas-elevated shadow-lg animate-in fade-in zoom-in-95 p-6">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-xl bg-amber-500/15 flex items-center justify-center">
                <AlertTriangle className="w-5 h-5 text-amber-500" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-ink">Assign to all data sources?</h3>
                <p className="text-[11px] text-ink-muted mt-0.5">{confirmRollout.wsName}</p>
              </div>
            </div>
            <p className="text-xs text-ink-muted mb-5 leading-relaxed">
              This will assign <span className="font-semibold text-ink">&ldquo;{ontology.name}&rdquo;</span> to
              all <span className="font-semibold text-ink">{confirmRollout.dsCount} data source{confirmRollout.dsCount !== 1 ? 's' : ''}</span> in
              this workspace. Data sources currently using another schema will be reassigned.
            </p>
            <div className="flex items-center justify-end gap-2">
              <button onClick={() => setConfirmRollout(null)}
                className="px-4 py-2 rounded-xl text-xs font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                Cancel
              </button>
              <button
                onClick={() => { onRollOutToWorkspace(confirmRollout.wsId); setConfirmRollout(null) }}
                disabled={isAssigning}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-amber-500 text-white hover:bg-amber-600 transition-colors shadow-sm disabled:opacity-50">
                {isAssigning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Layers className="w-3.5 h-3.5" />}
                Assign All
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
