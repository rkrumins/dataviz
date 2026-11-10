/**
 * ChangeNavigator — a review, one change at a time, on the canvas.
 *
 * - **The change, in plain words:** "Deleted · orders_legacy · from Sales › crm · by Ana · 3 days
 *   ago". Who and when come from the deletion read, for a deletion only; technical users also see
 *   the type and the qualified name.
 * - **One operation at a time**, with counts: All, Added, Modified, Deleted.
 * - **‹ 12 of 1,850 entities ›**, also on ← and →. Each step finds the change on the canvas
 *   (`useReviewOnCanvas`), past the 500 deletions drawn, and loads the next page when it gets there.
 * - **Details** opens the change's drawer; **List** the list beside the canvas; **×** ends the review.
 *
 * It sits at the bottom of the canvas, on the floating-chrome tier, and gives way to a trace.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, List, Loader2, PanelLeftOpen, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { DateTime } from '@/components/ui/DateTime'
import { HoverTip } from '@/components/ui/HoverTip'
import { Segmented, type SegmentedOption } from '@/components/ui/Segmented'
import type { ChangeListStatus } from '@/services/versioningApiService'
import { useCanvasStore } from '@/store/canvas'
import { usePersonaMode } from '@/store/persona'
import { useReviewStore } from '@/store/reviewStore'
import { useEntityDeletion } from '../hooks/useVersioning'
import { useReviewList, useReviewRows } from '../hooks/useReviewList'
import { KIND_LABEL, changeRowLabel, kindCounts } from '../model/changeListSummary'
import { ownerName } from '../model/branchVocab'
import { STATUS_META } from './NodeDiffBadge'
import { TombstoneDrawer } from './TombstoneDetails'

const OPERATIONS: ChangeListStatus[] = ['added', 'modified', 'removed']

/** A key press meant for something else: typing, a control's own arrows, or a dialog open over the
 *  canvas (the lens, a panel), which the keys belong to. */
function forSomethingElse(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return true
  if (document.querySelector('[role="dialog"]')) return true
  const t = e.target instanceof HTMLElement ? e.target : null
  return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)
    || !!t.closest('[role="dialog"],[role="radiogroup"],[role="listbox"],[role="menu"]'))
}

export function ChangeNavigator({ viewId, hidden = false }: { viewId: string | null; hidden?: boolean }) {
  const open = useReviewStore((s) => s.navigatorOpen)
  if (!open || hidden) return null
  return <Navigator viewId={viewId} />
}

function Navigator({ viewId }: { viewId: string | null }) {
  const list = useReviewList(viewId)
  const rowsQ = useReviewRows(list)
  const { rows, matching, hasNextPage, isFetchingNextPage, fetchNextPage } = rowsQ
  const current = useReviewStore((s) => s.current)
  const position = useReviewStore((s) => s.position)
  const found = useReviewStore((s) => s.found)
  const operation = useReviewStore((s) => s.operation)
  const listOpen = useReviewStore((s) => s.listOpen)
  const visit = useReviewStore((s) => s.visit)
  const setOperation = useReviewStore((s) => s.setOperation)
  const toggleList = useReviewStore((s) => s.toggleList)
  const endReview = useReviewStore((s) => s.endReview)
  const technical = usePersonaMode() === 'technical'

  // A review starts at its first change, and so does a list narrowed afresh.
  useEffect(() => {
    if (!current && rows.length > 0) visit(rows[0], 0)
  }, [current, rows, visit])

  // A step past the rows loaded asks for the next page, and lands once it's there.
  const pending = useRef<number | null>(null)
  const go = useCallback((to: number) => {
    if (to < 0 || to >= matching) return
    if (to < rows.length) { pending.current = null; visit(rows[to], to); return }
    pending.current = to
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage()
  }, [matching, rows, visit, hasNextPage, isFetchingNextPage, fetchNextPage])
  useEffect(() => {
    const to = pending.current
    if (to != null && to < rows.length) { pending.current = null; visit(rows[to], to) }
  }, [rows, visit])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || forSomethingElse(e)) return
      e.preventDefault()
      go(position + (e.key === 'ArrowRight' ? 1 : -1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go, position])

  // Who deleted it and when, and where it lived: asked for the change the review is on only.
  const origin = list.current?.origin
  const deletion = useEntityDeletion(list.wsId ?? undefined, list.graphId,
    current?.status === 'removed' ? current.entityId : null, {
      branchId: origin && 'branchId' in origin ? origin.branchId : null,
      atSeq: origin && 'toSeq' in origin ? origin.toSeq : null,
      kind: current?.kind,
    })
  const del = deletion.data
  const [tombstoneOpen, setTombstoneOpen] = useState(false)

  const s = list.s
  const counts = s && list.kind ? kindCounts(s, list.kind) : null
  const operationOptions: SegmentedOption<ChangeListStatus | 'all'>[] = [
    { value: 'all', label: 'All', count: counts ? counts.added + counts.modified + counts.removed : undefined },
    ...OPERATIONS.map((op) => ({ value: op, label: STATUS_META[op].label, count: counts?.[op], disabled: !!counts && counts[op] === 0 })),
  ]
  const meta = current ? STATUS_META[current.status] : null
  const name = current ? changeRowLabel(current) : ''
  const urn = current ? current.urn || current.entityId : ''
  const onCanvas = useCanvasStore((st) => !!urn && st._nodeIndex.has(urn))
  const detailsFor = current?.kind === 'node' && (onCanvas || current.status === 'removed')
  const details = () => {
    if (!current) return
    if (onCanvas) useCanvasStore.getState().openNodeDrawer(urn)
    else setTombstoneOpen(true)
  }
  const where = del?.ancestors?.map((a) => a.displayName || a.urn).filter(Boolean).join(' › ')

  return (
    <div
      role="region"
      aria-label="Review changes"
      data-canvas-interactive
      className="absolute left-1/2 -translate-x-1/2 z-40 w-[min(740px,calc(100%-2rem))] rounded-2xl border border-glass-border bg-canvas-elevated/95 backdrop-blur-md shadow-xl shadow-black/15 px-3.5 pt-2.5 pb-2 pointer-events-auto"
      style={{ bottom: 'calc(1rem + var(--trace-dock-height, 0px))' }}
    >
      <div className="flex items-center gap-2 min-w-0">
        {current && meta ? (
          <p className="flex items-baseline gap-1.5 min-w-0 text-[12.5px]" aria-live="polite">
            <span className={cn('inline-flex items-center gap-1 self-center shrink-0 font-semibold', meta.text)}>
              <meta.Icon className="w-3.5 h-3.5" aria-hidden /> {meta.label}
            </span>
            <span className="text-ink-muted/50">·</span>
            <span className={cn('font-semibold text-ink truncate min-w-0', meta.strike)}>{name}</span>
            {technical && current.type && <span className="shrink-0 text-ink-muted">{current.type}</span>}
            {where && <span className="text-ink-muted truncate min-w-0">from {where}</span>}
            {del?.deleted && (
              <span className="shrink-0 text-ink-muted">
                {del.deleted.deletedBy && <>by {ownerName(del.deleted.deletedBy, del.userNames)} · </>}
                <DateTime at={del.deleted.at} />
              </span>
            )}
          </p>
        ) : (
          <p className="text-[12.5px] text-ink-muted">{rowsQ.isLoading || !s ? 'Loading the changes…' : 'Nothing to review here.'}</p>
        )}
        <div className="flex-1" />
        {found === 'looking' && <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-ink-muted" aria-label="Finding it on the canvas" />}
        <HoverTip className="inline-flex" label="End the review">
          <button type="button" onClick={endReview} aria-label="End the review"
            className="p-1 -mr-1 rounded-md text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06]">
            <X className="w-3.5 h-3.5" />
          </button>
        </HoverTip>
      </div>
      {technical && current?.kind === 'node' && current.qualifiedName && current.qualifiedName !== name && (
        <p className="mt-0.5 text-[11px] font-mono text-ink-muted/80 truncate">{current.qualifiedName}</p>
      )}
      {(found === 'nearby' || found === 'missing') && (
        <p className="mt-0.5 text-[11px] text-amber-700 dark:text-amber-300">
          {found === 'nearby' ? "It isn't drawn here: this is as near as the canvas gets." : "It isn't on this canvas."}
          {detailsFor && ' Details still says what it was.'}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Segmented label="Show" options={operationOptions} value={operation ?? 'all'}
          onChange={(v) => setOperation(v === 'all' ? null : v)} />
        <div className="flex-1" />
        <div className="inline-flex items-center gap-0.5">
          <button type="button" onClick={() => go(position - 1)} disabled={!current || position <= 0}
            aria-label="Previous change" aria-keyshortcuts="ArrowLeft"
            className="p-1 rounded-md text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06] disabled:opacity-35">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="px-1 text-center text-[12px] text-ink tabular-nums whitespace-nowrap">
            {current ? (position + 1).toLocaleString() : '–'} of {matching.toLocaleString()}
            {list.kinds.length > 1 && list.kind && <span className="text-ink-muted"> {KIND_LABEL[list.kind].toLowerCase()}</span>}
          </span>
          <button type="button" onClick={() => go(position + 1)} disabled={!current || position + 1 >= matching}
            aria-label="Next change" aria-keyshortcuts="ArrowRight"
            className="p-1 rounded-md text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06] disabled:opacity-35">
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
        <button type="button" onClick={details} disabled={!detailsFor}
          className="h-7 px-2.5 rounded-lg border border-glass-border text-[12px] font-medium text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.05] disabled:opacity-40">
          Details
        </button>
        <button type="button" onClick={toggleList} aria-pressed={listOpen}
          className={cn('inline-flex items-center gap-1 h-7 px-2.5 rounded-lg border text-[12px] font-medium',
            listOpen ? 'border-accent-lineage/40 bg-accent-lineage/[0.08] text-ink' : 'border-glass-border text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.05]')}>
          {listOpen ? <List className="w-3.5 h-3.5" /> : <PanelLeftOpen className="w-3.5 h-3.5" />} List
        </button>
      </div>

      {tombstoneOpen && current && list.wsId && list.graphId && origin && (
        <TombstoneDrawer onClose={() => setTombstoneOpen(false)}
          target={{ wsId: list.wsId, graphId: list.graphId, entityId: current.entityId, kind: current.kind, origin, label: name }} />
      )}
    </div>
  )
}
