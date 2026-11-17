/**
 * ChangeTree — a change list top-down: what changed under its containers, from the top, a level at
 * a time — the database first, then its schemas, then its tables — each container saying how many
 * changes sit under it (`12 inside +8 ~3 −1`), so a reviewer goes where the change is, one step at a
 * time, instead of scrolling 100,000 rows.
 *
 * The server lays the tree out once per version of the list, without payloads, and hands it out a
 * level and a page at a time (`useChangeTree`); this draws the rows open — virtualized — and
 * nothing else. A change in it is the same row as in the list (`renderChange`): its summary, then
 * its key differences, then all of them.
 *
 * Keys, on the tree: J / K (↓ / ↑) move · → opens a container, then steps into it · ← closes what
 * is open, then goes to the container · Enter opens a change · the list's own keys on a change.
 * `reveal` opens the way down to a change (a search result's "Show in hierarchy").
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Boxes, ChevronRight, ChevronsDownUp, Loader2, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { HoverTip } from '@/components/ui/HoverTip'
import { Skeleton } from '@/components/ui/Skeleton'
import type { ChangeListRow, ChangeTreeItem } from '@/services/versioningApiService'
import { stopOf, useChangeNavigatorStore } from '@/store/changeNavigatorStore'
import { useExpandableRows, type ExpandableRows, type RowLevel } from '@/hooks/useExpandableRows'
import { TOP, useChangeTree, type ChangeTreeSource, type TreeRow } from '../hooks/useChangeTree'
import { FieldCountChips } from './ChangeSummary'

/** How far each level sits in from its container. */
const INDENT = 18
/** Each row as it measures (a change: its name and summary; a container: one line; "Show more"),
 *  so a range scrolled into view lays out once instead of re-measuring every row it mounts. */
const CHANGE_HEIGHT = 61
const CONTAINER_HEIGHT = 38
const NOTE_HEIGHT = 32

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
  /** Step through the changes at its level on the canvas, from it. */
  onShow: () => void
}

export interface ChangeTreeProps {
  source: ChangeTreeSource
  /** How a change draws itself — the list's own row. */
  renderChange: (row: ChangeListRow, frame: TreeRowFrame) => ReactNode
  /** The list's own keys on a change (accept, reject, comment, show). */
  changeKeys?: (e: KeyboardEvent, row: ChangeListRow, setLevel: (level: RowLevel) => void, show: () => void) => boolean
  /** Open the way down to this change, then focus it (a new `nonce` each time it is asked). */
  reveal?: { entityId: string; nonce: number } | null
  maxHeight?: number | string
}

const treeDomId = (id: string) => `change-tree-${id}`

const insideOf = (i: ChangeTreeItem) => i.inside.added + i.inside.modified + i.inside.removed
const nameOf = (i: ChangeTreeItem) => (i.change
  ? (i.change.kind === 'node' ? i.change.displayName || i.change.urn || i.change.entityId
    : `${i.change.sourceName || '…'} → ${i.change.targetName || '…'}`)
  : i.name || i.id)

/** "12 inside +8 ~3 −1": how many changes sit under a container, in the change colours. */
function Inside({ item }: { item: ChangeTreeItem }) {
  const n = insideOf(item)
  if (!n) return null
  return (
    <span className="inline-flex items-center gap-1.5 shrink-0">
      <span className="text-[10.5px] text-ink-muted tabular-nums">{n.toLocaleString()} inside</span>
      <FieldCountChips summary={{ changed: item.inside.modified, added: item.inside.added, removed: item.inside.removed }} />
    </span>
  )
}

export function ChangeTree({ source, renderChange, changeKeys, reveal, maxHeight = '60vh' }: ChangeTreeProps) {
  const tree = useChangeTree(source)
  const { rows, open, setOpen } = tree
  const scrollRef = useRef<HTMLDivElement>(null)

  const itemRows = useMemo(() => rows.filter((r): r is Extract<TreeRow, { kind: 'item' }> => r.kind === 'item'), [rows])
  const keys = useMemo(() => itemRows.map((r) => r.key), [itemRows])
  const byKey = useMemo(() => new Map(itemRows.map((r) => [r.key, r])), [itemRows])
  const rowAt = useMemo(() => new Map(rows.map((r, i) => [r.key, i])), [rows])
  const keyAt = useMemo(() => new Map(keys.map((k, i) => [k, i])), [keys])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      const r = rows[i]
      return r?.kind !== 'item' ? NOTE_HEIGHT : r.item.change ? CHANGE_HEIGHT : CONTAINER_HEIGHT
    },
    overscan: 12,
    getItemKey: (i) => rows[i]?.key ?? i,
  })
  const focusRow = (id: string, align: 'auto' | 'center' = 'auto') => {
    const at = rowAt.get(id)
    if (at === undefined) return
    virtualizer.scrollToIndex(at, { align })
    requestAnimationFrame(() => document.getElementById(treeDomId(id))?.focus())
  }
  const go = (id: string) => { expand.setCurrent(id); focusRow(id) }

  // The changes at a level, as canvas stops: what "Show" steps through.
  const showFrom = (r: Extract<TreeRow, { kind: 'item' }>) => {
    const saved = 'branchId' in source.origin
    const level = tree.levels.get(r.parent)?.items ?? []
    const stops = level.flatMap((i) => (i.change && i.change.kind === 'node' && i.change.status !== 'removed' ? [stopOf(i.change, saved)] : []))
    const id = r.item.change ? (r.item.change.urn ?? r.item.change.entityId) : r.item.id
    useChangeNavigatorStore.getState().start(stops, { scope: 'saved', atId: id })
  }

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
        if (expand.levelOf(id) > 0 && r.item.change) return false
        if (r.item.hasChildren && open.has(id)) { setOpen(id, false); return true }
        if (r.parent !== TOP) { go(r.parent); return true }
        return false
      }
      if (r.item.change && changeKeys?.(e, r.item.change, (l) => expand.setLevel(id, l), () => showFrom(r))) return true
      return false
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
  }, [current, byKey])

  // Revealing a change: read where it sits, open the way down, then focus it once its row is read.
  const [pending, setPending] = useState<string | null>(null)
  const [revealFailed, setRevealFailed] = useState<string | null>(null)
  const { pathOf, reveal: openPath } = tree
  useEffect(() => {
    if (!reveal) return
    let live = true
    setRevealFailed(null)
    pathOf(reveal.entityId)
      .then((p) => { if (live) { openPath(p); setPending(reveal.entityId) } })
      .catch(() => { if (live) setRevealFailed(reveal.entityId) })
    return () => { live = false }
  }, [reveal, pathOf, openPath])
  const landOn = (id: string) => { expand.setCurrent(id); expand.setLevel(id, 1); focusRow(id, 'center') }
  const landRef = useRef(landOn)
  useLayoutEffect(() => { landRef.current = landOn })
  useEffect(() => {
    if (!pending || !byKey.has(pending)) return
    landRef.current(pending)
    setPending(null)
  }, [pending, byKey])

  if (rows.length === 1 && rows[0].kind === 'loading') {
    return (
      <div className="space-y-1.5" aria-busy>
        <p className="text-[11px] text-ink-muted">Laying the changes out under their containers…</p>
        {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-8 w-full" style={{ marginLeft: (i % 3) * INDENT }} />)}
      </div>
    )
  }

  const virtualItems = virtualizer.getVirtualItems()
  return (
    <div className="flex flex-col gap-1.5 min-h-0">
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
            <button type="button" onClick={tree.collapseAll}
              className="inline-flex items-center gap-1 px-2 h-7 rounded-lg text-[11.5px] font-semibold text-ink-secondary hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
              <ChevronsDownUp className="w-3.5 h-3.5" aria-hidden /> Collapse all
            </button>
          </HoverTip>
        )}
      </div>
      {revealFailed && (
        <p role="alert" className="text-[11px] text-ink-muted">Couldn't find where that change sits. Try again in a moment.</p>
      )}
      <div ref={scrollRef} className="overflow-y-auto custom-scrollbar -mx-1 px-1" style={{ maxHeight }}>
        <div role="list" aria-label="Changes, top-down" onKeyDown={expand.onKeyDown}
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
                    <TreeItemRow r={r} open={open.has(r.key)} expand={expand} setOpen={setOpen}
                      renderChange={renderChange} onShow={() => showFrom(r)} />
                  ) : r.kind === 'more' || r.kind === 'earlier' ? (
                    <button type="button" onClick={() => (r.kind === 'more' ? tree.more(r.parent) : tree.earlier(r.parent))}
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

function TreeItemRow({ r, open, expand, setOpen, renderChange, onShow }: {
  r: Extract<TreeRow, { kind: 'item' }>
  open: boolean
  expand: ExpandableRows<string>
  setOpen: (id: string, on: boolean) => void
  renderChange: ChangeTreeProps['renderChange']
  onShow: () => void
}) {
  const { item } = r
  const name = nameOf(item)
  const current = expand.current === r.key
  const toggleKids = () => setOpen(r.key, !open)
  if (item.change) {
    const lead = item.hasChildren ? (
      <button type="button" tabIndex={-1} onClick={toggleKids} aria-expanded={open}
        aria-label={open ? `Hide what's inside ${name}` : `Show what's inside ${name}`}
        className="mt-0.5 w-5 h-5 shrink-0 rounded-md flex items-center justify-center text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06]">
        <ChevronRight className={cn('w-3.5 h-3.5 motion-safe:transition-transform', open && 'rotate-90')} aria-hidden />
      </button>
    ) : <span aria-hidden className="w-5 shrink-0" />
    return <>{renderChange(item.change, {
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
