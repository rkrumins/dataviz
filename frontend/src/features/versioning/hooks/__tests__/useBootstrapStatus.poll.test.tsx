/**
 * useBootstrapStatus follows the enablement job at the pace every job is followed at
 * (`jobPollDelayMs`, by how many answers it has had: often at first, less as the copy proves
 * long), and stops asking once the job ends.
 */
import React from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import type { BootstrapJob } from '@/services/versioningApiService'

const getBootstrapStatus = vi.fn()
vi.mock('@/services/versioningApiService', () => ({
  getBootstrapStatus: (...args: unknown[]) => getBootstrapStatus(...args),
}))
vi.mock('@/hooks/useAggregatedLineage', () => ({ invalidateAggregatedEdges: vi.fn() }))
const jobPollDelayMs = vi.fn((_tick: number) => 5)
vi.mock('@/config/polling', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/config/polling')>(),
  jobPollDelayMs: (tick: number) => jobPollDelayMs(tick),
}))

import { useBootstrapStatus } from '../useVersioning'

const job = (status: BootstrapJob['status']): BootstrapJob => ({
  jobId: 'vjob_1', graphId: 'g1', status, phase: 'nodes', processed: 1, total: 10, percent: 10,
})

describe('useBootstrapStatus', () => {
  it('asks at the job pace, by answers so far, and stops once the job ends', async () => {
    getBootstrapStatus
      .mockResolvedValueOnce(job('pending'))
      .mockResolvedValueOnce(job('running'))
      .mockResolvedValueOnce(job('running'))
      .mockResolvedValue(job('completed'))
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(() => useBootstrapStatus('ws1', 'ds1'), { wrapper })

    await waitFor(() => expect(result.current.data?.status).toBe('completed'))
    expect(new Set(jobPollDelayMs.mock.calls.map(([tick]) => tick))).toEqual(new Set([1, 2, 3]))
    await new Promise((r) => setTimeout(r, 50))
    expect(getBootstrapStatus).toHaveBeenCalledTimes(4)
  })

  it('does not ask while the job is paused for a decision: nothing moves until someone decides', async () => {
    getBootstrapStatus.mockReset().mockResolvedValue(job('needs_decision'))
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(() => useBootstrapStatus('ws1', 'ds1'), { wrapper })

    await waitFor(() => expect(result.current.data?.status).toBe('needs_decision'))
    await new Promise((r) => setTimeout(r, 50))
    expect(getBootstrapStatus).toHaveBeenCalledTimes(1)
  })
})
