/**
 * pollJob — how every job dialog follows a job the server's workers run (an import, an export, a
 * publish). Pins:
 *   - it asks often while the job may be a short one, then less (`jobPollDelayMs`);
 *   - it stops asking while the tab is hidden, and asks at once when it is shown;
 *   - a failed poll doesn't end it (the job runs on regardless): it asks again until the job has
 *     gone unanswered for `patienceMs`, but a refusal or an ended session is final at once — as
 *     `authFetch` reports them too;
 *   - aborting ends it at once, even mid-wait;
 *   - what isn't a job (an upload being checked) is followed until `until` says it is done.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../fetchWithTimeout', () => ({ fetchWithTimeout: vi.fn() }))

import { authFetch } from '../apiClient'
import { fetchWithTimeout } from '../fetchWithTimeout'
import { pollJob, type Job } from '../importExportApiService'

const job = (status: Job['status']): Job => ({ jobId: 'j1', jobType: 'ingest', graphId: 'g1', status })
const refused = (status: number, message: string) => Object.assign(new Error(message), { status })
/** Settles the poll into a value or an error, so a rejection is never left unhandled. */
const outcome = (p: Promise<Job>) => p.then((value) => ({ value }), (error: Error) => ({ error }))

let hidden = false

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(Math, 'random').mockReturnValue(0)          // no jitter: the waits are exact
  hidden = false
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  // Back to jsdom's own (inherited) `hidden`.
  delete (document as unknown as Record<string, unknown>).hidden
})

describe('pollJob', () => {
  it('asks until the job ends, telling every answer', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(job('pending'))
      .mockResolvedValueOnce(job('running'))
      .mockResolvedValueOnce(job('completed'))
    const onTick = vi.fn()
    const done = outcome(pollJob(fetcher, { onTick }))
    await vi.advanceTimersByTimeAsync(2_000)

    expect(await done).toEqual({ value: job('completed') })
    expect(onTick.mock.calls.map(([j]) => j.status)).toEqual(['pending', 'running', 'completed'])
  })

  it('asks every second at first, then less often', async () => {
    const fetcher = vi.fn().mockResolvedValue(job('running'))
    void outcome(pollJob(fetcher))
    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5_000)            // five 1s waits
    expect(fetcher).toHaveBeenCalledTimes(6)
    await vi.advanceTimersByTimeAsync(1_999)            // the sixth wait is 2s
    expect(fetcher).toHaveBeenCalledTimes(6)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetcher).toHaveBeenCalledTimes(7)
  })

  it('stops asking while the tab is hidden, and asks at once when it is shown', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(job('running')).mockResolvedValueOnce(job('completed'))
    const done = outcome(pollJob(fetcher))
    await vi.advanceTimersByTimeAsync(0)
    hidden = true
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetcher).toHaveBeenCalledTimes(1)

    hidden = false
    document.dispatchEvent(new Event('visibilitychange'))
    expect(await done).toEqual({ value: job('completed') })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('asks again through a dropped connection or a server error', async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new Error('Bad Gateway'))          // authFetch: no status on it
      .mockRejectedValueOnce(refused(503, 'Service Unavailable'))
      .mockResolvedValueOnce(job('completed'))
    const done = outcome(pollJob(fetcher))
    await vi.advanceTimersByTimeAsync(3_000)

    expect(await done).toEqual({ value: job('completed') })
  })

  it('gives up once the job has gone unanswered past its patience, with the last error', async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    const done = outcome(pollJob(fetcher, { patienceMs: 10_000 }))
    await vi.advanceTimersByTimeAsync(9_000)
    expect(fetcher).toHaveBeenCalledTimes(8)                     // still asking
    await vi.advanceTimersByTimeAsync(2_000)

    expect(await done).toEqual({ error: new TypeError('Failed to fetch') })
  })

  it("doesn't count the time the tab was hidden against its patience", async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(job('completed'))
    const done = outcome(pollJob(fetcher, { patienceMs: 10_000 }))
    await vi.advanceTimersByTimeAsync(0)
    hidden = true
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    hidden = false
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(1_000)

    expect(await done).toEqual({ value: job('completed') })
  })

  it('is final at once on a refusal, or a session that ended', async () => {
    for (const err of [refused(404, 'Not Found'), new Error('Session expired')]) {
      const fetcher = vi.fn().mockRejectedValue(err)
      const done = outcome(pollJob(fetcher))
      await vi.advanceTimersByTimeAsync(0)

      expect(await done).toEqual({ error: err })
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  })

  it('is final at once on a refusal authFetch reports, and asks again through a server error', async () => {
    vi.mocked(fetchWithTimeout).mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'Not found' }), { status: 404 }))
    const refusal = outcome(pollJob(() => authFetch<Job>('/jobs/j1')))
    await vi.advanceTimersByTimeAsync(0)
    expect(await refusal).toEqual({ error: expect.objectContaining({ message: 'Not found', status: 404 }) })
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1)

    vi.mocked(fetchWithTimeout).mockReset()
      .mockResolvedValueOnce(new Response('Bad Gateway', { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(job('completed')), { status: 200 }))
    const recovered = outcome(pollJob(() => authFetch<Job>('/jobs/j1')))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await recovered).toEqual({ value: job('completed') })
  })

  it('follows what isn’t a job until it says it is done', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ status: 'inspecting' })
      .mockResolvedValueOnce({ status: 'ready' })
    const done = pollJob(fetcher, { until: (u) => u.status === 'ready' || u.status === 'invalid' })
    await vi.advanceTimersByTimeAsync(1_000)

    expect(await done).toEqual({ status: 'ready' })
  })

  it('ends at once when aborted, even mid-wait', async () => {
    const fetcher = vi.fn().mockResolvedValue(job('running'))
    const ctl = new AbortController()
    const done = outcome(pollJob(fetcher, { signal: ctl.signal }))
    await vi.advanceTimersByTimeAsync(0)
    ctl.abort()

    const { error } = (await done) as { error: Error }
    expect(error.name).toBe('AbortError')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('ends at once when aborted while the tab is hidden', async () => {
    const fetcher = vi.fn().mockResolvedValue(job('running'))
    const ctl = new AbortController()
    hidden = true
    const done = outcome(pollJob(fetcher, { signal: ctl.signal }))
    await vi.advanceTimersByTimeAsync(0)
    ctl.abort()

    const { error } = (await done) as { error: Error }
    expect(error.name).toBe('AbortError')
    expect(fetcher).not.toHaveBeenCalled()
  })
})
