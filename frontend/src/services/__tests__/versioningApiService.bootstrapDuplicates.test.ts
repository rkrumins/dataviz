/**
 * The duplicate-identifier calls of "enable version control": the list (a page, or the whole thing
 * as a CSV), and the decision, which carries the fingerprint of the list the manager was shown. A
 * decision the server can no longer take must arrive as a typed error, so the UI can tell "the list
 * changed — review it again" apart from any other failure.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../fetchWithTimeout', () => ({ fetchWithTimeout: vi.fn() }))

import { fetchWithTimeout } from '../fetchWithTimeout'
import {
  BootstrapDecisionError, bootstrapDuplicatesCsvUrl, decideBootstrapDuplicates, getBootstrapDuplicates,
} from '../versioningApiService'

const answer = (status: number, body: unknown) =>
  vi.mocked(fetchWithTimeout).mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))

beforeEach(() => vi.mocked(fetchWithTimeout).mockReset())

describe('the duplicate list', () => {
  it('reads a page after a cursor, for the data source', async () => {
    answer(200, { items: [], next: null })
    await getBootstrapDuplicates('ws1', 'ds 1', { after: 'c1', limit: 500 })

    const sent = new URL(vi.mocked(fetchWithTimeout).mock.calls[0][0] as string, 'http://app')
    expect(sent.pathname).toBe('/api/v1/ws1/graph/bootstrap/duplicates')
    expect(Object.fromEntries(sent.searchParams)).toEqual({ dataSourceId: 'ds 1', after: 'c1', limit: '500' })
  })

  it('downloads the whole list as CSV from the same route', () => {
    const sent = new URL(bootstrapDuplicatesCsvUrl('ws1', 'ds 1'), 'http://app')
    expect(sent.pathname).toBe('/api/v1/ws1/graph/bootstrap/duplicates')
    expect(Object.fromEntries(sent.searchParams)).toEqual({ dataSourceId: 'ds 1', format: 'csv' })
  })
})

describe('the decision', () => {
  it('posts a collapse with the fingerprint of the list that was shown', async () => {
    answer(202, { jobId: 'vjob_1', status: 'pending' })
    await decideBootstrapDuplicates('ws1', 'ds1', { fingerprint: 'fp_1' })

    const [url, init] = vi.mocked(fetchWithTimeout).mock.calls[0]
    expect(url).toBe('/api/v1/ws1/graph/bootstrap/decision?dataSourceId=ds1')
    expect(init).toMatchObject({ method: 'POST' })
    expect(JSON.parse(init!.body as string)).toEqual({ action: 'collapse', fingerprint: 'fp_1' })
  })

  it('names a refusal over a changed list, so the user is asked to review it again', async () => {
    answer(409, { detail: { type: 'stale_decision' } })
    const err = await decideBootstrapDuplicates('ws1', 'ds1', { fingerprint: 'fp_old' }).catch((e) => e)
    expect(err).toBeInstanceOf(BootstrapDecisionError)
    expect(err.type).toBe('stale_decision')
  })

  it('names a refusal because the job is no longer waiting, in words rather than JSON', async () => {
    answer(409, { detail: { type: 'not_awaiting_decision' } })
    const err = await decideBootstrapDuplicates('ws1', 'ds1', { fingerprint: 'fp_1' }).catch((e) => e)
    expect(err).toBeInstanceOf(BootstrapDecisionError)
    expect(err.type).toBe('not_awaiting_decision')
    expect(err.message).toMatch(/no longer waiting/)
  })
})
