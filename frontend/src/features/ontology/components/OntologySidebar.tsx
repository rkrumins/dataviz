import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { Search, Plus, Shield, CheckCircle2, PenLine, Lock, Box, GitBranch, Loader2, BookOpen, Database, X, Trash2, LayoutGrid, LayoutDashboard, Link2, Unlink, PanelLeftClose, PanelLeftOpen, Info, ChevronDown, ChevronUp, Layers } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import type { DataSourceResponse, WorkspaceResponse } from '@/services/workspaceService'
import type { StatusFilter } from '../lib/ontology-types' // used by STATUS_CONFIGS key type
import { useOntologies } from '../hooks/useOntologies'

interface OntologySidebarProps {
  ontologies: OntologyDefinitionResponse[]
  selectedOntologyId: string | undefined
  activeDataSource: DataSourceResponse | null
  assignmentCountMap: Map<string, number>
  workspaces: WorkspaceResponse[]
  isLoading: boolean
  isSuggesting?: boolean
  onCreateDraft: () => void
  onSuggest?: () => void
  dashboardMode?: boolean
  onToggleDashboard?: () => void
}

const STATUS_CONFIGS: Record<Exclude<StatusFilter, 'all' | 'deleted'>, {
  icon: React.ComponentType<{ className?: string }>
  color: string
  activeColor: string
}> = {
  system: { icon: Shield, color: 'text-indigo-500', activeColor: 'bg-indigo-500/15' },
  published: { icon: CheckCircle2, color: 'text-emerald-500', activeColor: 'bg-emerald-500/15' },
  draft: { icon: PenLine, color: 'text-amber-500', activeColor: 'bg-amber-500/15' },
}

type StatusFilterOption = 'all' | 'system' | 'published' | 'draft' | 'deleted'
type UsageFilterOption = 'all' | 'in-use' | 'unassigned'

const STATUS_TABS: Array<{
  id: StatusFilterOption
  label: string
  icon: React.ComponentType<{ className?: string }>
  color: string
}> = [
  { id: 'all', label: 'All', icon: LayoutGrid, color: 'text-indigo-500' },
  { id: 'system', label: 'System', icon: Shield, color: 'text-indigo-500' },
  { id: 'published', label: 'Published', icon: CheckCircle2, color: 'text-emerald-500' },
  { id: 'draft', label: 'Draft', icon: PenLine, color: 'text-amber-500' },
]

const USAGE_TABS: Array<{
  id: UsageFilterOption
  label: string
  icon: React.ComponentType<{ className?: string }> | null
  color: string
  activeColor: string
}> = [
  { id: 'all', label: 'All', icon: null, color: 'text-ink-muted', activeColor: 'text-ink' },
  { id: 'in-use', label: 'In Use', icon: Link2, color: 'text-emerald-500', activeColor: 'text-emerald-600 dark:text-emerald-400' },
  { id: 'unassigned', label: 'Unassigned', icon: Unlink, color: 'text-ink-muted', activeColor: 'text-ink-secondary' },
]

function getStatusKey(o: OntologyDefinitionResponse): Exclude<StatusFilter, 'all' | 'deleted'> {
  if (o.isSystem) return 'system'
  if (o.isPublished) return 'published'
  return 'draft'
}

const MIN_WIDTH = 260
const MAX_WIDTH = 480
const DEFAULT_WIDTH = 320
const COLLAPSED_WIDTH = 52

/** Portal-based tooltip that escapes overflow:hidden/auto containers */
function CollapsedTooltip({
  anchorRef,
  visible,
  children,
}: {
  anchorRef: React.RefObject<HTMLElement | null>
  visible: boolean
  children: React.ReactNode
}) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  useEffect(() => {
    if (!visible || !anchorRef.current) { setPos(null); return }
    const rect = anchorRef.current.getBoundingClientRect()
    setPos({
      top: rect.top + rect.height / 2,
      left: rect.right + 8,
    })
  }, [visible, anchorRef])

  if (!visible || !pos) return null
  return createPortal(
    <div
      className="fixed z-[9999] pointer-events-none animate-in fade-in duration-150"
      style={{ top: pos.top, left: pos.left, transform: 'translateY(-50%)' }}
    >
      {children}
    </div>,
    document.body,
  )
}

export function OntologySidebar({
  ontologies,
  selectedOntologyId,
  activeDataSource,
  assignmentCountMap,
  workspaces,
  isLoading,
  onCreateDraft,
  dashboardMode,
  onToggleDashboard,
}: OntologySidebarProps) {
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilterOption>('all')
  const [usageFilter, setUsageFilter] = useState<UsageFilterOption>('all')
  const [collapsed, setCollapsed] = useState(false)
  const [legendOpen, setLegendOpen] = useState(false)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const hoveredRef = useRef<HTMLButtonElement | null>(null)
  const [width, setWidth] = useState(DEFAULT_WIDTH)
  const resizing = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(DEFAULT_WIDTH)

  // ── Resize handle ───────────────────────────────────────────────
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    resizing.current = true
    startX.current = e.clientX
    startWidth.current = width
    const onMouseMove = (e: MouseEvent) => {
      if (!resizing.current) return
      const delta = e.clientX - startX.current
      setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth.current + delta)))
    }
    const onMouseUp = () => {
      resizing.current = false
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [width])

  // Reverse map: ontologyId → workspace names that use it
  const ontologyWorkspaceMap = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const ws of workspaces) {
      for (const ds of ws.dataSources ?? []) {
        if (ds.ontologyId) {
          const names = map.get(ds.ontologyId) ?? []
          if (!names.includes(ws.name)) names.push(ws.name)
          map.set(ds.ontologyId, names)
        }
      }
    }
    return map
  }, [workspaces])

  const showDeleted = statusFilter === 'deleted'
  const { data: allWithDeleted = [], isLoading: isLoadingDeleted } = useOntologies(true)
  const sourceList = showDeleted ? allWithDeleted : ontologies
  const activeOntologyId = activeDataSource?.ontologyId

  // Apply status filter
  const statusFiltered = useMemo(() => {
    let list = sourceList
    switch (statusFilter) {
      case 'system': list = list.filter(o => o.isSystem && !o.deletedAt); break
      case 'published': list = list.filter(o => o.isPublished && !o.isSystem && !o.deletedAt); break
      case 'draft': list = list.filter(o => !o.isPublished && !o.isSystem && !o.deletedAt); break
      case 'deleted': list = list.filter(o => !!o.deletedAt); break
      default: list = list.filter(o => !o.deletedAt) // 'all'
    }
    return list
  }, [sourceList, statusFilter])

  // Apply usage filter on top of status filter (composite AND)
  const filtered = useMemo(() => {
    let list = statusFiltered
    if (usageFilter === 'in-use') list = list.filter(o => (assignmentCountMap.get(o.id) ?? 0) > 0)
    else if (usageFilter === 'unassigned') list = list.filter(o => (assignmentCountMap.get(o.id) ?? 0) === 0)
    if (search) {
      const q = search.toLowerCase()
      list = list.filter(o => o.name.toLowerCase().includes(q) || o.description?.toLowerCase().includes(q))
    }
    return list
  }, [statusFiltered, usageFilter, assignmentCountMap, search])

  const { pinnedOntology, restOntologies } = useMemo(() => {
    if (!activeOntologyId || showDeleted) return { pinnedOntology: null, restOntologies: filtered }
    const pinned = filtered.find(o => o.id === activeOntologyId) ?? null
    const rest = filtered.filter(o => o.id !== activeOntologyId)
    return { pinnedOntology: pinned, restOntologies: rest }
  }, [filtered, activeOntologyId, showDeleted])

  // Status counts are scoped to current usage filter (contextual)
  const counts = useMemo(() => {
    const active = ontologies.filter(o => !o.deletedAt)
    // Apply usage filter to get base for status counts
    let usageScoped = active
    if (usageFilter === 'in-use') usageScoped = active.filter(o => (assignmentCountMap.get(o.id) ?? 0) > 0)
    else if (usageFilter === 'unassigned') usageScoped = active.filter(o => (assignmentCountMap.get(o.id) ?? 0) === 0)

    return {
      all: usageScoped.length,
      system: usageScoped.filter(o => o.isSystem).length,
      published: usageScoped.filter(o => o.isPublished && !o.isSystem).length,
      draft: usageScoped.filter(o => !o.isPublished && !o.isSystem).length,
      deleted: allWithDeleted.filter(o => !!o.deletedAt).length,
    }
  }, [ontologies, allWithDeleted, assignmentCountMap, usageFilter])

  const effectiveLoading = isLoading || (showDeleted && isLoadingDeleted)

  // Entity types of the active data source's ontology (for match scoring)
  const activeOntologyEntityTypes = useMemo(() => {
    if (!activeOntologyId) return null
    const active = ontologies.find(o => o.id === activeOntologyId)
    if (!active) return null
    return new Set(Object.keys(active.entityTypeDefinitions ?? {}))
  }, [activeOntologyId, ontologies])

  // ── Group-by toggle ─────────────────────────────────────────────
  const [groupBy, setGroupBy] = useState<'flat' | 'workspace' | 'status'>('flat')
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())

  function toggleGroup(key: string) {
    setCollapsedGroups(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // Build workspace→ontologies grouping
  const workspaceGroups = useMemo(() => {
    const groups = new Map<string, { name: string; ontologies: OntologyDefinitionResponse[] }>()
    const assigned = new Set<string>()
    for (const ws of workspaces) {
      for (const ds of ws.dataSources ?? []) {
        if (ds.ontologyId) {
          const ont = filtered.find(o => o.id === ds.ontologyId)
          if (ont) {
            if (!groups.has(ws.id)) groups.set(ws.id, { name: ws.name, ontologies: [] })
            const g = groups.get(ws.id)!
            if (!g.ontologies.find(o => o.id === ont.id)) g.ontologies.push(ont)
            assigned.add(ont.id)
          }
        }
      }
    }
    const unassigned = filtered.filter(o => !assigned.has(o.id))
    return { groups, unassigned }
  }, [filtered, workspaces])

  // Build status groups
  const statusGroups = useMemo(() => {
    const system = filtered.filter(o => o.isSystem)
    const published = filtered.filter(o => o.isPublished && !o.isSystem)
    const draft = filtered.filter(o => !o.isPublished && !o.isSystem)
    return { system, published, draft }
  }, [filtered])

  // ── Render a single ontology item (simplified: 2 rows) ────────
  function renderItem(o: OntologyDefinitionResponse, isPinned = false) {
    const entityCount = Object.keys(o.entityTypeDefinitions ?? {}).length
    const relCount = Object.keys(o.relationshipTypeDefinitions ?? {}).length
    const isSelected = o.id === selectedOntologyId
    const isDeleted = !!o.deletedAt
    const statusKey = getStatusKey(o)
    const isActive = o.id === activeOntologyId
    const dsCount = assignmentCountMap.get(o.id) ?? 0
    const wsNames = ontologyWorkspaceMap.get(o.id) ?? []

    // Match score for tooltip
    let matchPercent: number | null = null
    if (activeOntologyEntityTypes && !isActive && !isDeleted && entityCount > 0) {
      const thisTypes = new Set(Object.keys(o.entityTypeDefinitions ?? {}))
      let overlap = 0
      for (const t of thisTypes) { if (activeOntologyEntityTypes.has(t)) overlap++ }
      const union = new Set([...thisTypes, ...activeOntologyEntityTypes]).size
      if (union > 0) matchPercent = Math.round((overlap / union) * 100)
    }

    return (
      <button
        key={o.id}
        onClick={() => navigate(`/schema/${o.id}`)}
        title={matchPercent ? `${matchPercent}% entity type overlap` : undefined}
        className={cn(
          'w-full text-left rounded-xl px-3 py-2.5 transition-all group relative',
          isDeleted && 'opacity-60',
          isPinned && 'border border-emerald-500/20 bg-gradient-to-r from-emerald-500/[0.06] to-emerald-500/[0.02] dark:from-emerald-500/[0.10] dark:to-emerald-500/[0.03]',
          !isPinned && !isDeleted && isSelected && 'bg-gradient-to-r from-indigo-500/[0.08] to-violet-500/[0.04] dark:from-indigo-500/[0.12] dark:to-violet-500/[0.06] ring-1 ring-indigo-500/20 shadow-sm',
          isDeleted && isSelected && 'bg-gradient-to-r from-red-500/[0.06] to-red-500/[0.02] ring-1 ring-red-500/20',
          !isPinned && !isSelected && !isDeleted && 'hover:bg-black/[0.03] dark:hover:bg-white/[0.03]',
          isDeleted && !isSelected && 'hover:bg-red-500/[0.03]',
        )}
      >
        {/* Row 1: Icon badge + Name + version + badges */}
        <div className="flex items-center gap-2.5">
          {/* AdminOverview-style icon badge */}
          <div className={cn(
            'w-7 h-7 rounded-lg border flex items-center justify-center flex-shrink-0',
            isDeleted
              ? 'bg-red-500/10 border-red-500/20'
              : statusKey === 'system'
                ? 'bg-indigo-500/10 border-indigo-500/20'
                : statusKey === 'published'
                  ? 'bg-emerald-500/10 border-emerald-500/20'
                  : 'bg-amber-500/10 border-amber-500/20',
          )}>
            {isDeleted
              ? <Trash2 className="w-3.5 h-3.5 text-red-400" />
              : statusKey === 'system'
                ? <Shield className="w-3.5 h-3.5 text-indigo-500" />
                : statusKey === 'published'
                  ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                  : <PenLine className="w-3.5 h-3.5 text-amber-500" />}
          </div>
          <span className={cn(
            'text-[13px] font-semibold truncate flex-1 min-w-0',
            isDeleted && 'line-through text-ink-muted',
            !isDeleted && (isSelected || isPinned ? 'text-ink' : 'text-ink-secondary group-hover:text-ink'),
          )}>
            {o.name}
          </span>
          <span className={cn(
            'text-[10px] font-mono font-bold flex-shrink-0',
            isDeleted ? 'text-ink-muted/40' : 'text-ink-muted',
          )}>
            v{o.version}
          </span>
          {isActive && !isDeleted && (
            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-[8px] font-bold text-emerald-600 dark:text-emerald-400 flex-shrink-0 ring-1 ring-emerald-500/20">
              <Link2 className="w-2 h-2" />
              ACTIVE
            </span>
          )}
          {isDeleted && (
            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-red-500/10 text-[8px] font-bold text-red-500 flex-shrink-0">
              <Trash2 className="w-2 h-2" />
            </span>
          )}
        </div>

        {/* Row 2: Entity/rel counts + workspace count */}
        <div className="flex items-center justify-between mt-1 ml-[38px]">
          <span className={cn(
            'text-[11px]',
            isDeleted ? 'text-ink-muted/40' : 'text-ink-muted/60',
          )}>
            {entityCount} entities · {relCount} rels
          </span>
          {!isDeleted && dsCount > 0 && !isActive && (
            <span className="inline-flex items-center gap-0.5 text-[10px] text-ink-muted/50">
              <Database className="w-2.5 h-2.5" />
              {dsCount}
            </span>
          )}
          {!isDeleted && wsNames.length > 0 && groupBy !== 'workspace' && (
            <span className="text-[10px] text-ink-muted/40 truncate max-w-[100px]" title={wsNames.join(', ')}>
              {wsNames[0]}{wsNames.length > 1 ? ` +${wsNames.length - 1}` : ''}
            </span>
          )}
        </div>
      </button>
    )
  }

  // ── Render a group header ─────────────────────────────────────
  function renderGroupHeader(key: string, label: string, count: number, dotColor?: string) {
    const isOpen = !collapsedGroups.has(key)
    return (
      <button
        key={`header-${key}`}
        onClick={() => toggleGroup(key)}
        className="w-full flex items-center gap-2 px-3 py-2 text-[11px] font-semibold text-ink-muted uppercase tracking-wider hover:text-ink transition-colors"
      >
        {dotColor && <span className={cn('w-2 h-2 rounded-full flex-shrink-0', dotColor)} />}
        <span className="flex-1 text-left truncate">{label}</span>
        <span className="px-1.5 py-0.5 rounded-full bg-black/[0.04] dark:bg-white/[0.06] text-[10px] font-bold">
          {count}
        </span>
        {isOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />}
      </button>
    )
  }

  // ── Collapsed state ─────────────────────────────────────────────
  if (collapsed) {
    // Find the hovered ontology for the portal tooltip
    const hoveredOntology = hoveredId ? filtered.find(o => o.id === hoveredId) ?? null : null

    return (
      <div
        className="flex-shrink-0 flex flex-col border-r border-glass-border bg-canvas-elevated/40 h-full relative"
        style={{ width: COLLAPSED_WIDTH }}
      >
        {/* Expand button */}
        <div className="p-2 pt-4">
          <button
            onClick={() => setCollapsed(false)}
            className="w-full flex items-center justify-center p-2 rounded-lg hover:bg-black/[0.04] dark:hover:bg-white/[0.04] text-ink-muted hover:text-ink transition-colors"
            title="Expand sidebar"
          >
            <PanelLeftOpen className="w-4 h-4" />
          </button>
        </div>

        {/* Collapsed icon list */}
        <div className="flex-1 overflow-y-auto px-1.5 pb-2 space-y-0.5">
          {filtered.slice(0, 30).map(o => {
            const isSelected = o.id === selectedOntologyId
            const isActive = o.id === activeOntologyId
            const statusKey = getStatusKey(o)
            const config = STATUS_CONFIGS[statusKey]
            const StatusIcon = o.deletedAt ? Trash2 : config.icon
            return (
              <button
                key={o.id}
                ref={hoveredId === o.id ? hoveredRef : undefined}
                onClick={() => navigate(`/schema/${o.id}`)}
                onMouseEnter={(e) => { hoveredRef.current = e.currentTarget; setHoveredId(o.id) }}
                onMouseLeave={() => setHoveredId(null)}
                className={cn(
                  'w-full flex items-center justify-center p-2 rounded-lg transition-all relative',
                  isSelected
                    ? 'bg-indigo-500/15 ring-1 ring-indigo-500/20 shadow-sm'
                    : isActive
                      ? 'bg-emerald-500/10 ring-1 ring-emerald-500/20'
                      : 'hover:bg-black/[0.04] dark:hover:bg-white/[0.04]',
                )}
              >
                {/* Selected indicator bar */}
                {isSelected && (
                  <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-4 rounded-r-full bg-indigo-500" />
                )}
                {/* Active indicator dot */}
                {isActive && !isSelected && (
                  <div className="absolute right-1 top-1 w-1.5 h-1.5 rounded-full bg-emerald-500" />
                )}
                <StatusIcon className={cn(
                  'w-4 h-4',
                  o.deletedAt ? 'text-red-400' : isSelected ? 'text-indigo-500' : isActive ? 'text-emerald-500' : config.color,
                )} />
              </button>
            )
          })}
        </div>

        {/* Collapsed actions */}
        <div className="border-t border-glass-border/60 p-1.5 space-y-1">
          <button
            onClick={onCreateDraft}
            className="w-full flex items-center justify-center p-2 rounded-lg bg-indigo-500 text-white hover:bg-indigo-600 transition-colors"
            title="New Draft"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>

        {/* Portal tooltip — renders at document.body so it's never clipped */}
        {hoveredOntology && (() => {
          const o = hoveredOntology
          const isSelected = o.id === selectedOntologyId
          const isActive = o.id === activeOntologyId
          const statusKey = getStatusKey(o)
          const config = STATUS_CONFIGS[statusKey]
          const StatusIcon = o.deletedAt ? Trash2 : config.icon
          const dsCount = assignmentCountMap.get(o.id) ?? 0
          return (
            <CollapsedTooltip anchorRef={hoveredRef} visible>
              <div className="bg-canvas-elevated border border-glass-border rounded-xl shadow-xl px-4 py-3 min-w-[240px] max-w-[320px]">
                {/* Name + version */}
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-ink">{o.name}</span>
                  <span className={cn(
                    'inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-[10px] font-bold font-mono border',
                    o.isPublished || o.isSystem
                      ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/15'
                      : 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/15',
                  )}>
                    {o.isPublished || o.isSystem ? <Lock className="w-2.5 h-2.5" /> : <PenLine className="w-2.5 h-2.5" />}
                    v{o.version}
                  </span>
                  {isActive && (
                    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-[9px] font-bold text-emerald-600 dark:text-emerald-400 ring-1 ring-emerald-500/20">
                      <Link2 className="w-2.5 h-2.5" />
                      ASSIGNED
                    </span>
                  )}
                </div>

                {/* Description */}
                {o.description && (
                  <p className="text-xs text-ink-muted mt-1.5 leading-relaxed whitespace-normal line-clamp-3">
                    {o.description}
                  </p>
                )}

                {/* Divider */}
                <div className="h-px bg-glass-border/60 my-2" />

                {/* Status + stats row */}
                <div className="flex items-center gap-3 text-[11px] text-ink-muted">
                  <span className={cn(
                    'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md font-medium capitalize',
                    o.deletedAt
                      ? 'bg-red-500/10 text-red-500'
                      : statusKey === 'system'
                        ? 'bg-indigo-500/10 text-indigo-500'
                        : statusKey === 'published'
                          ? 'bg-emerald-500/10 text-emerald-500'
                          : 'bg-amber-500/10 text-amber-500',
                  )}>
                    <StatusIcon className="w-3 h-3" />
                    {o.deletedAt ? 'Deleted' : statusKey}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Box className="w-3 h-3" />
                    {Object.keys(o.entityTypeDefinitions ?? {}).length} entities
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <GitBranch className="w-3 h-3" />
                    {Object.keys(o.relationshipTypeDefinitions ?? {}).length} rels
                  </span>
                </div>

                {/* Usage row */}
                <div className="flex items-center gap-3 mt-1.5 text-[11px]">
                  {dsCount > 0 ? (
                    <span className="text-emerald-600 dark:text-emerald-400 font-medium inline-flex items-center gap-1">
                      <Link2 className="w-3 h-3" />
                      {dsCount} data source{dsCount !== 1 ? 's' : ''}
                    </span>
                  ) : (
                    <span className="text-ink-muted/50 font-medium inline-flex items-center gap-1">
                      <Unlink className="w-3 h-3" />
                      Unassigned
                    </span>
                  )}
                  {isSelected && (
                    <span className="text-indigo-500 font-bold inline-flex items-center gap-1">
                      Currently viewing
                    </span>
                  )}
                </div>
              </div>
            </CollapsedTooltip>
          )
        })()}
      </div>
    )
  }

  // ── Expanded state ──────────────────────────────────────────────
  return (
    <div
      className="flex-shrink-0 flex flex-col border-r border-glass-border bg-canvas-elevated/40 h-full relative"
      style={{ width }}
    >
      {/* Header */}
      <div className="px-4 pt-4 pb-3">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center shadow-lg shadow-amber-500/20">
            <Layers className="w-5 h-5 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-bold text-ink leading-tight">Semantic Layers</h1>
            <p className="text-[11px] text-ink-muted">Ontology models &amp; assignments</p>
          </div>
          <button
            onClick={() => setCollapsed(true)}
            className="p-1.5 rounded-lg hover:bg-black/[0.04] dark:hover:bg-white/[0.04] text-ink-muted hover:text-ink transition-colors flex-shrink-0"
            title="Collapse sidebar"
          >
            <PanelLeftClose className="w-4 h-4" />
          </button>
        </div>

        <div className="relative mb-2">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted/60" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search..."
            className="w-full pl-9 pr-8 py-2 rounded-xl bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border/60 text-xs text-ink placeholder:text-ink-muted/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500/30 focus:bg-white dark:focus:bg-white/[0.06] transition-all"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 text-ink-muted/50 hover:text-ink-muted transition-colors"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>

        {/* Dashboard toggle */}
        {onToggleDashboard && (
          <button
            onClick={onToggleDashboard}
            className={cn(
              'w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left group transition-all duration-200 relative mb-2',
              dashboardMode
                ? 'bg-gradient-to-r from-amber-500/10 to-orange-500/10 text-amber-600 dark:text-amber-400 shadow-sm border border-amber-500/20'
                : 'text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 hover:text-ink border border-transparent',
            )}
          >
            <div className={cn(
              'w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors',
              dashboardMode ? 'bg-amber-500/20' : 'bg-black/5 dark:bg-white/5',
            )}>
              <LayoutDashboard className={cn('w-3.5 h-3.5', dashboardMode ? 'text-amber-500' : 'text-ink-muted')} />
            </div>
            <div className="flex flex-col min-w-0 flex-1">
              <span className="text-sm font-semibold truncate leading-tight">Deployment Dashboard</span>
              <span className="text-[10px] text-ink-muted truncate mt-0.5">Overview &amp; Assignments</span>
            </div>
          </button>
        )}

        {/* Status filter row */}
        <div className="flex items-center gap-0.5 p-0.5 rounded-xl bg-black/[0.03] dark:bg-white/[0.03]">
          {STATUS_TABS.map(f => {
            const Icon = f.icon
            const count = counts[f.id] ?? 0
            const active = statusFilter === f.id
            return (
              <button
                key={f.id}
                onClick={() => setStatusFilter(f.id)}
                className={cn(
                  'flex-1 inline-flex items-center justify-center gap-1 px-1.5 py-1.5 rounded-lg text-[10px] font-semibold transition-all',
                  active
                    ? 'bg-white dark:bg-white/10 shadow-sm text-ink'
                    : 'text-ink-muted/60 hover:text-ink-muted',
                )}
              >
                <Icon className={cn('w-3 h-3', active ? f.color : 'text-ink-muted/50')} />
                {f.label}
                {count > 0 && (
                  <span className={cn('text-[9px] font-bold tabular-nums', active ? f.color : 'text-ink-muted/40')}>
                    {count}
                  </span>
                )}
              </button>
            )
          })}
        </div>

        {/* Usage filter row */}
        <div className="flex items-center gap-1 mt-1.5">
          {USAGE_TABS.map(f => {
            const Icon = f.icon
            // Contextual count: scoped to current status filter
            const count = f.id === 'all'
              ? statusFiltered.length
              : f.id === 'in-use'
                ? statusFiltered.filter(o => (assignmentCountMap.get(o.id) ?? 0) > 0).length
                : statusFiltered.filter(o => (assignmentCountMap.get(o.id) ?? 0) === 0).length
            const active = usageFilter === f.id
            return (
              <button
                key={f.id}
                onClick={() => setUsageFilter(f.id)}
                className={cn(
                  'inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-semibold transition-all border',
                  active
                    ? 'border-glass-border bg-white dark:bg-white/10 shadow-sm ' + f.activeColor
                    : 'border-transparent text-ink-muted/60 hover:text-ink-muted hover:bg-black/[0.03] dark:hover:bg-white/[0.03]',
                )}
              >
                {Icon && <Icon className={cn('w-3 h-3', active ? f.color : 'text-ink-muted/50')} />}
                {f.label}
                {count > 0 && (
                  <span className={cn('text-[9px] font-bold tabular-nums', active ? f.color : 'text-ink-muted/40')}>
                    {count}
                  </span>
                )}
              </button>
            )
          })}
        </div>

        {/* Group-by toggle */}
        <div className="flex items-center gap-0.5 mt-1.5 p-0.5 rounded-lg bg-black/[0.02] dark:bg-white/[0.02]">
          {(['flat', 'workspace', 'status'] as const).map(mode => (
            <button
              key={mode}
              onClick={() => setGroupBy(mode)}
              className={cn(
                'flex-1 px-2 py-1 rounded-md text-[10px] font-semibold transition-all capitalize',
                groupBy === mode
                  ? 'bg-white dark:bg-white/10 shadow-sm text-ink'
                  : 'text-ink-muted/60 hover:text-ink-muted',
              )}
            >
              {mode === 'flat' ? 'All' : mode === 'workspace' ? 'By Workspace' : 'By Status'}
            </button>
          ))}
        </div>

        {/* Deleted toggle */}
        {counts.deleted > 0 && (
          <button
            onClick={() => setStatusFilter(showDeleted ? 'all' : 'deleted')}
            className={cn(
              'flex items-center gap-1.5 mt-1.5 px-2 py-1 rounded-md text-[10px] font-medium transition-all w-full',
              showDeleted
                ? 'bg-red-500/10 text-red-500 dark:text-red-400'
                : 'text-ink-muted/60 hover:text-ink-muted hover:bg-black/[0.03] dark:hover:bg-white/[0.03]',
            )}
          >
            <Trash2 className="w-3 h-3" />
            {showDeleted ? 'Hide deleted' : 'Show deleted'}
            <span className={cn(
              'text-[9px] font-bold tabular-nums ml-auto',
              showDeleted ? 'text-red-400' : 'text-ink-muted/40',
            )}>
              {counts.deleted}
            </span>
          </button>
        )}
      </div>

      {/* Scrollable list */}
      <div className="flex-1 overflow-y-auto px-3 pb-3">
        {effectiveLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-5 h-5 animate-spin text-ink-muted/40" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16 px-4">
            <div className={cn(
              'w-12 h-12 mx-auto mb-3 rounded-2xl flex items-center justify-center',
              showDeleted
                ? 'bg-gradient-to-br from-red-500/10 to-red-500/5'
                : 'bg-gradient-to-br from-indigo-500/10 to-violet-500/10',
            )}>
              {showDeleted
                ? <Trash2 className="w-5 h-5 text-ink-muted/40" />
                : <BookOpen className="w-5 h-5 text-ink-muted/40" />
              }
            </div>
            <p className="text-xs font-medium text-ink-secondary">
              {showDeleted
                ? 'No deleted semantic layers'
                : search || statusFilter !== 'all' || usageFilter !== 'all' ? 'No semantic layers match' : 'No semantic layers yet'
              }
            </p>
            <p className="text-[11px] text-ink-muted/60 mt-1">
              {showDeleted
                ? 'Deleted semantic layers will appear here'
                : search ? 'Try a different search term' : 'Create a new draft to get started'
              }
            </p>
          </div>
        ) : (
          <>
            {groupBy === 'flat' && (
              <>
                {/* Pinned active ontology */}
                {pinnedOntology && (
                  <div className="mb-2">
                    <div className="flex items-center gap-1.5 px-1 mb-1.5">
                      <Link2 className="w-3 h-3 text-emerald-500" />
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                        Assigned
                      </span>
                    </div>
                    {renderItem(pinnedOntology, true)}
                  </div>
                )}

                {/* Separator */}
                {pinnedOntology && restOntologies.length > 0 && (
                  <div className="flex items-center gap-2 px-1 py-2">
                    <div className="flex-1 h-px bg-glass-border/60" />
                    <span className="text-[9px] font-medium text-ink-muted/40 uppercase tracking-wider">
                      {STATUS_TABS.find(f => f.id === statusFilter)?.label ?? 'All'}
                    </span>
                    <div className="flex-1 h-px bg-glass-border/60" />
                  </div>
                )}

                {/* Deleted section header */}
                {showDeleted && restOntologies.length > 0 && (
                  <div className="flex items-center gap-1.5 px-1 mb-1.5">
                    <Trash2 className="w-3 h-3 text-red-400" />
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-red-400">
                      Deleted
                    </span>
                  </div>
                )}

                {/* Rest of ontologies */}
                <div className="space-y-1">
                  {restOntologies.map(o => renderItem(o))}
                </div>
              </>
            )}

            {groupBy === 'workspace' && (
              <div className="space-y-1">
                {Array.from(workspaceGroups.groups.entries()).map(([wsId, group]) => (
                  <div key={wsId}>
                    {renderGroupHeader(wsId, group.name, group.ontologies.length, 'bg-indigo-500')}
                    {!collapsedGroups.has(wsId) && (
                      <div className="space-y-1 ml-1 pl-2 border-l border-glass-border/40">
                        {group.ontologies.map(o => renderItem(o, o.id === activeOntologyId))}
                      </div>
                    )}
                  </div>
                ))}
                {workspaceGroups.unassigned.length > 0 && (
                  <div>
                    {renderGroupHeader('__unassigned__', 'Unassigned', workspaceGroups.unassigned.length)}
                    {!collapsedGroups.has('__unassigned__') && (
                      <div className="space-y-1 ml-1 pl-2 border-l border-glass-border/40">
                        {workspaceGroups.unassigned.map(o => renderItem(o))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {groupBy === 'status' && (
              <div className="space-y-1">
                {statusGroups.system.length > 0 && (
                  <div>
                    {renderGroupHeader('__system__', 'System', statusGroups.system.length, 'bg-indigo-500')}
                    {!collapsedGroups.has('__system__') && (
                      <div className="space-y-1 ml-1 pl-2 border-l border-glass-border/40">
                        {statusGroups.system.map(o => renderItem(o))}
                      </div>
                    )}
                  </div>
                )}
                {statusGroups.published.length > 0 && (
                  <div>
                    {renderGroupHeader('__published__', 'Published', statusGroups.published.length, 'bg-emerald-500')}
                    {!collapsedGroups.has('__published__') && (
                      <div className="space-y-1 ml-1 pl-2 border-l border-glass-border/40">
                        {statusGroups.published.map(o => renderItem(o))}
                      </div>
                    )}
                  </div>
                )}
                {statusGroups.draft.length > 0 && (
                  <div>
                    {renderGroupHeader('__draft__', 'Drafts', statusGroups.draft.length, 'bg-amber-500')}
                    {!collapsedGroups.has('__draft__') && (
                      <div className="space-y-1 ml-1 pl-2 border-l border-glass-border/40">
                        {statusGroups.draft.map(o => renderItem(o))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Legend — collapsible */}
      <div className="border-t border-glass-border/60">
        <button
          onClick={() => setLegendOpen(v => !v)}
          className="w-full flex items-center gap-2 px-4 py-2.5 text-xs font-medium text-ink-muted hover:text-ink transition-colors"
        >
          <Info className="w-4 h-4" />
          <span>Legend</span>
          {legendOpen ? <ChevronDown className="w-3.5 h-3.5 ml-auto" /> : <ChevronUp className="w-3.5 h-3.5 ml-auto" />}
        </button>
        {legendOpen && (
          <div className="px-4 pb-4 space-y-4 animate-in fade-in slide-in-from-bottom-1 duration-200">
            {/* Status icons */}
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-secondary mb-2">Status</p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-md bg-indigo-500/10 flex items-center justify-center">
                    <Shield className="w-3.5 h-3.5 text-indigo-500" />
                  </div>
                  <span className="text-xs text-ink-muted">System</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-md bg-emerald-500/10 flex items-center justify-center">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                  </div>
                  <span className="text-xs text-ink-muted">Published</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-md bg-amber-500/10 flex items-center justify-center">
                    <PenLine className="w-3.5 h-3.5 text-amber-500" />
                  </div>
                  <span className="text-xs text-ink-muted">Draft</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-md bg-red-500/10 flex items-center justify-center">
                    <Trash2 className="w-3.5 h-3.5 text-red-400" />
                  </div>
                  <span className="text-xs text-ink-muted">Deleted</span>
                </div>
              </div>
            </div>

            {/* Version badges */}
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-secondary mb-2">Version</p>
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2.5">
                  <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-bold font-mono bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/15">
                    <Lock className="w-3 h-3" />v2
                  </span>
                  <span className="text-xs text-ink-muted">Locked — immutable, cannot be edited</span>
                </div>
                <div className="flex items-center gap-2.5">
                  <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-bold font-mono bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/15">
                    <PenLine className="w-3 h-3" />v1
                  </span>
                  <span className="text-xs text-ink-muted">Editable — draft, can be modified</span>
                </div>
              </div>
            </div>

            {/* Counters */}
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-secondary mb-2">Counters</p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                <div className="flex items-center gap-2">
                  <Box className="w-4 h-4 text-ink-muted" />
                  <span className="text-xs text-ink-muted">Entity types</span>
                </div>
                <div className="flex items-center gap-2">
                  <GitBranch className="w-4 h-4 text-ink-muted" />
                  <span className="text-xs text-ink-muted">Relationships</span>
                </div>
                <div className="flex items-center gap-2">
                  <Database className="w-4 h-4 text-ink-muted" />
                  <span className="text-xs text-ink-muted">Data sources</span>
                </div>
              </div>
            </div>

            {/* Badges */}
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-secondary mb-2">Badges</p>
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2.5">
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/10 text-[10px] font-bold text-emerald-600 ring-1 ring-emerald-500/20">
                    <Link2 className="w-3 h-3" />ASSIGNED
                  </span>
                  <span className="text-xs text-ink-muted">Linked to selected data source</span>
                </div>
                <div className="flex items-center gap-2.5">
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-emerald-500/10 text-[10px] font-bold text-emerald-600 ring-1 ring-emerald-500/20">
                    75% match
                  </span>
                  <span className="text-xs text-ink-muted">Entity type overlap with active</span>
                </div>
              </div>
            </div>

            {/* Usage filters */}
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-secondary mb-2">Usage</p>
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <Link2 className="w-4 h-4 text-emerald-500" />
                  <span className="text-xs text-ink-muted">In Use — assigned to data sources</span>
                </div>
                <div className="flex items-center gap-2">
                  <Unlink className="w-4 h-4 text-ink-muted" />
                  <span className="text-xs text-ink-muted">Unassigned — not used by any data source</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Bottom — single compact "New" button (CTAs live in the dashboard hero now) */}
      <div className="border-t border-glass-border/60 p-3">
        <button
          onClick={onCreateDraft}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-xs font-semibold bg-gradient-to-r from-indigo-500 to-violet-600 text-white hover:from-indigo-600 hover:to-violet-700 transition-all shadow-sm shadow-indigo-500/25"
        >
          <Plus className="w-3.5 h-3.5" />
          New Semantic Layer
        </button>
      </div>

      {/* Resize handle */}
      <div
        onMouseDown={onMouseDown}
        className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-indigo-500/30 active:bg-indigo-500/50 transition-colors z-10"
      />
    </div>
  )
}
