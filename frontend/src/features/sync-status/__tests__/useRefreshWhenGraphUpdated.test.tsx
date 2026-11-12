/**
 * useRefreshWhenGraphUpdated — while a versioned graph is updated, views show the version it last
 * finished; when the newer one is in (behind → in sync), the view refetches it: main's epoch moves
 * (hydration and schema) and the aggregated connections are dropped. Once per update, never on a
 * view that just switched to another source. The status read and the stores are mocked.
 */
import type { ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncStatus } from '../syncStatusApi'

const bumpMainEpoch = vi.fn()
const invalidateAggregatedEdges = vi.fn()
const fresh: Record<string, boolean> = {}

vi.mock('../syncStatusApi', () => ({
  getSyncStatus: vi.fn(async (_ws: string, ds: string): Promise<SyncStatus> => ({
    kind: 'versioned', dataSourceId: ds, checkedAt: '',
    versioned: { graphId: 'g', committed: 12, projected: fresh[ds] ? 12 : 10, fresh: fresh[ds], status: 'projecting',
      served: fresh[ds] ? 12 : 10 },
  })),
}))
vi.mock('@/hooks/useAggregatedLineage', () => ({ invalidateAggregatedEdges: () => invalidateAggregatedEdges() }))
vi.mock('@/store/branchStore', () => ({ useBranchStore: { getState: () => ({ bumpMainEpoch }) } }))

import { useRefreshWhenGraphUpdated } from '../useSyncStatus'

function setup(initialDs: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  const hook = renderHook(({ ds }) => useRefreshWhenGraphUpdated('ws1', ds, 'v1'), { wrapper, initialProps: { ds: initialDs } })
  return { qc, ...hook }
}

beforeEach(() => {
  bumpMainEpoch.mockClear()
  invalidateAggregatedEdges.mockClear()
  for (const k of Object.keys(fresh)) delete fresh[k]
})

describe('useRefreshWhenGraphUpdated', () => {
  it('refetches the view once when the graph it shows finishes its update', async () => {
    fresh.ds1 = false
    const { qc } = setup('ds1')
    await waitFor(() => expect(qc.getQueryState(['sync-status', 'ws1', 'ds1'])?.status).toBe('success'))
    expect(bumpMainEpoch).not.toHaveBeenCalled()

    fresh.ds1 = true
    await act(() => qc.refetchQueries({ queryKey: ['sync-status'] }))
    await waitFor(() => expect(bumpMainEpoch).toHaveBeenCalledTimes(1))
    expect(invalidateAggregatedEdges).toHaveBeenCalledTimes(1)

    // Still in sync on the next read: nothing more to bring in.
    await act(() => qc.refetchQueries({ queryKey: ['sync-status'] }))
    expect(bumpMainEpoch).toHaveBeenCalledTimes(1)
  })

  it('does not refetch for a view that switched from a graph behind to another, in sync', async () => {
    fresh.ds1 = false
    fresh.ds2 = true
    const { qc, rerender } = setup('ds1')
    await waitFor(() => expect(qc.getQueryState(['sync-status', 'ws1', 'ds1'])?.status).toBe('success'))
    rerender({ ds: 'ds2' })
    await waitFor(() => expect(qc.getQueryState(['sync-status', 'ws1', 'ds2'])?.status).toBe('success'))
    expect(bumpMainEpoch).not.toHaveBeenCalled()
    expect(invalidateAggregatedEdges).not.toHaveBeenCalled()
  })
})
