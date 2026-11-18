/**
 * readiness — what a review still needs, and the one thing to do next. Nothing here is new policy:
 * it says again, item by item, what the review and the reader's place in it already decide
 * (`useReviewActions` — who may approve, merge, pull, send back).
 *
 * A reviewer is asked to look through the changes, decide each one (a draft's review, open, small
 * enough to list), resolve open threads and give their verdict. Anyone sees what holds the merge:
 * approvals, changes asked for, being behind, conflicts, unsaved edits on the draft, what was
 * rejected, open threads that hold it, and whether they may merge at all.
 *
 * The primary action is the first item not yet done that has something to do about it — never a
 * step to another change — else Merge (Merge N accepted, merging in part), off with why where the
 * review says so. A reviewer who decides a draft's review with nothing rejected is offered Approve
 * all: every change still to decide accepted and the review approved in one go — and merged, when
 * they may merge and nothing but their approval holds it (Approve all & merge). Where the review carries the server's count (`pr.review`), that is what is read;
 * else the fields it had before.
 */
import type { PullReason, PullRequest, ReviewDecisionSummary, ReviewerState } from '@/services/versioningApiService'
import { ownerName } from '@/features/versioning/model/branchVocab'
import { isTerminalPr } from '@/features/versioning/model/prStatus'
import { isDraftMr } from '../components/PrMeta'

/** Where to go next: offered beside an item, never the primary action. */
export type StepKind = 'next_unviewed' | 'next_undecided' | 'next_thread'
export type ReviewActionKind =
  | 'approve' | 'approve_all' | 'approve_all_merge' | 'merge' | 'merge_accepted' | 'pull' | 'resolve_conflicts'
  | 'update_from_parent' | 'discard_rejected' | 'accept_missing'
export type ActionKind = ReviewActionKind | StepKind

export interface ReadinessItem {
  key: string
  ok: boolean
  title: string
  detail?: string
  action?: { label: string; kind: ActionKind }
}

export interface PrimaryAction {
  kind: ReviewActionKind
  label: string
  /** Not yet, and why. */
  disabled?: boolean
  why?: string
}

export interface Readiness {
  items: ReadinessItem[]
  primary: PrimaryAction | null
}

/** What the review page knows beside the review: the reader, and what `useReviewActions` decided. */
export interface ReadinessContext {
  me: string | null
  /** Manages its data source: without it, nothing on a review is theirs to do. */
  canManage: boolean
  showApprove: boolean
  canMerge: boolean
  mergeBlockedWhy?: string | null
  forksOff: boolean
  /** A fork behind its parent, as its merge said; and whether the reader can update it. */
  forkBehind: number | null
  canUpdateFromParent: boolean
  needsPull: boolean
  pullReason?: PullReason | null
  unsaved: number
  /** A draft's review, open: where its decisions stand. */
  decisions?: ReviewDecisionSummary | null
  mergeInPart: boolean
  /** The reader decides change by change (`viewerCan.decide`). */
  canDecide: boolean
  /** The reader may accept every change still to decide and approve in one go (nothing rejected). */
  canApproveAll?: boolean
  /** Its changes are listed one by one here (not a fork's review, not too large to list). */
  listable: boolean
  /** Changes the reader ticked viewed, of how many. */
  viewed: number
  total: number
  openThreads: number
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`

/** " by 3 changes people made" — what holds a draft's review back from main; people's changes
 *  are what make it pull, so they are what it counts when the server says. */
export function behindText(pr: { behindBy?: number | null; behindByPeople?: number | null }): string {
  const people = pr.behindByPeople ?? 0
  if (people > 0) return ` by ${people} change${people === 1 ? '' : 's'} people made`
  const n = pr.behindBy ?? 0
  return n > 0 ? ` by ${n} commit${n === 1 ? '' : 's'}` : ''
}

/** A reviewer (a person or a group), by name. */
export function reviewerName(pr: PullRequest, r: Pick<ReviewerState, 'type' | 'id'>): string {
  return r.type === 'group' ? pr.groupNames?.[r.id] ?? r.id : ownerName(r.id, pr.userNames)
}

/** Each reviewer asked, and where they stand. */
export function reviewerStates(pr: PullRequest): ReviewerState[] {
  if (pr.review) return pr.review.reviewers
  const approved = pr.approvedBy ?? []
  const stale = pr.staleApprovedBy ?? []
  return (pr.reviewers ?? []).map((id) => ({
    type: 'user', id, requestedAt: pr.createdAt,
    state: approved.includes(id) ? 'approved'
      : stale.includes(id) ? 'approved_earlier'
        : pr.changesRequested?.by === id ? 'changes_requested' : 'waiting',
  }))
}

/** How many approvals it has of how many it needs, and who it waits on. */
export function approvalProgress(pr: PullRequest): { have: number; required: number; satisfied: boolean; waiting: ReviewerState[] } {
  const waiting = reviewerStates(pr).filter((r) => r.state !== 'approved')
  if (pr.review) return { ...pr.review.approvals, waiting }
  const required = pr.reviewers?.length ?? 0
  return { have: pr.approvedBy?.length ?? 0, required, satisfied: required > 0 && pr.approvalStatus === 'approved', waiting }
}

/** Changes asked for, each with whether it still holds. */
export function changeRequests(pr: PullRequest): Array<{ by: string; at: string; reason?: string | null; holds: boolean }> {
  if (pr.review) return pr.review.changeRequests
  return pr.changesRequested ? [{ ...pr.changesRequested, holds: true }] : []
}

/** "Bob", "Bob and Cy", "Bob, Cy and 2 more". */
function names(list: string[]): string {
  if (list.length <= 2) return list.join(' and ')
  return `${list.slice(0, 2).join(', ')} and ${list.length - 2} more`
}

const STEPS = new Set<ActionKind>(['next_unviewed', 'next_undecided', 'next_thread'])

/** Whether the reader's approval is all that holds the merge, and they may merge: then approving
 *  all merges it too (Approve all & merge). Their approval counts toward the rule; nobody else's
 *  is awaited; nothing else holds it — changes asked for, being behind, conflicts, unsaved edits,
 *  open threads where they hold it. */
export function mergeFollowsApproval(pr: PullRequest, ctx: Pick<ReadinessContext,
  'me' | 'canMerge' | 'needsPull' | 'unsaved' | 'openThreads'>): boolean {
  if (!ctx.canMerge || ctx.needsPull || ctx.unsaved > 0 || pr.status === 'conflicts') return false
  if (changeRequests(pr).some((a) => a.holds)) return false
  if (pr.review?.threads.holdMerge && ctx.openThreads > 0) return false
  const progress = approvalProgress(pr)
  if (pr.review && pr.review.requiredApprovals > 0) return progress.have + 1 >= progress.required
  return !progress.waiting.some((r) => !(r.type === 'user' && r.id === ctx.me))
}

export function readiness(pr: PullRequest, ctx: ReadinessContext): Readiness {
  if (isTerminalPr(pr.status)) return { items: [], primary: null }
  if (pr.status === 'merging') {
    return {
      items: [{ key: 'merging', ok: false, title: 'Merging in the background',
        detail: 'A review this large merges as a job. Nothing can change it meanwhile.' }],
      primary: null,
    }
  }
  const items: ReadinessItem[] = []
  const me = ctx.me
  const author = !!me && (pr.actor === me || pr.sourceBranchOwner === me)
  const you = pr.review?.you
  const requested = you?.requested ?? (!!me && (pr.reviewers ?? []).includes(me))
  const asks = changeRequests(pr)
  const holding = asks.find((a) => a.holds) ?? null
  const d = ctx.decisions
  const accepted = d?.accepted ?? 0
  const rejected = d?.rejected ?? 0
  const threadsHold = !!pr.review?.threads.holdMerge && ctx.openThreads > 0

  const left = d ? d.undecided + d.stale : 0
  const progress = approvalProgress(pr)
  const mergeFollows = !!ctx.canApproveAll && mergeFollowsApproval(pr, ctx)

  // A reviewer's part.
  if (requested || ctx.canDecide) {
    if (ctx.total > 0) {
      const done = ctx.viewed >= ctx.total
      items.push({
        key: 'look', ok: done, title: 'Look through the changes',
        detail: `${ctx.viewed.toLocaleString()} of ${ctx.total.toLocaleString()} viewed`,
        action: done ? undefined : { label: 'Next to look at', kind: 'next_unviewed' },
      })
    }
    if (ctx.canDecide && ctx.listable && d) {
      items.push({
        key: 'decide', ok: left === 0, title: 'Decide each change',
        detail: left ? `${left.toLocaleString()} to decide${d.stale ? `, ${d.stale.toLocaleString()} of them changed since` : ''}`
          : `${accepted.toLocaleString()} accepted, ${rejected.toLocaleString()} rejected`,
        action: left ? { label: 'Next to decide', kind: 'next_undecided' } : undefined,
      })
    }
    items.push(ctx.openThreads > 0 ? {
      key: 'threads', ok: false, title: `Resolve ${plural(ctx.openThreads, 'open thread')}`,
      detail: threadsHold ? 'They hold the merge until they are resolved.' : undefined,
      action: { label: 'Next thread', kind: 'next_thread' },
    } : { key: 'threads', ok: true, title: 'No open threads' })
    if (requested) {
      const approved = you ? you.verdict === 'approve' && !you.updatedSinceReviewed : !!me && (pr.approvedBy ?? []).includes(me)
      const earlier = you ? you.verdict === 'approve' && you.updatedSinceReviewed : !!me && (pr.staleApprovedBy ?? []).includes(me)
      const askedByMe = !!me && holding?.by === me
      items.push({
        key: 'verdict', ok: approved || askedByMe,
        title: approved ? 'You approved it' : askedByMe ? 'You asked for changes' : 'Give your verdict',
        detail: approved || askedByMe ? undefined
          : earlier ? 'You approved an earlier version: it changed since.' : 'Approve it, or send it back saying what should change.',
        action: ctx.canApproveAll && (left > 0 || mergeFollows)
          ? { label: `${left > 0 ? 'Approve all' : 'Approve'}${mergeFollows ? ' & merge' : ''}`,
            kind: mergeFollows ? 'approve_all_merge' : 'approve_all' }
          : ctx.showApprove ? { label: 'Approve', kind: 'approve' } : undefined,
      })
    }
  }

  // What holds the merge.
  if (ctx.forksOff) {
    items.push({ key: 'forks_off', ok: false, title: 'Forks are turned off',
      detail: 'A fork’s review can be read but not approved or merged until an administrator turns forks on.' })
  }
  if (progress.required > 0) {
    items.push({
      key: 'approvals', ok: progress.satisfied,
      title: progress.satisfied ? 'Approved' : `${progress.have.toLocaleString()} of ${plural(progress.required, 'approval')}`,
      detail: progress.satisfied || !progress.waiting.length ? undefined
        : `Waiting on ${names(progress.waiting.map((r) => reviewerName(pr, r)))}`,
    })
  }
  if (holding) {
    items.push({
      key: 'sent_back', ok: false, title: `${ownerName(holding.by, pr.userNames)} asked for changes`,
      detail: holding.reason ? `“${holding.reason}” It merges once the draft changes.` : 'It merges once the draft changes.',
      action: author && rejected > 0 ? { label: 'Discard the rejected', kind: 'discard_rejected' } : undefined,
    })
  } else {
    const last = [...asks].sort((a, b) => b.at.localeCompare(a.at))[0]
    if (last) {
      const by = ownerName(last.by, pr.userNames)
      items.push({ key: 'sent_back', ok: true,
        title: author ? `You changed it since: it’s back with ${by}` : `Changed since ${by} asked for changes` })
    }
  }
  if (isDraftMr(pr)) {
    items.push(ctx.needsPull ? {
      key: 'up_to_date', ok: false, title: 'Behind main',
      detail: ctx.pullReason === 'overlap'
        ? 'Automation changed something this draft changes since it started. Pull the latest to see what it changed.'
        : `This draft is behind main${behindText(pr)}. Pull the latest changes before it can merge.`,
      action: { label: 'Pull the latest', kind: 'pull' },
    } : { key: 'up_to_date', ok: true, title: 'Up to date with main' })
  } else if (ctx.forkBehind !== null) {
    items.push({
      key: 'up_to_date', ok: false, title: 'Behind its parent',
      detail: `This fork is behind its parent${ctx.forkBehind > 0 ? ` by ${plural(ctx.forkBehind, 'change')}` : ''}. Update it first: it merges only up to date.`,
      action: ctx.canUpdateFromParent ? { label: 'Update from parent', kind: 'update_from_parent' } : undefined,
    })
  }
  if (pr.status === 'conflicts') {
    items.push({ key: 'conflicts', ok: false, title: isDraftMr(pr) ? 'Conflicts with main' : 'Conflicts with its parent',
      detail: 'The target has moved. Resolve the conflicts as it merges.', action: { label: 'Resolve conflicts', kind: 'resolve_conflicts' } })
  }
  if (ctx.unsaved > 0) {
    items.push({ key: 'unsaved', ok: false, title: `${plural(ctx.unsaved, 'unsaved edit')} on this draft`,
      detail: 'Save or discard them on the canvas first: a merge would leave them behind.' })
  }
  if (ctx.mergeInPart && d) {
    if (d.missing > 0) {
      items.push({ key: 'missing', ok: false,
        title: `${plural(d.missing, 'change')} the accepted ones need ${d.missing === 1 ? 'isn’t' : 'aren’t'} accepted`,
        action: ctx.canDecide ? { label: 'Accept them too', kind: 'accept_missing' } : undefined })
    }
    if (rejected > 0 && !holding) {
      items.push({
        key: 'rejected', ok: false, title: `${plural(rejected, 'change')} rejected`,
        detail: 'Merge only what is accepted, or discard what was rejected from the draft.',
        action: ctx.canMerge ? { label: `Merge ${accepted.toLocaleString()} accepted`, kind: 'merge_accepted' }
          : author ? { label: 'Discard the rejected', kind: 'discard_rejected' } : undefined,
      })
    }
  }
  if (threadsHold && !items.some((i) => i.key === 'threads')) {
    items.push({ key: 'threads_hold', ok: false, title: 'Open threads hold the merge',
      detail: `Resolve the ${plural(ctx.openThreads, 'open thread')} first.`, action: { label: 'Next thread', kind: 'next_thread' } })
  }
  if (!ctx.canMerge && !ctx.forksOff) {
    items.push({ key: 'permission', ok: false, title: 'You can’t merge this', detail: ctx.mergeBlockedWhy ?? undefined })
  }

  return { items, primary: primaryOf(items, ctx, { holding: !!holding, threadsHold, accepted }) }
}

function primaryOf(items: ReadinessItem[], ctx: ReadinessContext, at: { holding: boolean; threadsHold: boolean; accepted: number }): PrimaryAction | null {
  if (!ctx.canManage || ctx.forksOff) return null
  // Merge, whole or what is accepted: off where the review says it can't yet, with why.
  const mergeGate = (accepted: boolean): Pick<PrimaryAction, 'disabled' | 'why'> => {
    const why = !ctx.canMerge ? ctx.mergeBlockedWhy ?? 'You can’t merge this review'
      : at.holding ? 'Sent back for changes: it merges once the draft changes'
        : accepted && at.accepted === 0 ? 'Accept the changes that should merge first'
          : accepted && (ctx.decisions?.missing ?? 0) > 0 ? 'Accept what the accepted changes need first'
            : ctx.unsaved > 0 ? 'Save or discard your unsaved edits first'
              : at.threadsHold ? 'Resolve the open threads first' : undefined
    return why ? { disabled: true, why } : {}
  }
  const next = items.find((i) => !i.ok && i.action && !STEPS.has(i.action.kind))?.action
  if (next) {
    const kind = next.kind as ReviewActionKind
    if (kind === 'merge' || kind === 'merge_accepted') return { kind, label: next.label, ...mergeGate(kind === 'merge_accepted') }
    if (kind === 'resolve_conflicts') return { kind, label: next.label, ...mergeGate(ctx.mergeInPart) }
    return { kind, label: next.label }
  }
  return ctx.mergeInPart
    ? { kind: 'merge_accepted', label: `Merge ${at.accepted.toLocaleString()} accepted`, ...mergeGate(true) }
    : { kind: 'merge', label: 'Merge', ...mergeGate(false) }
}
