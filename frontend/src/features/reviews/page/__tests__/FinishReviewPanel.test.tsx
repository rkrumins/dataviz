/**
 * Finish your review: the reviewer's tally; Comment, Approve or Request changes, each off with the
 * server's reason where they may not give it (a fork's review is sent back by closing it); a summary,
 * which a comment needs, and asking for changes with nothing rejected; ⌘↵ sends it; and a draft that
 * moved on while they reviewed says so, recording nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ReviewActions } from '../../hooks/useReviewActions'
import { isApplePlatform } from '@/lib/platform'
import { FinishReviewPanel } from '../FinishReviewPanel'

const submitReview = vi.fn()
const onOpenChange = vi.fn()

const actions = (over: Record<string, unknown> = {}) => ({
  pr: { prId: 'pr_1', graphId: 'g1', actor: 'u_ana' },
  viewerCan: {
    approve: true, approveReason: null, merge: true, mergeReason: null, comment: true, commentReason: null,
    decide: true, decideReason: null, requestChanges: true, requestChangesReason: null,
  },
  deciding: true,
  decisions: { total: 40, accepted: 10, rejected: 0, stale: 0, undecided: 30, missing: 0, missingIds: [], headCommitId: 'c9' },
  rejected: 0,
  showApprove: true,
  busy: false,
  changesFetching: false,
  submitReview,
  pending: { submit: false },
  ...over,
}) as unknown as ReviewActions

function open(a = actions()) {
  render(
    <FinishReviewPanel actions={a} open onOpenChange={onOpenChange} viewed={12} total={40} openThreads={3}>
      <button type="button">Finish your review</button>
    </FinishReviewPanel>,
  )
  return screen.getByRole('dialog', { name: 'Finish your review' })
}
const radio = (panel: HTMLElement, name: string) => within(panel).getByRole('radio', { name })
const submit = (panel: HTMLElement) => within(panel).getByRole('button', { name: 'Submit review' })
const summary = (panel: HTMLElement) => within(panel).getByRole('textbox', { name: 'Summary' })

beforeEach(() => {
  submitReview.mockReset()
  onOpenChange.mockReset()
})

describe('FinishReviewPanel', () => {
  it('tallies what the reviewer did', () => {
    const decisions = { total: 40, accepted: 10, rejected: 2, stale: 0, undecided: 28, missing: 0, missingIds: [], headCommitId: 'c9' }
    const panel = open(actions({ decisions, rejected: 2 }))
    expect(within(panel).getByText('You viewed 12 of 40 · accepted 10 · rejected 2 · 3 open threads')).toBeInTheDocument()
  })

  it('approves, with an optional summary, and closes once it is in', () => {
    const panel = open()
    expect(radio(panel, 'Approve')).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(submit(panel))
    expect(submitReview).toHaveBeenCalledWith('approve', '', expect.anything())
    act(() => submitReview.mock.calls[0][2].onDone())
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('a comment needs a summary', () => {
    const panel = open()
    fireEvent.click(radio(panel, 'Comment'))
    expect(within(panel).getByText('A comment needs a summary.')).toBeInTheDocument()
    expect(submit(panel)).toBeDisabled()
    fireEvent.change(summary(panel), { target: { value: 'Owners look right' } })
    fireEvent.click(submit(panel))
    expect(submitReview).toHaveBeenCalledWith('comment', 'Owners look right', expect.anything())
  })

  it('asking for changes needs a summary only when nothing was rejected', () => {
    let panel = open()
    fireEvent.click(radio(panel, 'Request changes'))
    expect(submit(panel)).toBeDisabled()
    expect(within(panel).getByText('You rejected nothing: say what should change.')).toBeInTheDocument()
    cleanup()
    // Something rejected: it is the verdict offered first, and the rejections say why.
    panel = open(actions({ rejected: 2 }))
    expect(radio(panel, 'Request changes')).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(submit(panel))
    expect(submitReview).toHaveBeenCalledWith('request_changes', '', expect.anything())
  })

  it('a verdict the reader may not give is off, saying why', () => {
    const viewerCan = {
      approve: false, approveReason: 'self_review', merge: false, mergeReason: 'self_merge', comment: true, commentReason: null,
      decide: false, decideReason: 'fork_review', requestChanges: false, requestChangesReason: 'fork_review',
    }
    const panel = open(actions({ viewerCan, deciding: false, decisions: undefined }))
    expect(radio(panel, 'Approve')).toBeDisabled()
    expect(radio(panel, 'Request changes')).toBeDisabled()
    expect(radio(panel, 'Comment')).toHaveAttribute('aria-checked', 'true')
    expect(within(panel).getByText(/someone other than whoever opened a review approve it/)).toBeInTheDocument()
    expect(within(panel).getByText('A fork’s review is sent back by closing it.')).toBeInTheDocument()
    expect(within(panel).getByText('You viewed 12 of 40 · 3 open threads')).toBeInTheDocument()
  })

  it('⌘↵ sends it', () => {
    const panel = open()
    fireEvent.change(summary(panel), { target: { value: 'Ship it' } })
    fireEvent.keyDown(summary(panel), { key: 'Enter', ...(isApplePlatform() ? { metaKey: true } : { ctrlKey: true }) })
    expect(submitReview).toHaveBeenCalledWith('approve', 'Ship it', expect.anything())
  })

  it('the draft moved on while they reviewed: says so, and points at what is new', () => {
    const panel = open()
    fireEvent.click(submit(panel))
    act(() => submitReview.mock.calls[0][2].onMoved())
    const alert = within(panel).getByRole('alert')
    expect(alert).toHaveTextContent('The draft changed while you reviewed — see what’s new')
    fireEvent.click(within(alert).getByRole('button', { name: 'see what’s new' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
