/**
 * A change index can be asked for no more than so many changes (`max`) — a comparison highlighted on
 * the canvas is — and is otherwise asked for all of them, as a draft's rings are.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../fetchWithTimeout', () => ({ fetchWithTimeout: vi.fn() }))

import { fetchWithTimeout } from '../fetchWithTimeout'
import { getChangeIndex } from '../versioningApiService'

beforeEach(() => {
  vi.mocked(fetchWithTimeout).mockReset()
  vi.mocked(fetchWithTimeout).mockImplementation(async () => new Response(
    JSON.stringify({ origin: {}, entries: [], total: 0, truncated: false }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }))
})

describe('a change index', () => {
  it('asks for no more than `max` changes when given one, and for all of them otherwise', async () => {
    await getChangeIndex('ws1', 'g1', { fromSeq: 3, toSeq: 9 }, 20_000)
    await getChangeIndex('ws1', 'g1', { branchId: 'br_1' })
    const [capped, all] = vi.mocked(fetchWithTimeout).mock.calls.map((c) => new URL(String(c[0]), 'http://x').searchParams)
    expect([capped.get('fromSeq'), capped.get('toSeq'), capped.get('max')]).toEqual(['3', '9', '20000'])
    expect(all.get('branchId')).toBe('br_1')
    expect(all.has('max')).toBe(false)
  })
})
