/**
 * EntityHistory — pins the in-branch history behaviour: a draft's own (unmerged) revisions of an
 * entity show in a distinct "In this draft" group above the published `main` history; each shows
 * what it changed property by property, as the server reports it; a revision published after the
 * draft began is marked; older revisions load on demand, a page at a time.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const rev = (over: Record<string, unknown>) => ({
  id: String(over.commit_id), commit_seq: 1, content_hash: 'h', changes: [], on_draft: false,
  after_branch_point: false, commit_message: null, ...over,
})

const h = vi.hoisted(() => ({
  pages: [] as Array<Record<string, unknown>>,
  hasNextPage: false,
  fetchNextPage: vi.fn(),
  lastOpts: undefined as Record<string, unknown> | undefined,
}))

vi.mock('../../hooks/useVersioning', () => ({
  useEntityHistoryPages: (_w: string, _g: string, _e: string, opts: Record<string, unknown>) => {
    h.lastOpts = opts
    return {
      data: { pages: h.pages }, isLoading: false, isError: false,
      hasNextPage: h.hasNextPage, isFetchingNextPage: false, fetchNextPage: h.fetchNextPage, refetch: vi.fn(),
    }
  },
}))

import { EntityHistory } from '../EntityHistory'

beforeEach(() => {
  h.hasNextPage = false
  h.fetchNextPage.mockReset()
  h.pages = [{
    versions: [
      rev({ commit_id: 'd1', branch_id: 'draft1', op: 'update', actor: 'bob@x', created_at: '2024-02-01T00:00:00Z',
        on_draft: true, changes: [{ path: ['properties', 'owner'], kind: 'changed', before: 'ana', after: 'bo' }] }),
      rev({ commit_id: 'm2', branch_id: 'main', op: 'update', actor: 'system', created_at: '2024-01-15T00:00:00Z',
        after_branch_point: true, commit_message: 'Nightly sync',
        changes: [{ path: ['displayName'], kind: 'changed', before: 'orig', after: 'renamed' }] }),
      rev({ commit_id: 'm1', branch_id: 'main', op: 'create', actor: 'usr_alice123', created_at: '2024-01-01T00:00:00Z',
        changes: [{ path: ['displayName'], kind: 'added', before: null, after: 'orig' }] }),
    ],
    userNames: { usr_alice123: 'Alice Anderson' },
    hasMore: false,
  }]
})

describe('EntityHistory', () => {
  it('shows the draft’s revisions in their own group above published history, and asks for this draft', () => {
    render(<EntityHistory wsId="w" graphId="g" entityId="n" mainBranchId="main" branchId="draft1" />)
    expect(h.lastOpts?.branchId).toBe('draft1')
    expect(screen.getByText(/In this draft/i)).toBeInTheDocument()
    expect(screen.getByText('Published')).toBeInTheDocument()
    expect(screen.getByText('created')).toBeInTheDocument()
  })

  it('asks for main alone when not on a draft', () => {
    render(<EntityHistory wsId="w" graphId="g" entityId="n" mainBranchId="main" branchId="main" />)
    expect(h.lastOpts?.branchId).toBeNull()
  })

  it('shows what each revision changed, property by property', () => {
    render(<EntityHistory wsId="w" graphId="g" entityId="n" mainBranchId="main" branchId="draft1" />)
    expect(screen.getByText('owner')).toBeInTheDocument()
    expect(screen.getByText('ana')).toBeInTheDocument()
    expect(screen.getByText('bo')).toBeInTheDocument()
  })

  it('marks a revision published after the draft began, with its commit message', () => {
    render(<EntityHistory wsId="w" graphId="g" entityId="n" mainBranchId="main" branchId="draft1" />)
    expect(screen.getByText('after your draft began')).toBeInTheDocument()
    expect(screen.getByText('Nightly sync')).toBeInTheDocument()
  })

  it('resolves an actor via userNames and names a platform write "system"', () => {
    render(<EntityHistory wsId="w" graphId="g" entityId="n" mainBranchId="main" branchId={null} />)
    expect(screen.getByText(/by Alice Anderson/)).toBeInTheDocument()
    expect(screen.getByText('by system')).toBeInTheDocument()
    expect(screen.queryByText(/usr_alice123/)).not.toBeInTheDocument()
  })

  it('loads older revisions on demand', async () => {
    h.hasNextPage = true
    render(<EntityHistory wsId="w" graphId="g" entityId="n" mainBranchId="main" branchId={null} />)
    await userEvent.click(screen.getByRole('button', { name: /Show older revisions/ }))
    expect(h.fetchNextPage).toHaveBeenCalledTimes(1)
  })

  it('says when there is no history', () => {
    h.pages = [{ versions: [], hasMore: false }]
    render(<EntityHistory wsId="w" graphId="g" entityId="n" mainBranchId="main" branchId={null} />)
    expect(screen.getByText(/No history for this entity yet/)).toBeInTheDocument()
  })
})
