import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { ChangeListPage, ChangeListSummary } from '@/services/versioningApiService'

// jsdom has no layout: lay every item out, so the list's rows and its "near the end" paging run.
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
  getChangeSummary: vi.fn(),
  getChangeEntries: vi.fn(),
  getChangeEntry: vi.fn(),
}))
vi.mock('@/services/versioningApiService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/versioningApiService')>()),
  ...api,
}))

import { ChangeList } from '../ChangeList'

const NONE = { added: 0, modified: 0, removed: 0 }

function summary(over: Partial<ChangeListSummary> = {}): ChangeListSummary {
  return {
    origin: { branchId: 'br_1' }, counts: { added: 3, modified: 1, removed: 1 },
    entityCounts: { added: 2, modified: 1, removed: 1 }, edgeCounts: { ...NONE, added: 1 }, structureCounts: NONE,
    impact: { Table: 3, Column: 1 },
    byType: [
      { kind: 'node', type: 'Table', added: 2, modified: 1, removed: 0 },
      { kind: 'node', type: 'Column', added: 0, modified: 0, removed: 1 },
      { kind: 'edge', type: 'FLOWS_TO', added: 1, modified: 0, removed: 0 },
    ],
    total: 5, listed: 5, approximate: false, tooLarge: null, window: null, ...over,
  }
}

const row = (entityId: string, status: 'added' | 'modified' | 'removed', type: string, name: string) => ({
  entityId, kind: 'node' as const, status, type, structural: false, displayName: name, urn: `urn:${name}`,
})

function page(entries: ChangeListPage['entries'], offset: number, total: number): ChangeListPage {
  return { entries, total, offset, limit: 100, hasMore: offset + entries.length < total }
}

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

beforeEach(() => {
  api.getChangeSummary.mockReset()
  api.getChangeEntries.mockReset()
  api.getChangeEntry.mockReset()
})

describe('ChangeList', () => {
  it('lists a page, names each type once, and fetches the next page as it nears the end', async () => {
    api.getChangeSummary.mockResolvedValue(summary())
    api.getChangeEntries
      .mockResolvedValueOnce(page([row('c1', 'removed', 'Column', 'amount')], 0, 4))
      .mockResolvedValueOnce(page([row('t1', 'modified', 'Table', 'customers'), row('t2', 'added', 'Table', 'orders'),
        row('t3', 'added', 'Table', 'payments')], 1, 4))
    wrap(<ChangeList wsId="ws1" graphId="g1" origin={{ branchId: 'br_1' }} />)

    expect(await screen.findByText('payments')).toBeInTheDocument()
    expect(screen.getByText('amount')).toBeInTheDocument()
    // One header per run of a type, with how many of that type changed.
    expect(screen.getAllByText('Table')).toHaveLength(1)
    expect(screen.getByText('Column')).toBeInTheDocument()
    // The second page was asked for from where the first ended.
    expect(api.getChangeEntries).toHaveBeenNthCalledWith(2, 'ws1', 'g1', { branchId: 'br_1' },
      expect.objectContaining({ kind: 'node' }), 1, 100)
    expect(screen.getByText('4 entities')).toBeInTheDocument()
  })

  it('narrows by kind and status, asking the server for exactly that', async () => {
    api.getChangeSummary.mockResolvedValue(summary())
    api.getChangeEntries.mockResolvedValue(page([row('t2', 'added', 'Table', 'orders')], 0, 1))
    const user = userEvent.setup()
    wrap(<ChangeList wsId="ws1" graphId="g1" origin={{ fromSeq: 3, toSeq: 9 }} />)
    await screen.findByText('orders')

    await user.click(screen.getByRole('radio', { name: /Relationships/ }))
    await waitFor(() => expect(api.getChangeEntries).toHaveBeenLastCalledWith(
      'ws1', 'g1', { fromSeq: 3, toSeq: 9 }, expect.objectContaining({ kind: 'edge' }), 0, 100))

    const statuses = screen.getByRole('group', { name: /Show changes that were/ })
    await user.click(within(statuses).getByRole('button', { name: /Added/ }))
    await waitFor(() => expect(api.getChangeEntries).toHaveBeenLastCalledWith(
      'ws1', 'g1', { fromSeq: 3, toSeq: 9 }, expect.objectContaining({ kind: 'edge', statuses: ['added'] }), 0, 100))
  })

  it('opens a row to its before and after, fetched for that row alone', async () => {
    api.getChangeSummary.mockResolvedValue(summary())
    api.getChangeEntries.mockResolvedValue(page([row('t1', 'modified', 'Table', 'customers')], 0, 1))
    api.getChangeEntry.mockResolvedValue({
      entityId: 't1', kind: 'node', status: 'modified',
      before: { displayName: 'customers', owner: 'ana' }, after: { displayName: 'customers', owner: 'bo' },
    })
    const user = userEvent.setup()
    wrap(<ChangeList wsId="ws1" graphId="g1" origin={{ branchId: 'br_1' }} />)

    await user.click(await screen.findByRole('button', { name: /customers/ }))
    expect(await screen.findByText('bo')).toBeInTheDocument()
    expect(api.getChangeEntry).toHaveBeenCalledWith('ws1', 'g1', { branchId: 'br_1' }, 't1')
  })

  it('says how much changed when there is too much to list', async () => {
    api.getChangeSummary.mockResolvedValue(summary({
      counts: { added: 300_000, modified: 0, removed: 0 }, entityCounts: null, edgeCounts: null, structureCounts: null,
      byType: [], total: 300_000, listed: 0, approximate: true, tooLarge: { changed: 300_000, limit: 250_000 },
    }))
    wrap(<ChangeList wsId="ws1" graphId="g1" origin={{ fromSeq: 1, toSeq: 40 }} />)
    expect(await screen.findByText('About 300,000 changes')).toBeInTheDocument()
    expect(screen.getByText(/more than a list here shows/)).toBeInTheDocument()
    expect(api.getChangeEntries).not.toHaveBeenCalled()
  })

  it('says so when nothing changed', async () => {
    api.getChangeSummary.mockResolvedValue(summary({ counts: NONE, entityCounts: NONE, edgeCounts: NONE, total: 0, listed: 0, byType: [] }))
    wrap(<ChangeList wsId="ws1" graphId="g1" origin={{ branchId: 'br_1' }} emptyHint="Nothing in this draft yet." />)
    expect(await screen.findByText('Nothing in this draft yet.')).toBeInTheDocument()
  })
})
