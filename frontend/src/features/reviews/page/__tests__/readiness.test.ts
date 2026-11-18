/**
 * What a review still needs, said item by item, and the one thing to do next — the same rules the
 * drawer's buttons follow: Approve for a reviewer who hasn't, Pull the latest when behind, Resolve
 * conflicts, Merge N accepted when decided in part, Merge off with why where it can't yet.
 */
import { describe, it, expect } from 'vitest'
import type { PullRequest, ReviewDecisionSummary, ReviewState } from '@/services/versioningApiService'
import { approvalProgress, readiness, reviewerStates, type ReadinessContext } from '../readiness'

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  prId: 'pr_1', graphId: 'g1', targetGraphId: 'g1', sourceBranchId: 'br_1', targetBranch: 'main', status: 'open',
  actor: 'u_ana', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
  reviewers: ['u_bob'], approvedBy: [], userNames: { u_ana: 'Ana', u_bob: 'Bob', u_cy: 'Cy', u_me: 'Me' },
  ...over,
})
const ctx = (over: Partial<ReadinessContext> = {}): ReadinessContext => ({
  me: 'u_me', canManage: true, showApprove: false, canMerge: true, mergeBlockedWhy: null, forksOff: false,
  forkBehind: null, canUpdateFromParent: false, needsPull: false, pullReason: null, unsaved: 0, decisions: null,
  mergeInPart: false, canDecide: false, listable: true, viewed: 0, total: 4, openThreads: 0, ...over,
})
const summary = (over: Partial<ReviewDecisionSummary> = {}): ReviewDecisionSummary => ({
  total: 4, accepted: 2, rejected: 1, stale: 0, undecided: 1, missing: 0, missingIds: [], headCommitId: 'c1', ...over,
})
const item = (r: ReturnType<typeof readiness>, key: string) => r.items.find((i) => i.key === key)

describe('readiness — a reviewer', () => {
  const asked = pr({ reviewers: ['u_me', 'u_bob'] })

  it('asks them to look, decide, resolve threads and give their verdict — Approve first', () => {
    const r = readiness(asked, ctx({ showApprove: true, canDecide: true, decisions: summary(), viewed: 1, openThreads: 2 }))
    expect(r.items.slice(0, 4).map((i) => [i.key, i.ok])).toEqual([
      ['look', false], ['decide', false], ['threads', false], ['verdict', false],
    ])
    expect(item(r, 'look')!.detail).toBe('1 of 4 viewed')
    expect(item(r, 'look')!.action!.kind).toBe('next_unviewed')
    expect(item(r, 'decide')!.detail).toBe('1 to decide')
    expect(item(r, 'threads')!.title).toBe('Resolve 2 open threads')
    // Steps to another change are offered, never the primary action.
    expect(r.primary).toEqual({ kind: 'approve', label: 'Approve' })
  })

  it('is not asked to decide where changes are not decided one by one here', () => {
    expect(item(readiness(asked, ctx({ canDecide: true, decisions: summary(), listable: false })), 'decide')).toBeUndefined()
    expect(item(readiness(asked, ctx({ canDecide: false, decisions: summary() })), 'decide')).toBeUndefined()
  })

  it('says they approved, or that it changed since they did', () => {
    expect(item(readiness(pr({ reviewers: ['u_me'], approvedBy: ['u_me'] }), ctx()), 'verdict')).toMatchObject({ ok: true, title: 'You approved it' })
    expect(item(readiness(pr({ reviewers: ['u_me'], staleApprovedBy: ['u_me'] }), ctx({ showApprove: true })), 'verdict'))
      .toMatchObject({ ok: false, detail: expect.stringMatching(/approved an earlier version/) })
  })

  it('reads its own part from the server’s review when there is one', () => {
    const review: ReviewState = {
      requiredApprovals: 0, approvals: { required: 1, have: 0, satisfied: false },
      reviewers: [{ type: 'user', id: 'u_me', state: 'approved_earlier', requestedAt: '2026-11-01T00:00:00Z' }],
      changeRequests: [], threads: { open: 0, holdMerge: false },
      you: { requested: true, needsReview: true, updatedSinceReviewed: true, verdict: 'approve' },
    }
    const r = readiness(pr({ reviewers: [], review }), ctx({ showApprove: true }))
    expect(item(r, 'verdict')).toMatchObject({ ok: false, detail: expect.stringMatching(/earlier version/) })
  })

  it('is not a reviewer’s list for someone neither asked nor deciding', () => {
    const r = readiness(pr(), ctx())
    expect(item(r, 'look')).toBeUndefined()
    expect(item(r, 'verdict')).toBeUndefined()
  })
})

describe('readiness — what holds the merge', () => {
  it('waits on the reviewers who have not approved, by name, and Merge is next', () => {
    const r = readiness(pr({ reviewers: ['u_bob', 'u_cy'], approvedBy: ['u_cy'] }), ctx())
    expect(item(r, 'approvals')).toMatchObject({ ok: false, title: '1 of 2 approvals', detail: 'Waiting on Bob' })
    expect(r.primary).toEqual({ kind: 'merge', label: 'Merge' })
  })

  it('counts approvals as the server does when it says', () => {
    const review = {
      requiredApprovals: 1, approvals: { required: 1, have: 1, satisfied: true }, reviewers: [], changeRequests: [],
      threads: { open: 0, holdMerge: false },
    }
    expect(item(readiness(pr({ review }), ctx()), 'approvals')).toMatchObject({ ok: true, title: 'Approved' })
  })

  it('sent back: by whom and why, Merge off — and its author can discard what was rejected', () => {
    const changesRequested = { by: 'u_bob', at: '2026-11-02T00:00:00Z', reason: 'Use ISO codes' }
    const r = readiness(pr({ changesRequested }), ctx({ mergeInPart: true, decisions: summary() }))
    expect(item(r, 'sent_back')).toMatchObject({ ok: false, title: 'Bob asked for changes', detail: expect.stringMatching(/“Use ISO codes”/) })
    expect(item(r, 'rejected')).toBeUndefined()
    expect(r.primary).toMatchObject({ kind: 'merge_accepted', disabled: true, why: expect.stringMatching(/Sent back/) })
    const mine = readiness(pr({ changesRequested }), ctx({ me: 'u_ana', mergeInPart: true, decisions: summary() }))
    expect(mine.primary).toEqual({ kind: 'discard_rejected', label: 'Discard the rejected' })
  })

  it('a change asked for that no longer holds: it is back with whoever asked', () => {
    const review = {
      requiredApprovals: 0, approvals: { required: 1, have: 0, satisfied: false }, reviewers: [],
      changeRequests: [{ by: 'u_bob', at: '2026-11-02T00:00:00Z', holds: false }], threads: { open: 0, holdMerge: false },
    }
    expect(item(readiness(pr({ review }), ctx({ me: 'u_ana' })), 'sent_back'))
      .toEqual({ key: 'sent_back', ok: true, title: 'You changed it since: it’s back with Bob' })
  })

  it('behind main: Pull the latest is next', () => {
    const r = readiness(pr({ behindByPeople: 3 }), ctx({ needsPull: true }))
    expect(item(r, 'up_to_date')).toMatchObject({ ok: false, detail: expect.stringMatching(/behind main by 3 changes people made/) })
    expect(r.primary).toEqual({ kind: 'pull', label: 'Pull the latest' })
    expect(item(readiness(pr(), ctx()), 'up_to_date')).toMatchObject({ ok: true, title: 'Up to date with main' })
  })

  it('a fork behind its parent: Update from parent, where the reader can', () => {
    const fork = pr({ graphId: 'g_fork' })
    expect(readiness(fork, ctx({ forkBehind: 4, canUpdateFromParent: true })).primary).toEqual({ kind: 'update_from_parent', label: 'Update from parent' })
    expect(item(readiness(fork, ctx({ forkBehind: 4 })), 'up_to_date')).toMatchObject({ detail: expect.stringMatching(/by 4 changes/) })
    expect(item(readiness(fork, ctx()), 'up_to_date')).toBeUndefined()
  })

  it('conflicts: Resolve conflicts, which merges', () => {
    const r = readiness(pr({ status: 'conflicts' }), ctx())
    expect(item(r, 'conflicts')).toMatchObject({ ok: false, title: 'Conflicts with main' })
    expect(r.primary).toEqual({ kind: 'resolve_conflicts', label: 'Resolve conflicts' })
  })

  it('unsaved edits on the draft: saved first, Merge off till then', () => {
    const r = readiness(pr(), ctx({ unsaved: 2 }))
    expect(item(r, 'unsaved')).toMatchObject({ ok: false, title: '2 unsaved edits on this draft' })
    expect(r.primary).toMatchObject({ kind: 'merge', disabled: true, why: expect.stringMatching(/unsaved/) })
  })

  it('rejected changes: merge only what is accepted', () => {
    const r = readiness(pr(), ctx({ mergeInPart: true, decisions: summary() }))
    expect(item(r, 'rejected')).toMatchObject({ ok: false, title: '1 change rejected' })
    expect(r.primary).toEqual({ kind: 'merge_accepted', label: 'Merge 2 accepted' })
  })

  it('what is accepted needs more: Accept them too, for whoever decides', () => {
    const decisions = summary({ missing: 1, missingIds: ['T3'] })
    const r = readiness(pr(), ctx({ mergeInPart: true, decisions, canDecide: true }))
    expect(item(r, 'missing')).toMatchObject({ ok: false, title: '1 change the accepted ones need isn’t accepted' })
    expect(r.primary).toEqual({ kind: 'accept_missing', label: 'Accept them too' })
    expect(readiness(pr(), ctx({ mergeInPart: true, decisions })).primary)
      .toMatchObject({ kind: 'merge_accepted', disabled: true })
  })

  it('may not merge: says why, from the review’s word', () => {
    const why = 'This data source has someone other than whoever opened a review merge it'
    const r = readiness(pr(), ctx({ canMerge: false, mergeBlockedWhy: why }))
    expect(item(r, 'permission')).toMatchObject({ ok: false, detail: why })
    expect(r.primary).toEqual({ kind: 'merge', label: 'Merge', disabled: true, why })
  })

  it('open threads that hold the merge', () => {
    const review = {
      requiredApprovals: 0, approvals: { required: 0, have: 0, satisfied: true }, reviewers: [], changeRequests: [],
      threads: { open: 2, holdMerge: true },
    }
    const r = readiness(pr({ reviewers: [], review }), ctx({ openThreads: 2 }))
    expect(item(r, 'threads_hold')).toMatchObject({ ok: false })
    expect(r.primary).toMatchObject({ kind: 'merge', disabled: true, why: 'Resolve the open threads first' })
  })

  it('with forks off, neither Approve nor Merge', () => {
    const r = readiness(pr({ graphId: 'g_fork', reviewers: ['u_me'] }), ctx({ forksOff: true }))
    expect(item(r, 'forks_off')).toMatchObject({ ok: false })
    expect(r.primary).toBeNull()
  })

  it('nothing to do for someone who does not manage it, nor once it is merged, closed or merging', () => {
    expect(readiness(pr(), ctx({ canManage: false })).primary).toBeNull()
    expect(readiness(pr({ status: 'merged' }), ctx())).toEqual({ items: [], primary: null })
    expect(readiness(pr({ status: 'closed' }), ctx())).toEqual({ items: [], primary: null })
    expect(readiness(pr({ status: 'merging' }), ctx())).toMatchObject({ items: [{ key: 'merging' }], primary: null })
  })
})

describe('reviewers and approvals, without the server’s count', () => {
  it('each reviewer: approved, approved an earlier version, asked for changes, or waiting', () => {
    const p = pr({
      reviewers: ['u_a', 'u_b', 'u_c', 'u_d'], approvedBy: ['u_a'], staleApprovedBy: ['u_b'],
      changesRequested: { by: 'u_c', at: '2026-11-02T00:00:00Z' }, approvalStatus: 'pending',
    })
    expect(reviewerStates(p).map((r) => r.state)).toEqual(['approved', 'approved_earlier', 'changes_requested', 'waiting'])
    expect(approvalProgress(p)).toMatchObject({ have: 1, required: 4, satisfied: false })
  })
})
