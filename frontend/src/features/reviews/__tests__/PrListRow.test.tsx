/**
 * PrListRow — an inbox row says what is new on a review: a dot while something someone else did is
 * unread, that it changed since you reviewed it, its open threads and approvals, and when it was
 * last active; clicking it opens it.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { PullRequest, ReviewState } from '@/services/versioningApiService'

vi.mock('@/features/versioning/hooks/useVersioning', () => ({
  usePrDiffSummary: () => ({ data: undefined, isLoading: false }),
  useChangeSummary: () => ({ data: undefined, isLoading: false }),
  useCloseMergeRequest: () => ({ mutate: vi.fn(), isPending: false }),
}))

import { PrListRow } from '../components/PrListRow'

const review = (over: Partial<ReviewState> = {}): ReviewState => ({
  requiredApprovals: 0, approvals: { required: 2, have: 1, satisfied: false }, reviewers: [], changeRequests: [],
  threads: { open: 0, holdMerge: false },
  you: { requested: true, needsReview: true, updatedSinceReviewed: false }, ...over,
})
const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  prId: 'pr_1', graphId: 'g1', targetGraphId: 'g1', sourceBranchId: 'b1', targetBranch: 'main', status: 'open',
  title: 'Tidy owners', actor: 'u_ana', userNames: { u_ana: 'Ana' }, reviewers: ['u_me', 'u_bob'], approvedBy: ['u_bob'],
  createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', review: review(), ...over,
})

describe('PrListRow', () => {
  it('shows a dot while something on it is unread, and none once it is read', () => {
    const { rerender } = render(<PrListRow wsId="ws1" pr={pr({ unread: true })} onOpen={() => {}} />)
    expect(screen.getByRole('img', { name: 'Unread' })).toBeInTheDocument()
    rerender(<PrListRow wsId="ws1" pr={pr({ unread: false })} onOpen={() => {}} />)
    expect(screen.queryByRole('img', { name: 'Unread' })).not.toBeInTheDocument()
  })

  it('says when it changed since you reviewed it', () => {
    const { rerender } = render(<PrListRow wsId="ws1" pr={pr()} onOpen={() => {}} />)
    expect(screen.queryByText('Updated since you reviewed')).not.toBeInTheDocument()
    rerender(<PrListRow wsId="ws1" onOpen={() => {}}
      pr={pr({ review: review({ you: { requested: true, needsReview: true, updatedSinceReviewed: true } }) })} />)
    expect(screen.getByText('Updated since you reviewed')).toBeInTheDocument()
  })

  it('shows its approvals as its rule counts them, and its open threads', () => {
    render(<PrListRow wsId="ws1" pr={pr({ review: review({ threads: { open: 3, holdMerge: true } }) })} onOpen={() => {}} />)
    expect(screen.getByText('1/2')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
  })

  it('never shows two separators in a row where there is no change count', () => {
    for (const status of ['open', 'merged'] as const) {   // the summary didn't load; a merged review isn't counted
      const { container, unmount } = render(<PrListRow wsId="ws1" pr={pr({ status })} onOpen={() => {}} />)
      expect(container.textContent).not.toMatch(/·\s*·/)
      expect(container.textContent).toMatch(/main.*·\s*by Ana/)
      unmount()
    }
  })

  it('says when it was last active, else when it was opened', () => {
    const { container, rerender } = render(
      <PrListRow wsId="ws1" pr={pr({ lastActivityAt: '2026-11-03T10:00:00Z' })} onOpen={() => {}} />)
    expect(container.querySelector('time')).toHaveAttribute('dateTime', '2026-11-03T10:00:00.000Z')
    expect(container.querySelector('time')).toHaveTextContent(/^active /)
    rerender(<PrListRow wsId="ws1" pr={pr()} onOpen={() => {}} />)
    expect(container.querySelector('time')).toHaveAttribute('dateTime', '2026-11-01T00:00:00.000Z')
    expect(container.querySelector('time')).toHaveTextContent(/^opened /)
  })

  it('opens on a click, and offers Dismiss on a live review', () => {
    const onOpen = vi.fn()
    render(<PrListRow wsId="ws1" pr={pr()} onOpen={onOpen} />)
    fireEvent.click(screen.getByText('Tidy owners'))
    expect(onOpen).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText('Dismiss'))
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Confirm dismiss' })).toBeInTheDocument()
  })
})
