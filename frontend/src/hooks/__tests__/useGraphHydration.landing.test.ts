/**
 * Child pages that land close together commit as ONE store update.
 *
 * Every store update re-renders the whole canvas. Opening a level of 100
 * containers landed 100 pages one render each, the main thread fell behind
 * the network, and scrolling stuttered until the last page was in. So:
 *
 *  - pages landing within a short window (or until nothing else is on its way)
 *    commit together, with their containers' loading state;
 *  - a load settles only once its rows are in the store;
 *  - a lone load waits for nothing;
 *  - a page cancelled between landing and committing does not commit;
 *  - the rows' lineage is read once the loads settle, a few reads at a time,
 *    not one chain of reads per page as it lands.
 */
import { renderHook, act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Opts = { offset?: number; limit?: number }

const { mockProvider } = vi.hoisted(() => ({
  mockProvider: {
    getNodes: vi.fn(async () => []),
    getEdgesBetween: vi.fn(async () => []),
    getChildren: vi.fn(async () => []),
    getChildrenWithEdges: vi.fn(),
    getEdges: vi.fn(async () => []),
  },
}))

vi.mock('@/providers/GraphProviderContext', () => ({
  useGraphProvider: () => mockProvider,
  useGraphProviderContext: () => ({ providerVersion: 1 }),
}))
vi.mock('@/hooks/useViewSchema', () => ({
  useViewContainmentEdgeTypes: () => ['CONTAINS'],
  useViewLineageEdgeTypes: () => ['FLOWS_TO'],
  useViewRootEntityTypes: () => ['schema'],
  useViewEntityTypes: () => [
    { id: 'schema', hierarchy: { canBeContainedBy: [], canContain: ['table'] } },
    { id: 'table', hierarchy: { canBeContainedBy: ['schema'], canContain: [] } },
  ],
  useViewSchemaIsReady: () => true,
}))
vi.mock('@/store/schema', () => ({
  useActiveView: () => ({
    id: 'v1',
    layout: { type: 'reference', referenceLayout: { layers: [] } },
    content: { visibleEntityTypes: ['schema', 'table'] },
  }),
  isContainmentEdgeType: (edgeType: string, types: string[]) =>
    types.some((t) => t.toUpperCase() === edgeType.toUpperCase()),
  normalizeEdgeType: (e: { data?: { edgeType?: string; relationship?: string } }) =>
    (e.data?.edgeType || e.data?.relationship || '').toUpperCase(),
}))

import { useGraphHydration } from '../useGraphHydration'
import { useCanvasStore, type LineageNode } from '@/store/canvas'

const KIDS = 10
const parent = (i: number) => `urn:s:${i}`
const kid = (p: string, j: number) => `${p}/t${j}`
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A server answering each page after `latency` ms. */
function serve(latency: number) {
  return async (urn: string, opts?: Opts) => {
    if (latency) await wait(latency)
    const offset = opts?.offset ?? 0
    const ids = Array.from({ length: KIDS }, (_, j) => kid(urn, j))
    return {
      children: ids.map((u) => ({ urn: u, displayName: u, entityType: 'table' })),
      containmentEdges: ids.map((u) => ({ id: `c:${u}`, sourceUrn: urn, targetUrn: u, edgeType: 'CONTAINS' })),
      lineageEdges: [],
      totalChildren: KIDS,
      hasMore: false,
      nextOffset: offset + KIDS,
    }
  }
}

function seed(n: number) {
  const nodes = Array.from({ length: n }, (_, i) => ({
    id: parent(i), position: { x: 0, y: 0 }, data: { label: `s${i}`, urn: parent(i), type: 'schema', childCount: KIDS },
  }) as LineageNode)
  useCanvasStore.setState({
    nodes, edges: [], _nodeIndex: new Set(nodes.map((x) => x.id)), _edgeIndex: new Set(), childPaging: {}, visibleEdges: [],
  })
}

const held = (p: string) => useCanvasStore.getState().nodes.filter((n) => n.id.startsWith(`${p}/`)).length

/** Count store updates that changed the nodes — each is a canvas render. */
function countNodeUpdates() {
  let n = 0
  const unsubscribe = useCanvasStore.subscribe((s, prev) => { if (s.nodes !== prev.nodes) n += 1 })
  return { count: () => n, unsubscribe }
}

describe('child pages land together', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockProvider.getEdges.mockImplementation(async () => [])
  })

  it('30 pages landing close together commit in a few store updates, not 30', async () => {
    seed(30)
    mockProvider.getChildrenWithEdges.mockImplementation(serve(5) as never)
    const { result } = renderHook(() => useGraphHydration())
    const updates = countNodeUpdates()
    await act(async () => {
      await Promise.all(Array.from({ length: 30 }, (_, i) => result.current.loadChildren(parent(i))))
    })
    updates.unsubscribe()
    for (let i = 0; i < 30; i++) expect(held(parent(i))).toBe(KIDS)
    expect(mockProvider.getChildrenWithEdges).toHaveBeenCalledTimes(30)
    expect(updates.count()).toBeLessThanOrEqual(3)
    expect(result.current.loadingNodes.size).toBe(0)
    // Every pager has its position, as if each page had landed alone.
    for (let i = 0; i < 30; i++) {
      expect(useCanvasStore.getState().childPaging[parent(i)]).toMatchObject({ offset: KIDS, hasMore: false })
    }
  })

  it('a load settles only once its rows are in the store', async () => {
    // What every caller relies on: a reveal walking ancestors, "Load N more",
    // a level's run deciding it has landed.
    seed(12)
    mockProvider.getChildrenWithEdges.mockImplementation(serve(5) as never)
    const { result } = renderHook(() => useGraphHydration())
    const early: string[] = []
    await act(async () => {
      await Promise.all(Array.from({ length: 12 }, (_, i) => result.current.loadChildren(parent(i)).then(() => {
        if (held(parent(i)) < KIDS) early.push(parent(i))
      })))
    })
    expect(early).toEqual([])
  })

  it('a lone load lands at once, waiting for no window', async () => {
    seed(1)
    mockProvider.getChildrenWithEdges.mockImplementation(serve(0) as never)
    const { result } = renderHook(() => useGraphHydration())
    vi.useFakeTimers()
    try {
      // Resolves without the clock moving: nothing else was on its way.
      await act(async () => { await result.current.loadChildren(parent(0)) })
      expect(held(parent(0))).toBe(KIDS)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a page cancelled after it landed, before it committed, does not commit', async () => {
    seed(2)
    let releaseSecond: () => void = () => {}
    const second = new Promise<void>((r) => { releaseSecond = r })
    mockProvider.getChildrenWithEdges.mockImplementation(async (urn: string, opts?: Opts) => {
      if (urn === parent(1)) await second
      return serve(0)(urn, opts)
    })
    const { result } = renderHook(() => useGraphHydration())
    let both!: Promise<unknown>
    act(() => { both = Promise.all([result.current.loadChildren(parent(0)), result.current.loadChildren(parent(1))]) })
    // The first page is back and waits to land beside the second.
    await act(async () => { await wait(0) })
    expect(held(parent(0))).toBe(0)
    act(() => { result.current.cancelChildLoad(parent(0)) })
    releaseSecond()
    await act(async () => { await both })
    expect(held(parent(0))).toBe(0)
    expect(held(parent(1))).toBe(KIDS)
    expect(result.current.loadingNodes.size).toBe(0)
  })

  it("reads the rows' lineage once the loads settle, a few reads at a time", async () => {
    seed(20)
    mockProvider.getChildrenWithEdges.mockImplementation(serve(5) as never)
    let pagesOut = 0
    let edgesBeforeSettled = 0
    let reading = 0
    let mostReading = 0
    mockProvider.getChildrenWithEdges.mockImplementation(async (urn: string, opts?: Opts) => {
      pagesOut += 1
      try { return await serve(5)(urn, opts) } finally { pagesOut -= 1 }
    })
    mockProvider.getEdges.mockImplementation(async () => {
      if (pagesOut > 0) edgesBeforeSettled += 1
      reading += 1
      mostReading = Math.max(mostReading, reading)
      await wait(2)
      reading -= 1
      return []
    })
    const { result } = renderHook(() => useGraphHydration())
    await act(async () => {
      await Promise.all(Array.from({ length: 20 }, (_, i) => result.current.loadChildren(parent(i))))
    })
    await act(async () => { await wait(50) })
    expect(edgesBeforeSettled).toBe(0)
    // 200 rows: read 25 at a time, both directions — every row asked about once.
    expect(mockProvider.getEdges).toHaveBeenCalledTimes(16)
    // Two reads at once, each asking both directions.
    expect(mostReading).toBeLessThanOrEqual(4)
  })
})
