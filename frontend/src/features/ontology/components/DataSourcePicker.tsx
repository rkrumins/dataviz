/**
 * DataSourcePicker — spacious two-panel cross-workspace data source selector.
 *
 * Left: workspace tabs with stats. Right: data source cards with ontology context.
 * Status filter chips (All / Unassigned / Assigned) for quick narrowing.
 */
import { useState, useMemo, useEffect, useRef } from 'react'
import {
  Search, Database, Check, AlertTriangle, Shield, CheckCircle2,
  PenLine, Layers, ChevronRight, X, Filter,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { WorkspaceResponse } from '@/services/workspaceService'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'

interface DataSourcePickerProps {
  workspaces: WorkspaceResponse[]
  selectedWorkspaceId: string | null
  selectedDataSourceId: string | null
  onSelect: (workspaceId: string, dataSourceId: string) => void
  compact?: boolean
  highlightOrphans?: boolean
  ontologies?: OntologyDefinitionResponse[]
}

type DsFilter = 'all' | 'unassigned' | 'assigned'

export function DataSourcePicker({
  workspaces,
  selectedWorkspaceId,
  selectedDataSourceId,
  onSelect,
  compact = false,
  highlightOrphans = false,
  ontologies,
}: DataSourcePickerProps) {
  const [search, setSearch] = useState('')
  const [searchFocused, setSearchFocused] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const [dsFilter, setDsFilter] = useState<DsFilter>('all')
  const [activeWsId, setActiveWsId] = useState<string | null>(
    selectedWorkspaceId ?? workspaces[0]?.id ?? null,
  )

  useEffect(() => {
    if (selectedWorkspaceId && selectedWorkspaceId !== activeWsId) {
      setActiveWsId(selectedWorkspaceId)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedWorkspaceId])

  const ontologyMap = useMemo(() => {
    if (!ontologies) return null
    const m = new Map<string, OntologyDefinitionResponse>()
    for (const o of ontologies) m.set(o.id, o)
    return m
  }, [ontologies])

  const wsStats = useMemo(() => {
    const m = new Map<string, { total: number; orphans: number; assigned: number }>()
    for (const ws of workspaces) {
      let orphans = 0
      const dsList = ws.dataSources ?? []
      for (const ds of dsList) { if (!ds.ontologyId) orphans++ }
      m.set(ws.id, { total: dsList.length, orphans, assigned: dsList.length - orphans })
    }
    return m
  }, [workspaces])

  const activeWs = workspaces.find(w => w.id === activeWsId)
  const lowerSearch = search.toLowerCase()

  const filteredDs = useMemo(() => {
    if (!activeWs) return []
    let dsList = activeWs.dataSources ?? []

    // Status filter
    if (dsFilter === 'unassigned') dsList = dsList.filter(ds => !ds.ontologyId)
    else if (dsFilter === 'assigned') dsList = dsList.filter(ds => !!ds.ontologyId)

    // Search filter
    if (lowerSearch) {
      dsList = dsList.filter(ds => {
        const label = ds.label || ds.catalogItemId || ds.id
        return label.toLowerCase().includes(lowerSearch)
      })
    }
    return dsList
  }, [activeWs, lowerSearch, dsFilter])

  const filteredWorkspaces = useMemo(() => {
    if (!lowerSearch) return workspaces
    return workspaces.filter(ws => {
      if (ws.name.toLowerCase().includes(lowerSearch)) return true
      return (ws.dataSources ?? []).some(ds =>
        (ds.label || ds.catalogItemId || ds.id).toLowerCase().includes(lowerSearch),
      )
    })
  }, [workspaces, lowerSearch])

  const isSingleWorkspace = workspaces.length <= 1
  const activeStat = activeWsId ? wsStats.get(activeWsId) : null

  return (
    <div className="rounded-2xl border border-glass-border bg-canvas-elevated overflow-hidden">
      {/* ── Top bar: Search + status filter chips ─────────────────── */}
      <div className="px-4 py-3 border-b border-glass-border/50 space-y-3">
        {/* Search */}
        <div className={cn(
          'relative flex items-center rounded-xl border overflow-hidden transition-[border-color,box-shadow] duration-200',
          searchFocused
            ? 'border-accent-lineage/50 shadow-[0_0_0_3px_rgba(var(--accent-lineage-rgb,99,102,241),0.08)] bg-canvas-elevated'
            : 'border-glass-border bg-black/[0.02] dark:bg-white/[0.02]',
        )}>
          <Search className={cn(
            'w-4 h-4 ml-3 shrink-0 transition-colors duration-150',
            searchFocused ? 'text-accent-lineage' : 'text-ink-muted',
          )} />
          <input
            ref={searchRef}
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            placeholder={isSingleWorkspace ? 'Search data sources...' : 'Search workspaces and data sources...'}
            className="w-full bg-transparent py-2.5 px-3 text-sm text-ink outline-none placeholder:text-ink-muted/50 font-medium"
          />
          {search && (
            <button onClick={() => setSearch('')}
              className="mr-2 p-1 rounded-lg text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04] transition-colors">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Status filter chips */}
        {highlightOrphans && (
          <div className="flex items-center gap-1.5">
            <Filter className="w-3 h-3 text-ink-muted/50 mr-0.5" />
            {([
              { id: 'all' as DsFilter, label: 'All', count: activeStat?.total ?? 0 },
              { id: 'unassigned' as DsFilter, label: 'Unassigned', count: activeStat?.orphans ?? 0 },
              { id: 'assigned' as DsFilter, label: 'Assigned', count: activeStat?.assigned ?? 0 },
            ]).map(f => (
              <button
                key={f.id}
                onClick={() => setDsFilter(f.id)}
                className={cn(
                  'inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-all',
                  dsFilter === f.id
                    ? f.id === 'unassigned'
                      ? 'bg-red-500/10 text-red-600 dark:text-red-400 ring-1 ring-red-500/20'
                      : f.id === 'assigned'
                        ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 ring-1 ring-emerald-500/20'
                        : 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 ring-1 ring-indigo-500/20'
                    : 'text-ink-muted hover:text-ink hover:bg-black/[0.03] dark:hover:bg-white/[0.03]',
                )}
              >
                {f.label}
                <span className={cn(
                  'px-1.5 rounded-full text-[9px] font-bold',
                  dsFilter === f.id ? 'bg-black/[0.06] dark:bg-white/[0.08]' : 'bg-black/[0.04] dark:bg-white/[0.04]',
                )}>
                  {f.count}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Two-panel layout ─────────────────────────────────────── */}
      <div className={cn('flex', isSingleWorkspace ? '' : 'min-h-[320px]')}>

        {/* Left panel — workspace navigation */}
        {!isSingleWorkspace && (
          <div className="w-[220px] border-r border-glass-border/50 overflow-y-auto flex-shrink-0 bg-black/[0.01] dark:bg-white/[0.01]">
            <div className="p-2">
              <p className="text-[9px] font-bold text-ink-muted uppercase tracking-wider px-3 py-1.5 mb-1">
                Workspaces
              </p>
              {filteredWorkspaces.map(ws => {
                const isActive = ws.id === activeWsId
                const stat = wsStats.get(ws.id)
                const hasOrphans = highlightOrphans && (stat?.orphans ?? 0) > 0

                return (
                  <button
                    key={ws.id}
                    type="button"
                    onClick={() => { setActiveWsId(ws.id); setSearch(''); setDsFilter('all') }}
                    className={cn(
                      'w-full flex items-center gap-2.5 rounded-xl transition-all text-left mb-0.5',
                      'px-3 py-2.5',
                      isActive
                        ? 'bg-indigo-50 dark:bg-indigo-950/30 text-indigo-600 dark:text-indigo-400 shadow-sm'
                        : 'text-ink-secondary hover:bg-black/[0.03] dark:hover:bg-white/[0.03]',
                    )}
                  >
                    <div className={cn(
                      'w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0',
                      isActive ? 'bg-indigo-500/15' : 'bg-black/[0.04] dark:bg-white/[0.04]',
                    )}>
                      <Layers className={cn('w-3.5 h-3.5', isActive ? 'text-indigo-500' : 'text-ink-muted/60')} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold truncate">{ws.name}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[10px] text-ink-muted">{stat?.total ?? 0} sources</span>
                        {hasOrphans && (
                          <span className="text-[10px] text-red-500 font-semibold">{stat?.orphans} unassigned</span>
                        )}
                      </div>
                    </div>
                    {isActive && <ChevronRight className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />}
                  </button>
                )
              })}

              {filteredWorkspaces.length === 0 && (
                <div className="text-center py-6">
                  <Layers className="w-5 h-5 text-ink-muted/30 mx-auto mb-1.5" />
                  <p className="text-[10px] text-ink-muted">No workspaces match</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Right panel — data source cards */}
        <div className="flex-1 min-w-0 overflow-y-auto max-h-[360px]">
          {activeWs && (
            <div className="p-3">
              {/* Workspace context header */}
              {!isSingleWorkspace && (
                <div className="flex items-center gap-2 px-2 py-1.5 mb-2">
                  <div className="w-5 h-5 rounded-md bg-indigo-500/10 flex items-center justify-center">
                    <Layers className="w-3 h-3 text-indigo-500" />
                  </div>
                  <span className="text-xs font-bold text-ink">{activeWs.name}</span>
                  <span className="text-[10px] text-ink-muted ml-auto">
                    {filteredDs.length} data source{filteredDs.length !== 1 ? 's' : ''}
                    {dsFilter !== 'all' && ` (${dsFilter})`}
                  </span>
                </div>
              )}

              {/* Empty state */}
              {filteredDs.length === 0 && (
                <div className="text-center py-10 text-ink-muted">
                  <Database className="w-6 h-6 mx-auto mb-2 opacity-30" />
                  <p className="text-xs font-medium">
                    {search ? 'No data sources match your search' :
                     dsFilter !== 'all' ? `No ${dsFilter} data sources` :
                     'No data sources in this workspace'}
                  </p>
                </div>
              )}

              {/* Data source cards */}
              <div className="space-y-1.5">
                {filteredDs.map(ds => {
                  const isSelected = selectedWorkspaceId === activeWsId && selectedDataSourceId === ds.id
                  const isOrphan = !ds.ontologyId
                  const label = ds.label || ds.catalogItemId || ds.id
                  const assignedOnt = ds.ontologyId && ontologyMap ? ontologyMap.get(ds.ontologyId) : null

                  return (
                    <button
                      key={ds.id}
                      type="button"
                      onClick={() => onSelect(activeWsId!, ds.id)}
                      className={cn(
                        'w-full flex items-center gap-3 rounded-xl transition-all text-left',
                        compact ? 'px-3 py-2.5' : 'px-4 py-3',
                        isSelected
                          ? 'bg-indigo-50 dark:bg-indigo-950/30 ring-2 ring-indigo-500/30 shadow-sm'
                          : 'hover:bg-black/[0.025] dark:hover:bg-white/[0.025] border border-transparent hover:border-glass-border',
                        highlightOrphans && isOrphan && !isSelected && 'border border-dashed border-red-300/40 dark:border-red-700/30 bg-red-50/20 dark:bg-red-950/5',
                      )}
                    >
                      {/* Icon */}
                      <div className={cn(
                        'w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0',
                        isSelected ? 'bg-indigo-500/15' :
                        isOrphan ? 'bg-red-500/8' : 'bg-black/[0.03] dark:bg-white/[0.03]',
                      )}>
                        <Database className={cn(
                          'w-4 h-4',
                          isSelected ? 'text-indigo-500' : isOrphan ? 'text-red-400' : 'text-ink-muted',
                        )} />
                      </div>

                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        <p className={cn(
                          'text-sm font-semibold truncate',
                          isSelected ? 'text-indigo-600 dark:text-indigo-400' : 'text-ink',
                        )}>
                          {label}
                        </p>

                        {/* Ontology assignment context */}
                        {assignedOnt ? (
                          <div className="flex items-center gap-1.5 mt-1">
                            <OntologyPill ontology={assignedOnt} />
                          </div>
                        ) : highlightOrphans && isOrphan ? (
                          <div className="flex items-center gap-1.5 mt-1">
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium text-red-500 bg-red-500/8 border border-red-500/10">
                              <AlertTriangle className="w-2.5 h-2.5" />
                              No ontology assigned
                            </span>
                          </div>
                        ) : null}
                      </div>

                      {/* Selection indicator */}
                      {isSelected && (
                        <div className="w-6 h-6 rounded-full bg-indigo-500 flex items-center justify-center flex-shrink-0">
                          <Check className="w-3.5 h-3.5 text-white" />
                        </div>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {!activeWs && (
            <div className="text-center py-12 text-ink-muted">
              <Layers className="w-6 h-6 mx-auto mb-2 opacity-30" />
              <p className="text-xs font-medium">Select a workspace</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Ontology pill — shows the assigned ontology with status-colored styling
// ---------------------------------------------------------------------------

function OntologyPill({ ontology }: { ontology: OntologyDefinitionResponse }) {
  const isSystem = ontology.isSystem
  const isPublished = ontology.isPublished

  const StatusIcon = isSystem ? Shield : isPublished ? CheckCircle2 : PenLine
  const colors = isSystem
    ? 'text-indigo-600 dark:text-indigo-400 bg-indigo-500/8 border-indigo-500/15'
    : isPublished
      ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/8 border-emerald-500/15'
      : 'text-amber-600 dark:text-amber-400 bg-amber-500/8 border-amber-500/15'

  return (
    <span className={cn(
      'inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-semibold border',
      colors,
    )}>
      <StatusIcon className="w-2.5 h-2.5 flex-shrink-0" />
      <span className="truncate max-w-[140px]">{ontology.name}</span>
      <span className="opacity-50">v{ontology.version}</span>
    </span>
  )
}
