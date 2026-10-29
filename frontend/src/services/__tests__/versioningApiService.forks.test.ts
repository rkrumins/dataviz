/**
 * A graph's forks: listed, moved to the trash and restored through the fork routes, and a refusal
 * arrives as a ForkRefusedError that says, in words, what to do instead of the server's message.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../fetchWithTimeout', () => ({ fetchWithTimeout: vi.fn() }))

import { fetchWithTimeout } from '../fetchWithTimeout'
import { deleteFork, ForkRefusedError, listForks, restoreFork } from '../versioningApiService'

const answer = (status: number, body?: unknown) =>
  vi.mocked(fetchWithTimeout).mockResolvedValue(
    body === undefined
      ? new Response(null, { status })
      : new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))

const call = () => vi.mocked(fetchWithTimeout).mock.calls[0] as [string, RequestInit | undefined]

beforeEach(() => vi.mocked(fetchWithTimeout).mockReset())

describe('the fork routes', () => {
  it("lists a graph's forks", async () => {
    answer(200, [{ graphId: 'f1', deletedAt: null, purging: false }])
    expect(await listForks('ws1', 'g1')).toEqual([{ graphId: 'f1', deletedAt: null, purging: false }])
    expect(call()[0]).toBe('/api/v1/ws1/versioning/graphs/g1/forks')
  })

  it('deletes a fork with DELETE and restores it with POST …/restore', async () => {
    answer(204)
    await expect(deleteFork('ws1', 'f1')).resolves.toBeUndefined()
    expect(call()[0]).toBe('/api/v1/ws1/versioning/graphs/f1')
    expect(call()[1]?.method).toBe('DELETE')
    vi.mocked(fetchWithTimeout).mockClear()
    answer(204)
    await expect(restoreFork('ws1', 'f1')).resolves.toBeUndefined()
    expect(call()[0]).toBe('/api/v1/ws1/versioning/graphs/f1/restore')
    expect(call()[1]?.method).toBe('POST')
  })
})

describe('a fork refusal', () => {
  it.each([
    [{ type: 'live_forks', graphId: 'f1', forks: 2 }, 'Delete its forks first'],
    [{ type: 'not_a_fork', graphId: 'f1' }, 'goes with its data source'],
    [{ type: 'fork_not_restorable', graphId: 'f1', reason: 'purging' }, 'being deleted'],
    [{ type: 'fork_not_restorable', graphId: 'f1', reason: 'parent_deleted' }, 'Restore that first'],
    [{ type: 'fork_limit', limit: 10 }, 'already has 10 forks'],
  ])('%o reads in words', async (detail, words) => {
    answer(409, { detail: { ...detail, message: 'server words' } })
    const err = await restoreFork('ws1', 'f1').catch((e) => e)
    expect(err).toBeInstanceOf(ForkRefusedError)
    expect(err.type).toBe(detail.type)
    expect(err.message).toContain(words)
  })
})
