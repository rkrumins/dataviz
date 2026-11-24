/**
 * The "N views" pills read the server's counts, so they keep counting past the
 * 200 rows the hook used to tally from one page of the list.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const getViewCounts = vi.fn()
const listViews = vi.fn()
vi.mock('@/services/viewApiService', () => ({
  getViewCounts: (...a: unknown[]) => getViewCounts(...a),
  listViews: (...a: unknown[]) => listViews(...a),
}))

import { useWorkspaceViewCounts } from './useWorkspaceViewCounts'

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('useWorkspaceViewCounts', () => {
  beforeEach(() => {
    getViewCounts.mockReset()
    listViews.mockReset()
  })

  it('returns the server’s exact counts, past any page size', async () => {
    getViewCounts.mockResolvedValue({
      total: 1250,
      byWorkspace: { ws_fin: 1000, ws_ops: 250 },
      byDataSource: { ds_a: 900, ds_b: 350 },
    })
    const { result } = renderHook(() => useWorkspaceViewCounts(), { wrapper })

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.counts).toEqual({
      total: 1250,
      byWorkspace: { ws_fin: 1000, ws_ops: 250 },
      byDataSource: { ds_a: 900, ds_b: 350 },
    })
    expect(getViewCounts).toHaveBeenCalledTimes(1)
    // Never a page of rows counted in the browser.
    expect(listViews).not.toHaveBeenCalled()
  })

  it('reads as empty while loading and when the counts cannot be read', async () => {
    getViewCounts.mockRejectedValue(new Error('down'))
    const { result } = renderHook(() => useWorkspaceViewCounts(), { wrapper })

    expect(result.current.counts).toEqual({ total: 0, byWorkspace: {}, byDataSource: {} })
    await waitFor(() => expect(result.current.isFetching).toBe(false), { timeout: 3000 })
    expect(result.current.counts).toEqual({ total: 0, byWorkspace: {}, byDataSource: {} })
  })
})
