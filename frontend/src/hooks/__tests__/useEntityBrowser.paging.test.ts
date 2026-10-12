/**
 * useEntityBrowser — a container's children, paged by the SERVER's position.
 *
 * The wizard's Entity Browser used to page a container with a name cursor. That
 * stops early wherever the cursor means nothing: the branch/as-of provider
 * ignores it (page 1 comes back again — a 4,000-child container stopped at 50),
 * and FalkorDB compares it with a display name the entity may not store. Each
 * page is now read where the previous page said the next one starts, whatever
 * the provider and whatever the names — and a page that returns fewer rows than
 * it read (a draft deleted some) neither repeats rows nor ends paging.
 *
 * Also pinned: a failure stops claiming anything once a page lands by any path.
 */
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useEntityBrowser } from '../useEntityBrowser'

const P = 'urn:p'
const TOTAL = 120
const kid = (i: number) => `urn:c:${String(i).padStart(3, '0')}`

/** Children of P read by offset (the cursor is ignored, as the branch provider
 *  does); `hide` rows are dropped from what comes back without moving the position. */
function makeProvider(hide = new Set<number>(), total = TOTAL) {
  return {
    getTopLevelNodes: vi.fn(async () => ({
      nodes: [{ urn: P, entityType: 'domain', displayName: 'P', childCount: total }],
      hasMore: false, nextCursor: null, totalCount: 1,
    })),
    getChildrenWithEdges: vi.fn(async (_u: string, o: { offset?: number; limit?: number }) => {
      const start = o.offset ?? 0
      const read = Array.from({ length: Math.max(0, Math.min(o.limit ?? 50, total - start)) }, (_, k) => start + k)
      const shown = read.filter(i => !hide.has(i))
      return {
        children: shown.map(i => ({ urn: kid(i), entityType: 'system', displayName: `c${i}` })),
        containmentEdges: shown.map(i => ({ id: `e${i}`, sourceUrn: P, targetUrn: kid(i), edgeType: 'CONTAINS' })),
        lineageEdges: [], totalChildren: total,
        hasMore: start + read.length < total, nextOffset: start + read.length,
      }
    }),
  }
}

function mount(provider: ReturnType<typeof makeProvider>) {
  return renderHook(() => useEntityBrowser({
    provider: provider as never, containmentEdgeTypes: ['CONTAINS'], entityTypeDefinitions: [], enabled: true,
  }))
}

describe('useEntityBrowser — paging a container', () => {
  it('reads each page at the server position, on a provider that ignores cursors', async () => {
    const provider = makeProvider(new Set([10]))       // a draft deleted child 10
    const { result } = mount(provider)
    await act(async () => { await result.current.loadTopLevel() })
    await act(async () => { await result.current.expandNode(P) })
    await act(async () => { await result.current.loadMoreChildren(P) })
    await act(async () => { await result.current.loadMoreChildren(P) })

    const offsets = provider.getChildrenWithEdges.mock.calls.map(c => (c[1] as { offset?: number }).offset ?? 0)
    expect(offsets).toEqual([0, 50, 100])                // not 49/99: no re-read, no drift
    const kids = result.current.peekNode(P)!.childIds
    expect(kids).toHaveLength(TOTAL - 1)
    expect(new Set(kids).size).toBe(TOTAL - 1)
    expect(result.current.peekNode(P)!.hasMore).toBe(false)
  })

  it('loads ALL children by walking the server positions', async () => {
    const provider = makeProvider()
    const { result } = mount(provider)
    await act(async () => { await result.current.loadTopLevel() })
    let all: string[] = []
    await act(async () => { all = await result.current.loadAllChildren(P) })
    expect(all).toHaveLength(TOTAL)
    expect(new Set(all).size).toBe(TOTAL)
  })

  it('never lets a page that lands late move the position back', async () => {
    // A "load more" read at 50 answers AFTER a select-all has paged on to 550: it
    // adds its rows, but ending paging at 100 would hide everything after.
    const provider = makeProvider(new Set(), 1200)
    const serveKids = provider.getChildrenWithEdges.getMockImplementation()!
    let releaseLate: () => void = () => {}
    let releaseBulk: () => void = () => {}
    provider.getChildrenWithEdges.mockImplementation(async (u: string, o: { offset?: number; limit?: number }) => {
      if (o.offset === 50 && o.limit === 50) await new Promise<void>(r => { releaseLate = r })
      if (o.offset === 550) await new Promise<void>(r => { releaseBulk = r })
      return serveKids(u, o)
    })
    const { result } = mount(provider)
    await act(async () => { await result.current.loadTopLevel() })
    await act(async () => { await result.current.expandNode(P) })            // 0–50
    let late: Promise<void> = Promise.resolve()
    let bulk: Promise<string[]> = Promise.resolve([])
    await act(async () => {
      late = result.current.loadMoreChildren(P)                              // read at 50, held back
      bulk = result.current.loadAllChildren(P)                               // 50–550 lands, then waits at 550
      await new Promise(r => setTimeout(r, 0))
    })
    await act(async () => { releaseLate(); await late })                     // the late page lands now
    expect(result.current.peekNode(P)).toMatchObject({ nextOffset: 550, hasMore: true })
    await act(async () => { releaseBulk(); await bulk })
  })

  it('stops claiming a failure once a page lands', async () => {
    const provider = makeProvider()
    const { result } = mount(provider)
    await act(async () => { await result.current.loadTopLevel() })
    await act(async () => { await result.current.expandNode(P) })
    provider.getChildrenWithEdges.mockRejectedValueOnce(new Error('503'))
    await act(async () => { await result.current.loadMoreChildren(P) })
    expect(result.current.failedIds.has(P)).toBe(true)
    // A select-all (or any other path) lands the rest: the failure no longer stands.
    await act(async () => { await result.current.loadAllChildren(P) })
    expect(result.current.failedIds.has(P)).toBe(false)
  })
})
