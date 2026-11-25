/**
 * ReviewExplorer — Review & Save's list of staged changes, built for tens of thousands of them:
 *
 *   - a filter bar (what changed, how, which type, a search, what needs attention) with counts,
 *     "1,240 shown of 10,482", and Discard the N shown;
 *   - a virtualized list — one row per entity, relationship or layout item, drawn only while on
 *     screen — each a summary first ("Edited Owner, Tier and 2 more", or what it does: "Moves it
 *     into Finance"), opened to its key differences, then to everything: each field as the value
 *     it is, a move's from/to, a delete's cascade, conflicts and errors;
 *   - J/K (↑/↓) move, → / ← open and close, Shift+→ opens everything shown, o shows it on the
 *     canvas, Delete discards, n jumps to the next that needs attention, / searches;
 *   - or top-down (`Hierarchy`, the same choice as every change list): each change under its
 *     container as the canvas places it (`buildReviewTree`), a level at a time; filtered, the list
 *     says where each change sits, and "In hierarchy" opens the way down to it.
 *
 * Everything per row is built for the rows drawn and the one selected; the index behind it is built
 * once per list of changes (`buildReviewIndex`).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  AlertTriangle, ArrowUpRight, CheckCircle2, ChevronsDownUp, ChevronsUpDown, CircleAlert, Code2, Layers,
  ListFilter, ListTree, Navigation, Search, SearchX, Trash2, X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useCanvasStore } from '@/store/canvas'
import { usePersonaMode } from '@/store/persona'
import type { StagedChange } from '@/store/stagedChangesStore'
import { HoverTip } from '@/components/ui/HoverTip'
import { Kbd } from '@/components/ui/Kbd'
import { Segmented } from '@/components/ui/Segmented'
import { useEntityColorSet } from '@/hooks/useEntityVisual'
import { JsonView } from '@/components/panels/shell/JsonView'
import { nodeUpdatePatch } from '@/features/versioning/model/stagedChangesToOps'
import { fieldChanges, type ReviewGroup, type ReviewKind, type Sentence } from '@/features/versioning/model/reviewModel'
import {
  headingLabel, headingOf, isNarrowed, needsAttention, NO_FILTER, rowKey, type ReviewFilter, type ReviewIndex,
} from '@/features/versioning/model/reviewIndex'
import type { ChangeStatus } from '@/features/versioning/model/changeModel'
import { CascadeImpactList } from '@/features/versioning/components/CascadeImpactList'
import { ConflictChoices } from '@/features/versioning/components/ConflictChoices'
import { NodeDiffBadge } from '@/features/versioning/components/NodeDiffBadge'
import { ReviewValue } from '@/features/versioning/components/ReviewValue'
import { ExpandableChangeRow } from '@/features/versioning/components/ExpandableChangeRow'
import { ChangeSummary } from '@/features/versioning/components/ChangeSummary'
import { fieldPath, keyDifferences, summarizeFields, type FieldChange } from '@/features/versioning/model/fieldDiff'
import { useExpandableRows, type RowLevel } from '@/hooks/useExpandableRows'
import { ExportMenu, type ExportDetail } from '@/features/versioning/components/ExportMenu'
import { TreeView, type TreeRowFrame } from '@/features/versioning/components/TreeView'
import { useChangeListLayout } from '@/features/versioning/hooks/useChangeListLayout'
import { ChangeKindTag } from '../DropHint'
import { NO_REACH, ONLY_THIS_VIEW, dataTagText, type DataReach } from '../changeKind'
import { useReviewTree } from '@/features/versioning/hooks/useReviewTree'
import { pathOf, treeIdOf } from '@/features/versioning/model/reviewTree'
import type { ChangeTreeItem } from '@/services/versioningApiService'
import { canvasPlacement } from './canvasLookup'

/** A row closed: its name, and under it what it does. */
const ROW_HEIGHT = 58
const HEADING_HEIGHT = 30
const STATUSES: ChangeStatus[] = ['added', 'modified', 'removed']
const KIND_LABEL: Record<ReviewKind | 'all', string> = { all: 'All', node: 'Entities', edge: 'Relationships', layout: 'Layout' }
/** Changes of one group laid out in its detail before "and N more". */
const DETAIL_CHANGES = 20

function SentenceView({ sentence }: { sentence: Sentence }) {
  return (
    <>
      {sentence.map((p, i) => (typeof p === 'string'
        ? <span key={i}>{p}</span>
        : <span key={i} className="font-semibold text-ink">{p.name}</span>))}
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Filter bar

export function ReviewFilterBar({ index, filter, onChange, shown, attention, onDiscardShown, onExport, exporting, disabled, searchRef }: {
  index: ReviewIndex
  filter: ReviewFilter
  onChange: (f: ReviewFilter) => void
  /** How many groups the filter keeps. */
  shown: number
  /** How many need attention. */
  attention: number
  /** Discard every change the filter shows (offered only while it narrows). */
  onDiscardShown?: () => void
  /** Save what is shown as CSV. */
  onExport?: (detail: ExportDetail) => void
  exporting?: boolean
  disabled?: boolean
  searchRef?: RefObject<HTMLInputElement | null>
}) {
  const { facets } = index
  const total = index.groups.length
  // Typing filters a moment after it stops: at 50,000 rows each keystroke is not a pass.
  const [text, setText] = useState(filter.q)
  const [seen, setSeen] = useState(filter.q)
  if (filter.q !== seen) {
    // Set from outside (cleared, or a cluster opened from the Map): the box shows it.
    setSeen(filter.q)
    setText(filter.q)
  }
  useEffect(() => {
    if (text === filter.q) return
    const t = setTimeout(() => onChange({ ...filter, q: text }), 150)
    return () => clearTimeout(t)
  }, [text, filter, onChange])
  const set = (patch: Partial<ReviewFilter>) => onChange({ ...filter, ...patch })
  const kinds = (['node', 'edge', 'layout'] as const).filter((k) => facets.kind[k] > 0)
  const narrowed = isNarrowed(filter)

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        {kinds.length > 1 && (
          <Segmented
            label="What changed"
            value={filter.kind}
            onChange={(kind) => set({ kind, type: kind === 'node' || kind === 'all' ? filter.type : '' })}
            options={[{ value: 'all' as const, label: KIND_LABEL.all, count: total }, ...kinds.map((k) => ({ value: k, label: KIND_LABEL[k], count: facets.kind[k] }))]}
          />
        )}
        <div className="flex items-center gap-1" role="group" aria-label="Show changes that were">
          {STATUSES.map((st) => {
            const on = filter.statuses.includes(st)
            const n = facets.status[st]
            return (
              <button key={st} type="button" aria-pressed={on} disabled={n === 0}
                onClick={() => set({ statuses: on ? filter.statuses.filter((x) => x !== st) : [...filter.statuses, st] })}
                className={cn('rounded-md transition-opacity disabled:opacity-40', filter.statuses.length > 0 && !on && 'opacity-50 hover:opacity-80')}>
                <NodeDiffBadge status={st} count={n} withLabel className={cn(on && 'ring-1 ring-current')} />
              </button>
            )
          })}
        </div>
        {attention > 0 && (
          <button type="button" aria-pressed={filter.attention} onClick={() => set({ attention: !filter.attention })}
            className={cn(
              'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-semibold transition-colors',
              filter.attention
                ? 'border-rose-500/50 bg-rose-500/12 text-rose-700 dark:text-rose-300'
                : 'border-rose-500/25 bg-rose-500/[0.05] text-rose-600 dark:text-rose-300 hover:bg-rose-500/10',
            )}>
            <AlertTriangle className="w-3 h-3" aria-hidden />Needs attention<span className="tabular-nums">{attention.toLocaleString()}</span>
          </button>
        )}
      </div>
      <div className="flex items-center gap-2">
        <label className="relative flex-1 min-w-0">
          <span className="sr-only">Search these changes</span>
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-muted/70 pointer-events-none" aria-hidden />
          <input
            ref={searchRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && text) { e.stopPropagation(); setText('') }
            }}
            placeholder="Search by name, URN or what it does…"
            className="w-full h-8 pl-8 pr-8 rounded-lg bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border text-[12.5px] text-ink placeholder:text-ink-muted/60 focus:outline-none focus:ring-2 focus:ring-accent-lineage/40"
          />
          {text ? (
            <button type="button" onClick={() => setText('')} aria-label="Clear search"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.08]">
              <X className="w-3 h-3" />
            </button>
          ) : (
            <span className="absolute right-2 top-1/2 -translate-y-1/2 hidden sm:inline"><Kbd shortcut="/" /></span>
          )}
        </label>
        {facets.types.length > 1 && filter.kind !== 'edge' && filter.kind !== 'layout' && (
          <select aria-label="Type" value={filter.type} onChange={(e) => set({ type: e.target.value })}
            className="h-8 max-w-[40%] rounded-lg bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border px-2 text-[12.5px] text-ink focus:outline-none focus:ring-2 focus:ring-accent-lineage/40">
            <option value="">All types</option>
            {facets.types.map((t) => <option key={t.type} value={t.type}>{t.type || 'Untyped'} · {t.n.toLocaleString()}</option>)}
          </select>
        )}
      </div>
      <div className="flex items-center gap-2 min-h-[22px]">
        <p className="text-[11px] text-ink-muted tabular-nums flex items-center gap-1.5" aria-live="polite">
          <ListFilter className="w-3 h-3" aria-hidden />
          {narrowed
            ? <><span className="font-semibold text-ink">{shown.toLocaleString()}</span> shown of {total.toLocaleString()}</>
            : <>{total.toLocaleString()} {total === 1 ? 'thing' : 'things'} changed</>}
        </p>
        {narrowed && (
          <button type="button" onClick={() => { setText(''); onChange(NO_FILTER) }}
            className="text-[11px] font-semibold text-accent-lineage hover:underline">Clear filters</button>
        )}
        <span className="ml-auto" />
        {narrowed && shown > 0 && onDiscardShown && (
          <button type="button" disabled={disabled} onClick={onDiscardShown}
            className="inline-flex items-center gap-1 px-2 h-6 rounded-md text-[11px] font-semibold text-rose-600 dark:text-rose-300 hover:bg-rose-500/10 disabled:opacity-50 disabled:pointer-events-none">
            <Trash2 className="w-3 h-3" aria-hidden />Discard the {shown.toLocaleString()} shown
          </button>
        )}
        {onExport && shown > 0 && <ExportMenu onExport={onExport} busy={exporting} count={shown} />}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// The list: every change a summary first, opened to its key differences, then to all of it

const domId = (key: string) => `review-row-${key}`

export function ReviewExplorer({ index, rows, narrowed = false, selected, onSelect, problemIds, onDiscard, onReveal, onStepThrough, onClearFilter, searchRef, disabled, reach = NO_REACH }: {
  index: ReviewIndex
  /** The groups shown, as indices into `index.groups`. */
  rows: number[]
  /** The filter narrows them: top-down, they are listed with where each sits. */
  narrowed?: boolean
  /** The current group's key (`rowKey`) — shared with the Map. */
  selected: string | null
  onSelect: (key: string) => void
  problemIds?: ReadonlySet<string>
  onDiscard: (ids: string[]) => void
  onReveal?: (id: string) => void
  /** Walk the shown changes on the canvas, from this one. */
  onStepThrough?: (key: string) => void
  onClearFilter: () => void
  searchRef?: RefObject<HTMLInputElement | null>
  disabled?: boolean
  /** Who a data change reaches beyond this view. */
  reach?: DataReach
}) {
  const { groups } = index
  // Top-down (unless filtered): each change under its container, as the canvas places it.
  const [layout] = useChangeListLayout()
  const topDown = layout === 'tree'
  const showTree = topDown && !narrowed
  const tree = useReviewTree(groups, canvasPlacement, topDown)
  const [land, setLand] = useState<string | null>(null)
  const showInTree = (g: ReviewGroup) => {
    const id = treeIdOf(g)
    onClearFilter()
    tree.reveal(id)
    setLand(id)
  }
  const pathNames = (g: ReviewGroup) => (topDown && tree.tree ? pathOf(tree.tree, treeIdOf(g)).map((p) => tree.tree!.nameOf(p)) : undefined)
  const keys = useMemo(() => rows.map((r) => rowKey(groups[r])), [rows, groups])
  const posOf = useMemo(() => new Map(keys.map((k, i) => [k, i])), [keys])
  // The current row is one of those shown: lost to a filter (or never chosen), the first.
  const currentKey = selected !== null && posOf.has(selected) ? selected : (keys[0] ?? null)
  const position = currentKey !== null ? (posOf.get(currentKey) ?? -1) : -1
  const groupAt = (key: string | null) => (key !== null && posOf.has(key) ? groups[rows[posOf.get(key)!]] : undefined)

  // The rows as drawn: a heading before each run of a type (rows come ordered by it), then the
  // rows. `itemOf` finds a row's place among them — the keyboard moves between rows, never onto a
  // heading.
  const { items, itemOf } = useMemo(() => listItems(rows, groups), [rows, groups])
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (items[i].heading ? HEADING_HEIGHT : ROW_HEIGHT),
    overscan: 8,
    getItemKey: (i) => items[i].key,
  })
  const focusRow = (key: string, at: number) => {
    // A run's first row brings its heading into view with it.
    virtualizer.scrollToIndex(at === 0 ? 0 : itemOf[at], { align: 'auto' })
    requestAnimationFrame(() => document.getElementById(domId(key))?.focus())
  }
  const discard = (key: string) => {
    const g = groupAt(key)
    if (!g || disabled) return
    // The row after it takes its place (or the one before, at the end).
    const at = posOf.get(key)!
    const next = keys[at + 1] ?? keys[at - 1]
    if (next !== undefined) {
      onSelect(next)
      requestAnimationFrame(() => document.getElementById(domId(next))?.focus())
    }
    onDiscard(g.changes.map((c) => c.id))
  }
  const expand = useExpandableRows(keys, {
    current: currentKey,
    onCurrentChange: onSelect,
    // One change: open, there is nothing else to browse. Chosen on the Map: open on it.
    initialLevel: rows.length === 1 ? 1 : 0,
    initiallyOpen: selected,
    onNavigate: focusRow,
    extraKeys: (e, cur) => {
      const g = groupAt(cur)
      if (e.key === 'o' && g?.revealId && onReveal) { onReveal(g.revealId); return true }
      if ((e.key === 'Delete' || e.key === 'Backspace') && cur) { discard(cur); return true }
      if (e.key === '/') { searchRef?.current?.focus(); return true }
      if (e.key === 'n') {
        // The next change that needs attention, wrapping round.
        for (let k = 1; k <= rows.length; k++) {
          const at = (position + k) % rows.length
          if (needsAttention(groups[rows[at]], problemIds)) { onSelect(keys[at]); focusRow(keys[at], at); break }
        }
        return true
      }
      return false
    },
  })
  // A new filter: show the current row (the first, unless it is still shown).
  useEffect(() => {
    if (position >= 0) virtualizer.scrollToIndex(position === 0 ? 0 : itemOf[position], { align: 'auto' })
  }, [rows]) // eslint-disable-line react-hooks/exhaustive-deps

  if (groups.length === 0) return <EmptyState />
  if (rows.length === 0) return <EmptyState filtered onClear={onClearFilter} />

  const current = groupAt(currentKey)
  const drawn = virtualizer.getVirtualItems()
  return (
    <div className="flex flex-col gap-2 min-h-0">
      <div className="flex items-center gap-1.5 flex-wrap text-[11px] text-ink-muted">
        {showTree ? (
          <span className="tabular-nums" aria-live="polite">
            {groups.length.toLocaleString()} changed · under their containers
          </span>
        ) : (
          <span className="tabular-nums" aria-live="polite">
            Change <span className="font-semibold text-ink">{(position + 1).toLocaleString()}</span> of {rows.length.toLocaleString()}
          </span>
        )}
        <span className="hidden lg:inline-flex items-center gap-1 ml-1"><Kbd shortcut="j" /><Kbd shortcut="k" /> move · <Kbd shortcut="→" /> open</span>
        <div className="flex-1" />
        {!showTree && rows.length > 1 && (
          <HoverTip label={expand.allOpen ? 'Collapse every change' : 'Open every change to its key differences'}
            shortcut={expand.allOpen ? '⇧←' : '⇧→'} className="inline-flex">
            <button type="button" onClick={expand.allOpen ? expand.collapseAll : expand.expandAll}
              className="inline-flex items-center gap-1 px-2 h-7 rounded-lg font-semibold text-ink-secondary hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
              {expand.allOpen ? <ChevronsDownUp className="w-3.5 h-3.5" aria-hidden /> : <ChevronsUpDown className="w-3.5 h-3.5" aria-hidden />}
              {expand.allOpen ? 'Collapse all' : 'Expand all'}
            </button>
          </HoverTip>
        )}
        {!showTree && onStepThrough && current && current.kind !== 'layout' && (
          <HoverTip label="Step through these on the canvas" detail="One at a time, in this order — the dialog closes" className="inline-flex">
            <button type="button" onClick={() => onStepThrough(rowKey(current))}
              className="inline-flex items-center gap-1 px-2 h-7 rounded-lg font-semibold text-ink-secondary hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
              <Navigation className="w-3.5 h-3.5" aria-hidden />Step through
            </button>
          </HoverTip>
        )}
      </div>
      {showTree && tree.tree ? (
        <div className="rounded-2xl border border-glass-border bg-black/[0.015] dark:bg-white/[0.02] p-1.5 pt-1 h-[min(58vh,600px)] max-md:h-[50vh] flex flex-col min-h-0">
          <TreeView model={tree} label="Staged changes, top-down" maxHeight="100%" className="flex-1"
            isChange={(item) => tree.tree!.groupOf.has(item.id)} nameOf={(item) => item.name ?? item.id}
            land={land} onLanded={() => setLand(null)}
            onCurrent={(id) => { const i = tree.tree!.groupOf.get(id); if (i !== undefined) onSelect(rowKey(groups[i])) }}
            itemKeys={(e, item) => {
              const g = groups[tree.tree!.groupOf.get(item.id)!]
              if (e.key === 'o' && g.revealId && onReveal) { onReveal(g.revealId); return true }
              if ((e.key === 'Delete' || e.key === 'Backspace') && !disabled) { onDiscard(g.changes.map((c) => c.id)); return true }
              if (e.key === '/') { searchRef?.current?.focus(); return true }
              return false
            }}
            renderChange={(item: ChangeTreeItem, f: TreeRowFrame) => {
              const g = groups[tree.tree!.groupOf.get(item.id)!]
              return (
                <ReviewRow id={f.domId} group={g} level={f.level} current={f.current}
                  onToggle={f.onToggle} onLevel={f.onLevel} onFocus={f.onFocus}
                  setsize={f.setsize} posinset={f.posinset} heading={headingLabel(headingOf(g))} reach={reach}
                  depth={f.depth} lead={f.lead} inside={f.inside}
                  attention={needsAttention(g, problemIds)} problemIds={problemIds}
                  onReveal={onReveal} onDiscard={() => { if (!disabled) onDiscard(g.changes.map((c) => c.id)) }} disabled={disabled} />
              )
            }} />
        </div>
      ) : (
      <div ref={scrollRef} onKeyDown={expand.onKeyDown}
        className="relative overflow-y-auto custom-scrollbar rounded-2xl border border-glass-border bg-black/[0.015] dark:bg-white/[0.02] p-1.5 h-[min(58vh,600px)] max-md:h-[50vh]">
        <div role="list" aria-label="Staged changes" className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {drawn.map((v) => {
            const item = items[v.index]
            if (item.heading) {
              return (
                <div key={v.key} data-index={v.index} ref={virtualizer.measureElement} role="presentation"
                  className="absolute left-0 top-0 w-full px-2.5 flex items-end gap-2 pb-1"
                  style={{ height: HEADING_HEIGHT, transform: `translateY(${v.start}px)` }}>
                  <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-muted/80 truncate">{item.heading}</span>
                  <span className="text-[10.5px] text-ink-muted/70 tabular-nums">{item.count.toLocaleString()}</span>
                  {/* What a run of changes changes: the data, or only this view. */}
                  <ChangeKindTag kind={item.view ? 'view' : 'data'} reach={reach} className="ml-auto min-w-0 mb-px" />
                </div>
              )
            }
            const g = groups[rows[item.row]]
            const key = keys[item.row]
            return (
              <div key={v.key} data-index={v.index} ref={virtualizer.measureElement}
                className="absolute left-0 top-0 w-full" style={{ transform: `translateY(${v.start}px)` }}>
                <ReviewRow key={key} id={domId(key)} group={g} level={expand.levelOf(key)} current={key === currentKey}
                  onToggle={() => { onSelect(key); expand.toggle(key) }}
                  onLevel={(l) => expand.setLevel(key, l)}
                  onFocus={() => onSelect(key)}
                  setsize={rows.length} posinset={item.row + 1} heading={headingLabel(headingOf(g))} reach={reach}
                  attention={needsAttention(g, problemIds)} problemIds={problemIds}
                  path={pathNames(g)} onShowInTree={topDown ? () => showInTree(g) : undefined}
                  onReveal={onReveal} onDiscard={() => discard(key)} disabled={disabled} />
              </div>
            )
          })}
        </div>
      </div>
      )}
    </div>
  )
}

type ListItem = { key: string; heading: string; count: number; row: -1; view: boolean } | { key: string; heading: null; count: 0; row: number }

/** Headings and rows, in order — a heading before each run of one type — and each row's item. */
function listItems(rows: readonly number[], groups: readonly ReviewGroup[]): { items: ListItem[]; itemOf: number[] } {
  const items: ListItem[] = []
  const itemOf: number[] = new Array(rows.length)
  let last: string | null = null
  let headingAt = -1
  for (let i = 0; i < rows.length; i++) {
    const g = groups[rows[i]]
    const h = headingOf(g)
    if (h !== last) {
      headingAt = items.length
      items.push({ key: `heading:${h}`, heading: headingLabel(h), count: 0, row: -1, view: g.kind === 'layout' })
      last = h
    }
    ;(items[headingAt] as { count: number }).count++
    itemOf[i] = items.length
    items.push({ key: rowKey(g), heading: null, count: 0, row: i })
  }
  return { items, itemOf }
}

const isEmptyValue = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)

/** Everything a group's edits change, field by field, as one: a field edited twice is shown once,
 *  from where it started to where it ended. Built only for a row on screen. */
function groupFields(group: ReviewGroup): FieldChange[] {
  const byPath = new Map<string, FieldChange>()
  for (const c of group.changes) {
    for (const f of fieldChanges(c)) {
      const path = fieldPath(f)
      const seen = byPath.get(path)
      byPath.set(path, seen ? { ...seen, after: f.after } : f)
    }
  }
  const out: FieldChange[] = []
  for (const f of byPath.values()) {
    if (JSON.stringify(f.before ?? null) === JSON.stringify(f.after ?? null)) continue
    out.push({ ...f, kind: isEmptyValue(f.before) ? 'added' : isEmptyValue(f.after) ? 'removed' : 'changed' })
  }
  return out
}

function ReviewRow({
  id, group, level, current, onToggle, onLevel, onFocus, setsize, posinset, heading, attention, problemIds, onReveal, onDiscard,
  disabled, depth, lead, inside, path, onShowInTree, reach,
}: {
  id: string
  group: ReviewGroup
  level: RowLevel
  current: boolean
  onToggle: () => void
  onLevel: (level: RowLevel) => void
  onFocus: () => void
  setsize: number
  posinset: number
  /** The heading it is listed under, said with it. */
  heading: string
  attention: boolean
  problemIds?: ReadonlySet<string>
  onReveal?: (id: string) => void
  onDiscard: () => void
  disabled?: boolean
  /** In the tree: how deep it sits, what opens its children, how many changes are under it. */
  depth?: number
  lead?: ReactNode
  inside?: ReactNode
  /** Filtered, top-down: its containers, named — and opening the way down to it. */
  path?: string[]
  onShowInTree?: () => void
  /** Who a data change reaches — what an entity's row says it changes. */
  reach: DataReach
}) {
  const colors = useEntityColorSet(group.typeId ?? '')
  const layout = group.kind === 'layout'
  const n = group.changes.length
  const fields = useMemo(() => (layout ? [] : groupFields(group)), [group, layout])
  const edits = group.status === 'modified' && fields.length > 0
  const summary = useMemo(() => (edits ? summarizeFields(fields) : null), [edits, fields])
  const error = group.changes.find((c) => c.error)?.error
  const technical = usePersonaMode() === 'technical'

  return (
    <ExpandableChangeRow
      id={id} status={group.status} level={level} current={current} onToggle={onToggle} onFocus={onFocus}
      setsize={setsize} posinset={posinset} depth={depth} lead={lead} chevron={lead === undefined}
      title={(
        <span className="inline-flex items-center gap-1.5 min-w-0 max-w-full">
          {layout
            ? <Layers className="w-3.5 h-3.5 text-indigo-500 shrink-0" aria-hidden />
            : group.kind === 'node' && group.typeId && <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: colors.hex }} aria-hidden />}
          <span className="truncate">{layout ? 'View layout' : group.name}</span>
          <span className="sr-only">{`, ${heading}`}</span>
        </span>
      )}
      sub={path?.length
        ? <span aria-label={`in ${path.join(', ')}`}>{path.join(' › ')}</span>
        : group.kind === 'edge' ? group.edgeType : layout ? ONLY_THIS_VIEW : dataTagText(reach)}
      summary={summary
        ? <ChangeSummary summary={summary} status="modified" kind={group.kind === 'edge' ? 'edge' : 'node'} />
        : <span className="block text-[11.5px] text-ink-secondary truncate"><SentenceView sentence={group.sentence} /></span>}
      badges={n > 1 || attention || inside ? (
        <>
          {inside}
          {n > 1 && (
            <HoverTip label={`${n.toLocaleString()} changes to it`} detail="Shown as one: where it started, where it ends" className="inline-flex">
              <span className="px-1.5 h-5 inline-flex items-center rounded-md bg-black/[0.05] dark:bg-white/[0.08] text-[10px] font-semibold text-ink-secondary tabular-nums">×{n}</span>
            </HoverTip>
          )}
          {attention && (
            <HoverTip label="Needs attention" detail={error ?? 'The last save was refused because of it'} className="inline-flex">
              <CircleAlert className="w-3.5 h-3.5 text-rose-500" aria-label="Needs attention" />
            </HoverTip>
          )}
        </>
      ) : undefined}
      actions={(
        <>
          {onShowInTree && (
            <HoverTip label="Open the way down to it, top-down" className="inline-flex">
              <button type="button" onClick={onShowInTree} aria-label={`Show ${group.name} in the hierarchy`}
                className="inline-flex items-center gap-0.5 px-1.5 h-6 rounded-md text-[11px] font-semibold text-ink-secondary hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06]">
                <ListTree className="w-3 h-3" aria-hidden />In hierarchy
              </button>
            </HoverTip>
          )}
          {onReveal && group.revealId && (
            <HoverTip label="Show it on the canvas" shortcut="o" className="inline-flex">
              <button type="button" onClick={() => onReveal(group.revealId!)} aria-label={`Show ${group.name} on canvas`}
                className="inline-flex items-center gap-0.5 px-1.5 h-6 rounded-md text-[11px] font-semibold text-accent-lineage hover:bg-accent-lineage/10">
                Show<ArrowUpRight className="w-3 h-3" aria-hidden />
              </button>
            </HoverTip>
          )}
          <HoverTip label={n === 1 ? 'Discard this change' : `Discard these ${n} changes`} detail="Undo brings it back" shortcut="⌫" className="inline-flex">
            <button type="button" onClick={onDiscard} disabled={disabled}
              aria-label={n === 1 ? `Discard the change to ${group.name}` : `Discard ${n} changes to ${group.name}`}
              className="w-6 h-6 rounded-md flex items-center justify-center text-ink-muted hover:text-rose-600 dark:hover:text-rose-300 hover:bg-rose-500/10 disabled:opacity-50 disabled:pointer-events-none">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </HoverTip>
        </>
      )}
    >
      {(lvl) => (
        <div className="space-y-2.5">
          {error && (
            <p className="flex items-start gap-1.5 text-[12px] leading-snug text-rose-700 dark:text-rose-300 rounded-xl border border-rose-500/30 bg-rose-500/[0.06] px-3 py-2">
              <CircleAlert className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden />
              <span><span className="font-semibold">Not saved — </span>{error}</span>
            </p>
          )}
          {!error && group.changes.some((c) => problemIds?.has(c.id)) && (
            <p className="flex items-start gap-1.5 text-[12px] leading-snug text-rose-700 dark:text-rose-300">
              <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden />The last save was refused because of this change — see above.
            </p>
          )}
          {group.changes.map((c) => c.conflict && <ConflictChoices key={c.id} change={c} />)}
          {layout ? (
            <p className="text-[11.5px] text-ink-muted">Saved with the view — it never changes the data source.</p>
          ) : lvl === 1 && edits ? (
            // Its key differences: the few fields that say what this is about.
            <KeyFields fields={fields} onShowAll={fields.length > KEY_FIELDS || n > 1 || technical ? () => onLevel(2) : undefined} />
          ) : (
            <div className="space-y-3">
              {group.changes.slice(0, lvl === 1 ? 3 : DETAIL_CHANGES).map((c) => (
                <ChangeDetail key={c.id} change={c} several={n > 1} depth={lvl === 1 ? 'key' : 'all'} onShowAll={() => onLevel(2)} />
              ))}
              {lvl === 1 && n > 3 && (
                <button type="button" onClick={() => onLevel(2)} className="text-[11px] font-semibold text-accent-lineage hover:underline">
                  Show all {n.toLocaleString()} changes to it
                </button>
              )}
              {lvl === 2 && n > DETAIL_CHANGES && <p className="text-[11px] text-ink-muted">and {(n - DETAIL_CHANGES).toLocaleString()} more changes to it</p>}
            </div>
          )}
        </div>
      )}
    </ExpandableChangeRow>
  )
}

/** Fields shown before "Show all". */
const KEY_FIELDS = 5

function KeyFields({ fields, onShowAll }: { fields: FieldChange[]; onShowAll?: () => void }) {
  const key = keyDifferences(fields, KEY_FIELDS)
  return (
    <div className="space-y-1.5">
      <div className="rounded-xl border border-glass-border overflow-hidden bg-black/[0.015] dark:bg-white/[0.02]">
        {key.map((f, i) => <ReviewValue key={`${f.folder ?? ''}/${f.label}/${i}`} field={f} />)}
      </div>
      {onShowAll && (
        <button type="button" onClick={onShowAll} className="text-[11px] font-semibold text-accent-lineage hover:underline">
          {fields.length > key.length ? `Show all ${fields.length.toLocaleString()} fields` : 'Show every change to it'}
        </button>
      )}
    </div>
  )
}

/** One change's detail: its fields as values, a move's from/to, a delete's cascade. */
function ChangeDetail({ change, several, depth = 'all', onShowAll }: {
  change: StagedChange
  several: boolean
  /** `key`: its first few fields (and "Show all"); `all`: every field, and the technical view. */
  depth?: 'key' | 'all'
  onShowAll?: () => void
}) {
  const technical = usePersonaMode() === 'technical' && depth === 'all'
  const [json, setJson] = useState(false)
  const all = useMemo(() => fieldChanges(change), [change])
  const fields = depth === 'key' ? keyDifferences(all, KEY_FIELDS) : all
  const cascade = change.type === 'delete_entity' ? (change.before as { cascade?: Parameters<typeof CascadeImpactList>[0]['impact'] } | undefined)?.cascade : undefined
  // What the save sends — the patch, never the whole node twice.
  const patch = useMemo(() => {
    if (!json) return null
    if (change.type === 'update_entity' || change.type === 'rename_entity') {
      const { payload, unset } = nodeUpdatePatch(change.before, change.after)
      return unset.length ? { ...payload, unsetProperties: unset } : payload
    }
    return { before: change.before ?? null, after: change.after ?? null }
  }, [json, change])

  let body: ReactNode = null
  if (change.type === 'move_entity') body = <MoveDetail change={change} />
  else if (cascade) body = <CascadeImpactList impact={cascade} rootUrn={change.targetUrn} />
  else if (fields.length > 0) {
    body = (
      <div className="space-y-1.5">
        <div className="rounded-xl border border-glass-border overflow-hidden bg-black/[0.015] dark:bg-white/[0.02]">
          {fields.map((f, i) => <ReviewValue key={`${f.folder ?? ''}/${f.label}/${i}`} field={f} />)}
        </div>
        {depth === 'key' && all.length > fields.length && onShowAll && (
          <button type="button" onClick={onShowAll} className="text-[11px] font-semibold text-accent-lineage hover:underline">
            Show all {all.length.toLocaleString()} fields
          </button>
        )}
      </div>
    )
  }
  if (!body && !several && !technical) return null
  return (
    <div className="space-y-1.5">
      {several && <p className="text-[11px] text-ink-muted">{change.summary}</p>}
      {body}
      {technical && (
        <div>
          <button type="button" onClick={() => setJson((v) => !v)}
            className="inline-flex items-center gap-1 text-[10.5px] font-medium text-ink-muted hover:text-ink">
            <Code2 className="w-3 h-3" aria-hidden />{json ? 'Hide technical details' : 'Technical details'}
          </button>
          {json && patch && <div className="mt-1"><JsonView data={patch} label="What the save sends" /></div>}
        </div>
      )}
    </div>
  )
}

/** A move, in words: where the entity sits now and where the save puts it. (Its raw `before` holds
 *  the undo state — the links it replaced and its own placement — which is no reading matter.) */
function MoveDetail({ change }: { change: StagedChange }) {
  const label = (id: string | null | undefined) => {
    if (!id) return null
    const n = useCanvasStore.getState().nodes.find((x) => x.id === id)
    return (n?.data?.label as string | undefined) ?? id
  }
  const after = change.after as { parentId?: string | null; edgeType?: string | null }
  const removed = ((change.before as { removedLinks?: Array<{ source: string }> } | undefined)?.removedLinks ?? [])
  const from = [...new Set(removed.map((e) => label(e.source)))].filter(Boolean).join(', ')
  const cell = (title: string, value: string, hint?: string) => (
    <div className="rounded-lg border border-glass-border bg-black/[0.015] dark:bg-white/[0.02] p-2 min-w-0">
      <p className="text-[9px] uppercase tracking-[0.08em] text-ink-muted mb-1 font-bold">{title}</p>
      <p className="text-[12px] text-ink break-words">{value}</p>
      {hint && <p className="text-[10.5px] text-ink-muted mt-0.5">{hint}</p>}
    </div>
  )
  return (
    <div className="grid grid-cols-2 gap-2">
      {cell('From', from || 'Its current parent', from ? undefined : 'Replaced on save, wherever it is')}
      {cell('To', label(after.parentId) ?? 'Top level', after.edgeType ? `as ${after.edgeType}` : undefined)}
    </div>
  )
}

function EmptyState({ filtered = false, onClear }: { filtered?: boolean; onClear?: () => void }) {
  const Icon = filtered ? SearchX : CheckCircle2
  return (
    <div className="px-4 py-14 text-center flex flex-col items-center gap-3">
      <div className="w-14 h-14 rounded-2xl bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border flex items-center justify-center">
        <Icon className="w-7 h-7 text-ink-muted" strokeWidth={1.6} />
      </div>
      <div>
        <p className="text-sm text-ink font-semibold">{filtered ? 'No changes match your filter' : 'No staged changes'}</p>
        <p className="text-[12px] text-ink-muted mt-1 max-w-[420px] leading-relaxed">
          {filtered
            ? 'Try a different search, status or type — or clear the filter to see everything pending.'
            : 'Edit a value on the canvas or in an entity’s details — it shows up here, ready to save.'}
        </p>
      </div>
      {filtered && onClear && (
        <button type="button" onClick={onClear}
          className="mt-1 px-3 py-1.5 text-[11px] font-medium rounded-lg border border-glass-border text-ink-secondary hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
          Clear filter
        </button>
      )}
    </div>
  )
}
