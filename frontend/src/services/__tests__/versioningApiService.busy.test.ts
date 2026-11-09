/**
 * A server too busy to prepare a change list, the history calendar or the graph as it was answers
 * 503 with a Retry-After (`change_list_busy`, `revision_busy`): it arrives as a BusyError carrying
 * that wait, so the reads that ask again know when to. Any other 503 is not one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../fetchWithTimeout', () => ({ fetchWithTimeout: vi.fn() }))

import { fetchWithTimeout } from '../fetchWithTimeout'
import { BusyError, getChangeSummary, getRevision } from '../versioningApiService'

const answer = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  vi.mocked(fetchWithTimeout).mockImplementation(async () => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', ...headers },
  }))

beforeEach(() => vi.mocked(fetchWithTimeout).mockReset())

describe('a busy server', () => {
  it('is a BusyError carrying its Retry-After, for a change list', async () => {
    answer(503, { detail: { type: 'change_list_busy', retryable: true, message: 'this list is taking too long to prepare' } },
      { 'Retry-After': '5' })
    const err = await getChangeSummary('ws1', 'g1', { fromSeq: 3, toSeq: 9 }).catch((e) => e)
    expect(err).toBeInstanceOf(BusyError)
    expect(err).toMatchObject({ code: 'change_list_busy', retryAfterMs: 5_000, status: 503 })
    expect(err.message).toBe('this list is taking too long to prepare')
  })

  it('is a BusyError carrying its Retry-After, for the graph as it was', async () => {
    answer(503, { detail: { type: 'revision_busy', reason: 'builds_saturated', retryable: true } }, { 'Retry-After': '2' })
    const err = await getRevision('ws1', 'g1', 12).catch((e) => e)
    expect(err).toBeInstanceOf(BusyError)
    expect(err).toMatchObject({ code: 'revision_busy', retryAfterMs: 2_000 })
  })

  it('without a Retry-After, still busy, with no wait of its own', async () => {
    answer(503, { detail: { type: 'change_list_busy', retryable: true } })
    const err = await getChangeSummary('ws1', 'g1', { branchId: 'br_1' }).catch((e) => e)
    expect(err).toBeInstanceOf(BusyError)
    expect(err.retryAfterMs).toBeNull()
  })

  it('is no other 503', async () => {
    answer(503, { detail: 'the database is unavailable' }, { 'Retry-After': '5' })
    const err = await getChangeSummary('ws1', 'g1', { fromSeq: 3, toSeq: 9 }).catch((e) => e)
    expect(err).not.toBeInstanceOf(BusyError)
    expect(err.status).toBe(503)
  })
})
