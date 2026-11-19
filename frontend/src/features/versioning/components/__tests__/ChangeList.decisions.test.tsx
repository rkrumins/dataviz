/**
 * A draft's review decided change by change in its change list: Accept, Reject asking why, what
 * was decided shown on the row (and undone by clicking it), what a decision took with it said with
 * Undo, a decision that would reverse others asked first, and every change shown decided at once
 * after saying how many and what they take with them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ChangeListSummary, ReviewChangeRow } from '@/services/versioningApiService'

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number; getItemKey?: (i: number) => string | number }) => ({
    getVirtualItems: () => Array.from({ length: opts.count }, (_, index) => ({
      index, key: opts.getItemKey ? opts.getItemKey(index) : index, start: index * 36, size: 36,
    })),
    getTotalSize: () => opts.count * 36,
    measureElement: () => undefined,
  }),
}))
const api = vi.hoisted(() => ({
  listReviewChanges: vi.fn(),
  decideReviewChanges: vi.fn(),
  getChangeEntries: vi.fn(),
  getReviewCommentCounts: vi.fn(),
}))
vi.mock('@/services/versioningApiService', async (orig) => ({
  ...(await orig<typeof import('@/services/versioningApiService')>()),
  ...api,
}))

import { ChangeList } from '../ChangeList'
import { ReviewDecisionError } from '@/services/versioningApiService'

const NONE = { added: 0, modified: 0, removed: 0 }
const summary: ChangeListSummary = {
  origin: { branchId: 'br_1' }, counts: { ...NONE, added: 2, modified: 1 }, entityCounts: { ...NONE, added: 2, modified: 1 },
  edgeCounts: NONE, structureCounts: NONE, impact: { Table: 3 },
  byType: [{ kind: 'node', type: 'Table', added: 2, modified: 1, removed: 0 }],
  total: 3, listed: 3, approximate: false, tooLarge: null, window: null,
}
const row = (entityId: string, name: string, decision: ReviewChangeRow['decision'] = null): ReviewChangeRow => ({
  entityId, kind: 'node', status: 'added', type: 'Table', structural: false, displayName: name, decision,
})
const outcome = (over = {}) => ({ decided: 1, implied: [], impliedCount: 0, overrides: [], overrideCount: 0, dryRun: false, ...over })

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset())
  api.getReviewCommentCounts.mockResolvedValue({ entities: {}, general: { open: 0, total: 0 }, open: 0 })
  api.listReviewChanges.mockResolvedValue({
    entries: [
      row('T1', 'Orders'),
      row('T2', 'Sales', { verdict: 'rejected', reason: 'Not yet', actor: 'u_bo', decidedAt: 'now', impliedBy: null, stale: false }),
      row('T3', 'Refunds', { verdict: 'accepted', reason: null, actor: 'u_bo', decidedAt: 'now', impliedBy: 'T1', stale: false }),
    ],
    total: 3, offset: 0, limit: 200, hasMore: false,
  })
})

function renderList(canDecide = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ChangeList wsId="ws1" graphId="g1" origin={{ branchId: 'br_1' }} summary={summary}
        review={{
          prId: 'pr_1', canComment: true, canModerate: false,
          decisions: {
            canDecide, headCommitId: 'c9', names: { u_bo: 'Bo Chen' },
            summary: { total: 3, accepted: 1, rejected: 1, stale: 0, undecided: 1, missing: 0, missingIds: [], headCommitId: 'c9' },
          },
        }} />
    </QueryClientProvider>,
  )
}

describe('ChangeList — deciding a review', () => {
  it('lists the review’s changes with their decisions, and why one was rejected', async () => {
    renderList()
    expect(await screen.findByText('“Not yet”')).toBeInTheDocument()
    expect(screen.getByText('— Bo Chen')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Accepted: undo the decision on Refunds' })).toBeInTheDocument()
    expect(api.getChangeEntries).not.toHaveBeenCalled()
    expect(screen.getByRole('radio', { name: /To decide/ })).toBeInTheDocument()
  })

  it('accepts a change, and says what it took with it, with Undo', async () => {
    api.decideReviewChanges.mockResolvedValueOnce(outcome({ impliedCount: 2, implied: [{ entityId: 'T3', impliedBy: 'T1' }] }))
    renderList()
    fireEvent.click(await screen.findByRole('button', { name: 'Accept Orders' }))
    await waitFor(() => expect(api.decideReviewChanges).toHaveBeenCalledWith('ws1', 'pr_1', {
      verdict: 'accepted', entityIds: ['T1'], reason: undefined, expectedHeadCommitId: 'c9', force: false,
    }))
    expect(await screen.findByText('Accepted 1 change, and 2 it needs.')).toBeInTheDocument()
    api.decideReviewChanges.mockResolvedValueOnce(outcome())
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(api.decideReviewChanges).toHaveBeenLastCalledWith('ws1', 'pr_1', expect.objectContaining({
      verdict: null, entityIds: ['T1'],
    })))
  })

  it('asks why a change is rejected', async () => {
    api.decideReviewChanges.mockResolvedValue(outcome())
    renderList()
    fireEvent.click(await screen.findByRole('button', { name: 'Reject Orders' }))
    const why = screen.getByRole('textbox', { name: 'Why it is rejected' })
    fireEvent.change(why, { target: { value: 'Wrong owner' } })
    fireEvent.keyDown(why, { key: 'Enter' })
    await waitFor(() => expect(api.decideReviewChanges).toHaveBeenCalledWith('ws1', 'pr_1', expect.objectContaining({
      verdict: 'rejected', entityIds: ['T1'], reason: 'Wrong owner',
    })))
  })

  it('asks before reversing a decision a change takes with it', async () => {
    api.decideReviewChanges.mockRejectedValueOnce(new ReviewDecisionError('decision_conflict', 'x', { count: 1 }))
    api.decideReviewChanges.mockResolvedValueOnce(outcome())
    renderList()
    fireEvent.click(await screen.findByRole('button', { name: 'Accept Orders' }))
    expect(await screen.findByText('That reverses 1 decision made on changes it takes with it.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Accept anyway' }))
    await waitFor(() => expect(api.decideReviewChanges).toHaveBeenLastCalledWith('ws1', 'pr_1', expect.objectContaining({
      verdict: 'accepted', entityIds: ['T1'], force: true,
    })))
  })

  it('decides every change shown after saying how many, and what they take', async () => {
    api.decideReviewChanges.mockResolvedValueOnce(outcome({ decided: 3, impliedCount: 1, overrideCount: 1, dryRun: true }))
    api.decideReviewChanges.mockResolvedValueOnce(outcome({ decided: 3 }))
    renderList()
    fireEvent.click(await screen.findByRole('button', { name: 'Accept 3 shown' }))
    await waitFor(() => expect(api.decideReviewChanges).toHaveBeenCalledWith('ws1', 'pr_1', expect.objectContaining({
      verdict: 'accepted', dryRun: true, filter: expect.objectContaining({ kind: 'node' }),
    })))
    expect(await screen.findByText('Accept 3 changes shown, and 1 they need?')).toBeInTheDocument()
    expect(screen.getByText('1 change decided otherwise will be reversed.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Accept 4' }))
    await waitFor(() => expect(api.decideReviewChanges).toHaveBeenLastCalledWith('ws1', 'pr_1', expect.objectContaining({
      verdict: 'accepted', force: true, filter: expect.objectContaining({ kind: 'node' }),
    })))
  })

  it('shows decisions, without deciding, to someone who may not decide', async () => {
    renderList(false)
    expect(await screen.findByText('“Not yet”')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Accept Orders' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /shown$/ })).not.toBeInTheDocument()
  })
})
