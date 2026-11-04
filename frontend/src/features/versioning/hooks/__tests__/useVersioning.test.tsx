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
const createFork = vi.fn()
const updateFromParent = vi.fn()
const openForkPullRequest = vi.fn()
const listDataSources = vi.fn()
vi.mock('@/services/versioningApiService', () => ({
  rebuildProjection: (...args: unknown[]) => rebuildProjection(...args),
  decideBootstrapDuplicates: (...args: unknown[]) => decideBootstrapDuplicates(...args),
  rebaseDraft: (...args: unknown[]) => rebaseDraft(...args),
  createFork: (...args: unknown[]) => createFork(...args),
  updateFromParent: (...args: unknown[]) => updateFromParent(...args),
  openForkPullRequest: (...args: unknown[]) => openForkPullRequest(...args),
}))
vi.mock('@/services/workspaceService', () => ({
  workspaceService: { listDataSources: (...args: unknown[]) => listDataSources(...args) },
}))
vi.mock('@/hooks/useAggregatedLineage', () => ({ invalidateAggregatedEdges: vi.fn() }))
vi.mock('@/providers/providerPool', () => ({ releaseProviderCaches: vi.fn(() => 0) }))

import { invalidateAggregatedEdges } from '@/hooks/useAggregatedLineage'
import { releaseProviderCaches } from '@/providers/providerPool'
import { useBranchStore } from '@/store/branchStore'
import {
  useCreateFork, useDataSourcesWithForks, useDecideBootstrapDuplicates, useOpenForkPullRequest, usePullLatestDraft,
  useRebuildProjection, useRefreshDraftFromOthers, useUpdateFromParent, VERSIONING_KEYS,
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

describe('useRefreshDraftFromOthers', () => {
  it('reloads the draft, not main: cached reads dropped, the draft epoch bumped', () => {
    vi.mocked(releaseProviderCaches).mockImplementation(() => {
      expect(useBranchStore.getState().draftEpoch).toBe(draft)   // dropped before the re-key
      return 0
    })
    const { mainEpoch: main, draftEpoch: draft } = useBranchStore.getState()
    const qc = new QueryClient()
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(() => useRefreshDraftFromOthers('ws1', 'g1'), { wrapper })
    result.current('br_1', 7)
    expect(releaseProviderCaches).toHaveBeenCalledTimes(1)
    expect(useBranchStore.getState().draftEpoch).toBe(draft + 1)
    expect(useBranchStore.getState().mainEpoch).toBe(main)
  })
})

describe('the fork hooks', () => {
  beforeEach(() => vi.mocked(invalidateAggregatedEdges).mockClear())

  const setup = <T,>(hook: () => T) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(hook, { wrapper })
    return { result, invalidate }
  }
  const invalidated = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey))

  it('makes a fork, and reads the graph’s forks again so the new one shows', async () => {
    createFork.mockResolvedValue({ graphId: 'g_f', dataSourceId: 'dsfork_1', mainBranchId: 'b', forkBaseCommitSeq: 3 })
    const { result, invalidate } = setup(() => useCreateFork('ws1', 'g1'))
    result.current.mutate({ name: 'Q3' })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(createFork).toHaveBeenCalledWith('ws1', 'g1', { name: 'Q3' })
    expect(invalidated(invalidate)).toContain(JSON.stringify(VERSIONING_KEYS.forks('ws1', 'g1')))
    expect(invalidated(invalidate)).toContain(JSON.stringify(VERSIONING_KEYS.forkSources('ws1')))
  })

  it('refreshes the fork after an update that took changes in: its distance, history and canvas', async () => {
    updateFromParent.mockResolvedValue({ commitId: 'c9', parentSeq: 12, wrote: 3, upToDate: false })
    const epoch = useBranchStore.getState().mainEpoch
    const { result, invalidate } = setup(() => useUpdateFromParent('ws1', 'g_f'))
    result.current.mutate({ resolutions: { n1: null } })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(updateFromParent).toHaveBeenCalledWith('ws1', 'g_f', { resolutions: { n1: null } })
    expect(invalidated(invalidate)).toEqual(expect.arrayContaining([
      JSON.stringify([...VERSIONING_KEYS.all, 'forks']),
      JSON.stringify([...VERSIONING_KEYS.all, 'commits']),
      JSON.stringify(VERSIONING_KEYS.branches('ws1', 'g_f')),
    ]))
    expect(useBranchStore.getState().mainEpoch - epoch).toBe(1)
    expect(invalidateAggregatedEdges).toHaveBeenCalled()
  })

  it('leaves the canvas alone when the fork was up to date', async () => {
    updateFromParent.mockResolvedValue({ commitId: null, parentSeq: 12, wrote: 0, upToDate: true })
    const epoch = useBranchStore.getState().mainEpoch
    const { result } = setup(() => useUpdateFromParent('ws1', 'g_f'))
    result.current.mutate({})
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(useBranchStore.getState().mainEpoch - epoch).toBe(0)
    expect(invalidateAggregatedEdges).not.toHaveBeenCalled()
  })

  it('opens a fork’s review, and reads every list of reviews again', async () => {
    openForkPullRequest.mockResolvedValue({ prId: 'pr_9' })
    const { result, invalidate } = setup(() => useOpenForkPullRequest('ws1', 'g_f'))
    result.current.mutate({ title: 'Q3' })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(openForkPullRequest).toHaveBeenCalledWith('ws1', 'g_f', { title: 'Q3' })
    expect(invalidated(invalidate)).toEqual(expect.arrayContaining([
      JSON.stringify([...VERSIONING_KEYS.all, 'mrs']),
      JSON.stringify([...VERSIONING_KEYS.all, 'dataSourcePrs']),
    ]))
  })

  it('reads the data sources with forks only when asked to', async () => {
    listDataSources.mockResolvedValue([{ id: 'dsfork_1', forkOf: { dataSourceId: 'ds1', graphId: 'g1' } }])
    const off = setup(() => useDataSourcesWithForks('ws1', false))
    expect(off.result.current.fetchStatus).toBe('idle')
    expect(listDataSources).not.toHaveBeenCalled()
    const on = setup(() => useDataSourcesWithForks('ws1', true))
    await waitFor(() => expect(on.result.current.isSuccess).toBe(true))
    expect(listDataSources).toHaveBeenCalledWith('ws1', { includeForks: true })
  })
})
