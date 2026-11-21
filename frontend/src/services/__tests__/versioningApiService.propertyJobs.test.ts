/**
 * A bulk property change the server turns away arrives as a typed error: another job still
 * running on the draft names it (to follow), and a change it won't make as asked names why.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../fetchWithTimeout', () => ({ fetchWithTimeout: vi.fn() }))

import { fetchWithTimeout } from '../fetchWithTimeout'
import { JobActiveError, PropertyJobRefusedError, createPropertyJob } from '../versioningApiService'

const answer = (status: number, body: unknown) =>
  vi.mocked(fetchWithTimeout).mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))

const start = () => createPropertyJob('ws1', 'g1', 'd1', { kind: 'remove', key: 'owner' }, { ids: ['a'] }, 'key-12345').catch((e) => e)

beforeEach(() => vi.mocked(fetchWithTimeout).mockReset())

describe('starting a bulk property change', () => {
  it('another job still running on the draft names it, to follow', async () => {
    answer(409, { detail: { type: 'job_active', jobId: 'vjob_9', message: 'Another bulk property edit is running on this draft (job vjob_9).' } })
    const err = await start()
    expect(err).toBeInstanceOf(JobActiveError)
    expect(err.jobId).toBe('vjob_9')
    expect(err.status).toBe(409)
    expect(err.message).toContain('Another bulk property edit is running')
  })

  it('a change it won\'t make as asked says why, by its code', async () => {
    answer(422, { detail: { type: 'too_many_ids', code: 'too_many_ids', message: 'A job names up to 20,000 entities by id.' } })
    const err = await start()
    expect(err).toBeInstanceOf(PropertyJobRefusedError)
    expect(err.code).toBe('too_many_ids')
    expect(err.message).toBe('A job names up to 20,000 entities by id.')
  })

  it('any other refusal is a plain error with its status', async () => {
    answer(422, { detail: { type: 'something_else', code: 'something_else', message: 'No.' } })
    const err = await start()
    expect(err).not.toBeInstanceOf(PropertyJobRefusedError)
    expect(err.status).toBe(422)
  })
})
