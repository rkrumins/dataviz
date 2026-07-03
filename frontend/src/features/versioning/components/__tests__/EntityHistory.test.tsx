/**
 * EntityHistory — pins the in-branch history behaviour: a draft's own (unmerged) commits for an
 * entity show in a distinct "In this draft" group above the published `main` history, and with no
 * active draft only the published history shows (back-compat).
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const versions = [
  { commit_id: 'm1', commit_seq: 1, branch_id: 'main', op: 'create', actor: 'usr_alice123', created_at: '2024-01-01T00:00:00Z', payload: { urn: 'n', entityType: 'dataset', displayName: 'orig' } },
  { commit_id: 'd1', commit_seq: 1, branch_id: 'draft1', op: 'update', actor: 'bob@x', created_at: '2024-02-01T00:00:00Z', payload: { urn: 'n', entityType: 'dataset', displayName: 'my edit' } },
]

vi.mock('../../hooks/useVersioning', () => ({
  useEntityHistory: () => ({ data: { versions, userNames: { usr_alice123: 'Alice Anderson' } }, isLoading: false }),
  useBranches: () => ({ data: [{ branchId: 'draft1', baseCommitSeq: 1 }] }),
}))

import { EntityHistory } from '../EntityHistory'

describe('EntityHistory', () => {
  it('shows the draft branch commits in their own group above published history', () => {
    render(<EntityHistory wsId="w" graphId="g" entityId="n" mainBranchId="main" branchId="draft1" />)
    expect(screen.getByText(/In this draft/i)).toBeInTheDocument()
    expect(screen.getByText('Published')).toBeInTheDocument()
    expect(screen.getByText('updated')).toBeInTheDocument() // the draft edit
    expect(screen.getByText('created')).toBeInTheDocument() // the published create
  })

  it('shows only published history when not on a draft (back-compat)', () => {
    render(<EntityHistory wsId="w" graphId="g" entityId="n" mainBranchId="main" branchId={null} />)
    expect(screen.queryByText(/In this draft/i)).not.toBeInTheDocument()
    expect(screen.getByText('created')).toBeInTheDocument()
  })

  it('resolves a version actor via userNames, and falls back to Unknown when unresolved', () => {
    render(<EntityHistory wsId="w" graphId="g" entityId="n" mainBranchId="main" branchId={null} />)
    expect(screen.getByText(/by Alice Anderson/)).toBeInTheDocument()
    expect(screen.queryByText(/usr_alice123/)).not.toBeInTheDocument()
  })
})
