/**
 * A bulk property change the server turns away arrives as a typed error: another job still
 * running on the draft names it (to follow), and a change it won't make as asked names why.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../fetchWithTimeout', () => ({ fetchWithTimeout: vi.fn() }))

import { fetchWithTimeout } from '../fetchWithTimeout'
import {
  JobActiveError, PropertyJobRefusedError, PropertyJobUndoRefusedError, createPropertyJob, undoPropertyJob,
} from '../versioningApiService'

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

describe('undoing a bulk property change', () => {
  const undo = () => undoPropertyJob('ws1', 'g1', 'vjob_1', 'key-undo-1').catch((e) => e)

  it('asks for it with its key, and answers with the undo to follow', async () => {
    answer(202, { jobId: 'vjob_2', status: 'pending', op: { kind: 'undo', key: 'owner', sourceJobId: 'vjob_1', sourceLabel: 'Set owner' } })
    const job = await undo()
    expect(job.jobId).toBe('vjob_2')
    const [url, init] = vi.mocked(fetchWithTimeout).mock.calls[0]
    expect(url).toBe('/api/v1/ws1/versioning/graphs/g1/property-jobs/vjob_1/undo')
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('key-undo-1')
  })

  it('says why it can’t be undone, by its code — the undo that did it, for one undone already', async () => {
    answer(409, { detail: { type: 'already_undone', code: 'already_undone', jobId: 'vjob_3', message: 'Undone already.' } })
    const err = await undo()
    expect(err).toBeInstanceOf(PropertyJobUndoRefusedError)
    expect([err.status, err.code, err.jobId]).toEqual([409, 'already_undone', 'vjob_3'])
    for (const [status, code] of [[409, 'job_published'], [422, 'nothing_to_undo'], [422, 'undo_of_undo']] as const) {
      answer(status, { detail: { type: code, code, message: 'No.' } })
      const refused = await undo()
      expect([refused instanceof PropertyJobUndoRefusedError, refused.status, refused.code]).toEqual([true, status, code])
    }
  })

  it('another change running on the draft is the job to wait for', async () => {
    answer(409, { detail: { type: 'job_active', code: 'job_active', jobId: 'vjob_1', message: 'Running.' } })
    const err = await undo()
    expect(err).toBeInstanceOf(JobActiveError)
    expect(err.jobId).toBe('vjob_1')
  })
})
