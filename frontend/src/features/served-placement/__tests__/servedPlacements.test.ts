/**
 * ServedPlacements: where a view the server places draws each entity, asked once.
 *
 * Pinned here: asks within a tick merge into one request, deduped against what is answered
 * and on its way; batches of 2,000 (500 with nodes), two in flight, `now` ahead of
 * `background`; one map changed in place, `version` counting the answers; a moved stamp
 * drops what was answered; a busy server is asked again five times, a 500 twice, a 422
 * never; and a stopped ask leaves its entities unknown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ViewPlacementsAnswer } from '@/types/membership'
import type { FeedNode } from '@/types/searchView'

import { ServedPlacements } from '../servedPlacements'

const viewPlacements = vi.fn()
const provider = { viewPlacements }

const answer = (urns: string[], over: Partial<ViewPlacementsAnswer> = {}, layerOf = (u: string): string | null => (u.startsWith('out') ? null : 'L1')): ViewPlacementsAnswer => ({
  placements: Object.fromEntries(urns.map((u) => [u, { layerId: layerOf(u), source: layerOf(u) ? 'member' : 'none' }])),
  epoch: 1, dataVersion: 'd1', digest: 'x', ...over,
})
const node = (urn: string) => ({ urn, entityType: 'table', displayName: urn, ancestorPath: [], inLayer: 0 }) as unknown as FeedNode
const withNodes = (urns: string[], over: Partial<ViewPlacementsAnswer> = {}) => ({
  ...answer(urns, over), nodes: Object.fromEntries(urns.filter((u) => !u.startsWith('out')).map((u) => [u, node(u)])),
})
const failure = (status: number, retryAfterMs = 1) => Object.assign(new Error(`API Error ${status}: {}`), { status, retryAfterMs })

/** A request held open until the test answers it. */
function held() {
  const calls: Array<{ urns: string[]; opts: { signal?: AbortSignal; nodes?: boolean }; resolve: (a: ViewPlacementsAnswer) => void; reject: (e: unknown) => void }> = []
  viewPlacements.mockImplementation((_v: string, urns: string[], opts: { signal?: AbortSignal; nodes?: boolean }) =>
    new Promise((resolve, reject) => { calls.push({ urns, opts, resolve, reject }) }))
  return calls
}

const make = () => new ServedPlacements({ viewId: 'v1', provider })
const tick = () => vi.advanceTimersByTimeAsync(20)

describe('ServedPlacements', () => {
  beforeEach(() => {
    viewPlacements.mockReset()
    vi.useFakeTimers()
  })
  afterEach(() => { vi.useRealTimers() })

  it('merges the asks of one tick into one request, and never asks twice', async () => {
    viewPlacements.mockImplementation(async (_v: string, urns: string[]) => answer(urns))
    const s = make()
    const one = s.placeOf(['b', 'a'])
    const two = s.placeOf(['a', 'c'])
    expect(s.stateOf('a')).toBe('asking')
    await tick()
    expect(viewPlacements).toHaveBeenCalledTimes(1)
    expect(viewPlacements.mock.calls[0][1]).toEqual(['a', 'b', 'c'])
    expect((await one).get('a')).toEqual({ layerId: 'L1', source: 'member' })
    expect([...(await two).keys()]).toEqual(['a', 'c'])
    // Answered: asked again, nothing goes out.
    await s.placeOf(['a', 'b', 'c'])
    await tick()
    expect(viewPlacements).toHaveBeenCalledTimes(1)
  })

  it('an ask for what is on its way waits for that answer', async () => {
    const calls = held()
    const s = make()
    const first = s.placeOf(['a', 'b'])
    await tick()
    const second = s.placeOf(['b'])
    await tick()
    expect(calls).toHaveLength(1)
    calls[0].resolve(answer(['a', 'b']))
    expect((await second).get('b')?.layerId).toBe('L1')
    await first
  })

  it('sends sorted batches of 2,000 — 500 with nodes — two at a time', async () => {
    const calls = held()
    const s = make()
    const urns = Array.from({ length: 4500 }, (_, i) => `u${String(4499 - i).padStart(4, '0')}`)
    const placed = s.placeOf(urns)
    await tick()
    expect(calls.map((c) => c.urns.length)).toEqual([2000, 2000])
    expect(calls[0].urns[0]).toBe('u0000')
    calls[0].resolve(answer(calls[0].urns))
    await tick()
    expect(calls.map((c) => c.urns.length)).toEqual([2000, 2000, 500])
    calls[1].resolve(answer(calls[1].urns))
    calls[2].resolve(answer(calls[2].urns))
    expect((await placed).size).toBe(4500)

    const loading = s.load(Array.from({ length: 600 }, (_, i) => `n${i}`))
    await tick()
    expect(calls.slice(3).map((c) => [c.urns.length, c.opts.nodes])).toEqual([[500, true], [100, true]])
    calls[3].resolve(withNodes(calls[3].urns))
    calls[4].resolve(withNodes(calls[4].urns))
    expect((await loading).nodes).toHaveLength(600)
  })

  it('a `now` ask goes ahead of background ones waiting for a lane', async () => {
    const calls = held()
    const s = make()
    void s.placeOf(Array.from({ length: 6000 }, (_, i) => `bg${String(i).padStart(4, '0')}`))
    await tick()
    expect(calls).toHaveLength(2)                    // a third background batch waits
    const now = s.placeOf(['reveal'], { priority: 'now' })
    await tick()
    calls[0].resolve(answer(calls[0].urns))
    await tick()
    expect(calls[2].urns).toEqual(['reveal'])
    calls[2].resolve(answer(['reveal']))
    expect((await now).get('reveal')?.layerId).toBe('L1')
  })

  it('keeps ONE map, changed in place: the version counts each answer', async () => {
    const calls = held()
    const s = make()
    const map = s.placements
    void s.placeOf(Array.from({ length: 2500 }, (_, i) => `u${i}`))
    await tick()
    const before = s.version
    calls[0].resolve(answer(calls[0].urns))
    await tick()
    expect(s.version).toBe(before + 1)
    calls[1].resolve(answer(calls[1].urns))
    await tick()
    expect(s.version).toBe(before + 2)
    expect(s.placements).toBe(map)
    expect(map.size).toBe(2500)
    expect(s.counts()).toEqual({ placed: 2500, asking: 0, failed: 0, outside: 0 })
  })

  it('an answer with another stamp drops what was answered before, keeping itself', async () => {
    const calls = held()
    const s = make()
    void s.placeOf(['a'])
    await tick()
    calls[0].resolve(answer(['a']))
    await tick()
    void s.placeOf(['b'])
    await tick()
    const generation = s.generation
    calls[1].resolve(answer(['b'], { epoch: 2, digest: 'y' }))
    await tick()
    expect(s.get('a')).toBeUndefined()
    expect(s.get('b')?.layerId).toBe('L1')
    expect(s.generation).toBe(generation + 1)
  })

  it('an answer read before the stamp moved is asked again', async () => {
    const calls = held()
    const s = make()
    const placed = s.placeOf(Array.from({ length: 4001 }, (_, i) => `u${String(i).padStart(4, '0')}`))
    await tick()
    calls[0].resolve(answer(calls[0].urns, { epoch: 1 }))
    await tick()
    expect(calls[2].urns).toEqual(['u4000'])          // sent under the first stamp
    // The other lane's answer: the view moved on (a newer epoch).
    calls[1].resolve(answer(calls[1].urns, { epoch: 2 }))
    await tick()
    expect(s.placements.size).toBe(2000)
    // Read before the move: not taken, asked again.
    calls[2].resolve(answer(['u4000'], { epoch: 1 }))
    await tick()
    expect(s.get('u4000')).toBeUndefined()
    expect(calls[3].urns).toEqual(['u4000'])
    calls[3].resolve(answer(['u4000'], { epoch: 2 }))
    await tick()
    expect(s.get('u4000')?.layerId).toBe('L1')
    expect((await placed).get('u4000')?.layerId).toBe('L1')
  })

  it('asks a busy server again five more times, then says it failed — and Retry asks again', async () => {
    viewPlacements.mockRejectedValue(failure(429))
    const s = make()
    const placed = s.placeOf(['a', 'b'])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(viewPlacements).toHaveBeenCalledTimes(6)
    expect((await placed).get('a')).toBeNull()
    expect(s.stateOf('a')).toBe('failed')
    expect(s.counts(['a', 'b'])).toEqual({ placed: 0, asking: 0, failed: 2, outside: 0 })

    viewPlacements.mockReset()
    viewPlacements.mockImplementation(async (_v: string, urns: string[]) => answer(urns))
    s.retryFailed()
    expect(s.stateOf('a')).toBe('asking')
    await tick()
    expect(s.stateOf('a')).toBe('placed')
  })

  it('a server error is asked again twice; a connection that dropped, as a busy server', async () => {
    viewPlacements.mockRejectedValue(failure(500))
    const s = make()
    void s.placeOf(['a'])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(viewPlacements).toHaveBeenCalledTimes(3)
    expect(s.stateOf('a')).toBe('failed')

    viewPlacements.mockReset()
    viewPlacements.mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockImplementation(async (_v: string, urns: string[]) => answer(urns))
    void s.placeOf(['b'])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(viewPlacements).toHaveBeenCalledTimes(2)
    expect(s.stateOf('b')).toBe('placed')
  })

  it('a 422 says the view isn’t one the server places: nothing more is asked', async () => {
    viewPlacements.mockRejectedValue(Object.assign(failure(422), { code: 'not_served_view' }))
    const s = make()
    const asked = s.placeOf(['a'])
    await tick()
    expect((await asked).get('a')).toBeNull()
    expect(s.unavailable).toEqual({ status: 422, reason: 'not_served_view' })
    expect(viewPlacements).toHaveBeenCalledTimes(1)
    await s.placeOf(['b'])
    expect((await s.load(['c'])).failed).toEqual(['c'])
    await tick()
    expect(viewPlacements).toHaveBeenCalledTimes(1)
    // The first key only names what it was read for; a new one (the view changed) asks again.
    s.reset('first')
    expect(s.unavailable).not.toBeNull()
    s.reset('changed')
    expect(s.unavailable).toBeNull()
  })

  it('a stopped ask leaves its entities unknown, asking nothing more', async () => {
    const calls = held()
    const s = make()
    const before = new AbortController()
    const p1 = s.placeOf(['a'], { signal: before.signal })
    before.abort()
    await expect(p1).rejects.toThrow()
    await tick()
    expect(calls).toHaveLength(0)
    expect(s.stateOf('a')).toBe('unknown')

    const during = new AbortController()
    const p2 = s.placeOf(['b'], { signal: during.signal })
    await tick()
    expect(calls).toHaveLength(1)
    during.abort()
    await expect(p2).rejects.toThrow()
    expect(calls[0].opts.signal?.aborted).toBe(true)
    calls[0].reject(new DOMException('aborted', 'AbortError'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(s.stateOf('b')).toBe('unknown')
    expect(calls).toHaveLength(1)                     // not asked again
  })

  it('a stopped ask keeps what another still waits on', async () => {
    const calls = held()
    const s = make()
    const stop = new AbortController()
    void s.placeOf(['a'], { signal: stop.signal }).catch(() => {})
    const kept = s.placeOf(['a'])
    await tick()
    stop.abort()
    expect(calls[0].opts.signal?.aborted).toBe(false)
    calls[0].resolve(answer(['a']))
    expect((await kept).get('a')?.layerId).toBe('L1')
  })

  it('load brings each drawn entity’s node, tagged for its layer, batch by batch', async () => {
    const calls = held()
    const s = make()
    const batches: number[] = []
    const progress: number[] = []
    const loading = s.load(['t1', 'out1', 't2'], {
      onNodes: (nodes) => batches.push(nodes.length), onProgress: (p) => progress.push(p.done),
    })
    await tick()
    expect(calls[0].opts.nodes).toBe(true)
    calls[0].resolve(withNodes(calls[0].urns))
    const out = await loading
    expect(out.outside).toEqual(['out1'])
    expect(out.nodes.map((n) => [n.node.urn, n.layerId, (n.node as { feedLayerId?: string }).feedLayerId]))
      .toEqual([['t1', 'L1', 'L1'], ['t2', 'L1', 'L1']])
    expect(batches).toEqual([2])
    expect(progress).toEqual([3])
    // Known to be drawn nowhere: no node to ask for.
    expect((await s.load(['out1'])).outside).toEqual(['out1'])
    expect(calls).toHaveLength(1)
  })
})
