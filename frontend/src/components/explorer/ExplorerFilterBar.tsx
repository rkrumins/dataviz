/**
 * ExplorerFilterBar — toolbar combining category pills and filter dropdowns.
 *
 * Layout:
 *   [Category pills]                                           [page controls]
 *   [Versioned | External] [Date ▾] [People ▾] | [Workspace ▾] [Source ▾] [Type ▾] [Tag ▾] [Visibility ▾]
 *   [active filter chips … Clear all]
 *
 * It edits one ``ViewFilterState`` (features/view-filters) — the value the page
 * keeps in its address and the workspace Views tab keeps in state — so the two
 * surfaces filter identically. Every menu is the shared ``FilterDropdown`` (same
 * search behaviour, accent tokens and keyboard isolation), and every option shows
 * how many views it would leave given the other filters, so a dead end is
 * visible before it is clicked.
 *
 * Performance: no transition-all, no backdrop-blur on persistent elements.
 */
import { useMemo } from 'react'
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
  Database,
  Trash2,
  Tag,
  Shapes,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { viewTypeLabel, viewTypeColor, viewTypeIconComponent } from '@/lib/viewUtils'
import { useWorkspacesStore } from '@/store/workspaces'
import type { ViewFilterState } from '@/features/view-filters/model'
import { filterChips, clearDimensions } from '@/features/view-filters/dimensions'
import { useFilterLookups } from '@/features/view-filters/useFilterLookups'
import { useLiveFacets } from '@/features/view-filters/useLiveFacets'
import { withCounts } from '@/features/view-filters/facetOptions'
import { SOURCE_KIND_META } from '@/features/view-filters/sourceKindMeta'
import { SourceKindToggle } from '@/features/view-filters/components/SourceKindToggle'
import { DateFilterMenu } from '@/features/view-filters/components/DateFilterMenu'
import { PeopleFilterMenu } from '@/features/view-filters/components/PeopleFilterMenu'
import type { CurrentPerson } from '@/features/view-filters/people'
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
  { id: 'enterprise', label: 'Enterprise', icon: Globe },
  { id: 'workspace', label: 'Workspace', icon: Users },
  { id: 'private', label: 'Private', icon: Lock },
] as const

// Per-view-type icon + colour + label come from the SHARED resolver in
// lib/viewUtils — no local copy (see viewTypeMeta/viewTypeLabel).

/** A data source as the Source menu lists it. */
interface SourceRow {
  id: string
  label: string
  workspaceId: string
  workspaceName?: string
  kind?: 'versioned' | 'external' | null
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function ExplorerFilterBar({ state, onChange, today, currentUser, trailing }: ExplorerFilterBarProps) {
  const { workspaceIds, dataSourceId, viewTypes, tags, category, visibility } = state
  const set = (patch: Partial<ViewFilterState>) => onChange({ ...state, ...patch })

  const workspaces = useWorkspacesStore(s => s.workspaces)
  const ctx = useMemo(() => ({ currentUserId: currentUser?.id ?? null, today }), [currentUser?.id, today])
  const { universe, people, counts, sourceKinds, pending } = useLiveFacets(state, ctx)
  const lookups = useFilterLookups(people, today, currentUser?.id)

  // ── Options: from the universe, counts from the live facets ────────

  // Your workspaces, plus any other workspace whose views you can read.
  const workspaceOptions: FilterOption[] = useMemo(() => {
    const named = new Map(workspaces.map(w => [w.id, w.name]))
    for (const w of universe.workspaces ?? []) if (!named.has(w.id)) named.set(w.id, w.name)
    const rows = [...named].map(([id, name]) => ({ id, name }))
    return withCounts(rows, w => w.id, counts.workspaces, workspaceIds, id => ({ id, name: id }))
      .map(({ option: w, count }) => ({ id: w.id, label: w.name, count }))
  }, [workspaces, universe.workspaces, counts.workspaces, workspaceIds])

  // Sources of the chosen workspaces (all of them when none is chosen), each with
  // its workspace and whether it is versioned.
  const dataSourceOptions: FilterOption[] = useMemo(() => {
    const byId = new Map<string, SourceRow>()
    for (const w of workspaces) {
      for (const d of w.dataSources ?? []) {
        byId.set(d.id, { id: d.id, label: d.label ?? d.id, workspaceId: w.id, workspaceName: w.name })
      }
    }
    for (const d of universe.dataSources ?? []) {
      const known = byId.get(d.id)
      byId.set(d.id, {
        id: d.id, label: known?.label ?? d.name, workspaceId: known?.workspaceId ?? d.workspaceId ?? '',
        workspaceName: known?.workspaceName ?? d.workspaceName ?? undefined, kind: d.kind,
      })
    }
    const inScope = [...byId.values()]
      .filter(d => workspaceIds.length === 0 || workspaceIds.includes(d.workspaceId))
    return withCounts(inScope, d => d.id, counts.dataSources, dataSourceId ? [dataSourceId] : [],
      id => ({ id, label: id, workspaceId: '' }))
      .map(({ option: d, count }) => {
        const meta = d.kind ? SOURCE_KIND_META[d.kind] : null
        return {
          id: d.id, label: d.label, sublabel: d.workspaceName, count,
          icon: meta?.icon ?? Database,
          iconClassName: meta?.glyph ?? 'text-emerald-500',
        }
      })
  }, [workspaces, universe.dataSources, workspaceIds, counts.dataSources, dataSourceId])

  const viewTypeOptions: FilterOption[] = useMemo(
    () => withCounts(universe.viewTypes, vt => vt.value, counts.viewTypes, viewTypes, value => ({ value, count: 0 }))
      .map(({ option: vt, count }) => ({
        id: vt.value,
        label: viewTypeLabel(vt.value),
        icon: viewTypeIconComponent(vt.value),
        iconClassName: viewTypeColor(vt.value),
        count,
      })),
    [universe.viewTypes, counts.viewTypes, viewTypes],
  )

  const tagOptions: FilterOption[] = useMemo(
    () => withCounts(universe.tags, t => t.value, counts.tags, tags, value => ({ value, count: 0 }))
      .map(({ option: t, count }) => ({ id: t.value, label: t.value, count })),
    [universe.tags, counts.tags, tags],
  )

  const visibilityOptions: FilterOption[] = useMemo(
    () => withCounts([...VISIBILITY_OPTIONS], o => o.id, counts.visibilities)
      .map(({ option: o, count }) => ({ id: o.id, label: o.label, icon: o.icon, count })),
    [counts.visibilities],
  )

  // ── Active filter chips ─────────────────────────────────────────
  // Search and category have their own controls; every other filter is a chip.
  const chips = useMemo(() => filterChips(state, lookups), [state, lookups])

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
              onClick={() => set({ category: tab.key })}
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
          counts={sourceKinds}
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

        <FilterDropdown
          icon={Users}
          label="Workspace"
          accent="indigo"
          options={workspaceOptions}
          selectedIds={workspaceIds}
          onChange={ids => set({ workspaceIds: ids })}
          countsPending={pending}
          emptyMessage="No workspaces"
        />

        <FilterDropdown
          icon={Database}
          label="Source"
          accent="emerald"
          selectionMode="single"
          options={dataSourceOptions}
          selectedIds={dataSourceId ? [dataSourceId] : []}
          onChange={ids => set({ dataSourceId: ids[0] ?? null })}
          activeLabelFormatter={(ids, opts) => opts.find(o => o.id === ids[0])?.label ?? 'Source'}
          countsPending={pending}
          panelWidthClassName="w-72"
          searchPlaceholder="Search sources..."
          emptyMessage="No data sources"
        />

        <FilterDropdown
          icon={Shapes}
          label="Type"
          accent="sky"
          options={viewTypeOptions}
          selectedIds={viewTypes}
          onChange={types => set({ viewTypes: types })}
          countsPending={pending}
          disableSearch
          emptyMessage="No view types"
        />

        <FilterDropdown
          icon={Tag}
          label="Tag"
          accent="amber"
          options={tagOptions}
          selectedIds={tags}
          onChange={next => set({ tags: next })}
          countsPending={pending}
          emptyMessage="No tags yet"
        />

        <FilterDropdown
          icon={Globe}
          label="Visibility"
          accent="violet"
          selectionMode="single"
          options={visibilityOptions}
          selectedIds={visibility ? [visibility] : []}
          onChange={ids => set({ visibility: ids[0] ?? null })}
          activeLabelFormatter={(ids, opts) => opts.find(o => o.id === ids[0])?.label ?? 'Visibility'}
          countsPending={pending}
          disableSearch
          panelWidthClassName="w-52"
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
