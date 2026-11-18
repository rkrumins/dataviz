/**
 * EntityHistory — pins the in-branch history behaviour: a draft's own (unmerged) revisions of an
 * entity show in a distinct "In this draft" group above the published `main` history; each shows
 * what it changed property by property, as the server reports it; a revision published after the
 * draft began is marked; older revisions load on demand, a page at a time.
 */
import { render as rtlRender, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement, ReactNode } from 'react'
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
  revision: { data: undefined, isLoading: false, isError: false, refetch: vi.fn() } as Record<string, unknown>,
  summary: { data: undefined, isLoading: false, isError: false, refetch: vi.fn() } as Record<string, unknown>,
}))

vi.mock('../../hooks/useVersioning', () => ({
  useEntityHistoryPages: (_w: string, _g: string, _e: string, opts: Record<string, unknown>) => {
    h.lastOpts = opts
    return {
      data: { pages: h.pages }, isLoading: false, isError: false,
      hasNextPage: h.hasNextPage, isFetchingNextPage: false, fetchNextPage: h.fetchNextPage, refetch: vi.fn(),
    }
  },
  useEntityRevision: () => h.revision,
  useEntitySummary: () => h.summary,
}))

import { EntityHistory } from '../EntityHistory'

// A person is named by the chip that names people, which reads through react-query.
const render = (ui: ReactElement) => rtlRender(ui, {
  wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>,
})

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

  it('says in one line what each revision changed, and opens to the values', async () => {
    render(<EntityHistory wsId="w" graphId="g" entityId="n" mainBranchId="main" branchId="draft1" />)
    // Collapsed: the summary names what changed, the values wait.
    expect(screen.getAllByText(/Edited owner/).length).toBeGreaterThan(0)
    expect(screen.queryByText('ana')).not.toBeInTheDocument()
    const [first] = screen.getAllByRole('button', { expanded: false })
    await userEvent.click(first)
    expect(screen.getByText('ana')).toBeInTheDocument()
    expect(screen.getByText('bo')).toBeInTheDocument()
  })

  it('opens every revision shown, and moves between them by keyboard', async () => {
    render(<EntityHistory wsId="w" graphId="g" entityId="n" mainBranchId="main" branchId="draft1" />)
    await userEvent.click(screen.getByRole('button', { name: 'Expand all' }))
    expect(screen.getAllByRole('button', { expanded: true }).length).toBeGreaterThan(1)
    await userEvent.click(screen.getByRole('button', { name: 'Collapse all' }))
    expect(screen.queryAllByRole('button', { expanded: true })).toHaveLength(0)
    const rows = screen.getAllByRole('button', { expanded: false })
    rows[0].focus()
    await userEvent.keyboard('j')
    expect(rows[1]).toHaveFocus()
    await userEvent.keyboard('{ArrowRight}')
    expect(rows[1]).toHaveAttribute('aria-expanded', 'true')
  })

  it('marks a revision published after the draft began, with its commit message', () => {
    render(<EntityHistory wsId="w" graphId="g" entityId="n" mainBranchId="main" branchId="draft1" />)
    expect(screen.getByText('after your draft began')).toBeInTheDocument()
    expect(screen.getByText('Nightly sync')).toBeInTheDocument()
  })

  it('resolves an actor via userNames and names a platform write "system"', () => {
    render(<EntityHistory wsId="w" graphId="g" entityId="n" mainBranchId="main" branchId={null} />)
    expect(screen.getByText('Alice Anderson')).toBeInTheDocument()
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

describe('EntityHistory — each revision, richer', () => {
  const node = (props: Record<string, unknown>) => ({ kind: 'node', version: 'v', node: { id: 'n', urn: 'n', displayName: 'Orders', entityType: 'dataset', properties: props } })

  it('asks for the relationship history of a relationship', () => {
    render(<EntityHistory wsId="w" graphId="g" entityId="e" mainBranchId="main" branchId={null} kind="edge" />)
    expect(h.lastOpts?.kind).toBe('edge')
  })

  it('says what kind of change it was and why, under a heading for its day', () => {
    h.pages = [{ versions: [rev({ commit_id: 'p1', op: 'update', actor: 'system', created_at: '2024-03-05T10:00:00Z',
      commit_kind: 'squash_publish', change_reason: 'Quarterly certification', changes: [] })], hasMore: false }]
    render(<EntityHistory wsId="w" graphId="g" entityId="n" mainBranchId="main" branchId={null} />)
    expect(screen.getByText('published')).toBeInTheDocument()
    expect(screen.getByText('Why: Quarterly certification')).toBeInTheDocument()
    expect(screen.getByText(new Date('2024-03-05T10:00:00Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }))).toBeInTheDocument()
  })

  it('shows the entity as it was after a revision', async () => {
    h.revision = { data: { id: 'm1', value: node({ owner: 'ana', tier: 'gold' }), userNames: {} }, isLoading: false, isError: false, refetch: vi.fn() }
    render(<EntityHistory wsId="w" graphId="g" entityId="n" mainBranchId="main" branchId={null} />)
    await userEvent.click(screen.getAllByRole('button', { expanded: false })[0])
    await userEvent.click(screen.getByRole('radio', { name: 'As it was' }))
    expect(screen.getByText(/As of/)).toBeInTheDocument()
    expect(screen.getByText('Orders')).toBeInTheDocument()
    expect(screen.getByText('owner')).toBeInTheDocument()
    expect(screen.getByText('gold')).toBeInTheDocument()
  })

  it('compares a revision with now — or says nothing has changed since', async () => {
    h.revision = { data: { id: 'm1', value: node({ owner: 'ana' }) }, isLoading: false, isError: false, refetch: vi.fn() }
    h.summary = { data: { value: node({ owner: 'bo' }) }, isLoading: false, isError: false, refetch: vi.fn() }
    const { unmount } = render(<EntityHistory wsId="w" graphId="g" entityId="n" mainBranchId="main" branchId={null} />)
    await userEvent.click(screen.getAllByRole('button', { expanded: false })[0])
    await userEvent.click(screen.getByRole('radio', { name: 'Compared with now' }))
    expect(screen.getByText(/then → now/)).toBeInTheDocument()
    expect(screen.getByText('ana')).toBeInTheDocument()
    expect(screen.getByText('bo')).toBeInTheDocument()
    unmount()

    h.summary = { data: { value: node({ owner: 'ana' }) }, isLoading: false, isError: false, refetch: vi.fn() }
    render(<EntityHistory wsId="w" graphId="g" entityId="n" mainBranchId="main" branchId={null} />)
    await userEvent.click(screen.getAllByRole('button', { expanded: false })[0])
    await userEvent.click(screen.getByRole('radio', { name: 'Compared with now' }))
    expect(screen.getByText(/Identical to now/)).toBeInTheDocument()
  })

  it('offers Try again when a revision cannot be read', async () => {
    const refetch = vi.fn()
    h.revision = { data: undefined, isLoading: false, isError: true, refetch }
    render(<EntityHistory wsId="w" graphId="g" entityId="n" mainBranchId="main" branchId={null} />)
    await userEvent.click(screen.getAllByRole('button', { expanded: false })[0])
    await userEvent.click(screen.getByRole('radio', { name: 'As it was' }))
    await userEvent.click(screen.getByRole('button', { name: /Try again/ }))
    expect(refetch).toHaveBeenCalled()
  })
})
