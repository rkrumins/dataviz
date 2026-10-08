/**
 * useVersioning — useRebuildProjection seeds the watermark cache with the response's watermark so an
 * instant rebuild still surfaces a 'rebuilding' observation. Without the seed, the post-invalidate
 * refetch can return already-fresh and the Data Health progress effect hangs at "Rebuilding…".
 */
import React from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi } from 'vitest'
import type { RebuildResponse } from '@/services/versioningApiService'

const rebuildProjection = vi.fn()
const decideBootstrapDuplicates = vi.fn()
vi.mock('@/services/versioningApiService', () => ({
  rebuildProjection: (...args: unknown[]) => rebuildProjection(...args),
  decideBootstrapDuplicates: (...args: unknown[]) => decideBootstrapDuplicates(...args),
}))
vi.mock('@/hooks/useAggregatedLineage', () => ({ invalidateAggregatedEdges: vi.fn() }))

import { useDecideBootstrapDuplicates, useRebuildProjection, VERSIONING_KEYS } from '../useVersioning'

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

    result.current.mutate('fp_1')
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(decideBootstrapDuplicates).toHaveBeenCalledWith('ws1', 'ds1', { fingerprint: 'fp_1' })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: VERSIONING_KEYS.bootstrap('ws1', 'ds1') })
  })

  it('refetches on a refusal too: the list changed, and the user must see the new one', async () => {
    decideBootstrapDuplicates.mockRejectedValue(new Error('stale'))
    const { result, invalidate } = setup()

    result.current.mutate('fp_old')
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: VERSIONING_KEYS.bootstrap('ws1', 'ds1') })
  })
})
