import { describe, expect, it } from 'vitest'
import { queuePosition, type Job } from '../importExportApiService'

const job = (queuedAhead?: number | null) => ({ jobId: 'j1', jobType: 'ingest', graphId: 'g1', status: 'pending', queuedAhead }) as Job

describe('queuePosition', () => {
  it('says how many jobs a queued one waits behind', () => {
    expect(queuePosition(job(0))).toBe('It starts next.')
    expect(queuePosition(job(1))).toBe('1 job is ahead of it.')
    expect(queuePosition(job(7))).toBe('7 jobs are ahead of it.')
  })

  it('says nothing for a job that is not queued', () => {
    expect(queuePosition(job(null))).toBeNull()
    expect(queuePosition(job(undefined))).toBeNull()
    expect(queuePosition(null)).toBeNull()
  })
})
