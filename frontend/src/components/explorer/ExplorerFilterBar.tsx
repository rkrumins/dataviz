/**
 * ExplorerFilterBar — toolbar combining category pills and filter dropdowns.
 *
 * Layout:
 *   [Category pills] | [Workspace ▾] [Source ▾] [Visibility ▾] [Type ▾] [Tag ▾] [Creator ▾]
 *
 * Multi-select dropdowns (Workspace / Type / Tag / Creator) use the shared
 * ``FilterDropdown`` component so their UX is consistent (same search
 * behaviour, same accent tokens, same keyboard isolation). Source and
 * Visibility remain bespoke — they are single-select with different
 * affordances and using them via FilterDropdown would be awkward.
 *
 * Performance: no transition-all, no backdrop-blur on persistent elements.
 */
import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Layers,
  LayoutGrid,
  Star,
  Clock,
  Share2,
  AlertTriangle,
  Users,
  Globe,
  Lock,
  X,
  ChevronDown,
  Check,
  Database,
  Trash2,
  Tag,
  Shapes,
  UserCircle,
  Network,
  GitBranch,
  Table2,
  Layers as LayersIcon,
  Layout as LayoutIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useWorkspacesStore } from '@/store/workspaces'
import { useViewFacets } from '@/hooks/useViewFacets'
import { avatarPaletteFor, initialsOf } from '@/lib/avatar'
import { FilterDropdown, type FilterOption } from './FilterDropdown'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ExplorerFilterBarProps {
  visibility: string | null
  onVisibilityChange: (v: string | null) => void
  workspaceIds: string[]
  onWorkspaceIdsChange: (ids: string[]) => void
  dataSourceId: string | null
  onDataSourceIdChange: (id: string | null) => void
  viewTypes: string[]
  onViewTypesChange: (types: string[]) => void
  tags: string[]
  onTagsChange: (tags: string[]) => void
  creatorIds: string[]
  onCreatorIdsChange: (ids: string[]) => void
  category: string | null
  onCategoryChange: (c: string | null) => void
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const CATEGORIES = [
  { key: null, label: 'All', icon: Layers },
  { key: 'my-views', label: 'My Views', icon: LayoutGrid },
  { key: 'my-favourites', label: 'Favorites', icon: Star },
  { key: 'recently-added', label: 'Recent', icon: Clock },
  { key: 'shared-with-me', label: 'Shared', icon: Share2 },
  { key: 'needs-attention', label: 'Attention', icon: AlertTriangle },
  { key: 'deleted', label: 'Deleted', icon: Trash2 },
] as const

const VISIBILITY_OPTIONS = [
  { key: null, label: 'Any visibility', icon: Layers },
  { key: 'enterprise', label: 'Enterprise', icon: Globe },
  { key: 'workspace', label: 'Workspace', icon: Users },
  { key: 'private', label: 'Private', icon: Lock },
] as const

/** Per-view-type icon + colour, mirroring ``ExplorerListRow`` / card. */
const VIEW_TYPE_META: Record<string, { icon: typeof Network; iconClass: string; label: string }> = {
  graph: { icon: Network, iconClass: 'text-indigo-500', label: 'Graph' },
  hierarchy: { icon: GitBranch, iconClass: 'text-violet-500', label: 'Hierarchy' },
  table: { icon: Table2, iconClass: 'text-emerald-500', label: 'Table' },
  'layered-lineage': { icon: LayersIcon, iconClass: 'text-amber-500', label: 'Lineage' },
  reference: { icon: LayoutIcon, iconClass: 'text-rose-500', label: 'Reference' },
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function useClickOutside(ref: React.RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [ref, onClose])
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function ExplorerFilterBar({
  visibility,
  onVisibilityChange,
  workspaceIds,
  onWorkspaceIdsChange,
  dataSourceId,
  onDataSourceIdChange,
  viewTypes,
  onViewTypesChange,
  tags,
  onTagsChange,
  creatorIds,
  onCreatorIdsChange,
  category,
  onCategoryChange,
}: ExplorerFilterBarProps) {
  const workspaces = useWorkspacesStore(s => s.workspaces)
  const { facets } = useViewFacets()

  // ── Source + Visibility bespoke dropdowns ────────────────────────
  const [dsOpen, setDsOpen] = useState(false)
  const [visOpen, setVisOpen] = useState(false)
  const [dsSearch, setDsSearch] = useState('')
  const dsSearchRef = useRef<HTMLInputElement>(null)
  const dsRef = useRef<HTMLDivElement>(null)
  const visRef = useRef<HTMLDivElement>(null)

  const closeDs = useCallback(() => { setDsOpen(false); setDsSearch('') }, [])
  const closeVis = useCallback(() => setVisOpen(false), [])

  useClickOutside(dsRef, closeDs)
  useClickOutside(visRef, closeVis)
  useEffect(() => { if (dsOpen) dsSearchRef.current?.focus() }, [dsOpen])

  const availableDataSources = useMemo(() => {
    const selected = workspaceIds.length > 0
      ? workspaces.filter(w => workspaceIds.includes(w.id))
      : workspaces
    return selected.flatMap(w => w.dataSources ?? [])
  }, [workspaces, workspaceIds])

  const filteredDataSources = useMemo(() => {
    if (!dsSearch.trim()) return availableDataSources
    const q = dsSearch.toLowerCase()
    return availableDataSources.filter(d => (d.label ?? d.id).toLowerCase().includes(q))
  }, [availableDataSources, dsSearch])

  // ── Options for shared FilterDropdown instances ─────────────────

  const workspaceOptions: FilterOption[] = useMemo(
    () => workspaces.map(w => ({ id: w.id, label: w.name })),
    [workspaces],
  )

  const viewTypeOptions: FilterOption[] = useMemo(
    () => facets.viewTypes.map(vt => {
      const meta = VIEW_TYPE_META[vt.value] ?? { icon: Shapes, iconClass: '', label: vt.value }
      return {
        id: vt.value,
        label: meta.label,
        sublabel: `${vt.count} view${vt.count !== 1 ? 's' : ''}`,
        icon: meta.icon,
        iconClassName: meta.iconClass,
      }
    }),
    [facets.viewTypes],
  )

  const tagOptions: FilterOption[] = useMemo(
    () => facets.tags.map(t => ({
      id: t.value,
      label: t.value,
      sublabel: `${t.count} view${t.count !== 1 ? 's' : ''}`,
    })),
    [facets.tags],
  )

  const creatorOptions: FilterOption[] = useMemo(
    () => facets.creators.map(c => ({
      id: c.userId,
      label: c.displayName,
      sublabel: c.email ?? undefined,
    })),
    [facets.creators],
  )

  /** Fast lookup from userId → full facet row for the custom option renderer. */
  const creatorById = useMemo(
    () => new Map(facets.creators.map(c => [c.userId, c])),
    [facets.creators],
  )

  // ── Active filter chips ─────────────────────────────────────────

  const activeFilters = useMemo(() => {
    const chips: { key: string; prefix: string; value: string }[] = []
    if (visibility) {
      const opt = VISIBILITY_OPTIONS.find(o => o.key === visibility)
      chips.push({ key: 'visibility', prefix: 'Visibility', value: opt?.label ?? visibility })
    }
    for (const wsId of workspaceIds) {
      const ws = workspaces.find(w => w.id === wsId)
      chips.push({ key: `ws-${wsId}`, prefix: 'Workspace', value: ws?.name ?? wsId })
    }
    if (dataSourceId) {
      const ds = availableDataSources.find(d => d.id === dataSourceId)
      chips.push({ key: 'ds', prefix: 'Source', value: ds?.label ?? dataSourceId })
    }
    for (const vt of viewTypes) {
      const meta = VIEW_TYPE_META[vt]
      chips.push({ key: `vt-${vt}`, prefix: 'Type', value: meta?.label ?? vt })
    }
    for (const t of tags) {
      chips.push({ key: `tag-${t}`, prefix: 'Tag', value: t })
    }
    for (const cid of creatorIds) {
      const c = facets.creators.find(x => x.userId === cid)
      chips.push({ key: `creator-${cid}`, prefix: 'Creator', value: c?.displayName ?? cid })
    }
    return chips
  }, [
    visibility, workspaceIds, dataSourceId, viewTypes, tags, creatorIds,
    workspaces, availableDataSources, facets.creators,
  ])

  function removeFilter(key: string) {
    if (key === 'visibility') onVisibilityChange(null)
    else if (key.startsWith('ws-')) onWorkspaceIdsChange(workspaceIds.filter(w => w !== key.slice(3)))
    else if (key === 'ds') onDataSourceIdChange(null)
    else if (key.startsWith('vt-')) onViewTypesChange(viewTypes.filter(v => v !== key.slice(3)))
    else if (key.startsWith('tag-')) onTagsChange(tags.filter(t => t !== key.slice(4)))
    else if (key.startsWith('creator-')) onCreatorIdsChange(creatorIds.filter(c => c !== key.slice(8)))
  }

  function clearAll() {
    onVisibilityChange(null)
    onWorkspaceIdsChange([])
    onDataSourceIdChange(null)
    onViewTypesChange([])
    onTagsChange([])
    onCreatorIdsChange([])
  }

  const visLabel = VISIBILITY_OPTIONS.find(o => o.key === visibility)?.label

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1 flex-wrap">
        {/* Category pills */}
        {CATEGORIES.map(tab => {
          const active = category === tab.key
          const Icon = tab.icon
          return (
            <button
              key={tab.key ?? '__all'}
              onClick={() => onCategoryChange(tab.key)}
              className={cn(
                'flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium',
                'transition-colors duration-150',
                active
                  ? 'bg-accent-lineage/12 text-accent-lineage'
                  : 'text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04]',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {tab.label}
            </button>
          )
        })}

        <div className="w-px h-5 bg-glass-border mx-1.5" />

        {/* Workspace — multi-select + search */}
        <FilterDropdown
          icon={Users}
          label="Workspace"
          accent="indigo"
          options={workspaceOptions}
          selectedIds={workspaceIds}
          onChange={onWorkspaceIdsChange}
          emptyMessage="No workspaces"
        />

        {/* Data Source — single-select (bespoke) */}
        <div ref={dsRef} className="relative">
          <button
            onClick={() => { if (dsOpen) closeDs(); else setDsOpen(true); closeVis() }}
            className={cn(
              'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium',
              'transition-colors duration-150',
              dataSourceId
                ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                : 'text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04]',
            )}
          >
            <Database className="h-3.5 w-3.5" />
            {dataSourceId
              ? (availableDataSources.find(d => d.id === dataSourceId)?.label ?? 'Source')
              : 'Source'}
            <ChevronDown className={cn('h-3 w-3 transition-transform duration-150', dsOpen && 'rotate-180')} />
          </button>

          {dsOpen && (
            <div className="absolute left-0 top-full z-50 mt-1.5 w-64 bg-canvas border border-glass-border rounded-xl shadow-xl overflow-hidden">
              <div className="relative border-b border-glass-border/50 p-2">
                <input
                  ref={dsSearchRef}
                  type="text"
                  value={dsSearch}
                  onChange={e => setDsSearch(e.target.value)}
                  placeholder="Search sources..."
                  className="w-full rounded-lg bg-black/[0.03] dark:bg-white/[0.04] px-2 py-1.5 text-xs text-ink outline-none placeholder:text-ink-muted/50 focus:bg-black/[0.05] dark:focus:bg-white/[0.06]"
                  onKeyDown={e => e.stopPropagation()}
                />
              </div>
              <div className="max-h-60 overflow-y-auto p-1">
                <button
                  onClick={() => { onDataSourceIdChange(null); closeDs() }}
                  className={cn(
                    'w-full rounded-lg px-3 py-2 text-left text-xs transition-colors duration-150',
                    !dataSourceId ? 'text-emerald-600 dark:text-emerald-400 font-medium' : 'text-ink-muted hover:bg-black/[0.04] dark:hover:bg-white/[0.04]',
                  )}
                >
                  All sources
                </button>
                {availableDataSources.length === 0 && (
                  <p className="px-3 py-2 text-xs text-ink-muted">No data sources</p>
                )}
                {availableDataSources.length > 0 && filteredDataSources.length === 0 && (
                  <p className="px-3 py-2 text-xs text-ink-muted">No matches</p>
                )}
                {filteredDataSources.map(ds => (
                  <button
                    key={ds.id}
                    onClick={() => { onDataSourceIdChange(ds.id); closeDs() }}
                    className={cn(
                      'w-full rounded-lg px-3 py-2 text-left text-xs transition-colors duration-150 truncate',
                      dataSourceId === ds.id ? 'text-emerald-600 dark:text-emerald-400 font-medium' : 'text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04]',
                    )}
                  >
                    {ds.label ?? ds.id}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Visibility — single-select (bespoke) */}
        <div ref={visRef} className="relative">
          <button
            onClick={() => { setVisOpen(p => !p); closeDs() }}
            className={cn(
              'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium',
              'transition-colors duration-150',
              visibility
                ? 'bg-violet-500/10 text-violet-600 dark:text-violet-400'
                : 'text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04]',
            )}
          >
            <Globe className="h-3.5 w-3.5" />
            {visLabel ?? 'Visibility'}
            <ChevronDown className={cn('h-3 w-3 transition-transform duration-150', visOpen && 'rotate-180')} />
          </button>

          {visOpen && (
            <div className="absolute left-0 top-full z-50 mt-1.5 w-48 p-1 bg-canvas border border-glass-border rounded-xl shadow-xl">
              {VISIBILITY_OPTIONS.map(opt => {
                const active = visibility === opt.key
                const Icon = opt.icon
                return (
                  <button
                    key={opt.key ?? '__all'}
                    onClick={() => { onVisibilityChange(opt.key); setVisOpen(false) }}
                    className={cn(
                      'w-full flex items-center gap-2 rounded-lg px-3 py-2 text-xs transition-colors duration-150',
                      active ? 'text-violet-600 dark:text-violet-400 font-medium' : 'text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04]',
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {opt.label}
                    {active && <Check className="h-3 w-3 ml-auto" />}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* View Type — multi-select */}
        <FilterDropdown
          icon={Shapes}
          label="Type"
          accent="sky"
          options={viewTypeOptions}
          selectedIds={viewTypes}
          onChange={onViewTypesChange}
          disableSearch
          emptyMessage="No view types"
        />

        {/* Tag — multi-select + search */}
        <FilterDropdown
          icon={Tag}
          label="Tag"
          accent="amber"
          options={tagOptions}
          selectedIds={tags}
          onChange={onTagsChange}
          emptyMessage="No tags yet"
        />

        {/* Creator — multi-select + search, rendered with avatar + name +
            email + view-count pill so users can visually pick from a roster
            rather than scanning plain-text rows. Mirrors the hover card
            treatment for continuity. */}
        <FilterDropdown
          icon={UserCircle}
          label="Creator"
          accent="rose"
          options={creatorOptions}
          selectedIds={creatorIds}
          onChange={onCreatorIdsChange}
          emptyMessage="No creators yet"
          searchPlaceholder="Search creators..."
          panelWidthClassName="w-80"
          activeLabelFormatter={(ids, opts) => {
            if (ids.length === 1) {
              const match = opts.find(o => o.id === ids[0])
              // Truncate very long names so the trigger button stays compact.
              const name = match?.label ?? ids[0]
              return name.length > 18 ? `${name.slice(0, 17)}…` : name
            }
            return `${ids.length} creators`
          }}
          renderOption={(opt, { isSelected }) => {
            const creator = creatorById.get(opt.id)
            const displayName = creator?.displayName ?? opt.label
            const email = creator?.email
            const count = creator?.count ?? 0
            const palette = avatarPaletteFor(opt.id)
            return (
              <div className="flex items-center gap-3 px-3 py-2">
                <div
                  className={cn(
                    'w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0',
                    'transition-all duration-150',
                    palette.bg,
                    palette.text,
                    isSelected && cn('ring-2 ring-offset-1 ring-offset-canvas', palette.ring),
                  )}
                >
                  {initialsOf(displayName)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className={cn(
                    'text-xs truncate',
                    isSelected ? 'font-semibold text-ink' : 'font-medium text-ink',
                  )}>
                    {displayName}
                  </div>
                  {email && (
                    <div className="text-[10px] text-ink-muted/70 truncate">
                      {email}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className="inline-flex items-center rounded-full bg-black/[0.04] dark:bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-medium text-ink-muted/80">
                    {count}
                  </span>
                  {isSelected && (
                    <Check className="h-3.5 w-3.5 text-rose-500 shrink-0" />
                  )}
                </div>
              </div>
            )
          }}
        />
      </div>

      {/* ── Active filter chips ──
          Container animates height; each chip inside uses its own
          spring for a tactile add/remove feel. */}
      <AnimatePresence>
        {activeFilters.length > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="flex flex-wrap items-center gap-1.5 overflow-hidden"
          >
            <AnimatePresence initial={false}>
              {activeFilters.map(f => (
                <motion.span
                  key={f.key}
                  layout
                  initial={{ opacity: 0, scale: 0.7, y: -4 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.7, y: -4 }}
                  transition={{ type: 'spring', stiffness: 500, damping: 28, mass: 0.6 }}
                  className="inline-flex items-center gap-1.5 rounded-full border border-glass-border bg-canvas-elevated pl-2.5 pr-1 py-1 text-[11px]"
                >
                  <span className="text-ink-muted/60 font-medium">{f.prefix}:</span>
                  <span className="font-semibold text-ink">{f.value}</span>
                  <button
                    onClick={() => removeFilter(f.key)}
                    className="rounded-full p-0.5 text-ink-muted hover:text-ink hover:bg-black/10 dark:hover:bg-white/10 transition-colors duration-150"
                    title="Remove filter"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </motion.span>
              ))}
            </AnimatePresence>
            <button
              onClick={clearAll}
              className="text-[11px] font-medium text-ink-muted hover:text-ink transition-colors duration-150 underline underline-offset-2"
            >
              Clear all
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
