/**
 * A draft's own saved changes, discarded from its change list: a dry run first, asked when more
 * goes with it than the one chosen, then one restore from the head the dry run read; with a filter,
 * every change shown at once.
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
const api = vi.hoisted(() => ({ getChangeEntries: vi.fn(), getChangeEntry: vi.fn(), restoreDraftChanges: vi.fn() }))
vi.mock('@/services/versioningApiService', async (orig) => ({
  ...(await orig<typeof import('@/services/versioningApiService')>()),
  ...api,
}))
const notify = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))

import { ChangeList } from '../ChangeList'

const NONE = { added: 0, modified: 0, removed: 0 }
const summary: ChangeListSummary = {
  origin: { branchId: 'br_1' }, counts: { ...NONE, added: 2 }, entityCounts: { ...NONE, added: 2 },
  edgeCounts: NONE, structureCounts: NONE, impact: { Table: 2 },
  byType: [{ kind: 'node', type: 'Table', added: 2, modified: 0, removed: 0 }],
  total: 2, listed: 2, approximate: false, tooLarge: null, window: null,
}
const row = (entityId: string, name: string): ChangeListRow => ({
  entityId, kind: 'node', status: 'added', type: 'Table', structural: false, displayName: name,
})

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset())
  notify.mockReset()
  api.getChangeEntries.mockResolvedValue({ entries: [row('T1', 'Orders'), row('T2', 'Sales')], total: 2, offset: 0, limit: 100, hasMore: false })
})

function renderList() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>
    <ChangeList wsId="ws1" graphId="g1" origin={{ branchId: 'br_1' }} summary={summary} restore={{ branchId: 'br_1' }} />
  </QueryClientProvider>)
}

describe('ChangeList — discarding saved changes', () => {
  it('asks when more goes with it, then discards from the head the dry run read', async () => {
    api.restoreDraftChanges
      .mockResolvedValueOnce({ restored: 2, chosen: 1, implied: [{ entityId: 'l1', impliedBy: 'T1' }], impliedCount: 1, dryRun: true, commitId: null, headCommitId: 'h1' })
      .mockResolvedValueOnce({ restored: 2, chosen: 1, implied: [], impliedCount: 1, dryRun: false, commitId: 'c2', headCommitId: 'c2' })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderList()
    fireEvent.click(await screen.findByRole('button', { name: 'Discard the change to Orders' }))
    await waitFor(() => expect(api.restoreDraftChanges).toHaveBeenCalledTimes(2))
    expect(api.restoreDraftChanges.mock.calls[0]).toEqual(['ws1', 'g1', 'br_1', { entityIds: ['T1'], dryRun: true }])
    expect(confirmSpy.mock.calls[0][0]).toMatch(/^Discard Orders from the draft\? 1 change that hold it together go with it\./)
    expect(api.restoreDraftChanges.mock.calls[1]).toEqual(['ws1', 'g1', 'br_1', { entityIds: ['T1'], expectedHeadCommitId: 'h1' }])
    await waitFor(() => expect(notify).toHaveBeenCalledWith('success', 'Discarded 2 changes from the draft.'))
    confirmSpy.mockRestore()
  })

  it('discards one alone without asking; cancelled, discards nothing', async () => {
    api.restoreDraftChanges
      .mockResolvedValueOnce({ restored: 1, chosen: 1, implied: [], impliedCount: 0, dryRun: true, commitId: null, headCommitId: 'h1' })
      .mockResolvedValueOnce({ restored: 1, chosen: 1, implied: [], impliedCount: 0, dryRun: false, commitId: 'c2' })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    renderList()
    fireEvent.click(await screen.findByRole('button', { name: 'Discard the change to Sales' }))
    await waitFor(() => expect(notify).toHaveBeenCalledWith('success', 'Discarded Sales from the draft.'))
    expect(confirmSpy).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it('narrowed, discards every change shown', async () => {
    api.restoreDraftChanges
      .mockResolvedValueOnce({ restored: 2, chosen: 2, implied: [], impliedCount: 0, dryRun: true, commitId: null, headCommitId: 'h1' })
      .mockResolvedValueOnce({ restored: 2, chosen: 2, implied: [], impliedCount: 0, dryRun: false, commitId: 'c2' })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderList()
    fireEvent.change(await screen.findByPlaceholderText(/Search/), { target: { value: 'a' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Discard the 2 shown' }))
    await waitFor(() => expect(api.restoreDraftChanges).toHaveBeenCalledTimes(2))
    expect(api.restoreDraftChanges.mock.calls[0][3]).toMatchObject({ filter: expect.objectContaining({ q: 'a' }), dryRun: true })
    expect(confirmSpy.mock.calls[0][0]).toMatch(/^Discard the 2 changes shown from the draft\?/)
    confirmSpy.mockRestore()
  })
})
