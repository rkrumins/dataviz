/**
 * usePropertyJobs — the draft's running bulk property jobs are followed to the end (progress kept
 * as it comes), and the end is announced once, with how it ended; jobs of another draft are left
 * alone.
 */
import { renderHook, waitFor } from '@testing-library/react'
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

  it('follows nothing without a draft', () => {
    renderHook(() => usePropertyJobs('ws', 'g1', null, vi.fn()))
    expect(follow).not.toHaveBeenCalled()
  })
})
