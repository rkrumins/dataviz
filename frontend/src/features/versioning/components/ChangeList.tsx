/**
 * ChangeList — a change list at any size: a draft's changes, one revision's, or two revisions
 * compared (`ChangeListOrigin`).
 *
 * The server classifies the list once and pages it (`/graphs/{gid}/diff/*`); this draws the
 * window you are looking at and fetches the next page as you near its end, so 100,000 changes
 * are 40 rows in the page, not 100,000. Nothing arrives with a payload: a row says what its
 * version row says (a name, a type, an edge's ends), and opening one fetches that entity's
 * before and after alone.
 *
 * Narrow it by kind (entities, relationships, structure), status, type and text — the counts on
 * each come from the same index the rows do, so they always agree.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowRight, ChevronRight, Loader2, Search, SearchX } from 'lucide-react'
import { cn } from '@/lib/utils'
import { EmptyState } from '@/components/ui/EmptyState'
import { Segmented, type SegmentedOption } from '@/components/ui/Segmented'
import { Skeleton, SkeletonText } from '@/components/ui/Skeleton'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import type {
  ChangeListCounts, ChangeListKind, ChangeListOrigin, ChangeListRow, ChangeListStatus, ChangeListSummary,
} from '@/services/versioningApiService'
import { useChangeEntries, useChangeEntry, useChangeSummary } from '../hooks/useVersioning'
import type { GraphChange } from '../model/changeModel'
import { EntityDiff } from './EntityDiff'
import { NodeDiffBadge, STATUS_META } from './NodeDiffBadge'

const STATUSES: ChangeListStatus[] = ['added', 'modified', 'removed']
const KIND_LABEL: Record<ChangeListKind, string> = {
  node: 'Entities', edge: 'Relationships', structure: 'Structure',
}
/** How near the end of what is loaded the next page is asked for. */
const PREFETCH_ROWS = 25
const ROW_HEIGHT = 36
const HEADER_HEIGHT = 30

const total = (c?: ChangeListCounts | null) => (c ? c.added + c.modified + c.removed : 0)

function kindCounts(s: ChangeListSummary, kind: ChangeListKind): ChangeListCounts | null | undefined {
  return kind === 'node' ? s.entityCounts : kind === 'edge' ? s.edgeCounts : s.structureCounts
}

type Item =
  | { kind: 'type'; key: string; type: string | null; count: number }
  | { kind: 'row'; key: string; row: ChangeListRow }

/** The rows as drawn: each run of one type under a header naming it and how many there are. */
function itemsOf(rows: ChangeListRow[], counts: Map<string, number>): Item[] {
  const out: Item[] = []
  let last: string | null | undefined
  for (const row of rows) {
    const type = row.type ?? null
    if (out.length === 0 || type !== last) {
      out.push({ kind: 'type', key: `type:${type ?? ''}:${out.length}`, type, count: counts.get(type ?? '') ?? 0 })
      last = type
    }
    out.push({ kind: 'row', key: row.entityId, row })
  }
  return out
}

function rowLabel(row: ChangeListRow): string {
  if (row.kind === 'node') return row.displayName || row.urn || row.entityId
  return `${row.sourceName || row.sourceEntityId || '…'} → ${row.targetName || row.targetEntityId || '…'}`
}

export interface ChangeListProps {
  wsId: string
  graphId: string
  origin: ChangeListOrigin
  /** When the caller holds the summary already; else it is fetched. */
  summary?: ChangeListSummary | null
  /** Said when the origin changes nothing. */
  emptyHint?: string
  /** Height the list may grow to before it scrolls. */
  maxHeight?: number | string
  className?: string
}

export function ChangeList({
  wsId, graphId, origin, summary, emptyHint = 'No changes.', maxHeight = '60vh', className,
}: ChangeListProps) {
  const summaryQ = useChangeSummary(wsId, graphId, summary ? null : origin)
  const s = summary ?? summaryQ.data ?? null

  const kinds = useMemo(
    () => (s ? (['node', 'edge', 'structure'] as const).filter((k) => total(kindCounts(s, k)) > 0) : []),
    [s],
  )
  const [kind, setKind] = useState<ChangeListKind | null>(null)
  const activeKind: ChangeListKind | undefined = kind && kinds.includes(kind) ? kind : kinds[0]
  const [statuses, setStatuses] = useState<ChangeListStatus[]>([])
  const [type, setType] = useState('')
  const [text, setText] = useState('')
  const q = useDebouncedValue(text, 250)
  // Narrowing to another kind starts its type afresh.
  const chooseKind = (k: ChangeListKind) => { setKind(k); setType('') }

  const listable = !!s && s.listed > 0 && !!activeKind
  const entriesQ = useChangeEntries(
    wsId, graphId, origin, { kind: activeKind, statuses, type: type || undefined, q },
    { enabled: listable },
  )
  const rows = useMemo(() => entriesQ.data?.pages.flatMap((p) => p.entries) ?? [], [entriesQ.data])
  const matching = entriesQ.data?.pages[0]?.total ?? 0

  const typeCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of s?.byType ?? []) {
      if (t.kind !== activeKind) continue
      const n = statuses.length ? statuses.reduce((sum, st) => sum + t[st], 0) : t.added + t.modified + t.removed
      m.set(t.type ?? '', n)
    }
    return m
  }, [s, activeKind, statuses])
  const typeOptions = useMemo(
    () => (s?.byType ?? []).filter((t) => t.kind === activeKind)
      .map((t) => ({ type: t.type ?? '', n: t.added + t.modified + t.removed }))
      .sort((a, b) => b.n - a.n),
    [s, activeKind],
  )
  const items = useMemo(() => itemsOf(rows, typeCounts), [rows, typeCounts])

  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const toggle = (id: string) => setOpen((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const scrollRef = useRef<HTMLDivElement>(null)
  const hasMore = !!entriesQ.hasNextPage
  const virtualizer = useVirtualizer({
    count: items.length + (hasMore ? 1 : 0),
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (items[i]?.kind === 'type' ? HEADER_HEIGHT : ROW_HEIGHT),
    overscan: 12,
    getItemKey: (i) => items[i]?.key ?? 'more',
  })
  const virtualItems = virtualizer.getVirtualItems()
  const lastShown = virtualItems.length ? virtualItems[virtualItems.length - 1].index : -1
  const { fetchNextPage, isFetchingNextPage } = entriesQ
  useEffect(() => {
    if (hasMore && !isFetchingNextPage && lastShown >= items.length - PREFETCH_ROWS) void fetchNextPage()
  }, [hasMore, isFetchingNextPage, lastShown, items.length, fetchNextPage])

  if (!s) {
    return summaryQ.isError
      ? <p className={cn('text-xs text-ink-muted py-3', className)}>Couldn't load these changes. Try again in a moment.</p>
      : <div className={cn('space-y-2 py-2', className)} aria-busy><Skeleton className="h-7 w-2/3" /><SkeletonText lines={4} /></div>
  }
  if (s.total === 0) {
    return <p className={cn('text-sm text-ink-muted py-8 text-center', className)}>{emptyHint}</p>
  }
  if (s.listed === 0 && s.tooLarge) {
    return <TooLargeToList summary={s} className={className} />
  }

  const kindOptions: SegmentedOption<ChangeListKind>[] = kinds.map((k) => ({
    value: k, label: KIND_LABEL[k], count: total(kindCounts(s, k)),
  }))
  const counts = activeKind ? kindCounts(s, activeKind) : null
  const narrowed = statuses.length > 0 || !!type || !!q.trim()

  return (
    <div className={cn('flex flex-col gap-2.5 min-h-0', className)}>
      <div className="flex flex-wrap items-center gap-2">
        {kindOptions.length > 1 && activeKind && (
          <Segmented label="What changed" options={kindOptions} value={activeKind} onChange={chooseKind} />
        )}
        <div className="flex items-center gap-1" role="group" aria-label="Show changes that were">
          {STATUSES.map((st) => {
            const on = statuses.includes(st)
            const n = counts?.[st] ?? 0
            return (
              <button
                key={st}
                type="button"
                aria-pressed={on}
                disabled={n === 0}
                onClick={() => setStatuses((prev) => (on ? prev.filter((x) => x !== st) : [...prev, st]))}
                className={cn(
                  'rounded-md transition-opacity disabled:opacity-40',
                  statuses.length > 0 && !on && 'opacity-50 hover:opacity-80',
                )}
              >
                <NodeDiffBadge status={st} count={n} withLabel className={cn(on && 'ring-1 ring-current')} />
              </button>
            )
          })}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <label className="relative flex-1 min-w-0">
          <span className="sr-only">Search these changes</span>
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-muted/70 pointer-events-none" />
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search by name, urn or type…"
            className="w-full h-8 pl-8 pr-2.5 rounded-lg bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border text-[12.5px] text-ink placeholder:text-ink-muted/60 focus:outline-none focus:ring-2 focus:ring-accent-lineage/40"
          />
        </label>
        {typeOptions.length > 1 && (
          <select
            aria-label="Type"
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="h-8 max-w-[45%] rounded-lg bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border px-2 text-[12.5px] text-ink focus:outline-none focus:ring-2 focus:ring-accent-lineage/40"
          >
            <option value="">All types</option>
            {typeOptions.map((t) => (
              <option key={t.type} value={t.type}>{t.type || 'Untyped'} · {t.n.toLocaleString()}</option>
            ))}
          </select>
        )}
      </div>

      <p className="text-[11px] text-ink-muted tabular-nums" aria-live="polite">
        {entriesQ.isLoading ? 'Loading…'
          : narrowed ? `${matching.toLocaleString()} matching`
            : `${matching.toLocaleString()} ${activeKind ? KIND_LABEL[activeKind].toLowerCase() : 'changes'}`}
        {rows.length < matching && !entriesQ.isLoading && ` · ${rows.length.toLocaleString()} loaded`}
      </p>

      {entriesQ.isError ? (
        <p className="text-xs text-ink-muted py-3">Couldn't load this page of changes. Try again in a moment.</p>
      ) : entriesQ.isLoading ? (
        <div className="space-y-1.5" aria-busy>
          {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-8 w-full" />)}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState compact icon={SearchX} title="Nothing matches"
          description="Try another type or status, or clear the search." />
      ) : (
        <div ref={scrollRef} className="overflow-y-auto custom-scrollbar -mx-1 px-1" style={{ maxHeight }}>
          <div role="list" aria-label="Changes" className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualItems.map((v) => {
              const item = items[v.index]
              return (
                <div
                  key={v.key}
                  data-index={v.index}
                  ref={virtualizer.measureElement}
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${v.start}px)` }}
                >
                  {!item ? (
                    <div className="flex items-center gap-2 h-9 px-2 text-[11px] text-ink-muted">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading more…
                    </div>
                  ) : item.kind === 'type' ? (
                    <div className="flex items-baseline gap-2 pt-2.5 pb-1 px-1">
                      <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-muted/80 truncate">
                        {item.type || 'Untyped'}
                      </span>
                      {item.count > 0 && (
                        <span className="text-[10.5px] text-ink-muted/70 tabular-nums">{item.count.toLocaleString()}</span>
                      )}
                    </div>
                  ) : (
                    <Row wsId={wsId} graphId={graphId} origin={origin} row={item.row}
                      open={open.has(item.row.entityId)} onToggle={() => toggle(item.row.entityId)} />
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function Row({ wsId, graphId, origin, row, open, onToggle }: {
  wsId: string
  graphId: string
  origin: ChangeListOrigin
  row: ChangeListRow
  open: boolean
  onToggle: () => void
}) {
  const meta = STATUS_META[row.status]
  const label = rowLabel(row)
  return (
    <div role="listitem" className={cn('mb-1 rounded-lg border-l-2 bg-canvas-overlay/40', meta.accent)}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full flex items-center gap-1.5 min-w-0 px-2.5 py-1.5 text-left group"
      >
        <ChevronRight className={cn('w-3.5 h-3.5 text-ink-muted/60 transition-transform shrink-0', open && 'rotate-90')} />
        <meta.Icon className={cn('w-3.5 h-3.5 shrink-0', meta.text)} aria-label={meta.label} />
        {row.kind === 'edge' ? (
          <span className="flex items-center gap-1 min-w-0 text-[13px] text-ink">
            <span className="truncate">{row.sourceName || row.sourceEntityId}</span>
            <ArrowRight className="w-3 h-3 text-ink-muted/70 shrink-0" />
            <span className="truncate">{row.targetName || row.targetEntityId}</span>
          </span>
        ) : (
          <span className="text-[13px] text-ink truncate">{label}</span>
        )}
        {row.kind === 'node' && row.qualifiedName && row.qualifiedName !== label && (
          <span className="text-[11px] text-ink-muted/70 truncate min-w-0 hidden sm:inline">{row.qualifiedName}</span>
        )}
      </button>
      {open && (
        <div className="px-2.5 pb-2 pl-7">
          <RowDetail wsId={wsId} graphId={graphId} origin={origin} row={row} />
        </div>
      )}
    </div>
  )
}

/** One entity before and after, fetched when its row is opened. */
function RowDetail({ wsId, graphId, origin, row }: {
  wsId: string
  graphId: string
  origin: ChangeListOrigin
  row: ChangeListRow
}) {
  const q = useChangeEntry(wsId, graphId, origin, row.entityId)
  if (q.isLoading) return <SkeletonText lines={2} className="py-1" />
  if (q.isError || !q.data) {
    return <p className="text-[11px] text-ink-muted px-2 py-1.5">Couldn't load this change.</p>
  }
  const d = q.data
  const change: GraphChange = {
    entityId: d.entityId,
    kind: d.kind,
    status: d.status === 'unchanged' ? 'modified' : d.status,
    label: rowLabel(row),
    before: d.before ?? undefined,
    after: d.after ?? undefined,
    origin: 'branchId' in origin
      ? { source: 'branch', branchId: origin.branchId }
      : { source: 'compare', fromSeq: origin.fromSeq, toSeq: origin.toSeq },
  }
  return <EntityDiff change={change} />
}

/** An origin past what a list holds: what changed, counted, and why it isn't listed. */
function TooLargeToList({ summary, className }: { summary: ChangeListSummary; className?: string }) {
  const changed = summary.tooLarge?.changed ?? summary.total
  return (
    <div className={cn('rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.03] px-4 py-3.5', className)}>
      <p className="text-[13px] font-medium text-ink">
        {summary.approximate ? 'About ' : ''}{changed.toLocaleString()} changes
      </p>
      <div className="flex flex-wrap gap-1.5 mt-2">
        {STATUSES.map((st) => summary.counts[st] > 0 && (
          <NodeDiffBadge key={st} status={st} count={summary.counts[st]} withLabel />
        ))}
      </div>
      <p className="text-[12px] text-ink-muted mt-2 leading-relaxed">
        That's more than a list here shows ({summary.tooLarge?.limit.toLocaleString()}).
        {summary.approximate && ' Counted from what each revision recorded, so an entity changed twice counts twice.'}
        {' '}Export the data to look through all of it.
      </p>
    </div>
  )
}
