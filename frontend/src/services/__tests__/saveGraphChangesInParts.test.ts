/**
 * A draft save too large for one request: its ops go up as NDJSON in parts (resumable, by the save's
 * key), the server writes them as one commit in a job followed until it ends — answering as a
 * one-request save answers, and refusing as one refuses (typed), never leaving the upload remembered
 * once it is done with.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const io = vi.hoisted(() => ({ sendNdjsonInParts: vi.fn(), remember: vi.fn(), fetchWithTimeout: vi.fn() }))
vi.mock('../importExportApiService', () => ({ sendNdjsonInParts: io.sendNdjsonInParts, remember: io.remember }))
vi.mock('../fetchWithTimeout', () => ({ fetchWithTimeout: io.fetchWithTimeout }))

import { MergeConflictError, saveGraphChangesInParts, type SaveProgress } from '../versioningApiService'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const ops = [{ op: 'create' as const, kind: 'node' as const, ref: 'tmp-1', payload: { displayName: 'A' } }]

beforeEach(() => {
  vi.useFakeTimers()
  Object.values(io).forEach((f) => f.mockReset())
  io.sendNdjsonInParts.mockImplementation(async (_ws: string, _g: string, file: File, o: { onProgress?: (s: number, t: number) => void }) => {
    o.onProgress?.(file.size, file.size)
    return { uploadId: 'iu_1', size: file.size, partBytes: 1, parts: 1, received: [0] }
  })
})

describe('saveGraphChangesInParts', () => {
  it('uploads the ops, queues them under the save’s key, and answers as the save route does', async () => {
    io.fetchWithTimeout
      .mockResolvedValueOnce(json({ jobId: 'job_1', status: 'pending' }, 202))
      .mockResolvedValueOnce(json({ jobId: 'job_1', status: 'running' }))
      .mockResolvedValueOnce(json({ jobId: 'job_1', status: 'completed', result: { commitId: 'c1', assigned: { 'tmp-1': 'urn:1' } } }))
    const seen: SaveProgress[] = []
    const done = saveGraphChangesInParts('ws', 'g1', 'br1', ops, 'Big', 'key-1', (p) => seen.push(p))
    await vi.runAllTimersAsync()
    expect(await done).toEqual({ commitId: 'c1', assigned: { 'tmp-1': 'urn:1' } })

    const [, , file, opts] = io.sendNdjsonInParts.mock.calls[0]
    expect(await (file as File).text()).toBe(`${JSON.stringify(ops[0])}\n`)
    expect(opts.key).toBe('save-upload:key-1')
    const [url, init] = io.fetchWithTimeout.mock.calls[0]
    expect(url).toBe('/api/v1/ws/versioning/graphs/g1/branches/br1/saves')
    expect(init.headers).toEqual({ 'Idempotency-Key': 'key-1' })
    expect(JSON.parse(init.body)).toEqual({ uploadId: 'iu_1', message: 'Big' })
    expect(io.fetchWithTimeout.mock.calls[2][0]).toBe('/api/v1/ws/versioning/graphs/g1/save-jobs/job_1')
    expect(seen.map((p) => p.phase)).toEqual(['preparing', 'uploading', 'saving'])
    expect(io.remember).toHaveBeenCalledWith('save-upload:key-1', null)
  })

  it('refuses as a one-request save refuses', async () => {
    io.fetchWithTimeout
      .mockResolvedValueOnce(json({ jobId: 'job_1', status: 'pending' }, 202))
      .mockResolvedValueOnce(json({ jobId: 'job_1', status: 'failed', error: { status: 409, detail: {
        type: 'merge_conflict', conflicts: [{ entity_id: 'e1' }], current: {} } } }))
    const done = saveGraphChangesInParts('ws', 'g1', 'br1', ops, undefined, 'key-2')
    const caught = done.catch((e) => e)
    await vi.runAllTimersAsync()
    expect(await caught).toBeInstanceOf(MergeConflictError)
  })

  it('rides out a poll that fails now and then', async () => {
    io.fetchWithTimeout
      .mockResolvedValueOnce(json({ jobId: 'job_1', status: 'pending' }, 202))
      .mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValueOnce(json({ jobId: 'job_1', status: 'completed', result: { commitId: 'c2', assigned: {} } }))
    const done = saveGraphChangesInParts('ws', 'g1', 'br1', ops, undefined, 'key-3')
    await vi.runAllTimersAsync()
    expect((await done).commitId).toBe('c2')
  })
})
