/**
 * Pausing and resuming editing of a graph: one route each, naming the revision the caller saw. A
 * save to a paused graph is refused with the server's words, which tell the user who can resume it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../fetchWithTimeout', () => ({ fetchWithTimeout: vi.fn() }))

import { fetchWithTimeout } from '../fetchWithTimeout'
import { applyGraphChanges, setGraphFrozen } from '../versioningApiService'

const answer = (status: number, body: unknown) =>
  vi.mocked(fetchWithTimeout).mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))

const call = () => vi.mocked(fetchWithTimeout).mock.calls[0] as [string, RequestInit | undefined]

beforeEach(() => vi.mocked(fetchWithTimeout).mockReset())

describe('the lifecycle routes', () => {
  it.each([
    [true, 'freeze', 'frozen'],
    [false, 'unfreeze', 'live'],
  ] as const)('frozen=%s posts …/lifecycle/%s with the revision seen', async (frozen, route, state) => {
    answer(200, { graphId: 'g1', state, rev: 4 })
    expect(await setGraphFrozen('ws1', 'g1', frozen, 3)).toEqual({ graphId: 'g1', state, rev: 4 })
    expect(call()[0]).toBe(`/api/v1/ws1/versioning/graphs/g1/lifecycle/${route}`)
    expect(call()[1]?.method).toBe('POST')
    expect(JSON.parse(String(call()[1]?.body))).toEqual({ expectedRev: 3 })
  })
})

describe('a save to a paused graph', () => {
  it("is refused with the server's words", async () => {
    const message = "Editing is paused on this graph. A publisher can resume it from the data source's Version control tab. Your change was not saved."
    answer(409, { detail: { type: 'graph_not_writable', state: 'frozen', reason: 'frozen', retryable: false, message } })
    const err = await applyGraphChanges('ws1', 'ds1', 'br_1', []).catch((e) => e)
    expect(err.message).toBe(message)
  })
})
