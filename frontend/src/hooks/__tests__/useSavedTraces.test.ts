/**
 * useSavedTraces — saved traces survive a reload (IndexedDB), keep their
 * results in a record of their own, give the oldest results up when the
 * browser is out of space, and still work — for this visit — with no
 * IndexedDB at all.
 */
import 'fake-indexeddb/auto'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import * as idb from '@/lib/idbStore'
import { useSavedTraces, type SaveTraceInput } from '../useSavedTraces'

const input = (urns: string[], rows = 3): SaveTraceInput => ({
  name: urns.join(' + '),
  recipe: {
    urn: urns[0]!, ...(urns.length > 1 ? { urns } : {}), focusId: urns[0]!,
    view: { showUpstream: true, showDownstream: true, depthUp: 25, depthDown: 25, traceExpansion: [] }, timestamp: 1,
  },
  seedLabels: urns,
  rows: Array.from({ length: rows }, (_, i) => ({
    urn: `urn:${urns[0]}:${i}`, name: `n${i}`, type: 'dataset', role: i ? 'upstream' : 'seed',
    hops: i, hopsUp: i, hopsDown: null, layer: 'L', path: [], reachedFrom: [],
  })),
  edges: [],
  counts: { nodes: rows, upstream: rows - 1, downstream: 0, edges: 0 },
  partial: false,
})

let n = 0
const fresh = () => ({ user: `u${++n}`, view: 'v1' })

describe('useSavedTraces', () => {
  it('saves a trace with its results, and both survive a reload', async () => {
    const who = fresh()
    const first = renderHook(() => useSavedTraces(who.user, who.view))
    let id = ''
    await act(async () => { id = (await first.result.current.save(input(['a', 'b']))).saved.id })
    expect(first.result.current.list.map(t => t.name)).toEqual(['a + b'])
    first.unmount()

    const again = renderHook(() => useSavedTraces(who.user, who.view))
    await waitFor(() => expect(again.result.current.list).toHaveLength(1))
    expect(again.result.current.list[0]).toMatchObject({ id, hasResults: true })
    const results = await again.result.current.results(id)
    expect(results?.rows.map(r => r.urn)).toEqual(['urn:a:0', 'urn:a:1', 'urn:a:2'])
  })

  it('each user and view has its own list', async () => {
    const who = fresh()
    const mine = renderHook(() => useSavedTraces(who.user, who.view))
    await act(async () => { await mine.result.current.save(input(['a'])) })
    const other = renderHook(() => useSavedTraces(who.user, 'v2'))
    await new Promise(r => setTimeout(r, 20))
    expect(other.result.current.list).toEqual([])
  })

  it('out of space, the oldest give up their results and the save is tried again', async () => {
    const who = fresh()
    const h = renderHook(() => useSavedTraces(who.user, who.view))
    await act(async () => { await h.result.current.save(input(['old'])) })
    const real = idb.idbSet
    let refusals = 1
    const spy = vi.spyOn(idb, 'idbSet').mockImplementation(async (key, value) => {
      if (key.startsWith('nx:saved-trace-snap:') && refusals-- > 0) return false
      return real(key, value)
    })
    let note: string | null = null
    await act(async () => { note = (await h.result.current.save(input(['new']))).note })
    spy.mockRestore()
    expect(note).toMatch(/to make room/i)
    const byName = new Map(h.result.current.list.map(t => [t.name, t]))
    expect(byName.get('new')?.hasResults).toBe(true)
    expect(byName.get('old')?.hasResults).toBe(false)
  })

  it('with no IndexedDB it keeps the list for this visit, and says so', async () => {
    const spy = vi.spyOn(idb, 'idbAvailable').mockReturnValue(false)
    const who = fresh()
    const h = renderHook(() => useSavedTraces(who.user, who.view))
    let note: string | null = null
    let id = ''
    await act(async () => { const o = await h.result.current.save(input(['a'])); note = o.note; id = o.saved.id })
    expect(h.result.current.persistent).toBe(false)
    expect(note).toMatch(/this visit only/i)
    expect((await h.result.current.results(id))?.rows).toHaveLength(3)
    spy.mockRestore()
  })

  it('rename and remove', async () => {
    const who = fresh()
    const h = renderHook(() => useSavedTraces(who.user, who.view))
    let id = ''
    await act(async () => { id = (await h.result.current.save(input(['a']))).saved.id })
    act(() => h.result.current.rename(id, 'Revenue feed'))
    expect(h.result.current.list[0]!.name).toBe('Revenue feed')
    act(() => h.result.current.remove(id))
    expect(h.result.current.list).toEqual([])
    expect(await h.result.current.results(id)).toBeNull()
  })
})
