/**
 * In a review, each change carries its discussion: a count on rows with threads, and, opened,
 * its threads under what changed — with Comment on any one field of it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ChangeListSummary } from '@/services/versioningApiService'

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
  getChangeEntries: vi.fn(),
  getChangeEntry: vi.fn(),
  getReviewCommentCounts: vi.fn(),
  listReviewThreads: vi.fn(),
  postReviewComment: vi.fn(),
}))
vi.mock('@/services/versioningApiService', async (orig) => ({
  ...(await orig<typeof import('@/services/versioningApiService')>()),
  ...api,
}))
vi.mock('@/store/auth', () => ({ useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { id: 'u_me' } }) }))

import { ChangeList } from '../ChangeList'

const NONE = { added: 0, modified: 0, removed: 0 }
const summary: ChangeListSummary = {
  origin: { branchId: 'br_1' }, counts: { ...NONE, modified: 2 }, entityCounts: { ...NONE, modified: 2 },
  edgeCounts: NONE, structureCounts: NONE, impact: { Table: 2 },
  byType: [{ kind: 'node', type: 'Table', added: 0, modified: 2, removed: 0 }],
  total: 2, listed: 2, approximate: false, tooLarge: null, window: null,
}
const row = (entityId: string, name: string) => ({
  entityId, kind: 'node' as const, status: 'modified' as const, type: 'Table', structural: false, displayName: name,
})

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset())
  api.getChangeEntries.mockResolvedValue({ entries: [row('T1', 'Orders'), row('T2', 'Sales')], total: 2, offset: 0, limit: 100, hasMore: false })
  api.getReviewCommentCounts.mockResolvedValue({ entities: { T1: { open: 2, total: 3 } }, general: { open: 0, total: 0 }, open: 2 })
  api.getChangeEntry.mockResolvedValue({
    entityId: 'T1', kind: 'node', status: 'modified',
    before: { displayName: 'Orders', description: 'old' }, after: { displayName: 'Orders', description: 'new' },
  })
  api.listReviewThreads.mockResolvedValue({ threads: [], total: 0, offset: 0, limit: 20, hasMore: false, userNames: {} })
  api.postReviewComment.mockResolvedValue({})
})

function renderList() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ChangeList wsId="ws1" graphId="g1" origin={{ branchId: 'br_1' }} summary={summary}
        review={{ prId: 'pr_1', canComment: true, canModerate: false }} />
    </QueryClientProvider>,
  )
}

describe('ChangeList — in a review', () => {
  it('counts the open threads on each change that has any', async () => {
    renderList()
    expect(await screen.findByLabelText('2 open threads')).toBeInTheDocument()
    const sales = screen.getByRole('button', { name: /Sales/ })
    expect(within(sales).queryByLabelText(/thread/)).not.toBeInTheDocument()
  })

  it('opens a change with its threads, and comments on one field of it', async () => {
    renderList()
    fireEvent.click(await screen.findByRole('button', { name: /Orders/ }))
    // Opened: its key differences first; its discussion one step further.
    fireEvent.click(await screen.findByRole('button', { name: /on this change$/ }))
    await waitFor(() => expect(api.listReviewThreads).toHaveBeenCalledWith('ws1', 'pr_1', { entityId: 'T1' }, 0, 20))
    fireEvent.click(await screen.findByRole('button', { name: 'Comment on Description' }))
    expect(screen.getByText('Commenting on')).toBeInTheDocument()
    const box = screen.getByRole('combobox', { name: 'Comment on Description…' })
    fireEvent.change(box, { target: { value: 'Why?' } })
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true })
    await waitFor(() => expect(api.postReviewComment).toHaveBeenCalledWith('ws1', 'pr_1',
      { body: 'Why?', mentions: [], entityId: 'T1', path: 'Description' }))
    // Posted: the next comment is on the whole change again.
    expect(await screen.findByRole('combobox', { name: 'Comment on this change…' })).toBeInTheDocument()
  })
})
