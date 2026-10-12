/**
 * ExplorerFilterBar — toolbar combining category pills and filter dropdowns.
 *
 * Layout:
 *   [Category pills]
 *   [Versioned | External] [Date ▾] [People ▾] [Workspace ▾] [Source ▾] [Type ▾] [Tag ▾] [Visibility ▾]
 *   [active filter chips … Clear all]
 *
 * It edits one ``ViewFilterState`` (features/view-filters) — the value the page
 * keeps in its address and the workspace Views tab keeps in state — so the two
 * surfaces filter identically. Multi-select dropdowns use the shared
 * ``FilterDropdown`` (same search behaviour, same accent tokens, same keyboard
 * isolation). Source and Visibility remain bespoke single-selects.
 *
 * Performance: no transition-all, no backdrop-blur on persistent elements.
 */
import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
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
  ChevronDown,
  Check,
  Database,
  Trash2,
  Tag,
  Shapes,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { viewTypeLabel, viewTypeColor, viewTypeIconComponent } from '@/lib/viewUtils'
import { keyboardScopeProps } from '@/lib/keyboardScope'
import { useWorkspacesStore } from '@/store/workspaces'
import { useViewFacets } from '@/hooks/useViewFacets'
import type { ViewFilterState } from '@/features/view-filters/model'
import { filterChips, clearDimensions } from '@/features/view-filters/dimensions'
import { useFilterLookups } from '@/features/view-filters/useFilterLookups'
import { SourceKindToggle } from '@/features/view-filters/components/SourceKindToggle'
import { DateFilterMenu } from '@/features/view-filters/components/DateFilterMenu'
import { PeopleFilterMenu } from '@/features/view-filters/components/PeopleFilterMenu'
import { peopleFromFacets, type CurrentPerson } from '@/features/view-filters/people'
import { ActiveFilterChips } from '@/features/view-filters/components/ActiveFilterChips'
import { FilterDropdown, type FilterOption } from './FilterDropdown'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ExplorerFilterBarProps {
  state: ViewFilterState
  onChange: (next: ViewFilterState) => void
  /** Local `YYYY-MM-DD` the date rules resolve against. */
  today: string
  currentUser: CurrentPerson | null
  /** The page's own controls (sort, layout), at the end of the first row. */
  trailing?: React.ReactNode
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

// Per-view-type icon + colour + label come from the SHARED resolver in
// lib/viewUtils — no local copy (see viewTypeMeta/viewTypeLabel).

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

export function ExplorerFilterBar({ state, onChange, today, currentUser, trailing }: ExplorerFilterBarProps) {
  const {
    visibility, workspaceIds, dataSourceId, viewTypes, tags, category,
  } = state
  const set = (patch: Partial<ViewFilterState>) => onChange({ ...state, ...patch })
  const onVisibilityChange = (v: string | null) => set({ visibility: v })
  const onWorkspaceIdsChange = (ids: string[]) => set({ workspaceIds: ids })
  const onDataSourceIdChange = (id: string | null) => set({ dataSourceId: id })
  const onViewTypesChange = (types: string[]) => set({ viewTypes: types })
  const onTagsChange = (next: string[]) => set({ tags: next })
  const onCategoryChange = (c: string | null) => set({ category: c })

  const workspaces = useWorkspacesStore(s => s.workspaces)
  const { facets } = useViewFacets()
  const people = useMemo(() => peopleFromFacets(facets), [facets])
  const lookups = useFilterLookups(people, today, currentUser?.id)

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
      return {
        id: vt.value,
        label: viewTypeLabel(vt.value),
        sublabel: `${vt.count} view${vt.count !== 1 ? 's' : ''}`,
        icon: viewTypeIconComponent(vt.value),
        iconClassName: viewTypeColor(vt.value),
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

  // ── Active filter chips ─────────────────────────────────────────
  // Search and category have their own controls; every other filter is a chip.
  const chips = useMemo(() => filterChips(state, lookups), [state, lookups])

  const visLabel = VISIBILITY_OPTIONS.find(o => o.key === visibility)?.label

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */
  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-1 flex-wrap">
        {/* Category pills */}
        {CATEGORIES.map(tab => {
          const active = category === tab.key
          const Icon = tab.icon
          return (
            <button
              key={tab.key ?? '__all'}
              onClick={() => onCategoryChange(tab.key)}
              aria-pressed={active}
              className={cn(
                'flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium',
                'transition-colors duration-150',
                active
                  ? 'bg-accent-lineage/10 text-accent-lineage'
                  : 'text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04]',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {tab.label}
            </button>
          )
        })}

        {trailing && <div className="ml-auto flex items-center gap-1.5">{trailing}</div>}
      </div>

      <div className="flex items-center gap-1 flex-wrap">
        {/* Versioned / External — two answers, both visible */}
        <SourceKindToggle
          value={state.sourceKind}
          onChange={v => set({ sourceKind: v })}
          className="mr-1"
        />

        {/* Date — created or last changed, presets + calendar */}
        <DateFilterMenu
          created={state.created}
          updated={state.updated}
          onChange={patch => set(patch)}
          today={today}
          recentActive={category === 'recently-added'}
        />

        {/* People — who created or last edited a view */}
        <PeopleFilterMenu
          ids={state.contributorIds}
          role={state.contributorRole}
          people={people}
          currentUser={currentUser}
          onChange={({ ids, role }) => set({ contributorIds: ids, contributorRole: role })}
        />

        <div className="w-px h-5 bg-glass-border mx-1" />

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
            <div {...keyboardScopeProps('view-filters')} className="absolute left-0 top-full z-50 mt-1.5 w-64 bg-canvas border border-glass-border rounded-xl shadow-xl overflow-hidden">
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
            <div {...keyboardScopeProps('view-filters')} className="absolute left-0 top-full z-50 mt-1.5 w-48 p-1 bg-canvas border border-glass-border rounded-xl shadow-xl">
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

      </div>

      <ActiveFilterChips
        chips={chips}
        currentUserId={currentUser?.id}
        onRemove={chip => onChange(chip.without(state))}
        // Category and search have their own controls and their own clears.
        onClearAll={() => onChange(clearDimensions(state, ['category', 'search']))}
      />
    </div>
  )
}
