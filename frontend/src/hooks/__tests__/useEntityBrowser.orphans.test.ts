/**
 * useEntityBrowser — "Orphans only".
 *
 * The mode is a server filter (`orphansOnly`) carried by every top-level request
 * while it is on, and by none while it is off. `listedOrphans` says which list is
 * on screen: it changes only when that list's first page lands, so a row is never
 * tagged an orphan from the toggle alone, and a page requested in the other mode
 * is dropped rather than appended to the wrong list.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useEntityBrowser } from '../useEntityBrowser'

type Q = { entityTypes?: string[]; orphansOnly?: boolean; searchQuery?: string; limit?: number; cursor?: string | null }

const pad = (i: number) => String(i).padStart(4, '0')
const row = (urn: string, entityType: string) => ({ urn, entityType, displayName: urn, childCount: 0 })
const ROOTS = Array.from({ length: 2500 }, (_, i) => row(`urn:d:${pad(i)}`, 'Domain'))
const ORPHANS = Array.from({ length: 120 }, (_, i) => row(`urn:t:${pad(i)}`, 'Table'))

/** Offset cursors over two fixed lists: the orphans when `orphansOnly`, else the roots. */
function makeProvider(total: (q: Q) => number | null = q => (q.orphansOnly ? ORPHANS : ROOTS).length) {
  return {
    getTopLevelNodes: vi.fn(async (q: Q) => {
      const rows = q.orphansOnly ? ORPHANS : ROOTS
      const start = q.cursor ? Number(q.cursor) : 0
      const page = rows.slice(start, start + (q.limit ?? 50))
      const end = start + page.length
      return {
        nodes: page, hasMore: end < rows.length, nextCursor: end < rows.length ? String(end) : null,
        totalCount: total(q), rootTypeCount: 0, orphanCount: 0,
      }
    }),
    getChildrenWithEdges: vi.fn(),
  }
}

function mount(provider: ReturnType<typeof makeProvider>) {
  return renderHook(() => useEntityBrowser({
    provider: provider as never, containmentEdgeTypes: ['CONTAINS'], entityTypeDefinitions: [], enabled: true,
  }))
}

/** Lets a request started by a void setter land. */
const settle = () => new Promise(r => setTimeout(r, 0))
const lastQuery = (p: ReturnType<typeof makeProvider>) => p.getTopLevelNodes.mock.calls.at(-1)![0]
const isOrphanId = (urn: string) => urn.startsWith('urn:t:')

/** Holds the next request matching `match` until `release()` is called. */
function holdNext(p: ReturnType<typeof makeProvider>, match: (q: Q) => boolean) {
  const serve = p.getTopLevelNodes.getMockImplementation()!
  let release: () => void = () => {}
  let held = false
  p.getTopLevelNodes.mockImplementation(async (q: Q) => {
    if (!held && match(q)) {
      held = true
      await new Promise<void>(r => { release = r })
    }
    return serve(q)
  })
  return () => release()
}

describe('useEntityBrowser — orphans only', () => {
  beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}) })
  afterEach(() => { vi.restoreAllMocks() })

  it('re-queries page 1 with orphansOnly when turned on, and lists the orphans', async () => {
    const p = makeProvider()
    const { result } = mount(p)
    await act(async () => { await result.current.loadTopLevel() })
    expect(lastQuery(p).orphansOnly).toBeUndefined()
    expect(result.current.listedOrphans).toBe(false)

    await act(async () => { result.current.setOrphansOnly(true); await settle() })
    expect(lastQuery(p)).toMatchObject({ orphansOnly: true, cursor: null, limit: 50 })
    expect(result.current.orphansOnly).toBe(true)
    expect(result.current.listedOrphans).toBe(true)
    expect(result.current.topLevelIds.every(isOrphanId)).toBe(true)
  })

  it('carries orphansOnly on load more, load all and search', async () => {
    const p = makeProvider()
    const { result } = mount(p)
    await act(async () => { result.current.setOrphansOnly(true); await settle() })

    await act(async () => { await result.current.loadMoreTopLevel() })
    expect(lastQuery(p)).toMatchObject({ orphansOnly: true, cursor: '50' })

    await act(async () => { await result.current.loadAllTopLevel() })
    expect(lastQuery(p)).toMatchObject({ orphansOnly: true, cursor: '100', limit: 1000 })
    expect(result.current.topLevelIds).toHaveLength(ORPHANS.length)

    await act(async () => {
      result.current.setSearch('t:00')
      await new Promise(r => setTimeout(r, 350))
    })
    expect(lastQuery(p)).toMatchObject({ orphansOnly: true, searchQuery: 't:00', cursor: null })
  })

  it('narrows within orphans by the type pill', async () => {
    const p = makeProvider()
    const { result } = mount(p)
    await act(async () => { result.current.setOrphansOnly(true); await settle() })
    await act(async () => { result.current.setTypeFilter('Table'); await settle() })
    expect(lastQuery(p)).toMatchObject({ entityTypes: ['Table'], orphansOnly: true })
  })

  it('sends no orphansOnly once turned off again', async () => {
    const p = makeProvider()
    const { result } = mount(p)
    await act(async () => { result.current.setOrphansOnly(true); await settle() })
    await act(async () => { result.current.setOrphansOnly(false); await settle() })
    expect(lastQuery(p).orphansOnly).toBeUndefined()
    expect(result.current.listedOrphans).toBe(false)
    await act(async () => { await result.current.loadMoreTopLevel() })
    expect(lastQuery(p).orphansOnly).toBeUndefined()
    expect(result.current.topLevelIds.some(isOrphanId)).toBe(false)
  })

  it('says whether the total is a count', async () => {
    const counted = makeProvider()
    const a = mount(counted)
    await act(async () => { await a.result.current.loadTopLevel() })
    expect(a.result.current.topLevelTotalExact).toBe(true)

    const timedOut = makeProvider(() => null)
    const b = mount(timedOut)
    await act(async () => { await b.result.current.loadTopLevel() })
    expect(b.result.current.topLevelTotalExact).toBe(false)
    expect(b.result.current.topLevelTotalCount).toBe(0)
  })

  it('counts orphans across the whole data source, ignoring the pill and search', async () => {
    const p = makeProvider()
    const { result } = mount(p)
    await act(async () => { result.current.setTypeFilter('Domain'); await settle() })
    let n: number | null = -1
    await act(async () => { n = await result.current.countOrphans() })
    expect(lastQuery(p)).toEqual({ orphansOnly: true, limit: 50, cursor: null, includeChildCount: true })
    expect(n).toBe(ORPHANS.length)

    // Not counted in time: "many" while pages remain, else what one page holds.
    p.getTopLevelNodes.mockResolvedValueOnce({ nodes: ORPHANS.slice(0, 50), hasMore: true, nextCursor: '50', totalCount: null, rootTypeCount: 0, orphanCount: 0 })
    await act(async () => { n = await result.current.countOrphans() })
    expect(n).toBeNull()
    p.getTopLevelNodes.mockResolvedValueOnce({ nodes: ORPHANS.slice(0, 7), hasMore: false, nextCursor: null, totalCount: null, rootTypeCount: 0, orphanCount: 0 })
    await act(async () => { n = await result.current.countOrphans() })
    expect(n).toBe(7)
  })

  it('keeps the rows untagged while the orphans list is loading, and after it fails', async () => {
    const p = makeProvider()
    const { result } = mount(p)
    await act(async () => { await result.current.loadTopLevel() })

    const release = holdNext(p, q => !!q.orphansOnly)
    await act(async () => { result.current.setOrphansOnly(true); await settle() })
    expect(result.current.orphansOnly).toBe(true)
    expect(result.current.listedOrphans).toBe(false)              // old rows still on screen
    await act(async () => { release(); await settle() })
    expect(result.current.listedOrphans).toBe(true)

    await act(async () => { result.current.setOrphansOnly(false); await settle() })
    p.getTopLevelNodes.mockRejectedValueOnce(new Error('503'))
    await act(async () => { result.current.setOrphansOnly(true); await settle() })
    expect(result.current.listedOrphans).toBe(false)
    expect(result.current.topLevelIds.some(isOrphanId)).toBe(false)
  })

  it('drops a load-more page from the other mode that lands after the switch', async () => {
    const p = makeProvider()
    const { result } = mount(p)
    await act(async () => { await result.current.loadTopLevel() })

    const release = holdNext(p, q => q.cursor === '50' && !q.orphansOnly)
    let more: Promise<void> = Promise.resolve()
    await act(async () => { more = result.current.loadMoreTopLevel() })
    await act(async () => { result.current.setOrphansOnly(true); await settle() })
    expect(result.current.listedOrphans).toBe(true)
    await act(async () => { release(); await more })

    expect(result.current.topLevelIds).toHaveLength(50)
    expect(result.current.topLevelIds.every(isOrphanId)).toBe(true)
    expect(result.current.topLevelTotalCount).toBe(ORPHANS.length)
  })

  it('stops loading all once the mode switches', async () => {
    const p = makeProvider()
    const { result } = mount(p)
    await act(async () => { await result.current.loadTopLevel() })

    const release = holdNext(p, q => q.limit === 1000 && !q.orphansOnly)
    let all: Promise<void> = Promise.resolve()
    await act(async () => { all = result.current.loadAllTopLevel() })
    await act(async () => { result.current.setOrphansOnly(true); await settle() })
    await act(async () => { release(); await all })

    const bulk = p.getTopLevelNodes.mock.calls.filter(([q]) => q.limit === 1000)
    expect(bulk).toHaveLength(1)                                  // no second default page
    expect(result.current.topLevelIds.every(isOrphanId)).toBe(true)
  })

  it('keeps the default list when the orphans page lands after the mode is turned back off', async () => {
    const p = makeProvider()
    const { result } = mount(p)
    await act(async () => { await result.current.loadTopLevel() })

    const release = holdNext(p, q => !!q.orphansOnly)
    await act(async () => { result.current.setOrphansOnly(true); await settle() })
    await act(async () => { result.current.setOrphansOnly(false); await settle() })
    await act(async () => { release(); await settle() })
    expect(result.current.listedOrphans).toBe(false)
    expect(result.current.topLevelIds.some(isOrphanId)).toBe(false)

    await act(async () => { await result.current.loadAllTopLevel() })
    expect(result.current.topLevelIds).toHaveLength(ROOTS.length)
  })

  it('lets Load all page the list on screen after a failed switch', async () => {
    const p = makeProvider()
    const { result } = mount(p)
    await act(async () => { await result.current.loadTopLevel() })
    p.getTopLevelNodes.mockRejectedValueOnce(new Error('503'))
    await act(async () => { result.current.setOrphansOnly(true); await settle() })
    expect(result.current.listedOrphans).toBe(false)

    await act(async () => { await result.current.loadAllTopLevel() })
    expect(lastQuery(p).orphansOnly).toBeUndefined()
    expect(result.current.topLevelIds).toHaveLength(ROOTS.length)
  })

  it('drops a load-more page asked for before an on-then-off switch', async () => {
    const p = makeProvider()
    const { result } = mount(p)
    await act(async () => { await result.current.loadTopLevel() })
    await act(async () => { await result.current.loadMoreTopLevel() })

    const release = holdNext(p, q => q.cursor === '100' && !q.orphansOnly)
    let more: Promise<void> = Promise.resolve()
    await act(async () => { more = result.current.loadMoreTopLevel() })
    await act(async () => { result.current.setOrphansOnly(true); await settle() })
    await act(async () => { result.current.setOrphansOnly(false); await settle() })
    await act(async () => { release(); await more })

    // Rows 100-149 after the new page 1 would skip 50-99 for good.
    expect(result.current.topLevelIds).toEqual(ROOTS.slice(0, 50).map(r => r.urn))
  })
})
