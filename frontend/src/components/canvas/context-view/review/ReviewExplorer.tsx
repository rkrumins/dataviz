/**
 * ReviewExplorer — Review & Save's list of staged changes, built for tens of thousands of them:
 *
 *   - a filter bar (what changed, how, which type, a search, what needs attention) with counts,
 *     "1,240 shown of 10,482", and Discard the N shown;
 *   - a virtualized list — one row per entity, relationship or layout item, drawn only while on
 *     screen, its sentence worded only then — moved through with ↑/↓ (or J/K), Home/End;
 *   - the selected change beside it: what it does, each field it changes as the value it is, a
 *     move's from/to, a delete's cascade, conflicts and errors — with Prev / Next ("312 of 1,240"),
 *     Show on canvas, Step through on canvas and Discard.
 *
 * Everything per row is built for the rows drawn and the one selected; the index behind it is built
 * once per list of changes (`buildReviewIndex`).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  AlertTriangle, ArrowUpRight, CheckCircle2, ChevronLeft, ChevronRight, CircleAlert, Code2, Layers,
  ListFilter, Navigation, Search, SearchX, Trash2, X,
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
import { NodeDiffBadge, STATUS_META } from '@/features/versioning/components/NodeDiffBadge'
import { ReviewValue } from '@/features/versioning/components/ReviewValue'
import { ExportMenu, type ExportDetail } from '@/features/versioning/components/ExportMenu'

const ROW_HEIGHT = 52
const HEADING_HEIGHT = 30
const STATUSES: ChangeStatus[] = ['added', 'modified', 'removed']
const KIND_LABEL: Record<ReviewKind | 'all', string> = { all: 'All', node: 'Entities', edge: 'Relationships', layout: 'Layout' }
/** Changes of one group laid out in its detail before "and N more". */
const DETAIL_CHANGES = 20

const sentenceText = (s: Sentence) => s.map((p) => (typeof p === 'string' ? p : p.name)).join('')

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
// List + detail

export function ReviewExplorer({ index, rows, selected, onSelect, problemIds, onDiscard, onReveal, onStepThrough, onClearFilter, searchRef, disabled }: {
  index: ReviewIndex
  /** The groups shown, as indices into `index.groups`. */
  rows: number[]
  /** The selected group's key (`rowKey`). */
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
}) {
  const { groups } = index
  // The selection is one of the rows shown: lost to a filter (or never made), the first.
  const position = useMemo(() => {
    if (selected) for (let i = 0; i < rows.length; i++) if (rowKey(groups[rows[i]]) === selected) return i
    return rows.length ? 0 : -1
  }, [rows, groups, selected])
  const current = position >= 0 ? groups[rows[position]] : undefined

  // The rows as drawn: a heading before each run of a type (rows come ordered by it), then the
  // rows. `itemOf` finds a row's place among them — the keyboard moves between rows, never onto
  // a heading.
  const { items, itemOf } = useMemo(() => listItems(rows, groups), [rows, groups])
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (items[i].heading ? HEADING_HEIGHT : ROW_HEIGHT),
    overscan: 10,
    getItemKey: (i) => items[i].key,
  })
  // A new filter: show the selected row (the first, unless it is still shown).
  useEffect(() => {
    if (position >= 0) virtualizer.scrollToIndex(position === 0 ? 0 : itemOf[position], { align: 'auto' })
  }, [rows]) // eslint-disable-line react-hooks/exhaustive-deps
  const go = (to: number) => {
    if (rows.length === 0) return
    const i = Math.max(0, Math.min(rows.length - 1, to))
    onSelect(rowKey(groups[rows[i]]))
    // A run's first row brings its heading into view with it.
    virtualizer.scrollToIndex(i === 0 ? 0 : itemOf[i], { align: 'auto' })
  }
  const discardCurrent = () => {
    if (!current || disabled) return
    // The row after it takes its place (or the one before, at the end).
    const next = rows[position + 1] ?? rows[position - 1]
    if (next !== undefined) onSelect(rowKey(groups[next]))
    onDiscard(current.changes.map((c) => c.id))
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const k = e.key
    const step = k === 'ArrowDown' || k === 'j' ? 1 : k === 'ArrowUp' || k === 'k' ? -1 : 0
    if (step) go(position + step)
    else if (k === 'Home') go(0)
    else if (k === 'End') go(rows.length - 1)
    else if (k === 'PageDown') go(position + 10)
    else if (k === 'PageUp') go(position - 10)
    else if ((k === 'o' || k === 'Enter') && current?.revealId && onReveal) onReveal(current.revealId)
    else if (k === 'Delete' || k === 'Backspace') discardCurrent()
    else if (k === '/') searchRef?.current?.focus()
    else return
    e.preventDefault()
  }

  if (groups.length === 0) return <EmptyState />
  if (rows.length === 0) return <EmptyState filtered onClear={onClearFilter} />

  const drawn = virtualizer.getVirtualItems()
  return (
    <div className="grid gap-3 md:grid-cols-[minmax(260px,360px)_minmax(0,1fr)] h-[min(58vh,600px)] max-md:h-auto">
      <div
        ref={scrollRef}
        role="listbox"
        aria-label="Staged changes"
        tabIndex={0}
        aria-activedescendant={current ? `review-row-${position}` : undefined}
        onKeyDown={onKey}
        className="relative overflow-y-auto custom-scrollbar rounded-2xl border border-glass-border bg-black/[0.015] dark:bg-white/[0.02] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 max-md:max-h-[36vh]"
      >
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {drawn.map((v) => {
            const item = items[v.index]
            if (item.heading) {
              return (
                <div key={v.key} role="presentation"
                  className="absolute left-0 top-0 w-full px-3 flex items-end gap-2 pb-1"
                  style={{ height: HEADING_HEIGHT, transform: `translateY(${v.start}px)` }}>
                  <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-muted/80 truncate">{item.heading}</span>
                  <span className="text-[10.5px] text-ink-muted/70 tabular-nums">{item.count.toLocaleString()}</span>
                </div>
              )
            }
            const g = groups[rows[item.row]]
            return (
              <div key={v.key} className="absolute left-0 top-0 w-full px-1.5 pt-1.5" style={{ height: ROW_HEIGHT, transform: `translateY(${v.start}px)` }}>
                <Row id={`review-row-${item.row}`} group={g} selected={item.row === position}
                  setSize={rows.length} posInSet={item.row + 1} heading={headingLabel(headingOf(g))}
                  attention={needsAttention(g, problemIds)} onClick={() => onSelect(rowKey(g))} />
              </div>
            )
          })}
        </div>
      </div>

      {current && (
        <Detail
          key={rowKey(current)}
          group={current}
          position={position}
          count={rows.length}
          problemIds={problemIds}
          onPrev={() => go(position - 1)}
          onNext={() => go(position + 1)}
          onDiscard={discardCurrent}
          onReveal={onReveal}
          onStepThrough={onStepThrough ? () => onStepThrough(rowKey(current)) : undefined}
          disabled={disabled}
        />
      )}
    </div>
  )
}

type ListItem = { key: string; heading: string; count: number; row: -1 } | { key: string; heading: null; count: 0; row: number }

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
      items.push({ key: `heading:${h}`, heading: headingLabel(h), count: 0, row: -1 })
      last = h
    }
    ;(items[headingAt] as { count: number }).count++
    itemOf[i] = items.length
    items.push({ key: rowKey(g), heading: null, count: 0, row: i })
  }
  return { items, itemOf }
}

function Row({ id, group, selected, attention, onClick, setSize, posInSet, heading }: {
  id: string
  group: ReviewGroup
  selected: boolean
  attention: boolean
  onClick: () => void
  /** Its place among every row shown — the list draws only the few on screen. */
  setSize: number
  posInSet: number
  /** The heading it is listed under, said with it. */
  heading: string
}) {
  const meta = STATUS_META[group.status]
  const colors = useEntityColorSet(group.typeId ?? '')
  const layout = group.kind === 'layout'
  const sentence = sentenceText(group.sentence)
  const n = group.changes.length
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      aria-setsize={setSize}
      aria-posinset={posInSet}
      onClick={onClick}
      className={cn(
        'h-[46px] flex items-center gap-2 pl-2 pr-2.5 rounded-xl border-l-[3px] cursor-pointer select-none transition-colors',
        layout ? 'border-l-indigo-500' : meta.accent,
        selected
          ? 'bg-accent-lineage/[0.09] ring-1 ring-accent-lineage/35'
          : 'hover:bg-black/[0.035] dark:hover:bg-white/[0.05]',
      )}
    >
      {layout
        ? <Layers className="w-3.5 h-3.5 text-indigo-500 shrink-0" aria-hidden />
        : <meta.Icon className={cn('w-3.5 h-3.5 shrink-0', meta.text)} aria-hidden />}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 min-w-0">
          {group.kind === 'node' && group.typeId && (
            <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: colors.hex }} aria-hidden />
          )}
          <span className="text-[12.5px] font-semibold text-ink truncate">{layout ? 'View layout' : group.name}</span>
          {n > 1 && <span className="text-[10px] text-ink-muted tabular-nums shrink-0">×{n}</span>}
          {attention && <CircleAlert className="w-3 h-3 text-rose-500 shrink-0" aria-label="Needs attention" />}
        </span>
        <span className="block text-[11px] text-ink-muted truncate leading-tight mt-0.5">{sentence}</span>
        <span className="sr-only">{`, ${heading}`}</span>
      </span>
    </div>
  )
}

function Detail({ group, position, count, problemIds, onPrev, onNext, onDiscard, onReveal, onStepThrough, disabled }: {
  group: ReviewGroup
  position: number
  count: number
  problemIds?: ReadonlySet<string>
  onPrev: () => void
  onNext: () => void
  onDiscard: () => void
  onReveal?: (id: string) => void
  onStepThrough?: () => void
  disabled?: boolean
}) {
  const meta = STATUS_META[group.status]
  const colors = useEntityColorSet(group.typeId ?? '')
  const layout = group.kind === 'layout'
  const n = group.changes.length
  const error = group.changes.find((c) => c.error)?.error
  const urn = group.changes.find((c) => c.targetUrn && c.targetUrn !== c.targetId)?.targetUrn
  const navBtn = 'w-7 h-7 rounded-lg flex items-center justify-center text-ink-secondary hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.08] disabled:opacity-35 disabled:pointer-events-none'

  return (
    <section aria-label="The selected change" className="min-w-0 flex flex-col rounded-2xl border border-glass-border bg-canvas-elevated overflow-hidden">
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-glass-border bg-black/[0.015] dark:bg-white/[0.02]">
        <button type="button" className={navBtn} onClick={onPrev} disabled={position <= 0} aria-label="Previous change">
          <ChevronLeft className="w-4 h-4" />
        </button>
        <span className="text-[11px] text-ink-muted tabular-nums px-1">
          <span className="font-semibold text-ink">{(position + 1).toLocaleString()}</span> of {count.toLocaleString()}
        </span>
        <button type="button" className={navBtn} onClick={onNext} disabled={position >= count - 1} aria-label="Next change">
          <ChevronRight className="w-4 h-4" />
        </button>
        <span className="hidden lg:flex items-center gap-1 text-[10.5px] text-ink-muted ml-1"><Kbd shortcut="j" /><Kbd shortcut="k" /> to move</span>
        <div className="flex-1" />
        {onStepThrough && !layout && (
          <HoverTip label="Step through these on the canvas" detail="One at a time, in this order — the dialog closes" className="inline-flex">
            <button type="button" onClick={onStepThrough}
              className="inline-flex items-center gap-1 px-2 h-7 rounded-lg text-[11px] font-semibold text-ink-secondary hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.08]">
              <Navigation className="w-3.5 h-3.5" aria-hidden />Step through
            </button>
          </HoverTip>
        )}
        {onReveal && group.revealId && (
          <button type="button" onClick={() => onReveal(group.revealId!)}
            className="inline-flex items-center gap-1 px-2 h-7 rounded-lg text-[11px] font-semibold text-accent-lineage hover:bg-accent-lineage/10">
            Show on canvas<ArrowUpRight className="w-3.5 h-3.5" aria-hidden />
          </button>
        )}
        <HoverTip label={n === 1 ? 'Discard this change' : `Discard these ${n} changes`} detail="Redo brings it back" className="inline-flex">
          <button type="button" onClick={onDiscard} disabled={disabled}
            aria-label={n === 1 ? 'Discard change' : `Discard ${n} changes`}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-ink-muted hover:text-rose-600 dark:hover:text-rose-300 hover:bg-rose-500/10 disabled:opacity-50 disabled:pointer-events-none">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </HoverTip>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar px-4 py-3.5 space-y-3">
        <div>
          <div className="flex items-center gap-2 min-w-0">
            {layout
              ? <Layers className="w-4 h-4 text-indigo-500 shrink-0" aria-hidden />
              : group.kind === 'node' && <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: group.typeId ? colors.hex : undefined }} aria-hidden />}
            <h4 className="text-[15px] font-bold text-ink truncate">{layout ? 'View layout' : group.name}</h4>
            {layout ? (
              <span className="px-1.5 py-px rounded text-[9.5px] font-bold uppercase tracking-wide shrink-0 bg-indigo-500/10 text-indigo-600 dark:text-indigo-300">This view only</span>
            ) : (
              <span className={cn('px-1.5 py-px rounded text-[9.5px] font-bold uppercase tracking-wide shrink-0', meta.bg, meta.text)}>
                {group.kind === 'edge' ? `${meta.label} link` : meta.label}
              </span>
            )}
            {group.typeId && <span className="text-[11px] text-ink-muted truncate">{group.typeId}</span>}
          </div>
          <p className="text-[12.5px] text-ink-secondary mt-1 leading-snug"><SentenceView sentence={group.sentence} /></p>
          {urn && <p className="text-[10.5px] text-ink-muted mt-0.5 font-mono truncate">{urn}</p>}
          {layout && <p className="text-[11px] text-ink-muted mt-1">Saved with the view — it never changes the data source.</p>}
        </div>

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

        {!layout && (
          <div className="space-y-3">
            {group.changes.slice(0, DETAIL_CHANGES).map((c) => <ChangeDetail key={c.id} change={c} several={n > 1} />)}
            {n > DETAIL_CHANGES && <p className="text-[11px] text-ink-muted">and {(n - DETAIL_CHANGES).toLocaleString()} more changes to it</p>}
          </div>
        )}
      </div>
    </section>
  )
}

/** One change's detail: its fields as values, a move's from/to, a delete's cascade. */
function ChangeDetail({ change, several }: { change: StagedChange; several: boolean }) {
  const technical = usePersonaMode() === 'technical'
  const [json, setJson] = useState(false)
  const fields = useMemo(() => fieldChanges(change), [change])
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
      <div className="rounded-xl border border-glass-border overflow-hidden bg-black/[0.015] dark:bg-white/[0.02]">
        {fields.map((f, i) => <ReviewValue key={`${f.folder ?? ''}/${f.label}/${i}`} field={f} />)}
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
 *  the undo state — the whole view layout — which is no reading matter.) */
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
