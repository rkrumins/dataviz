/**
 * Browsing a change list: each row says what it changed before it is opened; opened, its key
 * differences show from that summary with nothing fetched; all of its fields are a step further.
 * Expand all opens every row shown; J/K move between rows and → / ← open and close them.
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

import { ChangeList } from '../ChangeList'

const NONE = { added: 0, modified: 0, removed: 0 }
const summary: ChangeListSummary = {
  origin: { branchId: 'br_1' }, counts: { ...NONE, modified: 2 }, entityCounts: { ...NONE, modified: 2 },
  edgeCounts: NONE, structureCounts: NONE, impact: { Table: 2 },
  byType: [{ kind: 'node', type: 'Table', added: 0, modified: 2, removed: 0 }],
  total: 2, listed: 2, approximate: false, tooLarge: null, window: null,
}
const row = (entityId: string, name: string): ChangeListRow => ({
  entityId, kind: 'node', status: 'modified', type: 'Table', structural: false, displayName: name,
  fields: {
    changed: 2, added: 1, removed: 0, total: 9,
    top: [
      { label: 'owner', kind: 'changed', before: 'ana', after: 'bo' },
      { label: 'tier', kind: 'changed', before: 'silver', after: 'gold' },
      { label: 'steward', kind: 'added', before: null, after: 'cy' },
    ],
  },
})

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset())
  api.getChangeEntries.mockResolvedValue({ entries: [row('T1', 'Orders'), row('T2', 'Sales')], total: 2, offset: 0, limit: 100, hasMore: false })
  api.getChangeEntry.mockResolvedValue({ entityId: 'T1', kind: 'node', status: 'modified',
    before: { displayName: 'Orders', properties: { owner: 'ana' } }, after: { displayName: 'Orders', properties: { owner: 'bo' } } })
})

function renderList() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>
    <ChangeList wsId="ws1" graphId="g1" origin={{ branchId: 'br_1' }} summary={summary} />
  </QueryClientProvider>)
}

describe('ChangeList — summary, key differences, everything', () => {
  it('says what each change did before it is opened, and opens to its key differences without fetching', async () => {
    renderList()
    expect(await screen.findAllByText('Edited owner, tier, steward and 6 more')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: /^Orders/ }))
    expect(await screen.findByText('gold')).toBeInTheDocument()
    expect(api.getChangeEntry).not.toHaveBeenCalled()
    // A step further: every field, read for this change alone.
    fireEvent.click(screen.getByRole('button', { name: 'Show all 9 fields' }))
    await waitFor(() => expect(api.getChangeEntry).toHaveBeenCalledWith('ws1', 'g1', { branchId: 'br_1' }, 'T1'))
  })

  it('opens every row shown at once, and closes them again', async () => {
    renderList()
    fireEvent.click(await screen.findByRole('button', { name: 'Expand all' }))
    expect(screen.getAllByText('gold')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }))
    expect(screen.queryByText('gold')).not.toBeInTheDocument()
  })

  it('moves between rows and opens them by keyboard', async () => {
    renderList()
    const first = await screen.findByRole('button', { name: /^Orders/ })
    first.focus()
    fireEvent.keyDown(first, { key: 'j' })
    const second = screen.getByRole('button', { name: /^Sales/ })
    await waitFor(() => expect(second).toHaveFocus())
    fireEvent.keyDown(second, { key: 'ArrowRight' })
    expect(second).toHaveAttribute('aria-expanded', 'true')
    fireEvent.keyDown(second, { key: 'ArrowLeft' })
    expect(second).toHaveAttribute('aria-expanded', 'false')
  })
})
