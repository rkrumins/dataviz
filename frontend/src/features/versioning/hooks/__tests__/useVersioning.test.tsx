/**
 * useVersioning — useRebuildProjection seeds the watermark cache with the response's watermark so an
 * instant rebuild still surfaces a 'rebuilding' observation. Without the seed, the post-invalidate
 * refetch can return already-fresh and the Data Health progress effect hangs at "Rebuilding…".
 */
import React from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, it, expect, vi } from 'vitest'
import type { RebuildResponse } from '@/services/versioningApiService'

const rebuildProjection = vi.fn()
const decideBootstrapDuplicates = vi.fn()
const rebaseDraft = vi.fn()
vi.mock('@/services/versioningApiService', () => ({
  rebuildProjection: (...args: unknown[]) => rebuildProjection(...args),
  decideBootstrapDuplicates: (...args: unknown[]) => decideBootstrapDuplicates(...args),
  rebaseDraft: (...args: unknown[]) => rebaseDraft(...args),
}))
vi.mock('@/hooks/useAggregatedLineage', () => ({ invalidateAggregatedEdges: vi.fn() }))

import { invalidateAggregatedEdges } from '@/hooks/useAggregatedLineage'
import { useBranchStore } from '@/store/branchStore'
import {
  useDecideBootstrapDuplicates, usePullLatestDraft, useRebuildProjection, VERSIONING_KEYS,
} from '../useVersioning'

describe('useRebuildProjection', () => {
  it('seeds the watermark cache with the response watermark on success', async () => {
    const rebuilding: RebuildResponse = {
      started: true,
      alreadyRunning: false,
      watermark: { committed: 5, projected: 0, fresh: false, status: 'rebuilding' },
    }
    rebuildProjection.mockResolvedValue(rebuilding)

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(() => useRebuildProjection('ws1', 'g1'), { wrapper })

    result.current.mutate()
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    // The 'rebuilding' watermark is now in the cache (guaranteeing one 'rebuilding' observation),
    // not left to a refetch that could come back already-fresh.
    expect(qc.getQueryData(VERSIONING_KEYS.projectionWatermark('ws1', 'g1'))).toEqual(
      rebuilding.watermark,
    )
  })
})

describe('useDecideBootstrapDuplicates', () => {
  const setup = () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(() => useDecideBootstrapDuplicates('ws1', 'ds1'), { wrapper })
    return { result, invalidate }
  }

  it('sends the fingerprint of the list shown, then refetches the job so its progress shows', async () => {
    decideBootstrapDuplicates.mockResolvedValue({ jobId: 'vjob_1', status: 'pending' })
    const { result, invalidate } = setup()

    result.current.mutate({ fingerprint: 'fp_1', reason: 'Source loaded twice' })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(decideBootstrapDuplicates).toHaveBeenCalledWith(
      'ws1', 'ds1', { fingerprint: 'fp_1' }, { reason: 'Source loaded twice' },
    )
    expect(invalidate).toHaveBeenCalledWith({ queryKey: VERSIONING_KEYS.bootstrap('ws1', 'ds1') })
  })

  it('refetches on a refusal too: the list changed, and the user must see the new one', async () => {
    decideBootstrapDuplicates.mockRejectedValue(new Error('stale'))
    const { result, invalidate } = setup()

    result.current.mutate({ fingerprint: 'fp_old' })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: VERSIONING_KEYS.bootstrap('ws1', 'ds1') })
  })
})

describe('usePullLatestDraft', () => {
  beforeEach(() => vi.mocked(invalidateAggregatedEdges).mockClear())

  const pull = async (res: Record<string, unknown>) => {
    rebaseDraft.mockResolvedValue(res)
    const epoch = useBranchStore.getState().mainEpoch
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(() => usePullLatestDraft('ws1', 'g1'), { wrapper })
    result.current.mutate({ branchId: 'br_1' })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    return useBranchStore.getState().mainEpoch - epoch
  }

  it('refreshes the canvas after a pull that brought changes in, as publish does', async () => {
    expect(await pull({ clean: true, conflicts: [], alreadyUpToDate: false })).toBe(1)
    expect(invalidateAggregatedEdges).toHaveBeenCalled()
  })

  it('leaves the canvas alone when the pull changed nothing or stopped on conflicts', async () => {
    expect(await pull({ clean: true, conflicts: [], alreadyUpToDate: true })).toBe(0)
    expect(await pull({ clean: false, conflicts: [{ entity_id: 'A' }] })).toBe(0)
    expect(invalidateAggregatedEdges).not.toHaveBeenCalled()
  })
})
