/**
 * ViewHistoryTimeline — change history with up to three scopes:
 *  • This draft  — the active draft's own checkpoints, so you can review your individual commits
 *    before raising a PR (shown only while on a draft).
 *  • This view   — the view's PUBLISHED timeline: its publishes + shared graph-level events, at
 *    the SAME granularity as Whole graph (identical for a single-view source). Each "merged N
 *    commits" publish drills down to the raw draft commits it squashed.
 *  • Whole graph — the graph's full `main` log (every merge / import / genesis).
 * Each commit is expandable (lazy per-commit diff) via the shared {@link CommitRow}.
 *
 * Newest first, a page at a time — paged by the oldest revision listed (`before`), so a walk never
 * skips or repeats one while new ones land, and never stops at a cap — grouped by month and day in
 * the reader's time zone, and drawn a window at a time: years of revisions scroll as lightly as ten.
 *
 * With the revision viewer (the `revisionViewerEnabled` preview) this is where to travel in time:
 * each revision of Published opens on the canvas as the graph was then, compares with now or with
 * another, and copies a link to itself; the month picker goes to the end of any month or day; and
 * a comparison of two revisions opens here ({@link RevisionCompare}). Undo and Restore stay with
 * the people who can publish. Away from the canvas (a data source's Versioning tab) the same actions
 * open, highlight and link to a revision somewhere else — in one of its views.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useQueryClient } from '@tanstack/react-query'
import { Eye, Layers, GitBranch, GitCompareArrows, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useFeature } from '@/store/features'
import { usePermission } from '@/store/auth'
import { useBranchStore } from '@/store/branchStore'
import { useStagedChangeCount } from '@/store/stagedChangesStore'
import { Skeleton } from '@/components/ui/Skeleton'
import { useAppNotifications } from '@/components/ui/notifications'
import * as api from '@/services/versioningApiService'
import type { CompareRequest } from '@/store/versioningPanelStore'
import { VERSIONING_KEYS, useHistoryMonths, useHistoryPages, type HistoryScope } from '../hooks/useVersioning'
import { useRevisionViewer } from '../hooks/useRevisionViewer'
import { CommitRow, type RevisionRowActions } from './CommitRow'
import { HistoryMonthPicker } from './HistoryMonthPicker'
import { RevisionCompare } from './RevisionCompare'
import { RevertDialog, RestoreDialog } from './RollbackDialogs'

type Scope = 'draft' | 'view' | 'graph'
type Commit = Record<string, unknown>

type Item =
  | { kind: 'month'; key: string; month: string; label: string }
  | { kind: 'day'; key: string; label: string }
  | { kind: 'commit'; key: string; commit: Commit }
  | { kind: 'end'; key: 'end' }

const pad = (n: number) => String(n).padStart(2, '0')

/** The rows as drawn: each month under a header, each day under a label, in the reader's time zone. */
function itemsOf(commits: Commit[], now: Date): Item[] {
  const out: Item[] = []
  let month = ''
  let day = ''
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const y = new Date(now.getTime() - 86_400_000)
  const yesterday = `${y.getFullYear()}-${pad(y.getMonth() + 1)}-${pad(y.getDate())}`
  for (const c of commits) {
    const at = new Date(String(c.created_at))
    const valid = !Number.isNaN(at.getTime())
    const m = valid ? `${at.getFullYear()}-${pad(at.getMonth() + 1)}` : 'unknown'
    const d = valid ? `${m}-${pad(at.getDate())}` : 'unknown'
    if (m !== month) {
      month = m
      day = ''
      out.push({ kind: 'month', key: `m:${m}`, month: m,
        label: valid ? at.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : 'Undated' })
    }
    if (d !== day) {
      day = d
      out.push({ kind: 'day', key: `d:${d}`,
        label: d === today ? 'Today' : d === yesterday ? 'Yesterday'
          : valid ? at.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : '' })
    }
    out.push({ kind: 'commit', key: `c:${String(c.commit_id)}`, commit: c })
  }
  return out
}

const ESTIMATE: Record<Item['kind'], number> = { month: 36, day: 26, commit: 58, end: 64 }

export function ViewHistoryTimeline({
  wsId,
  graphId,
  viewId,
  branchId,
  canManage = false,
  compare: compareRequest = null,
  headSeq: givenHead = null,
  openBlocked: unavailable = null,
  onNavigate,
  onOpenRevision,
  onHighlight,
  revisionLink,
  onExport,
  onComparingChange,
}: {
  wsId: string
  graphId: string
  viewId?: string | null
  branchId?: string | null
  /** Managers get rollback actions (undo a revision / restore to a point) on published rows. */
  canManage?: boolean
  /** Open on a comparison of two revisions (the banner's "Compare with now", a revision too far
   *  back to draw). */
  compare?: CompareRequest | null
  /** Published's head where the branch store holds another graph's, or none (away from the
   *  canvas): what is now until the history's months say. */
  headSeq?: number | null
  /** Why no revision can be opened from here, or null (a data source with no view to open one in):
   *  Open, Highlight and Copy link are disabled, saying so, and the month picker offers no Open. */
  openBlocked?: string | null
  /** A revision was opened on the canvas: the drawer gets out of the way. */
  onNavigate?: () => void
  /** Away from the canvas, a revision opens elsewhere (in a view of the data source) — once asked
   *  whether it can be drawn, as on the canvas. */
  onOpenRevision?: (seq: number) => void
  /** Away from the canvas, a comparison is highlighted elsewhere. */
  onHighlight?: (fromSeq: number, toSeq: number) => void
  /** The link Copy link copies, instead of this page with `?rev=`. */
  revisionLink?: (seq: number) => string
  /** Export Published as it was at a revision. */
  onExport?: (seq: number) => void
  /** A comparison opened or closed (the drawer widens for one). */
  onComparingChange?: (comparing: boolean) => void
}) {
  const onDraft = !!branchId
  const [scope, setScope] = useState<Scope>(onDraft ? 'draft' : viewId ? 'view' : 'graph')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const { notify } = useAppNotifications()
  const qc = useQueryClient()

  // Rollback affordances: published (main) rows only — draft checkpoints aren't
  // main commits. Manager + admin-flag gated, and both write main, so they need publish too;
  // dialogs own the confirm/impact UX.
  const versioningEnabled = useFeature('versioningEnabled')
  const canPublish = usePermission('workspace:datasource:publish', wsId)
  const canRollback = canManage && canPublish && versioningEnabled
  const [revertTarget, setRevertTarget] = useState<Record<string, unknown> | null>(null)
  const [restoreTarget, setRestoreTarget] = useState<Record<string, unknown> | null>(null)

  // Travelling in time (the preview): open, compare, link.
  const revisionViewer = useRevisionViewer(wsId)
  const [compare, setCompare] = useState<CompareRequest | null>(compareRequest)
  const [askedCompare, setAskedCompare] = useState(compareRequest)
  if (askedCompare !== compareRequest) {
    setAskedCompare(compareRequest)
    if (compareRequest) setCompare(compareRequest)
  }
  useEffect(() => { onComparingChange?.(compare != null) }, [compare, onComparingChange])
  const [pickingFrom, setPickingFrom] = useState<number | null>(null)
  const openRevision = useBranchStore((s) => s.openRevision)
  // Opening a revision leaves the draft: unsaved edits would be parked out of sight.
  const unsaved = useStagedChangeCount()
  const openBlocked = unavailable ?? (unsaved > 0 ? 'Save or discard your unsaved edits first.' : null)
  const setHighlight = useBranchStore((s) => s.setHighlight)
  const closeRevision = useBranchStore((s) => s.closeRevision)
  // While a revision is open on the canvas, every "since then" counts up to the head it opened at.
  const pinnedHead = useBranchStore((s) => s.revision?.headAtOpen ?? null)
  const repinRevision = useBranchStore((s) => s.repinRevision)

  const historyScope: HistoryScope = scope === 'draft' && branchId ? { kind: 'draft', branchId }
    : scope === 'view' && viewId ? { kind: 'view', viewId } : { kind: 'graph' }
  const pages = useHistoryPages(wsId, graphId, historyScope)
  const monthsQ = useHistoryMonths(wsId, graphId, scope === 'view' ? viewId : null, scope !== 'draft')
  const resolvedHead = useBranchStore((s) => s.mainHeadCommitSeq)
  const headSeq = monthsQ.data?.headSeq ?? givenHead ?? resolvedHead
  const commits = useMemo(() => (pages.data?.pages ?? []).flatMap((p) => p.commits as Commit[]), [pages.data])
  const userNames = useMemo(
    () => Object.assign({}, ...(pages.data?.pages ?? []).map((p) => p.userNames ?? {})) as Record<string, string>,
    [pages.data])
  const items = useMemo(() => {
    const out = itemsOf(commits, new Date())
    if (commits.length > 0 && !pages.hasNextPage) out.push({ kind: 'end', key: 'end' })
    return out
  }, [commits, pages.hasNextPage])
  const toggle = useCallback((id: string) => setExpandedId((prev) => (prev === id ? null : id)), [])

  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => ESTIMATE[items[i]?.kind ?? 'commit'],
    getItemKey: (i) => items[i]?.key ?? i,
    overscan: 8,
  })
  const virtualItems = virtualizer.getVirtualItems()
  const last = virtualItems.at(-1)?.index ?? 0
  useEffect(() => {
    if (pages.hasNextPage && !pages.isFetchingNextPage && last >= items.length - 12) void pages.fetchNextPage()
  }, [last, items.length, pages])
  // The month the list is reading, pinned at the top as it scrolls.
  const first = virtualItems[0]?.index ?? 0
  const currentMonth = useMemo(() => {
    for (let i = Math.min(first, items.length - 1); i >= 0; i--) {
      const it = items[i]
      if (it?.kind === 'month') return it
    }
    return null
  }, [first, items])
  const monthCounts = useMemo(() => new Map((monthsQ.data?.months ?? []).map((m) => [m.month, m.count])), [monthsQ.data])

  // Bring the list to a month: page on until it is loaded, then scroll to its header.
  const [jumpTo, setJumpTo] = useState<string | null>(null)
  useEffect(() => {
    if (!jumpTo) return
    const idx = items.findIndex((it) => it.kind === 'month' && it.month <= jumpTo)
    const landed = idx >= 0 && (items[idx] as { month: string }).month === jumpTo
    if (landed || (idx >= 0 && !pages.hasNextPage)) {
      virtualizer.scrollToIndex(idx, { align: 'start' })
      setJumpTo(null)
    } else if (pages.hasNextPage && !pages.isFetchingNextPage) {
      void pages.fetchNextPage()
    } else if (!pages.hasNextPage) {
      setJumpTo(null)
    }
  }, [jumpTo, items, pages, virtualizer])

  const openOnCanvas = useCallback(async (seq: number, c?: Commit) => {
    try {
      const plan = await qc.fetchQuery({
        queryKey: VERSIONING_KEYS.revision(wsId, graphId, seq),
        queryFn: () => api.getRevision(wsId, graphId, seq),
        staleTime: 30_000,
      })
      if (!plan.openable) {
        setCompare({ fromSeq: seq, toSeq: null, notice: plan.reason === 'fork' ? 'fork' : 'too_far' })
        return
      }
      if (onOpenRevision) {
        onOpenRevision(seq)
        return
      }
      const commit = c ?? plan.commit
      openRevision({
        seq,
        headAtOpen: plan.headSeq,
        commitId: (commit.commit_id as string) ?? null,
        createdAt: (commit.created_at as string) ?? null,
        message: (commit.message as string) ?? null,
        actor: (commit.actor as string) ?? null,
      })
      onNavigate?.()
    } catch (e) {
      notify('error', e instanceof Error ? e.message : "That revision couldn't be opened.")
    }
  }, [qc, wsId, graphId, openRevision, onNavigate, onOpenRevision, notify])

  const copyLink = useCallback(async (seq: number) => {
    const url = new URL(window.location.href)
    url.searchParams.set('rev', String(seq))
    url.searchParams.delete('branch')
    try {
      await navigator.clipboard.writeText(revisionLink ? revisionLink(seq) : url.toString())
      notify('success', `Link copied — it opens the graph as it was at revision #${seq}.`)
    } catch {
      notify('error', "The link couldn't be copied.")
    }
  }, [notify, revisionLink])

  const revisionActionsFor = (c: Commit): RevisionRowActions | undefined => {
    const seq = c.commit_seq
    if (!revisionViewer || scope === 'draft' || typeof seq !== 'number') return undefined
    return {
      headSeq,
      pinnedHeadSeq: pinnedHead,
      onRepin: () => repinRevision(headSeq),
      openBlocked,
      linkBlocked: unavailable,
      onOpen: () => void openOnCanvas(seq, c),
      onCompareWithNow: () => setCompare({ fromSeq: seq, toSeq: null }),
      onCompareWith: () => setPickingFrom(seq),
      onCopyLink: () => void copyLink(seq),
    }
  }

  const scopeBtns: Array<{ id: Scope; label: string; Icon: ComponentType<{ className?: string }>; show: boolean }> = [
    { id: 'draft', label: 'This draft', Icon: GitBranch, show: onDraft },
    { id: 'view', label: 'This view', Icon: Eye, show: !!viewId },
    { id: 'graph', label: 'Whole graph', Icon: Layers, show: true },
  ]
  const visible = scopeBtns.filter((b) => b.show)

  const emptyMsg =
    scope === 'draft' ? 'No commits on this draft yet — make a change and save it.'
      : scope === 'graph' ? 'No commits yet.'
        : 'No changes from this view yet.'
  const emptyHint =
    scope === 'view'
      ? 'Publishes made from other views on this data source appear under Whole graph.'
      : null

  if (compare) {
    return (
      <div className="h-full overflow-y-auto custom-scrollbar pr-1 -mr-1">
        <RevisionCompare
          wsId={wsId}
          graphId={graphId}
          from={compare.fromSeq}
          to={compare.toSeq}
          headSeq={headSeq}
          notice={compare.notice ?? null}
          canOpen={revisionViewer}
          openBlocked={openBlocked}
          onChange={(fromSeq, toSeq) => setCompare({ fromSeq, toSeq })}
          onBack={() => setCompare(null)}
          onOpen={(seq) => {
            if (seq != null && seq < headSeq) void openOnCanvas(seq)
            // Published as it is now: on the canvas, the revision it reads closes; away from it, the head opens.
            else if (onOpenRevision) onOpenRevision(headSeq)
            else { closeRevision(); onNavigate?.() }
          }}
          onHighlight={(fromSeq, toSeq) => {
            if (onHighlight) {
              onHighlight(fromSeq, toSeq)
            } else if (toSeq >= headSeq) {
              closeRevision()
              setHighlight({ fromSeq, toSeq })
              onNavigate?.()
            } else {
              setHighlight({ fromSeq, toSeq })
              void openOnCanvas(toSeq)
            }
          }}
          onExport={onExport}
        />
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col gap-3 min-h-0">
      <div className="flex items-center gap-2 flex-wrap shrink-0">
        {visible.length > 1 && (
          <div className="inline-flex rounded-lg border border-glass-border overflow-hidden text-xs">
            {visible.map((b, i) => (
              <button
                key={b.id}
                onClick={() => { setScope(b.id); setExpandedId(null); setPickingFrom(null) }}
                className={cn(
                  'px-2.5 py-1 font-medium',
                  i > 0 && 'border-l border-glass-border',
                  scope === b.id ? 'bg-accent-lineage/15 text-accent-lineage' : 'text-ink-muted hover:bg-canvas-overlay',
                )}
              >
                <b.Icon className="w-3.5 h-3.5 inline mr-1" /> {b.label}
              </button>
            ))}
          </div>
        )}
        {revisionViewer && scope !== 'draft' && (
          <div className="ml-auto flex items-center gap-1.5">
            <HistoryMonthPicker
              months={monthsQ.data?.months}
              loading={monthsQ.isLoading}
              headSeq={headSeq}
              canOpen={revisionViewer && !openBlocked}
              onOpen={(seq) => void openOnCanvas(seq)}
              onCompare={(seq) => setCompare({ fromSeq: seq, toSeq: null })}
              onJump={setJumpTo}
            />
          </div>
        )}
      </div>

      {pickingFrom != null && (
        <div className="shrink-0 flex items-center gap-2 rounded-xl border border-indigo-500/25 bg-indigo-500/[0.06] px-3 py-2 text-[12px] animate-fade-in">
          <GitCompareArrows className="w-4 h-4 shrink-0 text-indigo-600 dark:text-indigo-300" />
          <span className="min-w-0 flex-1 text-ink">
            Comparing with revision <span className="font-semibold">#{pickingFrom}</span> — pick the other one below.
          </span>
          <button onClick={() => setPickingFrom(null)} aria-label="Stop comparing"
            className="p-1 rounded-md text-ink-muted hover:bg-canvas-overlay"><X className="w-3.5 h-3.5" /></button>
        </div>
      )}

      {pages.isLoading ? (
        <div className="space-y-4 pl-1" aria-busy="true" aria-label="Loading history">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex gap-3">
              <Skeleton className="w-2.5 h-2.5 mt-1 rounded-full" />
              <div className="flex-1 space-y-1.5"><Skeleton className="h-3.5 w-3/5" /><Skeleton className="h-3 w-2/5" /></div>
            </div>
          ))}
        </div>
      ) : commits.length === 0 ? (
        <div className="py-10 text-center">
          <p className="text-sm text-ink-muted">{emptyMsg}</p>
          {emptyHint && <p className="mt-1.5 text-xs text-ink-muted/70">{emptyHint}</p>}
        </div>
      ) : (
        <div ref={scrollRef} className="relative flex-1 min-h-0 overflow-y-auto custom-scrollbar -mr-2 pr-2">
          {/* Pinned over the list, taking no room of its own: it covers the month's own header
              when that is at the top, and names the month being read once it has scrolled away. */}
          {currentMonth && (
            <div className="sticky top-0 z-10 h-0">
              <div className="bg-canvas">
                <MonthHeader label={currentMonth.label} count={monthCounts.get(currentMonth.month)} />
              </div>
            </div>
          )}
          <div role="list" aria-label="Revisions" className="relative" style={{ height: virtualizer.getTotalSize() }}>
            {virtualItems.map((v) => {
              const it = items[v.index]
              if (!it) return null
              return (
                <div
                  key={v.key}
                  data-index={v.index}
                  ref={virtualizer.measureElement}
                  className="absolute left-0 right-0"
                  style={{ transform: `translateY(${v.start}px)` }}
                >
                  {it.kind === 'month' ? (
                    <MonthHeader label={it.label} count={monthCounts.get(it.month)} />
                  ) : it.kind === 'day' ? (
                    <p className="ml-1.5 pl-4 border-l border-glass-border pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-muted/70">
                      {it.label}
                    </p>
                  ) : it.kind === 'end' ? (
                    <p className="ml-1.5 pl-4 pt-3 pb-6 text-[11px] text-ink-muted/70">The beginning of this history.</p>
                  ) : (
                    <TimelineCommit
                      commit={it.commit}
                      wsId={wsId}
                      graphId={graphId}
                      viewId={viewId}
                      scope={scope}
                      userNames={userNames}
                      expanded={expandedId === String(it.commit.commit_id)}
                      onToggle={toggle}
                      onRevert={canRollback && scope !== 'draft' ? setRevertTarget : undefined}
                      onRestore={canRollback && scope !== 'draft' ? setRestoreTarget : undefined}
                      revision={revisionActionsFor(it.commit)}
                      pickingFrom={pickingFrom}
                      onPicked={(seq) => {
                        const a = Math.min(pickingFrom!, seq)
                        const b = Math.max(pickingFrom!, seq)
                        setPickingFrom(null)
                        setCompare({ fromSeq: a, toSeq: b >= headSeq ? null : b })
                      }}
                    />
                  )}
                </div>
              )
            })}
          </div>
          {pages.isFetchingNextPage && (
            <div className="space-y-3 pl-6 py-3" aria-hidden>
              <Skeleton className="h-3.5 w-1/2" /><Skeleton className="h-3 w-1/3" />
            </div>
          )}
        </div>
      )}

      <RevertDialog
        open={revertTarget !== null}
        commit={revertTarget}
        wsId={wsId}
        graphId={graphId}
        userNames={userNames}
        onClose={() => setRevertTarget(null)}
        onRestoreInstead={(target) => {
          setRevertTarget(null)
          setRestoreTarget(target)
        }}
      />
      <RestoreDialog
        open={restoreTarget !== null}
        commit={restoreTarget}
        wsId={wsId}
        graphId={graphId}
        userNames={userNames}
        onClose={() => setRestoreTarget(null)}
      />
    </div>
  )
}

function MonthHeader({ label, count }: { label: string; count?: number }) {
  return (
    <div className="flex items-baseline gap-2 pt-2 pb-1.5 border-b border-glass-border/60">
      <span className="text-[12px] font-semibold text-ink">{label}</span>
      {count != null && (
        <span className="text-[11px] text-ink-muted tabular-nums">{count} {count === 1 ? 'revision' : 'revisions'}</span>
      )}
    </div>
  )
}

/** One revision on the timeline's line — or, while another is being compared with, a target. */
function TimelineCommit({
  commit, wsId, graphId, viewId, scope, userNames, expanded, onToggle, onRevert, onRestore, revision,
  pickingFrom, onPicked,
}: {
  commit: Commit
  wsId: string
  graphId: string
  viewId?: string | null
  scope: Scope
  userNames: Record<string, string>
  expanded: boolean
  onToggle: (id: string) => void
  onRevert?: (c: Commit) => void
  onRestore?: (c: Commit) => void
  revision?: RevisionRowActions
  pickingFrom: number | null
  onPicked: (seq: number) => void
}) {
  const seq = typeof commit.commit_seq === 'number' ? commit.commit_seq : null
  const originatingViewLabel =
    scope === 'graph' && commit.originating_view_id && commit.originating_view_id !== viewId
      ? (commit.originating_view_id as string).slice(-6)
      : null
  const pickable = pickingFrom != null && seq != null && seq !== pickingFrom
  return (
    <div className={cn('ml-1.5 pl-4 border-l border-glass-border py-1.5', pickable && 'group/pick')}>
      <div className="relative">
        <CommitRow
          asItem="div"
          commit={commit}
          wsId={wsId}
          graphId={graphId}
          originatingViewLabel={originatingViewLabel}
          // "This view" and "Whole graph" show the published timeline, so a squash
          // drills down to its raw commits. "This draft" already IS raw commits.
          allowSquashDrilldown={scope !== 'draft'}
          published={scope !== 'draft'}
          userNames={userNames}
          expanded={expanded}
          onToggle={onToggle}
          onRevert={onRevert}
          onRestore={onRestore}
          revision={pickingFrom == null ? revision : undefined}
        />
        {pickable && (
          <button
            onClick={() => onPicked(seq!)}
            className="absolute right-0 top-0 inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold text-white bg-gradient-to-r from-indigo-500 to-violet-600 shadow-sm shadow-indigo-500/20 opacity-80 group-hover/pick:opacity-100 transition-opacity"
          >
            <GitCompareArrows className="w-3 h-3" /> Compare
          </button>
        )}
      </div>
    </div>
  )
}
