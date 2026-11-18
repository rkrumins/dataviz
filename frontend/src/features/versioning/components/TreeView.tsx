/**
 * TreeView — changes drawn top-down under their containers, whoever laid them out: the server
 * (`ChangeTree`, a change list) or the browser (Review & Save's staged changes). It draws the rows
 * open — virtualized — with a guide per level, each container saying how many changes sit under it
 * (`12 inside +8 ~3 −1`), "Show N more" where a level has more to read, and a breadcrumb of where
 * the current row sits. A change draws itself (`renderChange`); a container no change touched is a
 * row that opens.
 *
 * Keys: J / K (↓ / ↑) move · → opens a container, then steps into it · ← closes what is open, then
 * goes to the container · Enter opens a change · a surface's own keys on a change (`itemKeys`).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Boxes, ChevronRight, ChevronsDownUp, Loader2, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { HoverTip } from '@/components/ui/HoverTip'
import { Skeleton } from '@/components/ui/Skeleton'
import type { ChangeTreeItem } from '@/services/versioningApiService'
import { useExpandableRows, type ExpandableRows, type RowLevel } from '@/hooks/useExpandableRows'
import { TOP, type TreeLevel, type TreeRow } from '../hooks/useChangeTree'
import { FieldCountChips } from './ChangeSummary'

/** How far each level sits in from its container. */
const INDENT = 18
/** Each row as it measures (a change: its name and summary; a container: one line; "Show more"),
 *  so a range scrolled into view lays out once instead of re-measuring every row it mounts. */
const CHANGE_HEIGHT = 61
const CONTAINER_HEIGHT = 38
const NOTE_HEIGHT = 32

type ItemRow = Extract<TreeRow, { kind: 'item' }>

/** What lays the tree out: the rows open, each level as read, and what opens and reads more. */
export interface TreeModel {
  rows: TreeRow[]
  levels: ReadonlyMap<string, TreeLevel>
  open: ReadonlySet<string>
  setOpen: (id: string, on: boolean) => void
  more: (parent: string) => void
  earlier: (parent: string) => void
  collapseAll: () => void
}

/** What a change's row is given to draw itself in the tree. */
export interface TreeRowFrame {
  /** Its button's id: the tree focuses it. */
  domId: string
  level: RowLevel
  current: boolean
  onToggle: () => void
  onLevel: (level: RowLevel) => void
  onFocus: () => void
  setsize: number
  posinset: number
  depth: number
  /** What opens its children (or the space for it). */
  lead: ReactNode
  /** How many changes sit under it. */
  inside: ReactNode
  /** Step through the changes at its level, from it. */
  onShow: () => void
}

export interface TreeViewProps {
  model: TreeModel
  /** The list's accessible name. */
  label: string
  /** Whether an item is a change (else a container no change touched). */
  isChange: (item: ChangeTreeItem) => boolean
  nameOf: (item: ChangeTreeItem) => string
  renderChange: (item: ChangeTreeItem, frame: TreeRowFrame) => ReactNode
  /** A surface's own keys on a change. */
  itemKeys?: (e: KeyboardEvent, item: ChangeTreeItem, setLevel: (level: RowLevel) => void, show: () => void) => boolean
  /** Step through the changes at an item's level, from it. */
  showFrom?: (item: ChangeTreeItem, level: readonly ChangeTreeItem[]) => void
  /** Land on this row once it is drawn — current, opened, centred — then `onLanded`. */
  land?: string | null
  onLanded?: () => void
  /** Told the current row as it moves (a surface sharing it with another view). */
  onCurrent?: (key: string) => void
  /** Said above the rows (a reveal that failed). */
  notice?: ReactNode
  maxHeight?: number | string
  className?: string
}

export const treeDomId = (id: string) => `change-tree-${id}`

/** "12 inside +8 ~3 −1": how many changes sit under a container, in the change colours. */
function Inside({ item }: { item: ChangeTreeItem }) {
  const n = item.inside.added + item.inside.modified + item.inside.removed
  if (!n) return null
  return (
    <span className="inline-flex items-center gap-1.5 shrink-0">
      <span className="text-[10.5px] text-ink-muted tabular-nums">{n.toLocaleString()} inside</span>
      <FieldCountChips summary={{ changed: item.inside.modified, added: item.inside.added, removed: item.inside.removed }} />
    </span>
  )
}

export function TreeView({
  model, label, isChange, nameOf, renderChange, itemKeys, showFrom, land, onLanded, onCurrent, notice,
  maxHeight = '60vh', className,
}: TreeViewProps) {
  const { rows, open, setOpen } = model
  const scrollRef = useRef<HTMLDivElement>(null)

  const itemRows = useMemo(() => rows.filter((r): r is ItemRow => r.kind === 'item'), [rows])
  const keys = useMemo(() => itemRows.map((r) => r.key), [itemRows])
  const byKey = useMemo(() => new Map(itemRows.map((r) => [r.key, r])), [itemRows])
  const rowAt = useMemo(() => new Map(rows.map((r, i) => [r.key, i])), [rows])
  const keyAt = useMemo(() => new Map(keys.map((k, i) => [k, i])), [keys])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      const r = rows[i]
      return r?.kind !== 'item' ? NOTE_HEIGHT : isChange(r.item) ? CHANGE_HEIGHT : CONTAINER_HEIGHT
    },
    overscan: 6,
    getItemKey: (i) => rows[i]?.key ?? i,
    // Measurements and scrolls batched into React's own render, not each forced synchronously.
    useFlushSync: false,
  })
  const focusRow = (id: string, align: 'auto' | 'center' = 'auto') => {
    const at = rowAt.get(id)
    if (at === undefined) return
    virtualizer.scrollToIndex(at, { align })
    requestAnimationFrame(() => document.getElementById(treeDomId(id))?.focus())
  }
  const go = (id: string) => { expand.setCurrent(id); focusRow(id) }
  const show = (r: ItemRow) => showFrom?.(r.item, model.levels.get(r.parent)?.items ?? [])

  const expand = useExpandableRows(keys, {
    onNavigate: (id) => focusRow(id),
    extraKeys: (e, current) => {
      const r = current ? byKey.get(current) : undefined
      if (!r) return false
      const id = r.key
      if (!e.shiftKey && e.key === 'ArrowRight' && r.item.hasChildren) {
        if (!open.has(id)) { setOpen(id, true); return true }
        const next = keys[(keyAt.get(id) ?? -1) + 1]
        if (next && byKey.get(next)?.parent === id) { go(next); return true }
        return false
      }
      if (!e.shiftKey && e.key === 'ArrowLeft') {
        if (expand.levelOf(id) > 0 && isChange(r.item)) return false
        if (r.item.hasChildren && open.has(id)) { setOpen(id, false); return true }
        if (r.parent !== TOP) { go(r.parent); return true }
        return false
      }
      return isChange(r.item) && !!itemKeys?.(e, r.item, (l) => expand.setLevel(id, l), () => show(r))
    },
  })

  // Where the current row sits: its containers, named, from the top.
  const current = expand.current
  const crumbs = useMemo(() => {
    const out: Array<{ id: string; name: string }> = []
    let at = current ? byKey.get(current) : undefined
    while (at && at.parent !== TOP && out.length < 64) {
      const up = byKey.get(at.parent)
      if (!up) break
      out.unshift({ id: up.key, name: nameOf(up.item) })
      at = up
    }
    return out
  }, [current, byKey, nameOf])
  const onCurrentRef = useRef(onCurrent)
  useLayoutEffect(() => { onCurrentRef.current = onCurrent })
  useEffect(() => { if (current) onCurrentRef.current?.(current) }, [current])

  // Landing on a row (a revealed search result): once it is drawn, current, opened, centred.
  const landOn = (id: string) => { expand.setCurrent(id); expand.setLevel(id, 1); focusRow(id, 'center'); onLanded?.() }
  const landRef = useRef(landOn)
  useLayoutEffect(() => { landRef.current = landOn })
  useEffect(() => {
    if (land && byKey.has(land)) landRef.current(land)
  }, [land, byKey])

  if (rows.length === 1 && rows[0].kind === 'loading') {
    return (
      <div className={cn('space-y-1.5', className)} aria-busy>
        <p className="text-[11px] text-ink-muted">Laying the changes out under their containers…</p>
        {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-8 w-full" style={{ marginLeft: (i % 3) * INDENT }} />)}
      </div>
    )
  }

  const virtualItems = virtualizer.getVirtualItems()
  return (
    <div className={cn('flex flex-col gap-1.5 min-h-0', className)}>
      <div className="flex items-center gap-2 min-h-[24px]">
        <nav aria-label="Where this sits" className="flex-1 min-w-0 flex items-center gap-1 text-[11px] text-ink-muted overflow-hidden">
          <button type="button" onClick={() => keys[0] && go(keys[0])} className="shrink-0 font-semibold hover:text-ink">Top</button>
          {crumbs.map((c) => (
            <span key={c.id} className="inline-flex items-center gap-1 min-w-0">
              <ChevronRight className="w-3 h-3 shrink-0 text-ink-muted/60" aria-hidden />
              <button type="button" onClick={() => go(c.id)} className="truncate hover:text-ink">{c.name}</button>
            </span>
          ))}
        </nav>
        {open.size > 0 && (
          <HoverTip label="Close every container" className="inline-flex">
            <button type="button" onClick={model.collapseAll}
              className="inline-flex items-center gap-1 px-2 h-7 rounded-lg text-[11.5px] font-semibold text-ink-secondary hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
              <ChevronsDownUp className="w-3.5 h-3.5" aria-hidden /> Collapse all
            </button>
          </HoverTip>
        )}
      </div>
      {notice}
      <div ref={scrollRef} className="overflow-y-auto custom-scrollbar -mx-1 px-1" style={{ maxHeight }}>
        <div role="list" aria-label={label} onKeyDown={expand.onKeyDown}
          className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualItems.map((v) => {
            const r = rows[v.index]
            return (
              <div key={v.key} data-index={v.index} ref={virtualizer.measureElement}
                className="absolute left-0 top-0 w-full" style={{ transform: `translateY(${v.start}px)` }}>
                {/* A guide per level, so a deep row reads where it sits. */}
                {Array.from({ length: r.depth }, (_, d) => (
                  <span key={d} aria-hidden className="absolute top-0 bottom-0 w-px bg-glass-border" style={{ left: d * INDENT + 11 }} />
                ))}
                <div style={{ paddingLeft: r.depth * INDENT }}>
                  {r.kind === 'item' ? (
                    <TreeItemRow r={r} open={open.has(r.key)} expand={expand} setOpen={setOpen} isChange={isChange}
                      nameOf={nameOf} renderChange={renderChange} onShow={() => show(r)} />
                  ) : r.kind === 'more' || r.kind === 'earlier' ? (
                    <button type="button" onClick={() => (r.kind === 'more' ? model.more(r.parent) : model.earlier(r.parent))}
                      className="ml-7 mb-1 inline-flex items-center gap-1 h-7 px-2 rounded-lg text-[11.5px] font-semibold text-accent-lineage hover:bg-accent-lineage/10">
                      {r.kind === 'more'
                        ? `Show ${r.count.toLocaleString()} more${r.left > r.count ? ` of ${r.left.toLocaleString()}` : ''}`
                        : `Show ${r.count.toLocaleString()} earlier`}
                    </button>
                  ) : r.kind === 'loading' ? (
                    <div className="ml-7 flex items-center gap-2 h-8 text-[11px] text-ink-muted">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> Loading…
                    </div>
                  ) : (
                    <p role="alert" className="ml-7 flex items-center gap-2 h-8 text-[11px] text-ink-muted">
                      Couldn't load what's in here.
                      <button type="button" onClick={r.retry} className="inline-flex items-center gap-1 font-semibold text-accent-lineage hover:underline">
                        <RefreshCw className="w-3 h-3" aria-hidden /> Try again
                      </button>
                    </p>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function TreeItemRow({ r, open, expand, setOpen, isChange, nameOf, renderChange, onShow }: {
  r: ItemRow
  open: boolean
  expand: ExpandableRows<string>
  setOpen: (id: string, on: boolean) => void
  isChange: TreeViewProps['isChange']
  nameOf: TreeViewProps['nameOf']
  renderChange: TreeViewProps['renderChange']
  onShow: () => void
}) {
  const { item } = r
  const name = nameOf(item)
  const current = expand.current === r.key
  const toggleKids = () => setOpen(r.key, !open)
  if (isChange(item)) {
    const lead = item.hasChildren ? (
      <button type="button" tabIndex={-1} onClick={toggleKids} aria-expanded={open}
        aria-label={open ? `Hide what's inside ${name}` : `Show what's inside ${name}`}
        className="mt-0.5 w-5 h-5 shrink-0 rounded-md flex items-center justify-center text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06]">
        <ChevronRight className={cn('w-3.5 h-3.5 motion-safe:transition-transform', open && 'rotate-90')} aria-hidden />
      </button>
    ) : <span aria-hidden className="w-5 shrink-0" />
    return <>{renderChange(item, {
      domId: treeDomId(r.key), level: expand.levelOf(r.key), current,
      onToggle: () => expand.toggle(r.key), onLevel: (l) => expand.setLevel(r.key, l),
      onFocus: () => expand.setCurrent(r.key), setsize: r.setsize, posinset: r.posinset, depth: r.depth,
      lead, inside: <Inside item={item} />, onShow,
    })}</>
  }
  // A container no change touched: what it holds is the point — the row opens it.
  return (
    <div role="listitem" aria-level={r.depth + 1} aria-setsize={r.setsize} aria-posinset={r.posinset}
      className={cn('group/row relative mb-1 rounded-xl border border-transparent hover:bg-black/[0.025] dark:hover:bg-white/[0.035]',
        current && 'ring-1 ring-accent-lineage/35')}>
      <button id={treeDomId(r.key)} type="button" tabIndex={current ? 0 : -1} aria-expanded={open}
        onClick={toggleKids} onFocus={() => expand.setCurrent(r.key)}
        className="w-full flex items-center gap-1.5 text-left pl-2.5 pr-2 py-1.5 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40">
        <span className="w-5 h-5 shrink-0 flex items-center justify-center text-ink-muted">
          <ChevronRight className={cn('w-3.5 h-3.5 motion-safe:transition-transform', open && 'rotate-90')} aria-hidden />
        </span>
        <span className="w-5 h-5 rounded-md bg-black/[0.04] dark:bg-white/[0.06] flex items-center justify-center shrink-0">
          <Boxes className="w-3 h-3 text-ink-muted" aria-hidden />
        </span>
        <span className="min-w-0 flex-1 flex items-baseline gap-2">
          <span className="text-[13px] font-medium text-ink truncate">{name}</span>
          {item.type && <span className="text-[11px] text-ink-muted/80 truncate hidden sm:inline">{item.type}</span>}
        </span>
        <Inside item={item} />
      </button>
    </div>
  )
}
