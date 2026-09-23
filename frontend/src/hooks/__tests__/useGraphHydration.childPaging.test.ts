/**
 * `loadChildren` as a lossless, bounded pager over one parent's children.
 *
 * A container can hold thousands of children; the canvas reaches them a page at
 * a time as the user scrolls. That only works if every page call is:
 *
 *  - COMPLETE: repeated calls walk to the last child, each child exactly once,
 *    then stop asking (the server's `hasMore`, not a client count, says when).
 *  - POSITIONED BY THE SERVER: each page is read at the offset the previous page
 *    said the next one starts (`nextOffset`) — never a count of rows returned
 *    (a draft overlay adds and drops rows around a page) and never a name
 *    cursor (providers that ignore it; entities with no stored display name).
 *  - O(page): cross-page sibling lineage comes back WITH each page
 *    (`lineageScope: 'siblings'`) instead of re-sending every loaded sibling to
 *    /edges/between — the old supplement was quadratic per parent.
 *  - HONEST: a sibling edge whose far end is not loaded yet is held back (it
 *    returns with that sibling's own page).
 *  - STALL-PROOF: a page that brings nothing new (its rows arrived out of band)
 *    does not end the call — the pager walks on until something lands.
 *  - RESUMABLE: a failed page is retried from the SAME position.
 *  - FENCED: a page that lands after the graph was replaced is dropped.
 */
import { renderHook, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Page = {
  children: Array<{ urn: string; displayName: string; entityType: string; childCount?: number }>
  containmentEdges: Array<{ id: string; sourceUrn: string; targetUrn: string; edgeType: string }>
  lineageEdges: Array<{ id: string; sourceUrn: string; targetUrn: string; edgeType: string }>
  totalChildren: number
  hasMore: boolean
  nextOffset?: number | null
}

const { mockProvider } = vi.hoisted(() => ({
  mockProvider: {
    getNodes: vi.fn(async () => []),
    getEdgesBetween: vi.fn(async () => []),
    getChildren: vi.fn(async () => []),
    getChildrenWithEdges: vi.fn(async (): Promise<Page> => ({
      children: [], containmentEdges: [], lineageEdges: [], totalChildren: 0, hasMore: false, nextOffset: 0,
    })),
  },
}))

vi.mock('@/providers/GraphProviderContext', () => ({
  useGraphProvider: () => mockProvider,
  useGraphProviderContext: () => ({ providerVersion: 1 }),
}))
vi.mock('@/hooks/useViewSchema', () => ({
  useViewContainmentEdgeTypes: () => ['CONTAINS'],
  useViewLineageEdgeTypes: () => ['FLOWS_TO'],
  useViewRootEntityTypes: () => ['table'],
  useViewEntityTypes: () => [
    { id: 'table', hierarchy: { canBeContainedBy: [], canContain: ['column'] } },
    { id: 'column', hierarchy: { canBeContainedBy: ['table'], canContain: [] } },
  ],
  useViewSchemaIsReady: () => true,
}))
vi.mock('@/store/schema', () => ({
  useActiveView: () => ({
    id: 'v1',
    layout: { type: 'reference', referenceLayout: { layers: [] } },
    content: { visibleEntityTypes: ['table', 'column'] },
  }),
  isContainmentEdgeType: (edgeType: string, types: string[]) =>
    types.some((t) => t.toUpperCase() === edgeType.toUpperCase()),
  normalizeEdgeType: (e: { data?: { edgeType?: string; relationship?: string } }) =>
    (e.data?.edgeType || e.data?.relationship || '').toUpperCase(),
}))

import { useGraphHydration } from '../useGraphHydration'
import { useCanvasStore, type LineageNode } from '@/store/canvas'

const PARENT = 'urn:demo:table:P'
const TOTAL = 250
const PAGE = 100
const kid = (i: number) => `urn:demo:column:c${String(i).padStart(3, '0')}`

type Opts = { offset?: number; limit?: number; lineageScope?: string; sortDirection?: string; cursor?: string | null }

/** The server: children in its own order, read by OFFSET; it reports where the
 *  next page starts. `hide` drops rows from what it RETURNS without moving the
 *  position — what a draft that deleted them looks like. Lineage in siblings
 *  scope = edges between this page and ANY child, from `lineage`. */
function serve(lineage: Array<[number, number]> = [], hide: Set<number> = new Set()) {
  return async (_urn: string, opts: Opts) => {
    const start = opts.offset ?? 0
    const idx = Array.from({ length: Math.max(0, Math.min(PAGE, TOTAL - start)) }, (_, k) => start + k)
    const onPage = new Set(idx)
    const edges = lineage
      .filter(([a, b]) => onPage.has(a) || onPage.has(b))
      .filter(([a, b]) => opts.lineageScope === 'siblings' || (onPage.has(a) && onPage.has(b)))
      .map(([a, b]) => ({ id: `l${a}-${b}`, sourceUrn: kid(a), targetUrn: kid(b), edgeType: 'FLOWS_TO' }))
    const shown = idx.filter(i => !hide.has(i))
    return {
      children: shown.map(i => ({ urn: kid(i), displayName: `c${i}`, entityType: 'column' })),
      containmentEdges: shown.map(i => ({ id: `c-${i}`, sourceUrn: PARENT, targetUrn: kid(i), edgeType: 'CONTAINS' })),
      lineageEdges: edges,
      totalChildren: TOTAL,
      hasMore: start + idx.length < TOTAL,
      nextOffset: start + idx.length,
    }
  }
}

function seedParentOnly(held: number[] = []) {
  const parent = {
    id: PARENT, position: { x: 0, y: 0 },
    data: { label: 'P', urn: PARENT, type: 'table', childCount: TOTAL },
  } as LineageNode
  const kids = held.map(i => ({
    id: kid(i), position: { x: 0, y: 0 }, data: { label: `c${i}`, urn: kid(i), type: 'column' },
  }) as LineageNode)
  // Containment edges under the ids the server sends, so "held" means the same thing to both.
  useCanvasStore.setState({
    nodes: [parent, ...kids],
    edges: held.map(i => ({ id: `c-${i}`, source: PARENT, target: kid(i), data: { edgeType: 'CONTAINS' } }) as never),
    _nodeIndex: new Set([PARENT, ...kids.map(n => n.id)]),
    _edgeIndex: new Set(held.map(i => `c-${i}`)),
    childPaging: {},
    visibleEdges: [],
  })
}

const loadedKids = () => useCanvasStore.getState().nodes.filter(n => n.id !== PARENT).map(n => n.id)
const callOpts = (i: number) =>
  (mockProvider.getChildrenWithEdges.mock.calls[i] as unknown as [string, Opts])[1]

describe('loadChildren — lossless paging', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seedParentOnly()
  })

  it('walks every child exactly once, then stops asking', async () => {
    mockProvider.getChildrenWithEdges.mockImplementation(serve() as never)
    const { result } = renderHook(() => useGraphHydration())

    for (let i = 0; i < 4; i++) {
      await act(async () => { await result.current.loadChildren(PARENT) })
    }
    const got = loadedKids()
    expect(got).toHaveLength(TOTAL)
    expect(new Set(got).size).toBe(TOTAL)
    // 3 pages for 250 children; the 4th call must not hit the server.
    expect(mockProvider.getChildrenWithEdges).toHaveBeenCalledTimes(3)
  })

  it('reads each page where the server said it starts — never at a count of rows returned', async () => {
    // A draft deleted c050: page 1 returns 99 rows, but main's next page starts at 100.
    mockProvider.getChildrenWithEdges.mockImplementation(serve([], new Set([50])) as never)
    const { result } = renderHook(() => useGraphHydration())
    for (let i = 0; i < 3; i++) {
      await act(async () => { await result.current.loadChildren(PARENT) })
    }
    expect(callOpts(1).offset).toBe(100)      // not 99: counting would re-read c099…
    expect(callOpts(2).offset).toBe(200)
    expect(loadedKids()).toHaveLength(TOTAL - 1)
    // …and no name cursor, which some providers ignore and missing names break.
    for (let i = 0; i < 3; i++) expect(callOpts(i).cursor ?? null).toBeNull()
  })

  it('asks for sibling-scoped lineage and never re-sends loaded siblings', async () => {
    mockProvider.getChildrenWithEdges.mockImplementation(serve() as never)
    const { result } = renderHook(() => useGraphHydration())
    for (let i = 0; i < 3; i++) {
      await act(async () => { await result.current.loadChildren(PARENT) })
    }
    for (const call of mockProvider.getChildrenWithEdges.mock.calls as unknown as Array<[string, Opts]>) {
      expect(call[1].lineageScope).toBe('siblings')
    }
    expect(mockProvider.getEdgesBetween).not.toHaveBeenCalled()
  })

  it('holds an edge back until its far end loads, then keeps it', async () => {
    // c010 (page 1) -> c150 (page 2)
    mockProvider.getChildrenWithEdges.mockImplementation(serve([[10, 150]]) as never)
    const { result } = renderHook(() => useGraphHydration())
    const hasEdge = () => useCanvasStore.getState().edges.some(e => e.source === kid(10) && e.target === kid(150))

    await act(async () => { await result.current.loadChildren(PARENT) })
    expect(hasEdge()).toBe(false)          // c150 not loaded yet → no dangling edge
    await act(async () => { await result.current.loadChildren(PARENT) })
    expect(hasEdge()).toBe(true)           // came back with c150's page
  })

  it('starts at the top when the children held are not the first ones', async () => {
    // Placed by hand / loaded out of band: the LAST 50. Paging from "how many
    // are held" (50) would skip c000–c049 for good.
    seedParentOnly(Array.from({ length: 50 }, (_, i) => 200 + i))
    mockProvider.getChildrenWithEdges.mockImplementation(serve() as never)
    const { result } = renderHook(() => useGraphHydration())
    await act(async () => { await result.current.loadChildren(PARENT) })
    expect(callOpts(0).offset ?? 0).toBe(0)
    expect(loadedKids()).toContain(kid(0))
  })

  it('walks past a page whose rows are already held', async () => {
    // Page 1's rows are held (a search reveal) — the first page brings nothing
    // new; stopping there would leave the "load more" row where it was: a
    // silent stall.
    seedParentOnly(Array.from({ length: PAGE }, (_, i) => i))
    useCanvasStore.setState(s => ({
      nodes: s.nodes.map(n => (n.id === PARENT ? n : { ...n, data: { ...n.data, viaReveal: true } })),
    }))
    mockProvider.getChildrenWithEdges.mockImplementation(serve() as never)
    const { result } = renderHook(() => useGraphHydration())

    await act(async () => { await result.current.loadChildren(PARENT) })     // ONE call
    expect(loadedKids()).toHaveLength(2 * PAGE)                              // walked on to page 2
    expect(mockProvider.getChildrenWithEdges).toHaveBeenCalledTimes(2)
  })

  it('restarts at the top when the order changes', async () => {
    // An ascending prefetch left a pager at 100; a Z→A column must not resume
    // there — offset 100 of the DESCENDING order skips its first 100 rows.
    mockProvider.getChildrenWithEdges.mockImplementation(serve() as never)
    const { result } = renderHook(() => useGraphHydration())
    await act(async () => { await result.current.loadChildren(PARENT) })
    await act(async () => { await result.current.loadChildren(PARENT, { sortDirection: 'desc' }) })
    expect(callOpts(1)).toMatchObject({ offset: 0, sortDirection: 'desc' })
  })

  it('resumes a failed page from the same position', async () => {
    const ok = serve()
    let fail = true
    mockProvider.getChildrenWithEdges.mockImplementation((async (urn: string, opts: Opts) => {
      if (opts.offset === 100 && fail) { fail = false; throw new Error('503') }
      return ok(urn, opts)
    }) as never)
    const { result } = renderHook(() => useGraphHydration())

    await act(async () => { await result.current.loadChildren(PARENT) })     // page 1
    await act(async () => { await result.current.loadChildren(PARENT) })     // page 2 fails
    expect(result.current.failedNodes.has(PARENT)).toBe(true)
    await act(async () => { await result.current.loadChildren(PARENT) })     // retry
    expect(callOpts(2).offset).toBe(100)
    expect(result.current.failedNodes.has(PARENT)).toBe(false)
    expect(loadedKids()).toHaveLength(200)
  })

  it('drops a page that lands after the graph was replaced', async () => {
    // A re-hydrate replaced the graph while page 2 was in flight. Landing it
    // would adopt position 200 on the NEW graph and skip its first pages.
    const ok = serve()
    let release: () => void = () => {}
    mockProvider.getChildrenWithEdges.mockImplementation((async (urn: string, opts: Opts) => {
      if (opts.offset === 100) await new Promise<void>(r => { release = r })
      return ok(urn, opts)
    }) as never)
    const { result } = renderHook(() => useGraphHydration())
    await act(async () => { await result.current.loadChildren(PARENT) })
    let inFlight: Promise<unknown> = Promise.resolve()
    await act(async () => { inFlight = result.current.loadChildren(PARENT) })
    const parent = useCanvasStore.getState().nodes.find(n => n.id === PARENT)!
    act(() => { useCanvasStore.getState().setGraph([parent], []) })
    await act(async () => { release(); await inFlight })

    expect(loadedKids()).toHaveLength(0)
    expect(useCanvasStore.getState().childPaging[PARENT]).toBeUndefined()
  })

  it('a load that waited in the queue while the graph was replaced pages the NEW graph from its start', async () => {
    // Its position used to be taken when it was ASKED, then carried into the new
    // graph when it finally ran — the new graph's first pages were skipped.
    const others = Array.from({ length: 6 }, (_, i) => `urn:demo:table:O${i}`)
    const other = (id: string) => ({
      id, position: { x: 0, y: 0 }, data: { label: id, urn: id, type: 'table', childCount: 5 },
    }) as LineageNode
    const parent = useCanvasStore.getState().nodes.find(n => n.id === PARENT)!
    useCanvasStore.setState(s => ({
      nodes: [...s.nodes, ...others.map(other)],
      _nodeIndex: new Set([...s._nodeIndex, ...others]),
    }))
    const ok = serve()
    const releases: Array<() => void> = []
    mockProvider.getChildrenWithEdges.mockImplementation((async (u: string, o: Opts) => {
      if (u !== PARENT) {
        await new Promise<void>(r => { releases.push(r) })
        return { children: [], containmentEdges: [], lineageEdges: [], totalChildren: 0, hasMore: false, nextOffset: 0 }
      }
      return ok(u, o)
    }) as never)
    const { result } = renderHook(() => useGraphHydration())
    await act(async () => { await result.current.loadChildren(PARENT) })
    await act(async () => { await result.current.loadChildren(PARENT) })       // pager at 200
    const pending: Promise<unknown>[] = []
    act(() => { for (const o of others) pending.push(result.current.loadChildren(o)) })   // the queue is full
    act(() => { pending.push(result.current.loadChildren(PARENT)) })            // waits behind them
    act(() => { useCanvasStore.getState().setGraph([parent, ...others.map(other)], []) })
    await act(async () => { releases.forEach(r => r()); await Promise.all(pending) })

    const lastForParent = (mockProvider.getChildrenWithEdges.mock.calls as unknown as Array<[string, Opts]>)
      .filter(c => c[0] === PARENT).at(-1)![1]
    expect(lastForParent.offset ?? 0).toBe(0)
    expect(loadedKids()).toContain(kid(0))
  })

  it('a restart from the top costs ONE store update, however many held pages it walks', async () => {
    seedParentOnly(Array.from({ length: 200 }, (_, i) => i))    // pages 1–2 held, no pager
    mockProvider.getChildrenWithEdges.mockImplementation(serve() as never)
    const { result } = renderHook(() => useGraphHydration())
    let updates = 0
    const unsubscribe = useCanvasStore.subscribe(() => { updates += 1 })
    await act(async () => { await result.current.loadChildren(PARENT) })
    unsubscribe()
    expect(mockProvider.getChildrenWithEdges).toHaveBeenCalledTimes(3)       // 0, 100 held; 200 new
    expect(loadedKids()).toHaveLength(TOTAL)
    expect(updates).toBe(1)
  })

  it('ends the sequence on a page that says "more" but does not move', async () => {
    mockProvider.getChildrenWithEdges.mockResolvedValue({
      children: [], containmentEdges: [], lineageEdges: [], totalChildren: TOTAL, hasMore: true, nextOffset: 0,
    })
    const { result } = renderHook(() => useGraphHydration())
    await act(async () => { await result.current.loadChildren(PARENT) })
    expect(result.current.exhaustedParents.get(PARENT)).toBe(TOTAL)
    const calls = mockProvider.getChildrenWithEdges.mock.calls.length
    await act(async () => { await result.current.loadChildren(PARENT) })
    expect(mockProvider.getChildrenWithEdges.mock.calls.length).toBe(calls)   // no endless re-asking
  })

  it('does not let an "exhausted" verdict outlive children that appear later', async () => {
    // First look: the server has nothing yet — the pager rightly says exhausted.
    mockProvider.getChildrenWithEdges.mockResolvedValueOnce({
      children: [], containmentEdges: [], lineageEdges: [], totalChildren: 0, hasMore: false, nextOffset: 0,
    })
    const { result } = renderHook(() => useGraphHydration())
    await act(async () => { await result.current.loadChildren(PARENT) })
    // Said against the count the parent had then — consumers compare it.
    expect(result.current.exhaustedParents.get(PARENT)).toBe(TOTAL)

    // Children arrive at the source; the parent's count is refreshed.
    useCanvasStore.getState().updateNode(PARENT, { childCount: TOTAL + 1 })
    mockProvider.getChildrenWithEdges.mockImplementation(serve() as never)
    await act(async () => { await result.current.loadChildren(PARENT) })
    expect(loadedKids().length).toBeGreaterThan(0)
  })

  it('lands a page as ONE store update — every update re-renders the whole canvas', async () => {
    mockProvider.getChildrenWithEdges.mockImplementation(serve() as never)
    const { result } = renderHook(() => useGraphHydration())
    let updates = 0
    const unsubscribe = useCanvasStore.subscribe(() => { updates += 1 })
    await act(async () => { await result.current.loadChildren(PARENT) })
    unsubscribe()
    expect(loadedKids()).toHaveLength(PAGE)
    expect(updates).toBe(1)   // nodes, edges and the pager position together
  })

  it('with the count UNKNOWN, a server that ignores the offset gets a short walk, not an endless one', async () => {
    // A parent seeded from /ancestors has childCount null, and unknown means
    // "ask". A server that ignores the offset and reports no position returns
    // page 1 forever while saying "more"; with no count to bound the walk,
    // nothing else would stop it.
    seedParentOnly(Array.from({ length: PAGE }, (_, i) => i))   // page 1 held
    useCanvasStore.getState().updateNode(PARENT, { childCount: null } as never)
    const page1 = serve()
    mockProvider.getChildrenWithEdges.mockImplementation((async (u: string, o: Opts) => ({
      ...(await page1(u, { ...o, offset: 0 })),
      nextOffset: null,
    })) as never)
    const { result } = renderHook(() => useGraphHydration())
    await act(async () => { await result.current.loadChildren(PARENT) })
    expect(mockProvider.getChildrenWithEdges).toHaveBeenCalledTimes(5)
    // The ground covered is kept: the next ask carries on, it does not restart.
    await act(async () => { await result.current.loadChildren(PARENT) })
    expect(callOpts(5).offset).toBe(5 * PAGE)
  })

  describe("a page's lineage to the rest of the canvas", () => {
    const FAR = 'urn:demo:column:elsewhere'
    let open: () => void = () => {}
    beforeEach(() => {
      const gate = new Promise<void>(r => { open = r })
      Object.assign(mockProvider, {
        getEdges: vi.fn(async (q: { sourceUrns?: string[] }) => {
          await gate
          return q.sourceUrns ? [{ id: 'far-1', sourceUrn: kid(0), targetUrn: FAR, edgeType: 'FLOWS_TO' }] : []
        }),
      })
      mockProvider.getChildrenWithEdges.mockImplementation(serve() as never)
    })
    afterEach(() => { delete (mockProvider as { getEdges?: unknown }).getEdges })
    const hasFar = () => useCanvasStore.getState().edges.some(e => e.target === FAR)

    it('lands after the page', async () => {
      const { result } = renderHook(() => useGraphHydration())
      await act(async () => { await result.current.loadChildren(PARENT) })
      expect(hasFar()).toBe(false)                 // the rows paint first…
      await act(async () => { open(); await new Promise(r => setTimeout(r, 0)) })
      expect(hasFar()).toBe(true)                  // …and their flows follow
    })

    it('is dropped when the graph was replaced before it arrived', async () => {
      const { result } = renderHook(() => useGraphHydration())
      await act(async () => { await result.current.loadChildren(PARENT) })
      const parent = useCanvasStore.getState().nodes.find(n => n.id === PARENT)!
      act(() => { useCanvasStore.getState().setGraph([parent], []) })
      await act(async () => { open(); await new Promise(r => setTimeout(r, 0)) })
      expect(hasFar()).toBe(false)
    })
  })
})
