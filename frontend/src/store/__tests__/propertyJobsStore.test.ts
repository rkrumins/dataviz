/**
 * propertyJobsStore — the bulk property jobs this browser started are kept across a reload, each
 * with how it last stood; a draft's jobs say what they do to each property; and any surface opens
 * the dialog through one request, taken once.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { TrackedJob } from '../propertyJobsStore'

const tracked = (jobId: string, patch: Partial<TrackedJob> = {}): TrackedJob => ({
  jobId, wsId: 'ws', graphId: 'g1', branchId: 'd1', viewId: 'v1',
  op: { kind: 'rename', key: 'owner', to: 'steward' }, targetLabel: 'every entity in this view',
  startedAt: '2026-11-21T00:00:00Z', job: { jobId, status: 'running' }, ...patch,
})

beforeEach(() => {
  localStorage.clear()
  vi.resetModules()
})

describe('propertyJobsStore', () => {
  it('keeps the jobs it tracks across a reload, with how each last stood', async () => {
    const first = await import('../propertyJobsStore')
    first.usePropertyJobsStore.getState().track(tracked('j1'))
    first.usePropertyJobsStore.getState().update('j1', { jobId: 'j1', status: 'running', progress: 0.4 })
    vi.resetModules()
    const reloaded = await import('../propertyJobsStore')
    expect(reloaded.usePropertyJobsStore.getState().jobs).toMatchObject([{ jobId: 'j1', job: { progress: 0.4 } }])
  })

  it('forgets a dismissed job, and keeps only the newest ended ones', async () => {
    const { usePropertyJobsStore } = await import('../propertyJobsStore')
    const s = usePropertyJobsStore.getState()
    for (let i = 0; i < 25; i++) s.track(tracked(`e${i}`, { job: { jobId: `e${i}`, status: 'completed' } }))
    s.track(tracked('live'))
    const ids = usePropertyJobsStore.getState().jobs.map((j) => j.jobId)
    expect(ids).toContain('live')
    expect(ids).not.toContain('e0')
    expect(ids.filter((id) => id.startsWith('e'))).toHaveLength(20)
    usePropertyJobsStore.getState().dismiss('live')
    expect(usePropertyJobsStore.getState().jobs.map((j) => j.jobId)).not.toContain('live')
  })

  it('forgets a job it lost track of a week after losing it', async () => {
    const day = 24 * 60 * 60 * 1000
    const lostAgo = (ms: number) => ({ at: new Date(Date.now() - ms).toISOString(), message: 'Failed to fetch' })
    localStorage.setItem('property-jobs:v1', JSON.stringify([
      tracked('old', { lost: lostAgo(8 * day) }), tracked('recent', { lost: lostAgo(day) }), tracked('live'),
    ]))
    const { usePropertyJobsStore } = await import('../propertyJobsStore')
    expect(usePropertyJobsStore.getState().jobs.map((j) => j.jobId)).toEqual(['recent', 'live'])
    // A lost one is dismissed like an ended one; checked again, it is followed once more.
    usePropertyJobsStore.getState().checkAgain(['recent'])
    expect(usePropertyJobsStore.getState().jobs[0]!.lost).toMatchObject({ checking: true })
    usePropertyJobsStore.getState().dismiss('recent')
    expect(usePropertyJobsStore.getState().jobs.map((j) => j.jobId)).toEqual(['live'])
  })

  it('reads a broken stored list as empty', async () => {
    localStorage.setItem('property-jobs:v1', '{not json')
    const { usePropertyJobsStore } = await import('../propertyJobsStore')
    expect(usePropertyJobsStore.getState().jobs).toEqual([])
  })

  it('moves a draft\'s written epoch when a job ends — and while it runs, at most every 30 s', async () => {
    vi.useFakeTimers()
    try {
      const { usePropertyJobsStore } = await import('../propertyJobsStore')
      usePropertyJobsStore.getState().track(tracked('j1'))
      const epoch = () => usePropertyJobsStore.getState().writtenEpochs['g1|d1']?.epoch ?? 0
      const tick = (commits: number, status: 'running' | 'completed' = 'running') =>
        usePropertyJobsStore.getState().update('j1', { jobId: 'j1', status, summary: { commits } })
      tick(0)
      expect(epoch()).toBe(0)                  // nothing written yet
      tick(1)
      expect(epoch()).toBe(1)                  // its first window shows at once
      vi.advanceTimersByTime(10_000)
      tick(2)
      vi.advanceTimersByTime(10_000)
      tick(3)
      expect(epoch()).toBe(1)                  // windows land faster than the reads are asked again
      vi.advanceTimersByTime(10_000)
      tick(3)
      expect(epoch()).toBe(2)                  // 30 s on, it has written more than was last read
      vi.advanceTimersByTime(60_000)
      tick(3)
      expect(epoch()).toBe(2)                  // nothing more written
      tick(4, 'completed')
      expect(epoch()).toBe(3)                  // it ended: read at once
      expect(usePropertyJobsStore.getState().writtenEpochs['g1|d2']).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('hands a request to the dialog once', async () => {
    const { usePropertyJobsStore } = await import('../propertyJobsStore')
    usePropertyJobsStore.getState().requestOp({ kind: 'remove', key: 'owner' })
    expect(usePropertyJobsStore.getState().consumeRequest()).toEqual({ kind: 'remove', key: 'owner' })
    expect(usePropertyJobsStore.getState().consumeRequest()).toBeNull()
  })
})
