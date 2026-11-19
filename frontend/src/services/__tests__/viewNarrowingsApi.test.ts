/**
 * Narrowings saved with a view: what one held is kept gzipped and read back the same, what
 * is new and gone since is counted from it, its id is made here, and a save that met a slow
 * or busy server is asked again under that id — so it saves once.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const authFetch = vi.hoisted(() => vi.fn())
const fetchWithTimeout = vi.hoisted(() => vi.fn())
vi.mock('../apiClient', () => ({ authFetch }))
vi.mock('../fetchWithTimeout', () => ({ fetchWithTimeout }))

import {
  HELD_MAX, heldUrns, narrowingSince, newNarrowingId, packHeld, readHeld, saveNarrowing,
} from '../viewNarrowingsApi'

const result = (urns: string[], whole: string[] = [], truncated: never[] = []) => ({
  members: urns.map((urn) => ({ urn, via: 'seed' as const })), wholeSubtree: whole, truncated,
})

async function gunzipBase64(b64: string): Promise<string> {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  const source = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close() } })
  return new Response(source.pipeThrough(new DecompressionStream('gzip'))).text()
}

describe('viewNarrowingsApi', () => {
  beforeEach(() => { authFetch.mockReset(); fetchWithTimeout.mockReset() })

  it('keeps what a narrowing held — its members and what is whole in it, sorted, each once', async () => {
    const held = await packHeld(result(['urn:c', 'urn:a', 'urn:b'], ['urn:a', 'urn:z']))
    expect(held).toMatchObject({ count: 4, complete: true })
    expect(await gunzipBase64(held!.urnsGzip)).toBe('urn:a\nurn:b\nurn:c\nurn:z')
  })

  it('says it held more than it kept — past what the server keeps, or cut short', async () => {
    const many = Array.from({ length: HELD_MAX + 5 }, (_, i) => `urn:${String(i).padStart(6, '0')}`)
    expect(await packHeld(result(many))).toMatchObject({ count: HELD_MAX, complete: false })
    expect(await packHeld(result(['a'], [], [{ reason: 'member_cap', seen: 9, limit: 1 }] as never))).toMatchObject({ complete: false })
  })

  it('reads back what it held — and nothing when it kept none', async () => {
    const held = await packHeld(result(['urn:b', 'urn:a']))
    const gz = Uint8Array.from(atob(held!.urnsGzip), (c) => c.charCodeAt(0))
    fetchWithTimeout.mockResolvedValueOnce(new Response(gz, { status: 200 }))
    expect(await readHeld('v1', 'n1')).toEqual(['urn:a', 'urn:b'])
    expect(fetchWithTimeout.mock.calls[0][0]).toBe('/api/v1/views/v1/narrowings/n1/held')
    fetchWithTimeout.mockResolvedValueOnce(new Response(null, { status: 204 }))
    expect(await readHeld('v1', 'n1')).toBeNull()
  })

  it('counts what is new and gone since it was saved, and says when that is approximate', () => {
    expect(narrowingSince(['a', 'b', 'c'], true, result(['b', 'c', 'd', 'e']))).toEqual({ added: 2, removed: 1, approximate: false })
    expect(narrowingSince(['a'], false, result(['a']))).toEqual({ added: 0, removed: 0, approximate: true })
    expect(heldUrns(result(['b'], ['a', 'b']))).toEqual(['a', 'b'])
  })

  it('makes ids the server takes', () => {
    const ids = new Set(Array.from({ length: 50 }, newNarrowingId))
    expect(ids.size).toBe(50)
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{8,32}$/)
  })

  it('asks again under the same id through a busy server, and not after a refusal', async () => {
    vi.useFakeTimers()
    try {
      authFetch
        .mockRejectedValueOnce(Object.assign(new Error('busy'), { status: 503, retryAfterMs: 5 }))
        .mockResolvedValueOnce({ id: 'n1', name: 'x' })
      const saving = saveNarrowing('v1', 'n1', { name: 'x', spec: {} as never })
      await vi.runAllTimersAsync()
      expect(await saving).toEqual({ id: 'n1', name: 'x' })
      expect(authFetch.mock.calls.map((c) => [c[0], c[1].method])).toEqual([
        ['/api/v1/views/v1/narrowings/n1', 'PUT'], ['/api/v1/views/v1/narrowings/n1', 'PUT'],
      ])
      authFetch.mockReset()
      authFetch.mockRejectedValueOnce(Object.assign(new Error('Too many saved'), { status: 422 }))
      await expect(saveNarrowing('v1', 'n2', { name: 'x', spec: {} as never })).rejects.toThrow('Too many saved')
      expect(authFetch).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
