/**
 * The filter palette — every filter value in one searchable list (⇧F).
 *
 * Nine menus are quick with a mouse and slow with a keyboard. Here every value of
 * every filter — a person, a tag, a source, "Versioned", "Updated · Past 7 days",
 * a saved filter — is one search away, with the same live count its menu shows and
 * a check when it is on. Enter applies and closes; ⌘/Ctrl+Enter applies and stays
 * open, for picking several in a row. Typing a group's name ("tag", "people")
 * narrows the list to it, because an item's group is part of what it matches.
 *
 * The matching is ours rather than cmdk's: cmdk 1.1.1 ranks items within a group
 * but never reorders the groups, so its top pick for "tag pii" was a date preset
 * that happened to sit in an earlier group.
 */
import { useMemo, useRef, useState } from 'react'
import { Command } from 'cmdk'
import {
  Check, CalendarRange, Database, Filter, Globe, Layers, Lock, Shapes, Star, Tag, UserCircle, Users,
  Bookmark,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { keyboardScopeProps } from '@/lib/keyboardScope'
import { Backdrop } from '@/components/ui/Backdrop'
import { useFeature } from '@/store/features'
import { useWorkspacesStore } from '@/store/workspaces'
import { viewTypeLabel } from '@/lib/viewUtils'
import { DATE_PRESETS } from '../dateFilter'
import { CATEGORY_LABELS, SOURCE_KIND_LABELS, VISIBILITY_LABELS } from '../dimensions'
import { ME, type ViewFilterState } from '../model'
import type { ResolveContext } from '../params'
import type { CurrentPerson } from '../people'
import { SOURCE_KIND_META } from '../sourceKindMeta'
import { useLiveFacets } from '../useLiveFacets'

/** A saved filter, as the palette offers it. */
export interface PaletteSavedFilter {
  id: string
  name: string
  active: boolean
  apply: () => void
}

interface Item {
  key: string
  group: string
  label: string
  /** Extra words that should find it. */
  keywords?: string
  icon: React.ComponentType<{ className?: string }>
  iconClass?: string
  count?: number
  active: boolean
  apply: (s: ViewFilterState) => ViewFilterState
}

const startsAWord = (text: string, word: string) => text.split(/[\s·,-]+/).some(part => part.startsWith(word))

/**
 * How well an item matches the typed words: each must appear in its label, its
 * group or its keywords, and a word that starts the label counts most. 0 means
 * some word is missing.
 */
function matchScore(item: { group: string; label: string; keywords?: string }, words: string[]): number {
  const label = item.label.toLowerCase()
  const rest = `${item.group} ${item.keywords ?? ''}`.toLowerCase()
  let score = 0
  for (const w of words) {
    if (label.startsWith(w)) score += 4
    else if (startsAWord(label, w)) score += 3
    else if (label.includes(w)) score += 2
    else if (startsAWord(rest, w)) score += 1
    else if (rest.includes(w)) score += 0.5
    else return 0
  }
  return score
}

const PALETTE_DATES = DATE_PRESETS.filter(p => ['today', '7d', '30d', 'this-month', '90d', 'this-year'].includes(p.rule))

function toggle(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter(x => x !== id) : [...list, id]
}

export function FilterPalette({ state, onChange, ctx, currentUser, saved, onClose }: {
  state: ViewFilterState
  /** Given a change, not a whole state: ⌘↵ can pick again before the host has
   *  re-rendered, and the second pick must build on the first. */
  onChange: (update: (prev: ViewFilterState) => ViewFilterState) => void
  /** The host's resolve context, so the counts here match its list. */
  ctx: ResolveContext
  currentUser: CurrentPerson | null
  saved?: PaletteSavedFilter[]
  onClose: () => void
}) {
  const [search, setSearch] = useState('')
  const keepOpen = useRef(false)
  const versioning = useFeature('versioningEnabled')
  const workspaces = useWorkspacesStore(s => s.workspaces)
  const { universe, people, counts, sourceKinds } = useLiveFacets(state, ctx)

  const items = useMemo<Item[]>(() => {
    const out: Item[] = []
    for (const [key, label] of [[null, 'All views'], ...Object.entries(CATEGORY_LABELS)] as [string | null, string][]) {
      out.push({
        key: `cat-${key}`, group: 'Quick filters', label, icon: key === 'my-favourites' ? Star : Layers,
        active: state.category === key, apply: s => ({ ...s, category: s.category === key ? null : key }),
      })
    }
    if (versioning) {
      for (const kind of ['versioned', 'external'] as const) {
        out.push({
          key: `kind-${kind}`, group: 'Versioned or external', label: SOURCE_KIND_LABELS[kind],
          keywords: kind === 'versioned' ? 'version control drafts' : 'mastered elsewhere read-only',
          icon: SOURCE_KIND_META[kind].icon, iconClass: SOURCE_KIND_META[kind].glyph,
          count: sourceKinds?.[kind], active: state.sourceKind === kind,
          apply: s => ({ ...s, sourceKind: s.sourceKind === kind ? null : kind }),
        })
      }
    }
    for (const field of ['updated', 'created'] as const) {
      for (const p of PALETTE_DATES) {
        out.push({
          key: `${field}-${p.rule}`, group: 'Date', label: `${field === 'updated' ? 'Updated' : 'Created'} · ${p.label}`,
          keywords: field === 'updated' ? 'changed edited modified' : 'made new',
          icon: CalendarRange, iconClass: 'text-teal-500', active: state[field] === p.rule,
          apply: s => ({ ...s, [field]: s[field] === p.rule ? null : p.rule }),
        })
      }
    }
    const roleCount = (p: typeof people[number]) =>
      state.contributorRole === 'created' ? p.createdCount
        : state.contributorRole === 'edited' ? p.editedCount
          : state.contributorRole === 'published' ? p.publishedCount : p.count
    if (currentUser) {
      const me = people.find(p => p.userId === currentUser.id)
      out.push({
        key: 'person-me', group: 'People', label: 'You', keywords: `${currentUser.name} ${currentUser.email ?? ''} me`,
        icon: UserCircle, iconClass: 'text-rose-500', count: me ? roleCount(me) : undefined,
        active: state.contributorIds.includes(ME), apply: s => ({ ...s, contributorIds: toggle(s.contributorIds, ME) }),
      })
    }
    for (const p of people) {
      if (p.userId === currentUser?.id) continue
      out.push({
        key: `person-${p.userId}`, group: 'People', label: p.displayName, keywords: p.email ?? undefined,
        icon: UserCircle, iconClass: 'text-rose-500', count: roleCount(p),
        active: state.contributorIds.includes(p.userId),
        apply: s => ({ ...s, contributorIds: toggle(s.contributorIds, p.userId) }),
      })
    }
    const names = new Map(workspaces.map(w => [w.id, w.name]))
    for (const w of universe.workspaces ?? []) if (!names.has(w.id)) names.set(w.id, w.name)
    for (const [id, name] of names) {
      out.push({
        key: `ws-${id}`, group: 'Workspaces', label: name, icon: Users, iconClass: 'text-indigo-500',
        count: counts.workspaces ? (counts.workspaces.get(id) ?? 0) : undefined,
        active: state.workspaceIds.includes(id),
        apply: s => ({ ...s, workspaceIds: toggle(s.workspaceIds, id) }),
      })
    }
    for (const d of universe.dataSources ?? []) {
      const meta = d.kind ? SOURCE_KIND_META[d.kind] : null
      out.push({
        key: `ds-${d.id}`, group: 'Sources', label: d.name, keywords: d.workspaceName ?? undefined,
        icon: meta?.icon ?? Database, iconClass: meta?.glyph ?? 'text-emerald-500',
        count: counts.dataSources ? (counts.dataSources.get(d.id) ?? 0) : undefined,
        active: state.dataSourceId === d.id,
        apply: s => ({ ...s, dataSourceId: s.dataSourceId === d.id ? null : d.id }),
      })
    }
    for (const vt of universe.viewTypes) {
      out.push({
        key: `vt-${vt.value}`, group: 'Types', label: viewTypeLabel(vt.value), icon: Shapes, iconClass: 'text-sky-500',
        count: counts.viewTypes ? (counts.viewTypes.get(vt.value) ?? 0) : undefined,
        active: state.viewTypes.includes(vt.value),
        apply: s => ({ ...s, viewTypes: toggle(s.viewTypes, vt.value) }),
      })
    }
    for (const t of universe.tags) {
      out.push({
        key: `tag-${t.value}`, group: 'Tags', label: t.value, icon: Tag, iconClass: 'text-amber-500',
        count: counts.tags ? (counts.tags.get(t.value) ?? 0) : undefined,
        active: state.tags.includes(t.value),
        apply: s => ({ ...s, tags: toggle(s.tags, t.value) }),
      })
    }
    for (const [vis, label] of Object.entries(VISIBILITY_LABELS)) {
      out.push({
        key: `vis-${vis}`, group: 'Visibility', label, icon: vis === 'private' ? Lock : vis === 'workspace' ? Users : Globe,
        iconClass: 'text-violet-500', count: counts.visibilities ? (counts.visibilities.get(vis) ?? 0) : undefined,
        active: state.visibility === vis,
        apply: s => ({ ...s, visibility: s.visibility === vis ? null : vis }),
      })
    }
    return out
  }, [state, versioning, sourceKinds, people, currentUser, workspaces, universe, counts])

  const groups = useMemo(() => {
    type Row = Omit<Item, 'apply'> & { select: () => void }
    const rows: Row[] = [
      ...(saved ?? []).map(f => ({
        key: `saved-${f.id}`, group: 'Saved filters', label: f.name, icon: Bookmark,
        iconClass: 'text-accent-lineage', active: f.active, select: f.apply,
      })),
      ...items.map(({ apply, ...item }) => ({ ...item, select: () => onChange(apply) })),
    ]
    const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const byGroup = new Map<string, { best: number; rows: { row: Row; score: number }[] }>()
    for (const row of rows) {
      const score = words.length ? matchScore(row, words) : 1
      if (score === 0) continue
      const group = byGroup.get(row.group) ?? { best: 0, rows: [] }
      group.best = Math.max(group.best, score)
      group.rows.push({ row, score })
      byGroup.set(row.group, group)
    }
    // Best match first, so Enter takes it: groups by their best row, rows by
    // score, and ties keep their usual order (the sort is stable).
    return [...byGroup]
      .sort((a, b) => b[1].best - a[1].best)
      .map(([group, g]) => [group, g.rows.sort((a, b) => b.score - a.score).map(r => r.row)] as const)
  }, [saved, items, search, onChange])

  const pick = (apply: () => void) => {
    apply()
    if (keepOpen.current) keepOpen.current = false
    else onClose()
  }

  return (
    <>
      <Backdrop open onClick={onClose} zClassName="z-[100]" className="bg-black/40" />
      <div className="fixed inset-0 z-[100] pointer-events-none" {...keyboardScopeProps('filter-palette')}>
        <div className="absolute inset-x-0 top-[12%] flex justify-center px-4">
          <div className="relative w-full max-w-xl pointer-events-auto">
            <Command
              label="Filter views"
              loop
              shouldFilter={false}
              className="relative w-full overflow-hidden rounded-2xl border border-black/[0.08] dark:border-white/[0.1] bg-canvas-elevated shadow-2xl animate-slide-up"
              onKeyDown={e => {
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
                // ⌘/Ctrl+Enter applies and keeps the palette open.
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) keepOpen.current = true
              }}
            >
              <div className="flex items-center gap-3 border-b border-black/[0.06] dark:border-white/[0.08] px-4 py-3">
                <Filter className="h-4 w-4 text-accent-lineage" aria-hidden />
                <Command.Input
                  value={search}
                  onValueChange={setSearch}
                  placeholder="Filter by a person, tag, source, date…"
                  className="flex-1 bg-transparent text-sm text-ink placeholder:text-ink-muted focus:outline-none"
                  autoFocus
                />
                <kbd className="kbd">ESC</kbd>
              </div>
              <Command.List className="max-h-[420px] overflow-y-auto custom-scrollbar p-2">
                <Command.Empty className="py-8 text-center text-sm text-ink-muted">
                  Nothing to filter by matches &ldquo;{search}&rdquo;.
                </Command.Empty>
                {groups.map(([group, rows]) => (
                  <Command.Group key={group} heading={group}>
                    {rows.map(row => (
                      <PaletteRow
                        key={row.key}
                        value={row.key}
                        label={row.label}
                        icon={row.icon}
                        iconClass={row.iconClass}
                        count={row.count}
                        active={row.active}
                        onSelect={() => pick(row.select)}
                      />
                    ))}
                  </Command.Group>
                ))}
              </Command.List>
              <div className="flex items-center justify-between gap-3 border-t border-black/[0.06] dark:border-white/[0.08] px-4 py-2 text-[10px] text-ink-muted">
                <span><kbd className="kbd">↵</kbd> apply · <kbd className="kbd">⌘↵</kbd> apply and keep going</span>
                <span>Type a group (“tag”, “people”) to narrow</span>
              </div>
            </Command>
          </div>
        </div>
      </div>
    </>
  )
}

function PaletteRow({ value, label, icon: Icon, iconClass, count, active, onSelect }: {
  value: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  iconClass?: string
  count?: number
  active: boolean
  onSelect: () => void
}) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className={cn(
        'flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2',
        'data-[selected=true]:bg-accent-lineage/10 transition-colors duration-100',
        count === 0 && !active && 'opacity-50',
      )}
    >
      <Icon className={cn('h-4 w-4 shrink-0', iconClass)} aria-hidden />
      <span className={cn('min-w-0 flex-1 truncate text-sm text-ink', active && 'font-semibold')}>{label}</span>
      {count !== undefined && (
        <span className="tabular-nums text-[11px] font-semibold text-ink-muted">{count.toLocaleString()}</span>
      )}
      {active && <Check className="h-4 w-4 shrink-0 text-accent-lineage" strokeWidth={3} aria-label="On" />}
    </Command.Item>
  )
}
