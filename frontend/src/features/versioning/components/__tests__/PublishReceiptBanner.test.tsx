/**
 * The publish receipt says what landed: a publish that committed something offers its version in
 * history; one that changed nothing (main held its changes already) says so, and offers no version
 * to look at, since there is none.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usePublishReceiptStore, type PublishReceipt } from '@/store/publishReceiptStore'
import { PublishReceiptBanner } from '../PublishReceiptBanner'

const receipt = (r: Partial<PublishReceipt>): PublishReceipt => ({
  commitId: 'cmt_1', outcome: 'published', graphId: 'g1', via: 'publish',
  counts: { added: 2, modified: 1, removed: 0 }, ...r,
})

afterEach(() => usePublishReceiptStore.getState().clearReceipt())

describe('PublishReceiptBanner', () => {
  it('confirms a publish and offers its version in history', async () => {
    const onViewCommit = vi.fn()
    usePublishReceiptStore.getState().setReceipt(receipt({}))
    render(<PublishReceiptBanner graphId="g1" onViewCommit={onViewCommit} />)
    expect(screen.getByText('Published — your changes are now live')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /View in history/ }))
    expect(onViewCommit).toHaveBeenCalled()
  })

  it('says a publish that changed nothing was already live, with no version to look at', () => {
    usePublishReceiptStore.getState().setReceipt(receipt({ commitId: null, outcome: 'unchanged' }))
    render(<PublishReceiptBanner graphId="g1" onViewCommit={() => {}} />)
    expect(screen.getByText('Already live — the published graph had these changes')).toBeInTheDocument()
    expect(screen.getByText(/Nothing new was published/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /View in history/ })).not.toBeInTheDocument()
  })
})
