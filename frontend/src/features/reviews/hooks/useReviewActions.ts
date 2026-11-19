/**
 * useReviewActions — one review, read and acted on: what the reader may do with it, and doing it.
 * The review drawer and the review page both use it, so a review behaves the same wherever it is
 * open.
 *
 * Merge is conflict-aware: a conflict opens the resolver (`conflicts`), whose resolutions feed
 * straight back into a re-merge — or, after a pull, a re-pull. Merging what is accepted
 * (`mode: 'accepted'`) lands only that, and can discard what was rejected in the same step. A pull
 * shows what it brought in (`incoming`). Merged, a draft's review lands on main, with its receipt,
 * back on the view it came from; a fork's review stays where it is, and reads as merged.
 *
 * A review given (Finish your review: Comment, Approve or Request changes, with a summary), Approve
 * all and decisions are of what the reviewer saw: each sends the head the review was read at, and
 * the changes are read again when a poll brings a new head.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import {
  ForkNotUpToDateError, HeadMovedError, MergeConflictError, NotUpToDateError, ReviewDecisionError, type PullReason,
  type IncomingChanges, type ResolutionMap, getChangeEntry, type ChangeListOrigin, type ReviewVerdict,
} from '@/services/versioningApiService'
import {
  useMergeRequest, usePullLatestDraft,
  useApproveMergeRequest, useCloseMergeRequest, useMergeMergeRequest, useUpdateMergeRequest,
  useSubmitReview, useWithdrawChangesRequest, useDiscardRejected,
  useChangeSummary, usePrDiffSummary, VERSIONING_KEYS,
} from '@/features/versioning/hooks/useVersioning'
import { fromChangeCounts } from '@/features/versioning/model/changeAdapters'
import { ownerName } from '@/features/versioning/model/branchVocab'
import { isTerminalPr } from '@/features/versioning/model/prStatus'
import { refusalCopy } from '@/features/versioning/model/provenance'
import { mapWithConcurrency } from '@/lib/concurrency'
import { usePermission, useAuthStore } from '@/store/auth'
import { useFeature } from '@/store/features'
import { useBranchStore } from '@/store/branchStore'
import { usePublishReceiptStore } from '@/store/publishReceiptStore'
import { useUnsavedCountOnBranch } from '@/store/stagedChangesStore'
import { useAppNotifications } from '@/components/ui/notifications'
import { isDeleteModify, normalizeConflict } from '../conflictResolution'
import { derivePrTitle, isDraftMr } from '../components/PrMeta'
import type { DiscussionAccess } from '../comments/ReviewThreads'
import { DECISION_KEYS, useDecideChanges, useReviewDecisionSummary } from '../decisions/useReviewDecisions'

/** Why the reader may not merge a review, by the server's reason code (`viewerCan.mergeReason`). */
export const MERGE_REFUSALS: Record<string, string> = {
  publish_required: 'Merging into main needs the publish permission on this workspace',
  manage_required: 'Merging needs edit access to this data source',
  self_merge: 'This data source has someone other than whoever opened a review merge it',
}

/** Why the reader may not take part in the discussion (`viewerCan.commentReason`). */
const COMMENT_REFUSALS: Record<string, string> = {
  person_required: 'A key can’t take part in a review’s discussion — sign in as a person to comment.',
}

/** @param onClose what follows a review that is done with here: dismissed, or a draft's merged. */
export function useReviewActions(wsId: string, prId: string, onClose: () => void) {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { notify } = useAppNotifications()
  const canManage = usePermission('workspace:datasource:manage', wsId)
  // Merging, and reverting a merge, advance main: that needs publish as well.
  const canPublish = usePermission('workspace:datasource:publish', wsId)
  const user = useAuthStore((s) => s.user)
  const switchToMain = useBranchStore((s) => s.switchToMain)
  const setReceipt = usePublishReceiptStore((s) => s.setReceipt)

  const prQ = useMergeRequest(wsId, prId)
  const approveM = useApproveMergeRequest(wsId)
  const closePr = useCloseMergeRequest(wsId)
  const merge = useMergeMergeRequest(wsId)
  const update = useUpdateMergeRequest(wsId)
  const submitM = useSubmitReview(wsId)
  const withdrawM = useWithdrawChangesRequest(wsId)
  const discardRejectedM = useDiscardRejected(wsId)
  /** Merging what is accepted also discards what was rejected from the draft. */
  const [discardOnMerge, setDiscardOnMerge] = useState(false)
  const pullLatest = usePullLatestDraft(wsId, prQ.data?.graphId ?? '')

  const pr = prQ.data
  // What the review changes, read from the change index a page at a time — never the whole diff on
  // open, which for a 100,000-change review is tens of megabytes. A draft's review: its own change
  // list (once merged, main across its merge). A fork's: its summary (counted, and listed from the
  // window it names, once past the tree's cap).
  const draftReview = !!pr && isDraftMr(pr)
  const listOrigin: ChangeListOrigin | null = !pr || !draftReview ? null
    : pr.status === 'merged' && pr.resultingCommitSeq
      ? { fromSeq: pr.resultingCommitSeq - 1, toSeq: pr.resultingCommitSeq }
      : { branchId: pr.sourceBranchId }
  const draftSummaryQ = useChangeSummary(wsId, draftReview ? pr!.graphId : null, listOrigin)
  const forkSummaryQ = usePrDiffSummary(wsId, pr && !draftReview ? prId : null, 1000)
  const changeCounts = draftReview ? draftSummaryQ.data?.counts : forkSummaryQ.data?.counts
  const changeSet = useMemo(() => (changeCounts ? fromChangeCounts(changeCounts) : null), [changeCounts])
  const changesFetching = draftSummaryQ.isFetching || forkSummaryQ.isFetching
  // Approve sends the head the PR was read at, so the changes on screen must be of that head: when a
  // poll brings a new one, read them again (Approve waits for it).
  const queryClient = useQueryClient()
  const diffHead = useRef(pr?.headCommitId)
  useEffect(() => {
    if (pr?.headCommitId === diffHead.current) return
    if (diffHead.current !== undefined) {
      if (pr && listOrigin) void queryClient.invalidateQueries({ queryKey: VERSIONING_KEYS.changeList(wsId, pr.graphId, listOrigin) })
      void queryClient.invalidateQueries({ queryKey: VERSIONING_KEYS.prDiffSummary(wsId, prId) })
    }
    diffHead.current = pr?.headCommitId
  }, [pr?.headCommitId]) // eslint-disable-line react-hooks/exhaustive-deps
  // Edits still staged on the canvas for this draft are not part of it: a merge would leave them behind.
  const unsaved = useUnsavedCountOnBranch(pr?.sourceBranchId)

  const [conflicts, setConflicts] = useState<Array<Record<string, unknown>> | null>(null)
  // What each conflict resolution starts from — the conflicting entity's own value on the draft.
  // It comes with the conflicts (a merge's 409, a pull's answer); any it left out is read on its
  // own, a few at a time — never the review's whole diff (tens of megabytes at 100,000 changes).
  const [givenSeeds, setGivenSeeds] = useState<Record<string, Record<string, unknown> | undefined>>({})
  const missingSeeds = useMemo(() => {
    if (!conflicts) return []
    const out = new Set<string>()
    for (const c of conflicts.map((x) => normalizeConflict(x))) {
      if (c.entity_id && !isDeleteModify(c) && !givenSeeds[c.entity_id]) out.add(c.entity_id)
    }
    return [...out]
  }, [conflicts, givenSeeds])
  const [readSeeds, setReadSeeds] = useState<{ key: string; seeds: Record<string, Record<string, unknown> | undefined>; failed: boolean }>(
    { key: '', seeds: {}, failed: false })
  const missingKey = missingSeeds.join('\n')
  useEffect(() => {
    if (!pr || !listOrigin || missingSeeds.length === 0) return
    let gone = false
    void mapWithConcurrency(missingSeeds, 6, (id) => getChangeEntry(wsId, pr.graphId, listOrigin, id)).then((results) => {
      if (gone) return
      const out: Record<string, Record<string, unknown> | undefined> = {}
      let failed = false
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') out[missingSeeds[i]] = (r.value.after ?? undefined) as Record<string, unknown> | undefined
        else failed = true
      })
      setReadSeeds({ key: missingKey, seeds: out, failed })
    })
    return () => { gone = true }
  }, [missingKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const seeds = useMemo(
    () => (readSeeds.key === missingKey ? { ...readSeeds.seeds, ...givenSeeds } : givenSeeds),
    [readSeeds, missingKey, givenSeeds],
  )
  const seedError = readSeeds.key === missingKey && readSeeds.failed
    ? 'Couldn’t read every conflicting entity — close this and merge again.' : null
  const [resolverError, setResolverError] = useState<string | null>(null)
  const [needsPull, setNeedsPull] = useState(false)
  // Why it must pull, once a merge was refused for it (the list's `pullRequired` says only whether).
  const [pullReason, setPullReason] = useState<PullReason | null>(null)
  const [resolveMode, setResolveMode] = useState<'merge' | 'pull'>('merge')
  /** What a pull brought in — reviewed, not just asserted. */
  const [incoming, setIncoming] = useState<IncomingChanges | null>(null)
  // A fork's review merges into its parent, the review's target graph (a draft's, into its own).
  const forkReview = !!pr && !isDraftMr(pr)
  const forksOn = useFeature('forksEnabled')
  const forksOff = forkReview && !forksOn
  // Merged by a job: nothing changes it until the job lands it or hands it back.
  const merging = pr?.status === 'merging'
  /** A fork behind its parent, as its merge said: how far (it merges only up to date). */
  const [forkBehind, setForkBehind] = useState<number | null>(null)

  const terminal = isTerminalPr(pr?.status)
  // Who may approve and merge is the server's word (`viewerCan`): whoever opened a review approves
  // or merges it where its data source's policy lets them. Without it, its author and its draft's
  // owner are not offered Approve.
  const viewerCan = pr?.viewerCan
  const isAuthor = !!user && pr?.actor === user.id
  const isOwner = !!user && pr?.sourceBranchOwner === user.id
  const alreadyApproved = !!user && (pr?.approvedBy ?? []).includes(user.id)
  // Approve is asked of the requested reviewers — themselves, or through a group of theirs (the
  // server's `review.you`). An approval gone stale is not in approvedBy, so its reviewer is offered
  // Approve again.
  const isRequested = !!user && ((pr?.reviewers ?? []).includes(user.id) || !!pr?.review?.you?.requested)
  const showApprove = canManage && !terminal && !alreadyApproved && isRequested && !forksOff
    && (viewerCan ? viewerCan.approve : !isAuthor && !isOwner)
  const canMerge = viewerCan ? viewerCan.merge : canPublish
  const mergeBlockedWhy = MERGE_REFUSALS[viewerCan?.mergeReason ?? (canPublish ? '' : 'publish_required')]
  // Whoever sees a review discusses it (a person, not a key); a manager may remove what others wrote.
  const discussion: DiscussionAccess = {
    canComment: viewerCan?.comment ?? true,
    commentReason: viewerCan?.commentReason ? (COMMENT_REFUSALS[viewerCan.commentReason] ?? null) : null,
    canModerate: viewerCan?.moderate ?? canManage,
  }
  // A draft's review, decided change by change: Merge accepted lands what is accepted and leaves
  // the rest on the draft; with anything rejected, it is the only merge there is.
  const deciding = draftReview && !terminal && !merging
  const decisions = useReviewDecisionSummary(wsId, prId, deciding).data
  const acceptMissingM = useDecideChanges(wsId, prId)
  const accepted = decisions?.accepted ?? 0
  const rejected = decisions?.rejected ?? 0
  const mergeInPart = deciding && !!decisions && (rejected > 0 || (accepted > 0 && accepted < decisions.total))
  // Sent back for changes, while that holds: it merges once the draft changes (or it is withdrawn).
  const sentBack = draftReview && !terminal ? pr?.changesRequested ?? null : null
  const canSendBack = draftReview && !terminal && !merging && !sentBack && !!viewerCan?.decide
  // Finish your review: whoever is asked and may approve it, or may send it back, gives their verdict
  // — which verdicts they may give is `viewerCan`'s word.
  const canFinish = !forksOff && !merging && (showApprove || canSendBack)
  // Approve all: every change still to decide accepted, the review approved and — asked for —
  // merged, in one go. For a reviewer who decides a draft's review with nothing rejected: it never
  // overrides a rejection (that review merges what is accepted).
  const decideAllM = useDecideChanges(wsId, prId)
  const toDecide = decisions ? decisions.undecided + decisions.stale : 0
  const canApproveAll = deciding && !!decisions && !!viewerCan?.decide && showApprove && rejected === 0 && !sentBack
  const busy = approveM.isPending || closePr.isPending || merge.isPending || pullLatest.isPending
    || submitM.isPending || withdrawM.isPending || discardRejectedM.isPending || decideAllM.isPending

  // Proactive gate: the server flags a draft MR that lags main head. Mirror it into needsPull so the
  // banner + Pull-latest show up front (the 409 catch in runMerge is the backstop). A clean pull
  // clears it and invalidates this PR, so pr.behind flips false and keeps it cleared.
  // Only people's commits make a pull a must (pullRequired); automation alone is merged past.
  const mustPull = pr?.pullRequired ?? pr?.behind
  useEffect(() => { setNeedsPull(!terminal && !!mustPull) }, [mustPull, terminal])

  const runMerge = async (resolutions?: ResolutionMap, mode: 'all' | 'accepted' = 'all') => {
    if (!pr || unsaved > 0) return
    try {
      const discard = mode === 'accepted' && discardOnMerge && rejected > 0
      const res = await merge.mutateAsync({
        prId, graphId: pr.targetGraphId, message: `Merge: ${derivePrTitle(pr)}`, resolutions, mode,
        discardRejected: discard,
      })
      if (mode === 'accepted' && accepted < (decisions?.total ?? 0)) {
        // Merged in part: the draft stays open with the rest, and this review reads as merged.
        notify('success', `Merged ${accepted.toLocaleString()} accepted change${accepted === 1 ? '' : 's'} into main. `
          + (discard ? 'The rejected ones left the draft; anything undecided stays on it.' : 'The rest stay on the draft.'))
        void prQ.refetch()
        return
      }
      setConflicts(null)
      setResolverError(null)
      setForkBehind(null)
      // The receipt is the confirmation, and it survives the navigation below — a notification would not.
      // It is the graph's the merge landed in: a fork's parent, for a fork's review.
      setReceipt({
        commitId: res.commitId, outcome: res.outcome, graphId: pr.targetGraphId,
        counts: changeSet?.counts ?? { added: 0, modified: 0, removed: 0 }, via: 'review',
      })
      // A fork's review has no view to go back to, and its fork lives on: it stays, and reads as
      // merged once the review is read again.
      if (forkReview) return
      // Land on the freshly-merged main; read-your-writes serves main even before the projection
      // catches up. The source branch is now `merged`, so useActiveBranchGuard would evict anyone
      // sitting on it anyway — this just gets there first for the person who pressed the button.
      switchToMain()
      onClose()
      // Merging from the workspace Reviews inbox used to be a dead end: the branch store was mutated
      // with no canvas mounted and no way back to the work. Return to the view the draft came from,
      // where the receipt banner is waiting.
      if (pr.originatingViewId && !pathname.startsWith(`/views/${pr.originatingViewId}`)) {
        navigate(`/views/${pr.originatingViewId}`)
      }
    } catch (e) {
      // A fork's merge that ran as a job hands the review back when it is refused: read it again.
      if (forkReview) void prQ.refetch()
      if (e instanceof ForkNotUpToDateError) {
        setForkBehind(e.behind ?? 0)
        return
      }
      if (e instanceof NotUpToDateError) {
        setNeedsPull(true)
        setPullReason(e.reason ?? 'people')
        notify('error', refusalCopy(e.reason))
        return
      }
      if (e instanceof ReviewDecisionError) {
        // Decisions moved under the merge (an edit made one stale, say): read them again.
        void queryClient.invalidateQueries({ queryKey: DECISION_KEYS.all(wsId, prId) })
        notify('error', e.message)
        return
      }
      if (e instanceof MergeConflictError) {
        setGivenSeeds(e.seeds)
        setConflicts(e.conflicts)
        setResolverError(resolutions ? 'Some fields still conflict — adjust and retry.' : null)
        return
      }
      // The server says what holds it (approvals under the review's rule, open threads, a request
      // for changes); an older one only named the refusal.
      const msg = (e as Error).message
      const friendly = msg === 'approval_required' || /^\{.*approval_required/.test(msg)
        ? 'This PR needs approval from its reviewers before it can be merged.'
        : msg
      if (resolutions) setResolverError(friendly)
      else notify('error', friendly)
    }
  }

  const runPull = (resolutions?: ResolutionMap) => {
    if (!pr) return
    pullLatest.mutate(
      { branchId: pr.sourceBranchId, resolutions },
      {
        onSuccess: (res) => {
          if (!res.clean) {
            setResolveMode('pull')
            setGivenSeeds(Object.fromEntries(Object.entries(res.seeds ?? {}).map(([k, v]) => [k, v ?? undefined])))
            setConflicts(res.conflicts)
            setResolverError(resolutions ? 'Some fields still conflict — adjust and retry.' : null)
            return
          }
          setConflicts(null); setResolverError(null); setResolveMode('merge'); setNeedsPull(false)
          // A reviewer pulling before merge is taking in work that changes what THIS PR will land —
          // so show it. Merging blind was the thing that made "someone beat me to it" opaque.
          if (res.incoming && res.incoming.commitCount > 0) {
            setIncoming(res.incoming)
          } else {
            notify('info', 'Already up to date — you can merge now.')
          }
        },
        onError: (e) => notify('error', (e as Error).message),
      },
    )
  }

  /** The conflicts put aside: nothing merges or pulls. */
  const cancelConflicts = () => { setConflicts(null); setGivenSeeds({}); setResolverError(null); setResolveMode('merge') }
  const resolveConflicts = (resolutions: ResolutionMap) => (resolveMode === 'pull' ? runPull(resolutions) : runMerge(resolutions))

  /** Give your review — a verdict and its summary — of the head the review was read at; `onDone`
   *  once it is in. The draft moved on since: it is read again, nothing is recorded, and `onMoved`. */
  const submitReview = (verdict: ReviewVerdict, body: string, handlers: { onDone?: () => void; onMoved?: () => void } = {}) => {
    if (!pr) return
    submitM.mutate({ prId, graphId: pr.graphId, verdict, body: body.trim() || null, expectedHeadCommitId: pr.headCommitId }, {
      onSuccess: () => {
        notify('success', verdict === 'approve' ? 'Approved.'
          : verdict === 'request_changes' ? `Sent back to ${ownerName(pr.actor, pr.userNames)}. They’ve been told.`
            : `Your review is in. ${ownerName(pr.actor, pr.userNames)} has been told.`)
        handlers.onDone?.()
      },
      onError: (e) => {
        if (e instanceof HeadMovedError) {
          void prQ.refetch()
          if (listOrigin) void queryClient.invalidateQueries({ queryKey: VERSIONING_KEYS.changeList(wsId, pr.graphId, listOrigin) })
          void queryClient.invalidateQueries({ queryKey: VERSIONING_KEYS.prDiffSummary(wsId, prId) })
          if (handlers.onMoved) return handlers.onMoved()
        }
        notify('error', (e as Error).message)
      },
    })
  }

  /** Accept every change still to decide, approve, and (``andMerge``) merge — asked first. A step
   *  the server refuses stops there, saying why; what was done before it stands. */
  const approveAll = async (andMerge: boolean) => {
    if (!pr || !decisions || !canApproveAll) return
    const n = decisions.total
    const all = `${n.toLocaleString()} change${n === 1 ? '' : 's'}`
    const ask = toDecide > 0
      ? `Accept ${toDecide === n ? `all ${all}` : `the ${toDecide.toLocaleString()} of ${all} still to decide`}, approve${andMerge ? ', and merge into main' : ''}?`
      : `Approve${andMerge ? ' and merge into main' : ''}? All ${all} are accepted.`
    if (!window.confirm(ask)) return
    try {
      if (toDecide > 0) {
        await decideAllM.mutateAsync({ verdict: 'accepted', filter: { decision: 'undecided' }, expectedHeadCommitId: pr.headCommitId })
      }
      await approveM.mutateAsync({ prId, graphId: pr.graphId, expectedHeadCommitId: pr.headCommitId })
    } catch (e) {
      if (e instanceof HeadMovedError) {
        void prQ.refetch()
        if (listOrigin) void queryClient.invalidateQueries({ queryKey: VERSIONING_KEYS.changeList(wsId, pr.graphId, listOrigin) })
      }
      notify('error', (e as Error).message)
      return
    }
    if (andMerge) await runMerge()
    else notify('success', toDecide > 0 ? `Accepted ${toDecide.toLocaleString()} change${toDecide === 1 ? '' : 's'} and approved.` : 'Approved.')
  }

  const withdraw = () => {
    if (!pr) return
    withdrawM.mutate({ prId, graphId: pr.graphId }, {
      onSuccess: () => notify('success', 'Withdrawn: the review can merge again.'),
      onError: (e) => notify('error', (e as Error).message),
    })
  }

  /** The author takes the review's answer: what was rejected leaves the draft (asked first). */
  const discardRejected = () => {
    if (!pr) return
    if (!window.confirm(`Discard the ${rejected.toLocaleString()} rejected change${rejected === 1 ? '' : 's'} from the draft, and what holds them together? It is one new revision of the draft — change them again to bring them back.`)) return
    discardRejectedM.mutate({ prId, graphId: pr.graphId, branchId: pr.sourceBranchId }, {
      onSuccess: (out) => notify('success', `Discarded ${out.restored.toLocaleString()} change${out.restored === 1 ? '' : 's'} from the draft. The review is back in your reviewers’ hands.`),
      onError: (e) => notify('error', (e as Error).message),
    })
  }

  /** Close it without merging; `onFailed` when the server refused. */
  const dismiss = (onFailed?: () => void) => {
    if (!pr) return
    closePr.mutate({ prId, graphId: pr.graphId }, {
      onSuccess: () => { notify('success', 'Request dismissed — no changes applied.'); onClose() },
      onError: (e) => { notify('error', (e as Error).message); onFailed?.() },
    })
  }

  /** Accept the changes what is accepted needs, so Merge accepted can go ahead. */
  const acceptMissing = () => {
    if (!pr || !decisions) return
    acceptMissingM.mutate({ verdict: 'accepted', entityIds: decisions.missingIds, force: true, expectedHeadCommitId: pr.headCommitId },
      { onError: (e) => notify('error', (e as Error).message) })
  }

  /** Its title and description, edited in place (managers). */
  const saveDetails = (fields: { title: string; description: string }, onSaved?: () => void) => {
    if (!pr) return
    update.mutate(
      { prId, graphId: pr.graphId, title: fields.title, description: fields.description },
      {
        onSuccess: () => { onSaved?.(); notify('success', 'Updated.') },
        onError: (e) => notify('error', (e as Error).message),
      },
    )
  }

  return {
    prQ, pr, user, canManage, canPublish,
    draftReview, forkReview, listOrigin, draftSummaryQ, forkSummaryQ, changeSet, changesFetching, unsaved,
    terminal, merging, forksOn, forksOff, viewerCan, isAuthor, isOwner, showApprove, canMerge, mergeBlockedWhy,
    discussion, deciding, decisions, accepted, rejected, mergeInPart, sentBack, canFinish, busy,
    needsPull, pullReason, forkBehind, clearForkBehind: () => setForkBehind(null),
    discardOnMerge, setDiscardOnMerge,
    conflicts, seeds, seedError, resolverError, cancelConflicts, resolveConflicts,
    incoming, closeIncoming: () => setIncoming(null),
    canApproveAll, toDecide, approveAll,
    runMerge, runPull, submitReview, withdraw, discardRejected, dismiss, acceptMissing, saveDetails,
    pending: {
      merge: merge.isPending, pull: pullLatest.isPending, dismiss: closePr.isPending, submit: submitM.isPending,
      withdraw: withdrawM.isPending, discard: discardRejectedM.isPending, acceptMissing: acceptMissingM.isPending,
      approveAll: decideAllM.isPending || approveM.isPending,
      update: update.isPending,
    },
  }
}

export type ReviewActions = ReturnType<typeof useReviewActions>
