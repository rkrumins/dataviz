/**
 * `loadChildren` as a lossless, bounded pager over one parent's children.
 *
 * A container can hold thousands of children; the canvas reaches them a page at
 * a time as the user scrolls. That only works if every page call is:
 *
 *  - COMPLETE: repeated calls walk to the last child, each child exactly once,
 *    then stop asking (the server's `hasMore`, not a client count, says when).
 *  - PROVIDER-AGNOSTIC: each page carries the previous page's CURSOR (FalkorDB,
 *    lossless across duplicate names) AND the server-side OFFSET (the branch/
 *    as-of path pages by offset and ignores cursors).
 *  - O(page): cross-page sibling lineage comes back WITH each page
 *    (`lineageScope: 'siblings'`) instead of re-sending every loaded sibling to
 *    /edges/between — the old supplement was quadratic per parent.
 *  - HONEST: an edge whose far end is not loaded yet is held back (it returns
 *    with that sibling's own page), so the store never holds dangling edges.
 *  - STALL-PROOF: a page that brings nothing new (its rows arrived out of band)
 *    does not end the call — the pager walks on until something lands.
 *  - RESUMABLE: a failed page is retried from the SAME position.
 */
import { renderHook, act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Page = {
  children: Array<{ urn: string; displayName: string; entityType: string; childCount?: number }>
  containmentEdges: Array<{ id: string; sourceUrn: string; targetUrn: string; edgeType: string }>
  lineageEdges: Array<{ id: string; sourceUrn: string; targetUrn: string; edgeType: string }>
  totalChildren: number
  hasMore: boolean
  nextCursor: string | null
}

const { mockProvider } = vi.hoisted(() => ({
  mockProvider: {
    getNodes: vi.fn(async () => []),
    getEdgesBetween: vi.fn(async () => []),
    getChildren: vi.fn(async () => []),
    getChildrenWithEdges: vi.fn(async (): Promise<Page> => ({
      children: [], containmentEdges: [], lineageEdges: [], totalChildren: 0, hasMore: false, nextCursor: null,
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

/** The server: children in keyset order; a cursor is `after:<index>`. Serves by
 *  cursor when given (FalkorDB), else by offset (branch path). Lineage in siblings
 *  scope = edges between this page and ANY child, from `lineage`. */
function serve(lineage: Array<[number, number]> = []) {
  return async (_urn: string, opts: { cursor?: string | null; offset?: number; limit?: number; lineageScope?: string }) => {
    const start = opts.cursor ? Number(opts.cursor.split(':')[1]) + 1 : (opts.offset ?? 0)
    const idx = Array.from({ length: Math.min(PAGE, TOTAL - start) }, (_, k) => start + k)
    const onPage = new Set(idx)
    const edges = lineage
      .filter(([a, b]) => onPage.has(a) || onPage.has(b))
      .filter(([a, b]) => opts.lineageScope === 'siblings' || (onPage.has(a) && onPage.has(b)))
      .map(([a, b]) => ({ id: `l${a}-${b}`, sourceUrn: kid(a), targetUrn: kid(b), edgeType: 'FLOWS_TO' }))
    const last = idx[idx.length - 1]
    const hasMore = last !== undefined && last < TOTAL - 1
    return {
      children: idx.map(i => ({ urn: kid(i), displayName: `c${i}`, entityType: 'column' })),
      containmentEdges: idx.map(i => ({ id: `c-${i}`, sourceUrn: PARENT, targetUrn: kid(i), edgeType: 'CONTAINS' })),
      lineageEdges: edges,
      totalChildren: TOTAL,
      hasMore,
      nextCursor: hasMore ? `after:${last}` : null,
    }
  }
}

function seedParentOnly() {
  const parent = {
    id: PARENT, position: { x: 0, y: 0 },
    data: { label: 'P', urn: PARENT, type: 'table', childCount: TOTAL },
  } as LineageNode
  useCanvasStore.setState({
    nodes: [parent], edges: [],
    _nodeIndex: new Set([PARENT]), _edgeIndex: new Set(), childPaging: {},
    visibleEdges: [],
  })
}

const loadedKids = () => useCanvasStore.getState().nodes.filter(n => n.id !== PARENT).map(n => n.id)

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

  it('sends the previous cursor AND the server-side offset on every page', async () => {
    mockProvider.getChildrenWithEdges.mockImplementation(serve() as never)
    const { result } = renderHook(() => useGraphHydration())
    await act(async () => { await result.current.loadChildren(PARENT) })
    await act(async () => { await result.current.loadChildren(PARENT) })

    const second = (mockProvider.getChildrenWithEdges.mock.calls[1] as unknown as [string, { cursor?: string; offset?: number }])[1]
    expect(second.cursor).toBe('after:99')
    expect(second.offset).toBe(100)
  })

  it('asks for sibling-scoped lineage and never re-sends loaded siblings', async () => {
    mockProvider.getChildrenWithEdges.mockImplementation(serve() as never)
    const { result } = renderHook(() => useGraphHydration())
    for (let i = 0; i < 3; i++) {
      await act(async () => { await result.current.loadChildren(PARENT) })
    }
    for (const call of mockProvider.getChildrenWithEdges.mock.calls as unknown as Array<[string, { lineageScope?: string }]>) {
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

  it('walks past a page whose rows already arrived out of band', async () => {
    // Page 1's rows are already held but DON'T count toward the offset (search
    // reveals — see useGraphHydration.viaReveal.test). The first page therefore
    // brings nothing new; stopping there would leave the "load more" row with an
    // unchanged count, and its latch would never re-arm: a silent stall.
    const held = Array.from({ length: PAGE }, (_, i) => ({
      id: kid(i), position: { x: 0, y: 0 },
      data: { label: `c${i}`, urn: kid(i), type: 'column', viaReveal: true },
    }) as LineageNode)
    const state = useCanvasStore.getState()
    useCanvasStore.setState({
      nodes: [...state.nodes, ...held],
      edges: held.map(n => ({ id: `c-${n.id}`, source: PARENT, target: n.id, data: { edgeType: 'CONTAINS' } }) as never),
      _nodeIndex: new Set([PARENT, ...held.map(n => n.id)]),
      _edgeIndex: new Set(held.map(n => `c-${n.id}`)),
    })
    mockProvider.getChildrenWithEdges.mockImplementation(serve() as never)
    const { result } = renderHook(() => useGraphHydration())

    await act(async () => { await result.current.loadChildren(PARENT) })     // ONE call
    expect(loadedKids()).toHaveLength(2 * PAGE)                              // walked on to page 2
    expect(mockProvider.getChildrenWithEdges).toHaveBeenCalledTimes(2)
  })

  it('resumes a failed page from the same position', async () => {
    const ok = serve()
    let fail = true
    mockProvider.getChildrenWithEdges.mockImplementation((async (urn: string, opts: never) => {
      const o = opts as { cursor?: string }
      if (o.cursor === 'after:99' && fail) { fail = false; throw new Error('503') }
      return ok(urn, opts)
    }) as never)
    const { result } = renderHook(() => useGraphHydration())

    await act(async () => { await result.current.loadChildren(PARENT) })     // page 1
    await act(async () => { await result.current.loadChildren(PARENT) })     // page 2 fails
    expect(result.current.failedNodes.has(PARENT)).toBe(true)
    await act(async () => { await result.current.loadChildren(PARENT) })     // retry
    const retry = (mockProvider.getChildrenWithEdges.mock.calls.at(-1) as unknown as [string, { cursor?: string; offset?: number }])[1]
    expect(retry.cursor).toBe('after:99')
    expect(retry.offset).toBe(100)
    expect(result.current.failedNodes.has(PARENT)).toBe(false)
    expect(loadedKids()).toHaveLength(200)
  })

  it('does not let an "exhausted" verdict outlive children that appear later', async () => {
    // First look: the server has nothing yet — the pager rightly says exhausted.
    mockProvider.getChildrenWithEdges.mockResolvedValueOnce({
      children: [], containmentEdges: [], lineageEdges: [], totalChildren: 0, hasMore: false, nextCursor: null,
    })
    const { result } = renderHook(() => useGraphHydration())
    await act(async () => { await result.current.loadChildren(PARENT) })
    expect(result.current.exhaustedParents.has(PARENT)).toBe(true)

    // Children arrive at the source; the parent's count is refreshed.
    useCanvasStore.getState().updateNode(PARENT, { childCount: TOTAL + 1 })
    mockProvider.getChildrenWithEdges.mockImplementation(serve() as never)
    await act(async () => { await result.current.loadChildren(PARENT) })
    expect(loadedKids().length).toBeGreaterThan(0)
  })

  it('counts landed pages per parent, for callers that latch on progress', async () => {
    mockProvider.getChildrenWithEdges.mockImplementation(serve() as never)
    const { result } = renderHook(() => useGraphHydration())
    expect(result.current.childPageEpochs.get(PARENT) ?? 0).toBe(0)
    await act(async () => { await result.current.loadChildren(PARENT) })
    await act(async () => { await result.current.loadChildren(PARENT) })
    expect(result.current.childPageEpochs.get(PARENT)).toBe(2)
    expect(result.current.exhaustedParents.has(PARENT)).toBe(false)
    await act(async () => { await result.current.loadChildren(PARENT) })
    expect(result.current.exhaustedParents.has(PARENT)).toBe(true)
  })
})
