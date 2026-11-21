/**
 * usePropertyJobs — the draft's running bulk property jobs are followed to the end (progress kept
 * as it comes), and the end is announced once, with how it ended; jobs of another draft are left
 * alone. A follow that fails for good marks the job lost — gone, when the server no longer has it
 * — and a lost job is asked about again on the next sign of life.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PropertyJob } from '@/services/versioningApiService'

const follow = vi.hoisted(() => vi.fn())
vi.mock('@/services/versioningApiService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/versioningApiService')>()),
  followPropertyJob: follow,
}))

import { usePropertyJobsStore, type TrackedJob } from '@/store/propertyJobsStore'
import { usePropertyJobs } from '../usePropertyJobs'

const tracked = (jobId: string, branchId = 'd1'): TrackedJob => ({
  jobId, wsId: 'ws', graphId: 'g1', branchId, viewId: 'v1', op: { kind: 'remove', key: 'owner' },
  targetLabel: 'every entity in this view', startedAt: '', job: { jobId, status: 'running' },
})

beforeEach(() => {
  localStorage.clear()
  follow.mockReset()
  usePropertyJobsStore.setState({ jobs: [tracked('j1'), tracked('other', 'd2')] } as never)
})

describe('usePropertyJobs', () => {
  it('follows this draft\'s running jobs, keeps their progress, and announces the end once', async () => {
    follow.mockImplementation(async (_ws: string, _g: string, jobId: string, onTick: (j: PropertyJob) => void) => {
      onTick({ jobId, status: 'running', progress: 0.5 })
      expect(usePropertyJobsStore.getState().jobs.find((j) => j.jobId === jobId)?.job?.progress).toBe(0.5)
      // The end reaches onTick too — it is kept, and announced, only once the follow returns it.
      onTick({ jobId, status: 'completed', summary: { changed: 7 } })
      return { jobId, status: 'completed', summary: { changed: 7 } }
    })
    const onEnded = vi.fn()
    renderHook(() => usePropertyJobs('ws', 'g1', 'd1', onEnded))
    await waitFor(() => expect(onEnded).toHaveBeenCalledTimes(1))
    expect(follow).toHaveBeenCalledTimes(1)
    expect(follow.mock.calls[0][2]).toBe('j1')
    expect(onEnded.mock.calls[0][0]).toMatchObject({ jobId: 'j1' })
    expect(onEnded.mock.calls[0][1]).toMatchObject({ status: 'completed', summary: { changed: 7 } })
    expect(usePropertyJobsStore.getState().jobs.find((j) => j.jobId === 'j1')?.job?.status).toBe('completed')
  })

  it('marks a job it can no longer follow lost, and asks again once the browser is back online', async () => {
    follow.mockRejectedValueOnce(new Error('Failed to fetch'))
    const onEnded = vi.fn()
    renderHook(() => usePropertyJobs('ws', 'g1', 'd1', onEnded))
    const j1 = () => usePropertyJobsStore.getState().jobs.find((j) => j.jobId === 'j1')!
    await waitFor(() => expect(j1().lost).toMatchObject({ message: 'Failed to fetch' }))
    expect(j1().job?.status).toBe('running')
    const lostAt = j1().lost!.at

    follow.mockRejectedValueOnce(new Error('Failed to fetch'))
    act(() => { window.dispatchEvent(new Event('online')) })
    await waitFor(() => expect(follow).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(j1().lost?.checking).toBeFalsy())
    expect(j1().lost?.at).toBe(lostAt)                // lost since the first time

    follow.mockResolvedValueOnce({ jobId: 'j1', status: 'completed', summary: { changed: 3 } })
    act(() => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => expect(onEnded).toHaveBeenCalledTimes(1))
    expect(j1().lost).toBeUndefined()
    expect(j1().job?.status).toBe('completed')
  })

  it('a job the server no longer has is gone: not asked about again on its own', async () => {
    follow.mockRejectedValueOnce(Object.assign(new Error('property job not found'), { status: 404 }))
    renderHook(() => usePropertyJobs('ws', 'g1', 'd1', vi.fn()))
    await waitFor(() => expect(usePropertyJobsStore.getState().jobs[0]!.lost).toMatchObject({ gone: true }))
    act(() => { window.dispatchEvent(new Event('online')) })
    await act(async () => { await Promise.resolve() })
    expect(follow).toHaveBeenCalledTimes(1)
  })

  it('follows nothing without a draft', () => {
    renderHook(() => usePropertyJobs('ws', 'g1', null, vi.fn()))
    expect(follow).not.toHaveBeenCalled()
  })
})
