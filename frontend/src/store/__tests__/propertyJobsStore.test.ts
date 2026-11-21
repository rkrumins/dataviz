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

  it('reads a broken stored list as empty', async () => {
    localStorage.setItem('property-jobs:v1', '{not json')
    const { usePropertyJobsStore } = await import('../propertyJobsStore')
    expect(usePropertyJobsStore.getState().jobs).toEqual([])
  })

  it('hands a request to the dialog once', async () => {
    const { usePropertyJobsStore } = await import('../propertyJobsStore')
    usePropertyJobsStore.getState().requestOp({ kind: 'remove', key: 'owner' })
    expect(usePropertyJobsStore.getState().consumeRequest()).toEqual({ kind: 'remove', key: 'owner' })
    expect(usePropertyJobsStore.getState().consumeRequest()).toBeNull()
  })
})
