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
 *
 * In a review (`review`), each change also carries its discussion: a count on rows with threads,
 * and, opened, its threads under what changed — with Comment on any one field of it. A draft's
 * review is decided here too (`review.decisions`): each change accepted or rejected (with why),
 * narrowed by what is decided, and every change shown decided at once.
 *
 * Laid out top-down (`Hierarchy`, the Business default; remembered once chosen), the same changes
 * sit under their containers, a level at a time (`ChangeTree`). Searching or narrowing it lists what
 * matches across the whole list, each row saying where it sits — and "Show in hierarchy" opens the
 * way down to it.
 *
 * A draft's own saved changes (`restore`) can be discarded — one, or every change shown — each put
 * back where the draft began, with what holds it together (asked first, from a dry run).
 *
 * In a review, each change can be ticked Viewed (or `v`, which moves on to the next) — kept in this
 * browser, and unticked when the change moves on ("changed since you viewed it").
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  ArrowRight, ArrowUpRight, ChevronsDownUp, ChevronsUpDown, List, ListTree, Loader2, MessageSquare, MessageSquarePlus,
  Search, SearchX, Undo2, CheckSquare, Square,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { EmptyState } from '@/components/ui/EmptyState'
import { Segmented, type SegmentedOption } from '@/components/ui/Segmented'
import { Skeleton, SkeletonText } from '@/components/ui/Skeleton'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { triggerBrowserDownload } from '@/services/importExportApiService'
import {
  changeListExportUrl,
  type ChangeListCounts, type ChangeListKind, type ChangeListOrigin, type ChangeListRow, type ChangeListStatus,
  type ChangeListSummary, type DecisionState, type DecisionVerdict, type ReviewChangeRow, type ReviewDecisionSummary,
} from '@/services/versioningApiService'
import { ExportMenu, type ExportDetail } from './ExportMenu'
import { useChangeEntries, useChangeEntry, useChangeSummary, useRestoreDraftChanges } from '../hooks/useVersioning'
import { useAppNotifications } from '@/components/ui/notifications'
import { useViewedChanges } from '@/features/reviews/viewed/useViewedChanges'
import { ShortcutsHint } from '@/components/ui/ShortcutsHint'
import type { GraphChange } from '../model/changeModel'
import { changeListSource, useChangeNavigatorStore } from '@/store/changeNavigatorStore'
import { EntityDiff } from './EntityDiff'
import { ExpandableChangeRow } from './ExpandableChangeRow'
import { ChangeSummary } from './ChangeSummary'
import { useExpandableRows, type RowLevel } from '@/hooks/useExpandableRows'
import { fieldPath, fromSummaryTop } from '../model/fieldDiff'
import { HoverTip } from '@/components/ui/HoverTip'
import { useReviewCommentCounts, useReviewThreads } from '@/features/reviews/comments/useReviewComments'
import { ReviewThreads, type DiscussionAccess } from '@/features/reviews/comments/ReviewThreads'
import { useReviewChanges } from '@/features/reviews/decisions/useReviewDecisions'
import {
  DecisionBanner, DecisionFilter, RejectReason, RowDecision, useDecisionFlow,
} from '@/features/reviews/decisions/DecisionControls'
import { NodeDiffBadge } from './NodeDiffBadge'
import { ChangeTree, type TreeRowFrame } from './ChangeTree'
import { useChangeListLayout } from '../hooks/useChangeListLayout'
import type { ChangeListLayout } from '@/store/preferences'

const LAYOUTS: SegmentedOption<ChangeListLayout>[] = [
  { value: 'tree', label: 'Hierarchy', icon: ListTree },
  { value: 'list', label: 'List', icon: List },
]

const STATUSES: ChangeListStatus[] = ['added', 'modified', 'removed']
const KIND_LABEL: Record<ChangeListKind, string> = {
  node: 'Entities', edge: 'Relationships', structure: 'Structure',
}
/** How near the end of what is loaded the next page is asked for. */
const PREFETCH_ROWS = 25
/** A row closed: its name and, under it, what it changed. */
const ROW_HEIGHT = 54
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
  /** The review these changes are of: each change carries its discussion — and, in a draft's
   *  review, its decision. */
  review?: { prId: string } & DiscussionAccess & { decisions?: ReviewDecisions }
  /** A draft's own saved changes, which its editor can discard (each put back where it began). */
  restore?: { branchId: string }
  className?: string
}

/** A draft's review, decided change by change. */
export interface ReviewDecisions {
  canDecide: boolean
  /** The draft's head the reviewer is looking at: a decision is refused once it moved on. */
  headCommitId?: string | null
  summary?: ReviewDecisionSummary | null
  /** Who decided, by name. */
  names?: Record<string, string>
}

export function ChangeList({
  wsId, graphId, origin, summary, emptyHint = 'No changes.', maxHeight = '60vh', review, restore, className,
}: ChangeListProps) {
  const commentCounts = useReviewCommentCounts(wsId, review?.prId).data?.entities
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
  const decisions = review?.decisions
  const [decision, setDecision] = useState<DecisionState | null>(null)
  // Top-down, the tree holds every kind: no kind or type to pick. Narrowed, it lists what matches
  // across the whole list, each row with where it sits.
  const [layout, setLayout] = useChangeListLayout()
  const tree = layout === 'tree'
  const chooseLayout = (l: ChangeListLayout) => { setLayout(l); if (l === 'tree') setType('') }
  const narrowed = statuses.length > 0 || (!tree && !!type) || !!q.trim()
  const showTree = tree && !narrowed && !decision
  const [reveal, setReveal] = useState<{ entityId: string; nonce: number } | null>(null)
  const showInTree = (entityId: string) => {
    setText(''); setStatuses([]); setDecision(null)
    setReveal({ entityId, nonce: Date.now() })
  }
  const filter = { kind: tree ? undefined : activeKind, statuses, type: tree ? undefined : type || undefined, q }
  // Discarding saved changes: a dry run says what comes with them; asked when it is more than the
  // one chosen; then one restore commit, from the head the dry run read.
  const { notify } = useAppNotifications()
  const viewed = useViewedChanges(review?.prId)
  const restoreM = useRestoreDraftChanges(wsId, graphId, restore?.branchId ?? '')
  const discardSaved = async (pick: { ids: string[]; label: string } | 'shown') => {
    if (!restore || restoreM.isPending) return
    const body = pick === 'shown' ? { filter } : { entityIds: pick.ids }
    try {
      const dry = await restoreM.mutateAsync({ ...body, dryRun: true })
      if (!dry.restored) return
      const extra = dry.impliedCount
      const ask = pick === 'shown'
        ? `Discard the ${dry.chosen.toLocaleString()} change${dry.chosen === 1 ? '' : 's'} shown from the draft${extra ? `, and ${extra.toLocaleString()} more that hold them together` : ''}?`
        : extra ? `Discard ${pick.label} from the draft? ${extra.toLocaleString()} change${extra === 1 ? '' : 's'} that hold it together go with it.` : null
      if (ask && !window.confirm(`${ask} Each goes back to where the draft began, in one new revision — change it again to bring it back.`)) return
      const out = await restoreM.mutateAsync({ ...body, expectedHeadCommitId: dry.headCommitId })
      notify('success', out.restored === 1 && pick !== 'shown'
        ? `Discarded ${pick.label} from the draft.`
        : `Discarded ${out.restored.toLocaleString()} changes from the draft.`)
    } catch (e) {
      notify('error', (e as Error).message)
    }
  }
  // Each row says what it changed before it is opened (`summary`): counts, and its first few fields.
  const plainQ = useChangeEntries(wsId, graphId, origin, filter,
    { enabled: listable && !decisions && !showTree, summary: true, paths: tree })
  // A draft's review lists its changes with their decisions — the same list, the same order.
  const reviewQ = useReviewChanges(wsId, review?.prId, { ...filter, decision: decision ?? undefined },
    listable && !!decisions && !showTree, true, tree)
  const entriesQ = (decisions ? reviewQ : plainQ) as unknown as typeof plainQ
  const flow = useDecisionFlow(wsId, review?.prId ?? '', decisions?.headCommitId)
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
  // Narrowed by decision, a type's count across the list would not be what is shown under it.
  const items = useMemo(() => itemsOf(rows, decision ? new Map() : typeCounts), [rows, typeCounts, decision])
  const labelOf = useMemo(() => new Map(rows.map((r) => [r.entityId, rowLabel(r)])), [rows])
  // Where each entity still there stands among those the navigator steps through — the list's own
  // order, without what was removed (nothing to show).
  const stepAt = useMemo(() => {
    const at = new Map<string, number>()
    let n = 0
    for (const r of rows) if (r.kind === 'node' && r.status !== 'removed') at.set(r.entityId, n++)
    return at
  }, [rows])
  const showOnCanvas = (row: ChangeListRow) => {
    if (!activeKind) return
    const source = changeListSource(wsId, graphId, origin, { statuses, type: type || undefined, q })
    useChangeNavigatorStore.getState().start(source, {
      scope: 'saved', at: stepAt.get(row.entityId) ?? 0, narrowed: statuses.length > 0 || !!type || !!q.trim(),
    })
  }

  const scrollRef = useRef<HTMLDivElement>(null)
  const rowKeys = useMemo(() => rows.map((r) => r.entityId), [rows])
  const itemAt = useMemo(() => {
    const m = new Map<string, number>()
    items.forEach((it, i) => { if (it.kind === 'row') m.set(it.row.entityId, i) })
    return m
  }, [items])
  const rowById = useMemo(() => new Map(rows.map((r) => [r.entityId, r])), [rows])
  const rowIndex = useMemo(() => new Map(rows.map((r, i) => [r.entityId, i])), [rows])
  // Rejecting asks why, under its row: which row is asking (also from the `r` key).
  const [asking, setAsking] = useState<string | null>(null)
  // A change's own keys, in either layout: a accept, r reject (asks why), c its discussion, o show on canvas.
  const changeKeys = (e: KeyboardEvent, row: ChangeListRow, setLevel: (l: RowLevel) => void, show: () => void, next?: () => void) => {
    if (e.shiftKey) return false
    if (e.key === '?') { document.getElementById(`${keysId}`)?.focus(); return true }
    if (viewed.enabled && e.key === 'v') { viewed.toggle(row); if (!viewed.isViewed(row)) next?.(); return true }
    if (e.key === 'o' && canRevealRows && row.kind === 'node' && row.status !== 'removed') { show(); return true }
    if (decisions?.canDecide && e.key === 'a') { void flow.run('accepted', { entityIds: [row.entityId] }); return true }
    if (decisions?.canDecide && e.key === 'r') { setAsking(row.entityId); return true }
    if (review && e.key === 'c') { setLevel(2); return true }
    if (restore && (e.key === 'Delete' || e.key === 'Backspace')) { void discardSaved({ ids: [row.entityId], label: rowLabel(row) }); return true }
    return false
  }
  const decideOf = (row: ChangeListRow) => (decisions ? {
    decision: (row as ReviewChangeRow).decision ?? null,
    canDecide: decisions.canDecide, busy: flow.busy, names: decisions.names,
    impliedLabel: (() => {
      const by = (row as ReviewChangeRow).decision?.impliedBy
      return by ? labelOf.get(by) ?? null : null
    })(),
    onDecide: (verdict: DecisionVerdict | null, reason?: string | null) => void flow.run(verdict, { entityIds: [row.entityId] }, reason),
  } : undefined)
  const renderTreeChange = (row: ChangeListRow, f: TreeRowFrame) => (
    <Row wsId={wsId} graphId={graphId} origin={origin} row={row} domId={f.domId}
      level={f.level} current={f.current} onToggle={f.onToggle} onLevel={f.onLevel} onFocus={f.onFocus}
      setsize={f.setsize} posinset={f.posinset} depth={f.depth} lead={f.lead} inside={f.inside}
      asking={asking === row.entityId} onAsk={(on) => setAsking(on ? row.entityId : null)} onShow={f.onShow}
      onDiscard={restore ? () => void discardSaved({ ids: [row.entityId], label: rowLabel(row) }) : undefined}
      viewed={viewed.enabled ? { on: viewed.isViewed(row), changedSince: viewed.changedSince(row), toggle: () => viewed.toggle(row) } : undefined}
      review={review} comments={commentCounts?.[row.entityId]} decide={decideOf(row)} />
  )
  const expand = useExpandableRows(rowKeys, {
    onNavigate: (id) => {
      const at = itemAt.get(id)
      if (at === undefined) return
      virtualizer.scrollToIndex(at, { align: 'auto' })
      requestAnimationFrame(() => document.getElementById(rowDomId(id))?.focus())
    },
    extraKeys: (e, current) => {
      const row = current ? rowById.get(current) : undefined
      return !!row && changeKeys(e, row, (l) => expand.setLevel(row.entityId, l), () => showOnCanvas(row), () => {
        const nextRow = rows[(rowIndex.get(row.entityId) ?? -1) + 1]
        if (!nextRow) return
        expand.setCurrent(nextRow.entityId)
        const at = itemAt.get(nextRow.entityId)
        if (at !== undefined) virtualizer.scrollToIndex(at, { align: 'auto' })
        requestAnimationFrame(() => document.getElementById(rowDomId(nextRow.entityId))?.focus())
      })
    },
  })
  const canRevealRows = useChangeNavigatorStore((st) => st.canReveal)
  // The keys this list answers to, as it is now: what `?` (and the keyboard button) lists.
  const keysId = `change-keys-${graphId}`
  const shortcuts: Array<readonly [string, string]> = [
    ['j k', 'Next / previous change'],
    tree ? ['→ ←', 'Open / close — step in and out'] as const : ['→ ←', 'Open / close a change'] as const,
    ['shift+→', 'Open every change shown'],
    ...(canRevealRows ? [['o', 'Show it on the canvas'] as const] : []),
    ...(decisions?.canDecide ? [['a', 'Accept it'] as const, ['r', 'Reject it (asks why)'] as const] : []),
    ...(review ? [['c', 'Its discussion'] as const] : []),
    ...(viewed.enabled ? [['v', 'Mark it viewed, then the next'] as const] : []),
    ...(restore ? [['⌫', 'Discard it from the draft'] as const] : []),
  ]
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
  const counts = tree ? s.counts : activeKind ? kindCounts(s, activeKind) : null

  return (
    <div className={cn('flex flex-col gap-2.5 min-h-0', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented label="Lay the changes out" options={LAYOUTS} value={layout} onChange={chooseLayout} />
        {!tree && kindOptions.length > 1 && activeKind && (
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
            placeholder={tree ? 'Search every change, anywhere…' : 'Search by name, urn or type…'}
            className="w-full h-8 pl-8 pr-2.5 rounded-lg bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border text-[12.5px] text-ink placeholder:text-ink-muted/60 focus:outline-none focus:ring-2 focus:ring-accent-lineage/40"
          />
        </label>
        {!tree && typeOptions.length > 1 && (
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
        {/* What is listed, as filtered, streamed by the server — however many there are. */}
        <ExportMenu count={matching || undefined} onExport={(detail: ExportDetail) => triggerBrowserDownload(
          changeListExportUrl(wsId, graphId, origin, filter, detail),
          `changes${detail === 'properties' ? '-properties' : ''}.csv`)} />
      </div>

      {decisions && <DecisionFilter value={decision} onChange={setDecision} summary={decisions.summary} />}

      <div className="flex items-center gap-2 min-h-[28px]">
        <p className="flex-1 text-[11px] text-ink-muted tabular-nums" aria-live="polite">
          {showTree ? `${s.total.toLocaleString()} changes · top-down, under their containers`
            : entriesQ.isLoading ? 'Loading…'
              : narrowed || decision ? `${matching.toLocaleString()} matching${tree ? ' anywhere' : ''}`
                : `${matching.toLocaleString()} ${activeKind ? KIND_LABEL[activeKind].toLowerCase() : 'changes'}`}
          {!showTree && rows.length < matching && !entriesQ.isLoading && ` · ${rows.length.toLocaleString()} loaded`}
          {viewed.enabled && !showTree && rows.length > 0 && ` · ${rows.filter(viewed.isViewed).length.toLocaleString()} viewed`}
        </p>
        {!showTree && rows.length > 1 && (
          <HoverTip label={expand.allOpen ? 'Collapse every change' : 'Open every change to its key differences'}
            shortcut={expand.allOpen ? '⇧←' : '⇧→'} className="inline-flex">
            <button type="button" onClick={expand.allOpen ? expand.collapseAll : expand.expandAll}
              className="inline-flex items-center gap-1 px-2 h-7 rounded-lg text-[11.5px] font-semibold text-ink-secondary hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
              {expand.allOpen ? <ChevronsDownUp className="w-3.5 h-3.5" aria-hidden /> : <ChevronsUpDown className="w-3.5 h-3.5" aria-hidden />}
              {expand.allOpen ? 'Collapse all' : 'Expand all'}
            </button>
          </HoverTip>
        )}
        {restore && !showTree && (narrowed || decision) && matching > 0 && !entriesQ.isLoading && (
          <button type="button" disabled={restoreM.isPending} onClick={() => void discardSaved('shown')}
            className="inline-flex items-center gap-1 px-2 h-7 rounded-lg text-[11.5px] font-semibold text-rose-700 dark:text-rose-300 hover:bg-rose-500/10 disabled:opacity-50">
            {restoreM.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Undo2 className="w-3.5 h-3.5" aria-hidden />}
            Discard the {matching.toLocaleString()} shown
          </button>
        )}
        <ShortcutsHint id={keysId} shortcuts={shortcuts} />
        {decisions?.canDecide && !showTree && matching > 0 && !entriesQ.isLoading && (
          <>
            <button type="button" disabled={flow.busy} onClick={() => void flow.all('accepted', { ...filter, decision: decision ?? undefined })}
              className="inline-flex items-center gap-1 px-2 h-7 rounded-lg text-[11.5px] font-semibold text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-50">
              Accept {matching.toLocaleString()} shown
            </button>
            <button type="button" disabled={flow.busy} onClick={() => void flow.all('rejected', { ...filter, decision: decision ?? undefined })}
              className="inline-flex items-center gap-1 px-2 h-7 rounded-lg text-[11.5px] font-semibold text-rose-700 dark:text-rose-300 hover:bg-rose-500/10 disabled:opacity-50">
              Reject {matching.toLocaleString()} shown
            </button>
          </>
        )}
      </div>
      {decisions && <DecisionBanner flow={flow} />}

      {/* Kept while a search shows what matches, so closing it returns to the tree as it was left. */}
      {tree && (
        <div hidden={!showTree} className="min-h-0">
          <ChangeTree source={{ wsId, graphId, origin, prId: decisions ? review?.prId : null }}
            renderChange={renderTreeChange} changeKeys={changeKeys} reveal={reveal} maxHeight={maxHeight} />
        </div>
      )}
      {showTree ? null : entriesQ.isError ? (
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
          <div role="list" aria-label="Changes" onKeyDown={expand.onKeyDown}
            className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
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
                      level={expand.levelOf(item.row.entityId)} current={expand.current === item.row.entityId}
                      onToggle={() => expand.toggle(item.row.entityId)}
                      onLevel={(l) => expand.setLevel(item.row.entityId, l)}
                      onFocus={() => expand.setCurrent(item.row.entityId)}
                      setsize={matching} posinset={(rowIndex.get(item.row.entityId) ?? 0) + 1}
                      asking={asking === item.row.entityId}
                      onAsk={(on) => setAsking(on ? item.row.entityId : null)}
                      onShow={() => showOnCanvas(item.row)}
                      onShowInTree={tree ? () => showInTree(item.row.entityId) : undefined}
                      onDiscard={restore ? () => void discardSaved({ ids: [item.row.entityId], label: rowLabel(item.row) }) : undefined}
                      viewed={viewed.enabled ? { on: viewed.isViewed(item.row), changedSince: viewed.changedSince(item.row), toggle: () => viewed.toggle(item.row) } : undefined}
                      review={review} comments={commentCounts?.[item.row.entityId]}
                      decide={decideOf(item.row)} />
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

const rowDomId = (entityId: string) => `change-row-${entityId}`

function Row({
  wsId, graphId, origin, row, domId, level, current, onToggle, onLevel, onFocus, setsize, posinset, asking, onAsk,
  onShow, onShowInTree, onDiscard, viewed, review, comments, decide, depth, lead, inside,
}: {
  wsId: string
  graphId: string
  origin: ChangeListOrigin
  row: ChangeListRow
  /** Its button's id, when the list focusing it names it otherwise (the tree). */
  domId?: string
  level: RowLevel
  current: boolean
  onToggle: () => void
  onLevel: (level: RowLevel) => void
  onFocus: () => void
  setsize: number
  posinset: number
  /** Rejecting it asks why, under the row. */
  asking: boolean
  onAsk: (asking: boolean) => void
  /** Step through these on the canvas, from this one. */
  onShow: () => void
  /** A search result: open the way down to it, top-down. */
  onShowInTree?: () => void
  /** A draft's own saved change: put it back where the draft began. */
  onDiscard?: () => void
  /** In a review: the reviewer's own Viewed tick. */
  viewed?: { on: boolean; changedSince: boolean; toggle: () => void }
  /** In the tree: how deep it sits, what opens its children, and how many changes are under it. */
  depth?: number
  lead?: ReactNode
  inside?: ReactNode
  review?: ChangeListProps['review']
  /** Its threads, open and in all. */
  comments?: { open: number; total: number }
  /** In a draft's review: its decision, and deciding it. */
  decide?: {
    decision: ReviewChangeRow['decision']
    canDecide: boolean
    busy: boolean
    names?: Record<string, string>
    impliedLabel: string | null
    onDecide: (verdict: DecisionVerdict | null, reason?: string | null) => void
  }
}) {
  const label = rowLabel(row)
  const rejected = decide?.decision && !decide.decision.stale && decide.decision.verdict === 'rejected' ? decide.decision : null
  // On a canvas, an entity still there can be shown — and stepped on from — where it sits.
  const canReveal = useChangeNavigatorStore((s) => s.canReveal) && row.kind === 'node' && row.status !== 'removed'
  const edge = row.kind === 'edge'
  return (
    <ExpandableChangeRow
      id={domId ?? rowDomId(row.entityId)} status={row.status} level={level} current={current}
      onToggle={onToggle} onFocus={onFocus} setsize={setsize} posinset={posinset}
      depth={depth} lead={lead} chevron={lead === undefined}
      title={edge ? (
        <span className="inline-flex items-center gap-1 min-w-0 max-w-full">
          <span className="truncate">{row.sourceName || row.sourceEntityId}</span>
          <ArrowRight className="w-3 h-3 text-ink-muted/70 shrink-0" aria-label="to" />
          <span className="truncate">{row.targetName || row.targetEntityId}</span>
        </span>
      ) : label}
      sub={row.path?.length
        // A search result says where it sits, top down.
        ? <span aria-label={`in ${row.path.join(', ')}`}>{row.path.join(' › ')}</span>
        : edge ? row.type : (row.qualifiedName && row.qualifiedName !== label ? row.qualifiedName : undefined)}
      summary={row.fields ? <ChangeSummary summary={row.fields} status={row.status} kind={row.kind} /> : undefined}
      badges={(comments && comments.total > 0) || decide || inside || viewed ? (
        <>
          {inside}
          {viewed && (
            <HoverTip label={viewed.on ? 'Viewed' : viewed.changedSince ? 'Changed since you viewed it' : 'Mark it viewed'}
              detail="Only you see this" shortcut="v" className="inline-flex">
              <button type="button" onClick={viewed.toggle} aria-pressed={viewed.on}
                aria-label={viewed.on ? `${label} viewed` : `Mark ${label} viewed`}
                className={cn('inline-flex items-center gap-1 px-1.5 h-5 rounded-md text-[10.5px] font-semibold transition-colors',
                  viewed.on ? 'text-emerald-700 dark:text-emerald-300 bg-emerald-500/10'
                    : viewed.changedSince ? 'text-amber-700 dark:text-amber-300 bg-amber-500/10' : 'text-ink-muted hover:text-ink')}>
                {viewed.on ? <CheckSquare className="w-3 h-3" aria-hidden /> : <Square className="w-3 h-3" aria-hidden />}
                {viewed.changedSince && !viewed.on ? 'Changed' : 'Viewed'}
              </button>
            </HoverTip>
          )}
          {comments && comments.total > 0 && (
            <span
              aria-label={comments.open ? `${comments.open} open thread${comments.open === 1 ? '' : 's'}` : `${comments.total} resolved thread${comments.total === 1 ? '' : 's'}`}
              className={cn('inline-flex items-center gap-1 px-1.5 h-5 rounded-md text-[10.5px] font-semibold tabular-nums',
                comments.open ? 'bg-accent-lineage/10 text-accent-lineage' : 'text-ink-muted')}>
              <MessageSquare className="w-3 h-3" aria-hidden />{comments.open || comments.total}
            </span>
          )}
          {decide && (
            <RowDecision decision={decide.decision} canDecide={decide.canDecide} busy={decide.busy} label={label}
              impliedLabel={decide.impliedLabel} names={decide.names} asking={asking} onAsk={onAsk}
              onDecide={(v, why) => { onAsk(false); decide.onDecide(v, why) }} />
          )}
        </>
      ) : undefined}
      actions={canReveal || onShowInTree || onDiscard ? (
        <>
          {onShowInTree && (
            <HoverTip label={`Open the way down to ${label}, top-down`} className="inline-flex">
              <button type="button" onClick={onShowInTree} aria-label={`Show ${label} in the hierarchy`}
                className="inline-flex items-center gap-0.5 px-1.5 h-6 rounded-md text-[11px] font-semibold text-ink-secondary hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06]">
                <ListTree className="w-3 h-3" aria-hidden />In hierarchy
              </button>
            </HoverTip>
          )}
          {onDiscard && (
            <HoverTip label="Discard this change from the draft" detail="It goes back to where the draft began" shortcut="⌫" className="inline-flex">
              <button type="button" onClick={onDiscard} aria-label={`Discard the change to ${label}`}
                className="w-6 h-6 rounded-md flex items-center justify-center text-ink-muted hover:text-rose-600 dark:hover:text-rose-300 hover:bg-rose-500/10">
                <Undo2 className="w-3.5 h-3.5" aria-hidden />
              </button>
            </HoverTip>
          )}
          {canReveal && (
            <HoverTip label={`Show ${label} on the canvas`} shortcut="o" className="inline-flex">
              <button type="button" onClick={onShow} aria-label={`Show ${label} on canvas`}
                className="inline-flex items-center gap-0.5 px-1.5 h-6 rounded-md text-[11px] font-semibold text-accent-lineage hover:bg-accent-lineage/10">
                Show<ArrowUpRight className="w-3 h-3" aria-hidden />
              </button>
            </HoverTip>
          )}
        </>
      ) : undefined}
      footer={(
        <>
          {asking && decide && (
            <RejectReason label={label} onCancel={() => onAsk(false)}
              onReject={(why) => { onAsk(false); decide.onDecide('rejected', why) }} />
          )}
          {rejected?.reason && (
            <p className="px-2.5 pb-1.5 pl-10 -mt-0.5 text-[11.5px] text-rose-700/90 dark:text-rose-300/90 truncate">
              “{rejected.reason}”{decide?.names?.[rejected.actor] ? <span className="text-ink-muted"> — {decide.names[rejected.actor]}</span> : null}
            </p>
          )}
        </>
      )}
    >
      {(lvl) => (
        <div className="space-y-2">
          {lvl === 1 && row.fields && (row.fields.top.length > 0 || row.fields.total === 0)
            // Its key differences, from the row's own summary: nothing to fetch, so browsing is instant.
            ? <EntityDiff change={stubChange(row, origin)} fields={fromSummaryTop(row.fields.top)} depth="key"
                totalFields={row.fields.total} onShowAll={() => onLevel(2)} />
            : <RowDetail wsId={wsId} graphId={graphId} origin={origin} row={row} review={review}
                depth={lvl === 1 ? 'key' : 'all'} onShowAll={() => onLevel(2)} />}
          {lvl === 1 && review && (
            // Its discussion is one step further: every field, its threads, and where to comment.
            <button type="button" onClick={() => onLevel(2)}
              className="inline-flex items-center gap-1 text-[11px] font-semibold text-accent-lineage hover:underline">
              <MessageSquare className="w-3 h-3" aria-hidden />
              {comments && comments.total > 0
                ? `${comments.total.toLocaleString()} thread${comments.total === 1 ? '' : 's'} on this change`
                : 'Comment on this change'}
            </button>
          )}
        </div>
      )}
    </ExpandableChangeRow>
  )
}

/** A row as a change, before its values are read: enough for its key differences to render. */
function stubChange(row: ChangeListRow, origin: ChangeListOrigin): GraphChange {
  return {
    entityId: row.entityId, kind: row.kind, status: row.status, label: rowLabel(row),
    origin: 'branchId' in origin
      ? { source: 'branch', branchId: origin.branchId }
      : { source: 'compare', fromSeq: origin.fromSeq, toSeq: origin.toSeq },
  }
}

/** One entity before and after, fetched when its row is opened — in a review, with its threads. */
function RowDetail({ wsId, graphId, origin, row, review, depth = 'all', onShowAll }: {
  wsId: string
  graphId: string
  origin: ChangeListOrigin
  row: ChangeListRow
  review?: ChangeListProps['review']
  depth?: 'key' | 'all'
  onShowAll?: () => void
}) {
  const q = useChangeEntry(wsId, graphId, origin, row.entityId)
  const [path, setPath] = useState<string | null>(null)
  // Threads on each field, from the change's own threads (the list below reads the same page).
  const threadsQ = useReviewThreads(wsId, review?.prId ?? '', { entityId: row.entityId }, !!review)
  const onField = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of threadsQ.data?.pages.flatMap((p) => p.threads) ?? []) {
      if (t.path && !t.resolvedAt) m.set(t.path, (m.get(t.path) ?? 0) + 1)
    }
    return m
  }, [threadsQ.data])
  if (q.isLoading) return <SkeletonText lines={2} className="py-1" />
  if (q.isError || !q.data) {
    return (
      <p className="flex items-center gap-2 text-[11px] text-ink-muted px-2 py-1.5" role="alert">
        Couldn't load this change.
        <button type="button" onClick={() => void q.refetch()} className="font-semibold text-accent-lineage hover:underline">Try again</button>
      </p>
    )
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
  if (!review || depth === 'key') return <EntityDiff change={change} depth={depth} onShowAll={onShowAll} />
  return (
    <div className="space-y-2.5">
      <EntityDiff change={change} fieldAction={(f) => {
        const p = fieldPath(f)
        const n = onField.get(p) ?? 0
        if (!n && !review.canComment) return null
        return (
          <HoverTip label={n ? `${n} open thread${n === 1 ? '' : 's'} on ${f.label}` : `Comment on ${f.label}`} className="inline-flex">
            <button type="button" onClick={() => setPath(p)} aria-label={`Comment on ${f.label}`}
              className={cn('inline-flex items-center gap-0.5 h-6 px-1 rounded-md text-[10.5px] font-semibold tabular-nums transition-opacity',
                n ? 'text-accent-lineage' : 'text-ink-muted opacity-0 group-hover/value:opacity-100 focus-visible:opacity-100 hover:text-ink',
                path === p && 'opacity-100 bg-accent-lineage/10 text-accent-lineage')}>
              {n ? <><MessageSquare className="w-3 h-3" aria-hidden />{n}</> : <MessageSquarePlus className="w-3.5 h-3.5" aria-hidden />}
            </button>
          </HoverTip>
        )
      }} />
      <ReviewThreads
        wsId={wsId} prId={review.prId} filter={{ entityId: row.entityId }} access={review}
        compose={{ entityId: row.entityId, path, placeholder: path ? `Comment on ${path.split('/').pop()}…` : 'Comment on this change…' }}
        onClearPath={() => setPath(null)}
      />
    </div>
  )
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
