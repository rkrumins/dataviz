/**
 * ViewHistoryTimeline — RTL test for the per-commit drill-down: a commit row is expandable, and
 * expanding it lazily fetches + renders that commit's hierarchical diff (the impact header).
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { DiffSummaryResponse } from '@/services/versioningApiService'

const SUMMARY: DiffSummaryResponse = {
  groups: [{
    key: 'DOM', kind: 'container', label: 'Sales', entityType: 'Dataset', status: 'unchanged',
    counts: { added: 1, modified: 0, removed: 0 }, childTotal: 1, deleted: false,
  }],
  groupTotal: 1,
  counts: { added: 1, modified: 0, removed: 0 },
  impact: { Dataset: 1, Table: 1 },
}

const useCommitDiffSummary = vi.fn((_ws?: string, _gid?: string | null, cid?: string | null) => ({
  data: cid ? SUMMARY : undefined,
  isLoading: false,
}))

vi.mock('../../hooks/useVersioning', () => ({
  useCommitLog: () => ({ data: { commits: [] }, isLoading: false }),
  useViewCommitLog: () => ({
    data: { commits: [{ commit_id: 'cmt_1', commit_seq: 2, message: 'Add Sales dataset', actor: 'u@x', created_at: '2024-01-01T00:00:00Z', stats: { create: 1 } }] },
    isLoading: false,
  }),
  useCommitDiffSummary: (ws?: string, gid?: string | null, cid?: string | null) => useCommitDiffSummary(ws, gid, cid),
}))

vi.mock('@/services/versioningApiService', () => ({ getCommitDiffChildren: vi.fn() }))

import { ViewHistoryTimeline } from '../ViewHistoryTimeline'

describe('ViewHistoryTimeline drill-down', () => {
  it('expands a commit to show its hierarchical diff', async () => {
    render(<ViewHistoryTimeline wsId="ws1" graphId="g1" viewId={null} />)

    // commit row renders; diff not fetched until expanded
    expect(screen.getByText('Add Sales dataset')).toBeInTheDocument()
    expect(useCommitDiffSummary).not.toHaveBeenCalledWith('ws1', 'g1', 'cmt_1')
    expect(screen.queryByText(/change/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('Add Sales dataset'))

    // now the commit's diff summary is fetched and rendered (impact header + group)
    expect(useCommitDiffSummary).toHaveBeenCalledWith('ws1', 'g1', 'cmt_1')
    expect(await screen.findByText(/1 change/i)).toBeInTheDocument()
    expect(screen.getByText('Sales')).toBeInTheDocument()
  })
})
