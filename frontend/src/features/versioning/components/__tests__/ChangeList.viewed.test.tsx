/**
 * A reviewer's own Viewed ticks: tick a change (or `v`, which moves on to the next), see how many
 * are viewed, find it remembered for the review — and a change that moved on since reads Changed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ChangeListRow, ChangeListSummary } from '@/services/versioningApiService'

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number; getItemKey?: (i: number) => string | number }) => ({
    getVirtualItems: () => Array.from({ length: opts.count }, (_, index) => ({
      index, key: opts.getItemKey ? opts.getItemKey(index) : index, start: index * 54, size: 54,
    })),
    getTotalSize: () => opts.count * 54,
    measureElement: () => undefined,
    scrollToIndex: () => undefined,
  }),
}))
const api = vi.hoisted(() => ({ getChangeEntries: vi.fn(), getChangeEntry: vi.fn() }))
vi.mock('@/services/versioningApiService', async (orig) => ({
  ...(await orig<typeof import('@/services/versioningApiService')>()),
  ...api,
}))
vi.mock('@/features/reviews/comments/useReviewComments', () => ({
  useReviewCommentCounts: () => ({ data: undefined }),
  useReviewThreads: () => ({ data: undefined }),
}))

import { ChangeList } from '../ChangeList'

const NONE = { added: 0, modified: 0, removed: 0 }
const summary: ChangeListSummary = {
  origin: { branchId: 'br_1' }, counts: { ...NONE, modified: 2 }, entityCounts: { ...NONE, modified: 2 },
  edgeCounts: NONE, structureCounts: NONE, impact: { Table: 2 },
  byType: [{ kind: 'node', type: 'Table', added: 0, modified: 2, removed: 0 }],
  total: 2, listed: 2, approximate: false, tooLarge: null, window: null,
}
const row = (entityId: string, name: string, after = 'bo'): ChangeListRow => ({
  entityId, kind: 'node', status: 'modified', type: 'Table', structural: false, displayName: name,
  fields: { changed: 1, added: 0, removed: 0, total: 1, top: [{ label: 'owner', kind: 'changed', before: 'ana', after }] },
})

beforeEach(() => {
  window.localStorage.clear()
  Object.values(api).forEach((f) => f.mockReset())
  api.getChangeEntries.mockResolvedValue({ entries: [row('T1', 'Orders'), row('T2', 'Sales')], total: 2, offset: 0, limit: 100, hasMore: false })
})

function renderList() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>
    <ChangeList wsId="ws1" graphId="g1" origin={{ branchId: 'br_1' }} summary={summary}
      review={{ prId: 'pr1', canComment: false, canResolve: false } as never} />
  </QueryClientProvider>)
}

describe('ChangeList — Viewed', () => {
  it('ticks a change viewed, v ticks and moves on, and the count says how far', async () => {
    renderList()
    fireEvent.click(await screen.findByRole('button', { name: 'Mark Orders viewed' }))
    expect(screen.getByRole('button', { name: 'Orders viewed' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText(/1 viewed/)).toBeInTheDocument()
    fireEvent.keyDown(document.getElementById('change-row-T1')!, { key: 'j' })
    fireEvent.keyDown(document.getElementById('change-row-T2')!, { key: 'v' })
    expect(screen.getByRole('button', { name: 'Sales viewed' })).toBeInTheDocument()
    expect(screen.getByText(/2 viewed/)).toBeInTheDocument()
    expect(JSON.parse(window.localStorage.getItem('nexus-viewed:pr1')!)).toHaveProperty('T2')
  })

  it('lists the keys it answers to — a review\'s own among them', async () => {
    renderList()
    const keys = await screen.findByRole('button', { name: 'Keyboard shortcuts' })
    fireEvent.focus(keys)
    expect(await screen.findByText('Mark it viewed, then the next')).toBeInTheDocument()
    expect(screen.getByText('Next / previous change')).toBeInTheDocument()
    expect(screen.getByText('Its discussion')).toBeInTheDocument()
  })

  it('a change that moved on since it was viewed reads Changed, unticked', async () => {
    renderList()
    fireEvent.click(await screen.findByRole('button', { name: 'Mark Orders viewed' }))
    const seen = window.localStorage.getItem('nexus-viewed:pr1')
    api.getChangeEntries.mockResolvedValue({ entries: [row('T1', 'Orders', 'cy'), row('T2', 'Sales')], total: 2, offset: 0, limit: 100, hasMore: false })
    window.localStorage.setItem('nexus-viewed:pr1', seen!)
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={qc}>
      <ChangeList wsId="ws1" graphId="g1" origin={{ branchId: 'br_2' }} summary={summary}
        review={{ prId: 'pr1', canComment: false, canResolve: false } as never} />
    </QueryClientProvider>)
    await waitFor(() => expect(screen.getAllByText('Changed').length).toBeGreaterThan(0))
  })
})
