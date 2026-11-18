/**
 * ReviewPage — one review, the whole page. The header says what it is, where it stands and the one
 * thing to do next. Below it, three columns, each scrolling on its own: the changes to go through,
 * the change open, and beside it what the review still needs, who reviews it and its conversation.
 * Narrower, the side follows the change; narrower still, the changes fold away above it.
 *
 * The change open, and a thread a link opened, are in the address (`useReviewSelection`); keys move
 * through the changes and act on the one open (`useReviewKeys`). `?finish=1` opens Finish your
 * review (the drawer's way here to give a verdict). What a review lets the reader do, and doing it,
 * is the drawer's own (`useReviewActions`).
 */
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft, SearchX } from 'lucide-react'
import { EmptyState } from '@/components/ui/EmptyState'
import { Disclosure } from '@/components/ui/Disclosure'
import { ShortcutsHint } from '@/components/ui/ShortcutsHint'
import { Skeleton, SkeletonText } from '@/components/ui/Skeleton'
import type { ChangeListEntry, ChangeListRow, ReviewChangeRow } from '@/services/versioningApiService'
import { useChangeEntry } from '@/features/versioning/hooks/useVersioning'
import { UpdateFromParentButton } from '@/features/versioning/components/UpdateFromParentButton'
import { ConflictResolver } from '../components/ConflictResolver'
import { IncomingChangesSheet } from '@/features/versioning/components/IncomingChangesSheet'
import { useReviewActions } from '../hooks/useReviewActions'
import { useReviewCommentCounts } from '../comments/useReviewComments'
import { useDecisionFlow } from '../decisions/DecisionControls'
import { useViewedChanges } from '../viewed/useViewedChanges'
import { readiness, type ActionKind } from './readiness'
import { ReviewHeader } from './ReviewHeader'
import { ReviewPrimaryAction } from './ReviewPrimaryAction'
import { ReviewNavigator } from './ReviewNavigator'
import { ReviewChangePane } from './ReviewChangePane'
import { ReviewSide, type SideTab } from './ReviewSide'
import { useReviewSelection } from './useReviewSelection'
import { useReviewOrder } from './useReviewOrder'
import { reviewShortcuts, useReviewKeys } from './useReviewKeys'

const KEYS_ID = 'review-page-keys'

/** Room for the changes in a column of their own (Tailwind's `lg`). */
function useWide(): boolean {
  const query = '(min-width: 1024px)'
  const [wide, setWide] = useState(() => typeof window.matchMedia !== 'function' || window.matchMedia(query).matches)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(query)
    const sync = () => setWide(mq.matches)
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])
  return wide
}

/** A change opened by a link before its page of the list was read: as much as its entity says. */
function entryRow(d: ChangeListEntry | undefined): ChangeListRow | null {
  if (!d) return null
  const side = (d.after ?? d.before ?? {}) as { displayName?: string | null }
  return { entityId: d.entityId, kind: d.kind, status: d.status === 'unchanged' ? 'modified' : d.status, structural: false, displayName: side.displayName ?? null }
}

export function ReviewPage({ wsId, prId }: { wsId: string; prId: string }) {
  const navigate = useNavigate()
  const inbox = `/workspaces/${wsId}/reviews`
  const actions = useReviewActions(wsId, prId, () => navigate(inbox))
  const { pr, prQ, user, draftReview, draftSummaryQ, forkSummaryQ, listOrigin, deciding, decisions, viewerCan } = actions
  const wide = useWide()
  const selection = useReviewSelection(wsId, prId)
  const selected = selection.selected

  // Where its changes are listed: a draft's review, its own list; a fork's past the tree's cap, the
  // window of the fork's main they are in.
  const forkList = forkSummaryQ.data?.list
  const source = pr && draftReview && listOrigin ? { graphId: pr.graphId, origin: listOrigin }
    : forkList ? { graphId: forkList.graphId, origin: { fromSeq: forkList.fromSeq, toSeq: forkList.toSeq } } : null
  const counts = draftReview ? draftSummaryQ.data?.counts : forkSummaryQ.data?.counts
  const total = counts ? counts.added + counts.modified + counts.removed : 0
  // Decided here change by change: a draft's review, open, small enough to list, for whoever decides.
  const listable = !!source && (draftSummaryQ.data?.listed ?? 1) > 0
  const decidingHere = deciding && listable
  const canDecide = decidingHere && !!viewerCan?.decide

  const order = useReviewOrder({ wsId, prId, source, withDecisions: deciding })
  const viewed = useViewedChanges(prId)
  const viewedCount = viewed.count(order.rows)
  const threadCounts = useReviewCommentCounts(wsId, prId).data
  const openThreads = threadCounts?.open ?? 0
  const flow = useDecisionFlow(wsId, prId, pr?.headCommitId)
  const [asking, setAsking] = useState(false)
  const [picked, setPicked] = useState<ChangeListRow | null>(null)
  // Finish your review, open — from the start where the address asks; closed, the address no longer does.
  const [params, setParams] = useSearchParams()
  const [finishing, setFinishing] = useState(() => params.get('finish') === '1')
  const onFinishing = (open: boolean) => {
    setFinishing(open)
    if (!open && params.has('finish')) setParams((prev) => { const next = new URLSearchParams(prev); next.delete('finish'); return next }, { replace: true })
  }
  const paneRef = useRef<HTMLDivElement>(null)

  // A thread on the review as a whole opens the Discussion.
  const [tab, setTab] = useState<SideTab>('discussion')
  const [tabFor, setTabFor] = useState<string | null>(null)
  if (selection.threadOnReview && selection.threadId !== tabFor) {
    setTabFor(selection.threadId)
    setTab('discussion')
  }

  const listedRow = selected ? order.byId.get(selected) ?? (picked?.entityId === selected ? picked : null) : null
  const entryQ = useChangeEntry(wsId, source?.graphId, source?.origin, selected && !listedRow ? selected : null)
  const row = listedRow ?? (selected ? entryRow(entryQ.data) : null)

  const ready = pr ? readiness(pr, {
    me: user?.id ?? null, canManage: actions.canManage, canFinish: actions.canFinish, canMerge: actions.canMerge,
    mergeBlockedWhy: actions.mergeBlockedWhy, forksOff: actions.forksOff, forkBehind: actions.forkBehind,
    canUpdateFromParent: actions.forksOn && actions.canPublish, needsPull: actions.needsPull, pullReason: actions.pullReason,
    unsaved: actions.unsaved, decisions: deciding ? decisions : null, mergeInPart: actions.mergeInPart,
    canDecide: !!viewerCan?.decide, canApproveAll: actions.canApproveAll, listable, viewed: viewedCount, total, openThreads,
  }) : { items: [], primary: null }

  // Moving between changes.
  const go = (r: ChangeListRow | null) => { if (!r) return; setAsking(false); selection.select(r.entityId) }
  const step = (dir: 1 | -1) => go(order.step(selected, dir))
  const undecided = (r: ChangeListRow) => { const d = (r as ReviewChangeRow).decision; return !d || d.stale }
  // What still needs the reader: deciding, what is undecided; else, what they haven't viewed.
  const needsYou = (r: ChangeListRow) => (canDecide ? undecided(r) : !viewed.isViewed(r))
  const threadStep = (dir: 1 | -1) => {
    const hit = order.seek(selected, dir, (r) => (threadCounts?.entities[r.entityId]?.open ?? 0) > 0)
    if (hit) return go(hit)
    // A thread on a change not read into the list yet.
    const other = Object.entries(threadCounts?.entities ?? {}).find(([id, c]) => c.open > 0 && id !== selected)?.[0]
    if (other) selection.select(other)
  }

  const act = (kind: ActionKind) => {
    switch (kind) {
      case 'next_unviewed': return go(order.seek(selected, 1, (r) => !viewed.isViewed(r)))
      case 'next_undecided': return go(order.seek(selected, 1, undecided))
      case 'next_thread': return threadStep(1)
      case 'finish': return setFinishing(true)
      case 'approve_all': return void actions.approveAll(false)
      case 'approve_all_merge': return void actions.approveAll(true)
      case 'merge': return void actions.runMerge()
      case 'merge_accepted': return void actions.runMerge(undefined, 'accepted')
      case 'resolve_conflicts': return void actions.runMerge(undefined, actions.mergeInPart ? 'accepted' : 'all')
      case 'pull': return actions.runPull()
      case 'discard_rejected': return actions.discardRejected()
      case 'accept_missing': return actions.acceptMissing()
      case 'update_from_parent': return // its own button does it
    }
  }

  useReviewKeys({
    next: () => step(1),
    prev: () => step(-1),
    nextNeeding: () => go(order.seek(selected, 1, needsYou)),
    prevNeeding: () => go(order.seek(selected, -1, needsYou)),
    nextThread: () => threadStep(1),
    prevThread: () => threadStep(-1),
    viewed: () => {
      if (!listedRow || !viewed.enabled) return
      const was = viewed.isViewed(listedRow)
      viewed.toggle(listedRow)
      if (!was) step(1)
    },
    accept: canDecide && selected ? () => void flow.run('accepted', { entityIds: [selected] }) : undefined,
    reject: canDecide && listedRow ? () => setAsking(true) : undefined,
    comment: () => paneRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus(),
    primary: () => { if (ready.primary && !ready.primary.disabled && !actions.busy) act(ready.primary.kind) },
    help: () => document.getElementById(KEYS_ID)?.focus(),
  })

  if (prQ.isError) {
    const missing = (prQ.error as { status?: number } | null)?.status === 404
    return (
      <div className="absolute inset-0 overflow-y-auto bg-canvas flex flex-col items-center pt-16">
        <EmptyState icon={SearchX}
          title={missing ? 'This review isn’t here' : 'Couldn’t open this review'}
          description={missing ? 'It may have been removed, or the link is mistyped.' : 'Try again in a moment.'} />
        <Link to={inbox} className="inline-flex items-center gap-1.5 text-sm font-semibold text-accent-lineage hover:underline">
          <ArrowLeft className="w-4 h-4" aria-hidden /> Back to reviews
        </Link>
      </div>
    )
  }
  if (!pr) {
    return (
      <div className="absolute inset-0 bg-canvas p-6 space-y-4" aria-busy>
        <Skeleton className="h-8 w-1/3" />
        <SkeletonText lines={6} />
      </div>
    )
  }

  const navigator = (
    <ReviewNavigator wsId={wsId} prId={prId} actions={actions} source={source} selected={selected}
      onPick={(r) => { setPicked(r); go(r) }} viewed={viewedCount} total={total} openThreads={openThreads} />
  )
  const shortcuts = <ShortcutsHint id={KEYS_ID} shortcuts={reviewShortcuts({ canDecide })} />

  return (
    <div className="absolute inset-0 flex flex-col bg-canvas">
      <ReviewHeader wsId={wsId} actions={actions} shortcuts={shortcuts}
        primaryAction={<ReviewPrimaryAction wsId={wsId} actions={actions} primary={ready.primary} approveAll={ready.approveAll} onAct={act}
          finish={{ open: finishing, onOpenChange: onFinishing, viewed: viewedCount, total, openThreads }} />} />

      <div className="flex-1 min-h-0 grid grid-cols-1 overflow-y-auto lg:overflow-hidden lg:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[320px_minmax(0,1fr)_360px]">
        {wide && (
          <aside aria-label="Changes" className="min-h-0 overflow-y-auto border-r border-glass-border/60 p-4">
            {navigator}
          </aside>
        )}
        <div className="lg:min-h-0 lg:overflow-y-auto xl:contents">
          <main aria-label="The change open" className="xl:min-h-0 xl:overflow-y-auto">
            {!wide && (
              <Disclosure className="px-4 pt-4" buttonClassName="py-1 text-[13px] font-semibold text-ink"
                summary={`Changes (${total.toLocaleString()})`}>
                <div className="pt-3">{navigator}</div>
              </Disclosure>
            )}
            <ReviewChangePane ref={paneRef} actions={actions} wsId={wsId} prId={prId} source={source} row={row}
              listed={!!listedRow} onStep={step} viewed={viewed} flow={flow} asking={asking} onAsk={setAsking}
              deciding={decidingHere} focusThreadId={selection.threadChange && selection.threadChange === selected ? selection.threadId : null} />
          </main>
          <aside aria-label="Where it stands" className="xl:min-h-0 xl:overflow-y-auto border-t xl:border-t-0 xl:border-l border-glass-border/60">
            <ReviewSide wsId={wsId} prId={prId} actions={actions} items={ready.items} onAct={act}
              tab={tab} onTab={setTab} focusThreadId={selection.threadOnReview ? selection.threadId : null}
              custom={{
                update_from_parent: actions.forksOn && actions.canPublish
                  ? <UpdateFromParentButton wsId={wsId} forkGraphId={pr.graphId} onUpdated={actions.clearForkBehind} /> : null,
              }} />
          </aside>
        </div>
      </div>

      {actions.conflicts && (
        <ConflictResolver
          conflicts={actions.conflicts}
          seeds={actions.seeds}
          seedError={actions.seedError}
          busy={actions.pending.merge || actions.pending.pull}
          error={actions.resolverError}
          onCancel={actions.cancelConflicts}
          onResolve={actions.resolveConflicts}
        />
      )}
      {actions.incoming && (
        <IncomingChangesSheet wsId={wsId} graphId={pr.graphId} incoming={actions.incoming}
          userNames={pr.userNames} onClose={actions.closeIncoming} />
      )}
    </div>
  )
}
