/**
 * useRevealSearchHit — revealing a deep hit opens the PATH, not the estate.
 *
 * A hit five levels down used to cost five pages of siblings: the walk
 * awaited `loadChildren` for every ancestor, so landing on one column meant
 * fetching four others the user never asked to see. The path is all the
 * reveal owes them — each level opens with its spine child under it and the
 * column's own "N more · load" row stays the way to pull the siblings.
 *
 * Pinned here:
 *  - a 3-deep spine fetches NO child page, opens the levels top-down in
 *    order, selects the hit, and reports that it landed on the hit;
 *  - a spine that breaks reports the deepest level it actually OPENED —
 *    a node that is in the store but under a level that never opened is
 *    drawn nowhere, so neither the selection nor the outcome may claim it;
 *  - the levels are staggered ~80 ms apart, and reduced motion drops the
 *    wait entirely (no timer at all, not a zero-length one);
 *  - the prefetch primes what the reveal primes — nodes marked `viaReveal`
 *    AND the containment edges — so a warmed spine and a revealed one are
 *    the same spine;
 *  - a spine ancestor is never childless to the canvas's first-page
 *    auto-load (ContextViewCanvas.tsx ~:2892), which is what keeps the
 *    revealed level from pulling page 1 the moment it opens.
 */
import { renderHook, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

// `toCanvasNode` is re-exported from useGraphHydration, whose import chain
// reaches `@/main` (a real entrypoint with a module-load `createRoot`).
// Same dead-end stub as the sibling useRevealSearchHit test.
vi.mock('@/lib/queryClient', () => ({
  getQueryClient: () => ({}),
}))
vi.mock('@/hooks/useViewSchema', () => ({
  useViewContainmentEdgeTypes: () => ['CONTAINS'],
  useViewLineageEdgeTypes: () => ['FLOWS_TO'],
  useViewRootEntityTypes: () => ['database'],
  useViewEntityTypes: () => [],
  useViewSchemaIsReady: () => true,
}))

import { useRevealSearchHit, usePrefetchSearchHitSpine } from '../useRevealSearchHit'
import { useContainmentHierarchy } from '../useContainmentHierarchy'
import { useCanvasStore, type LineageNode } from '@/store/canvas'
import { usePreferencesStore } from '@/store/preferences'
import type { GraphDataProvider, GraphNode } from '@/providers/GraphDataProvider'
import type { AncestorRef } from '@/types/search'

// ---------------------------------------------------------------------------
// Fixtures — a hit three levels below the only node the canvas has hydrated.
// ---------------------------------------------------------------------------

const L1 = 'urn:demo:database:D'
const L2 = 'urn:demo:schema:S'
const L3 = 'urn:demo:table:T'
const HIT = 'urn:demo:column:C'

const SPINE: AncestorRef[] = [
  { urn: L1, displayName: 'warehouse', entityType: 'database' },
  { urn: L2, displayName: 'public', entityType: 'schema' },
  { urn: L3, displayName: 'orders', entityType: 'table' },
]

function makeLineageNode(id: string): LineageNode {
  return {
    id,
    position: { x: 0, y: 0 },
    data: { label: id, urn: id, type: 'generic' },
  } as LineageNode
}

function makeGraphNode(urn: string, displayName: string): GraphNode {
  return { urn, entityType: 'generic', displayName, properties: {} } as GraphNode
}

const SPINE_EDGES = [
  { id: `c:${L1}>${L2}`, sourceUrn: L1, targetUrn: L2, edgeType: 'CONTAINS' },
  { id: `c:${L2}>${L3}`, sourceUrn: L2, targetUrn: L3, edgeType: 'CONTAINS' },
  { id: `c:${L3}>${HIT}`, sourceUrn: L3, targetUrn: HIT, edgeType: 'CONTAINS' },
]

/** A provider that answers the whole spine below the hydrated root. */
function makeProvider(over: Partial<GraphDataProvider> = {}): GraphDataProvider {
  return {
    getNodes: vi.fn(async () => [
      makeGraphNode(L2, 'public'),
      makeGraphNode(L3, 'orders'),
      makeGraphNode(HIT, 'customer_id'),
    ]),
    getEdgesBetween: vi.fn(async () => SPINE_EDGES),
    // The two ways a child PAGE is fetched. The walk must touch neither.
    getChildren: vi.fn(async () => []),
    getChildrenWithEdges: vi.fn(async () => ({
      children: [], containmentEdges: [], lineageEdges: [],
      totalChildren: 0, hasMore: false, nextCursor: null,
    })),
    ...over,
  } as unknown as GraphDataProvider
}

/** Records what the canvas's expansion set was asked to become, in order. */
function expansionRecorder() {
  let current = new Set<string>()
  const order: string[] = []
  const setExpandedNodes = vi.fn((update: unknown) => {
    const next = typeof update === 'function'
      ? (update as (prev: Set<string>) => Set<string>)(current)
      : (update as Set<string>)
    next.forEach((id) => { if (!current.has(id)) order.push(id) })
    current = next
  })
  return { setExpandedNodes, order, has: (id: string) => current.has(id) }
}

/** A media query the browser can answer — jsdom ships none, and "no
 *  matchMedia" is itself read as "no motion to pace". */
function stubMatchMedia(matches: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn(() => ({
      matches,
      media: '(prefers-reduced-motion: reduce)',
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  })
}

let selectNode: Mock<(id: string, multi?: boolean) => void>

beforeEach(() => {
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(
    (cb: FrameRequestCallback) => {
      cb(0)
      return 0
    },
  )
  selectNode = vi.fn<(id: string, multi?: boolean) => void>()
  usePreferencesStore.setState({ reducedMotion: false })
  // Only the top level is hydrated — everything below it is lazy.
  useCanvasStore.setState({
    nodes: [makeLineageNode(L1)],
    edges: [],
    _nodeIndex: new Set([L1]),
    _edgeIndex: new Set(),
    visibleEdges: [],
    selectNode,
  })
})

afterEach(() => {
  vi.useRealTimers()
  delete (window as { matchMedia?: unknown }).matchMedia
})


// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

describe('useRevealSearchHit — the path, and nothing else', () => {
  it('opens every level top-down without fetching one page of siblings', async () => {
    const provider = makeProvider()
    const { setExpandedNodes, order } = expansionRecorder()

    const { result } = renderHook(() =>
      useRevealSearchHit({ setExpandedNodes, provider }),
    )

    let outcome
    await act(async () => {
      outcome = await result.current(HIT, SPINE)
    })

    // THE point of the change: five levels deep used to mean five child
    // pages, four of which are siblings nobody asked for. The walk no
    // longer takes a child loader at all — and it reaches for neither of
    // the provider's own ways to fetch a page.
    expect(provider.getChildrenWithEdges).not.toHaveBeenCalled()
    expect(provider.getChildren).not.toHaveBeenCalled()
    expect(order).toEqual([L1, L2, L3])
    expect(selectNode).toHaveBeenCalledWith(HIT)
    expect(outcome).toEqual({
      landedOn: 'hit', urn: HIT, displayName: 'customer_id',
    })
  })

  it('scrolls the hit into view once the path is open', async () => {
    const scrollIntoView = vi.fn()
    const { result } = renderHook(() =>
      useRevealSearchHit({
        setExpandedNodes: vi.fn(),
        provider: makeProvider(),
        scrollIntoView,
      }),
    )

    await act(async () => { await result.current(HIT, SPINE) })

    expect(scrollIntoView).toHaveBeenCalledWith(HIT)
  })

  it('reports the deepest level it opened when the spine breaks', async () => {
    // The middle of the spine never arrived, so nothing below it can be
    // drawn — and the box has to say so rather than claim the hit.
    const provider = makeProvider({
      getNodes: vi.fn(async () => [makeGraphNode(L2, 'public')]),
    } as Partial<GraphDataProvider>)
    const { setExpandedNodes, order } = expansionRecorder()

    const { result } = renderHook(() =>
      useRevealSearchHit({
        setExpandedNodes,
        provider,
      }),
    )

    let outcome
    await act(async () => {
      outcome = await result.current(HIT, SPINE)
    })

    expect(order).toEqual([L1, L2])
    expect(selectNode).toHaveBeenCalledWith(L2)
    expect(outcome).toEqual({
      landedOn: 'ancestor', urn: L2, displayName: 'public',
    })
  })

  it('does not claim a hit that is in the store but under a level that never opened', async () => {
    // A partial answer: the hit itself came back, the level above it did
    // not. Selecting the hit would highlight a row that is drawn nowhere.
    const provider = makeProvider({
      getNodes: vi.fn(async () => [
        makeGraphNode(L2, 'public'),
        makeGraphNode(HIT, 'customer_id'),
      ]),
    } as Partial<GraphDataProvider>)

    const { result } = renderHook(() =>
      useRevealSearchHit({
        setExpandedNodes: vi.fn(),
        provider,
      }),
    )

    let outcome
    await act(async () => {
      outcome = await result.current(HIT, SPINE)
    })

    expect(outcome).toEqual({
      landedOn: 'ancestor', urn: L2, displayName: 'public',
    })
    expect(selectNode).toHaveBeenCalledWith(L2)
    expect(selectNode).not.toHaveBeenCalledWith(HIT)
  })

  it('says nothing opened when not one level of the spine is reachable', async () => {
    useCanvasStore.setState({ nodes: [], _nodeIndex: new Set(), selectNode })
    const provider = makeProvider({
      getNodes: vi.fn().mockRejectedValue(new Error('502')),
    } as Partial<GraphDataProvider>)

    const { result } = renderHook(() =>
      useRevealSearchHit({
        setExpandedNodes: vi.fn(),
        provider,
      }),
    )

    let outcome
    await act(async () => {
      outcome = await result.current(HIT, SPINE)
    })

    expect(selectNode).not.toHaveBeenCalled()
    expect(outcome).toEqual({ landedOn: 'ancestor', urn: '', displayName: '' })
  })
})


describe('useRevealSearchHit — telling the canvas what it opened', () => {
  it('accounts for every level whose spine child actually attached', async () => {
    // The canvas auto-pages an expanded container that holds nothing. Today
    // a revealed level escapes that only because its primed edge happens to
    // have populated the containment map — an inference, made in another
    // file, from data this walk never checks. The walk says it outright now.
    const markFirstPageHandled = vi.fn()
    const { result } = renderHook(() =>
      useRevealSearchHit({
        setExpandedNodes: vi.fn(),
        provider: makeProvider(),
        markFirstPageHandled,
      }),
    )

    await act(async () => { await result.current(HIT, SPINE) })

    expect(markFirstPageHandled.mock.calls.map((c) => c[0])).toEqual([L1, L2, L3])
  })

  it('accounts for no level when the spine never attached', async () => {
    // A prime that failed leaves the levels genuinely empty, and an empty
    // expanded container is exactly what the auto-load exists to fill. The
    // walk must not claim a level it did not furnish.
    const markFirstPageHandled = vi.fn()
    const provider = makeProvider({
      getEdgesBetween: vi.fn(async () => []),
    } as Partial<GraphDataProvider>)
    const { result } = renderHook(() =>
      useRevealSearchHit({
        setExpandedNodes: vi.fn(),
        provider,
        markFirstPageHandled,
      }),
    )

    await act(async () => { await result.current(HIT, SPINE) })

    expect(markFirstPageHandled).not.toHaveBeenCalled()
  })

  it('tells the store when the spine edges could not be fetched', async () => {
    // The canvas surfaces a degraded edge picture from this flag. A reveal
    // that lost its edges is exactly that, and it used to pass in silence.
    const noteEdgeFetchFailure = vi.fn()
    useCanvasStore.setState({ noteEdgeFetchFailure })
    const provider = makeProvider({
      getEdgesBetween: vi.fn().mockRejectedValue(new Error('502 shed')),
    } as Partial<GraphDataProvider>)
    const { result } = renderHook(() =>
      useRevealSearchHit({ setExpandedNodes: vi.fn(), provider }),
    )

    await act(async () => { await result.current(HIT, SPINE) })

    expect(noteEdgeFetchFailure).toHaveBeenCalledWith('502 shed')
  })
})


describe('useRevealSearchHit — the stagger', () => {
  it('opens one level every 80 ms rather than all of them at once', async () => {
    // `toFake` deliberately spares requestAnimationFrame: the frame the
    // walk settles on is mocked synchronous above, and faking it here
    // would hang the walk on a clock nobody advances.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    stubMatchMedia(false)
    const { setExpandedNodes, order } = expansionRecorder()

    const { result } = renderHook(() =>
      useRevealSearchHit({
        setExpandedNodes,
        provider: makeProvider(),
      }),
    )

    const walk = result.current(HIT, SPINE)

    await vi.advanceTimersByTimeAsync(0)
    expect(order).toEqual([L1])

    await vi.advanceTimersByTimeAsync(80)
    expect(order).toEqual([L1, L2])

    await vi.advanceTimersByTimeAsync(80)
    expect(order).toEqual([L1, L2, L3])

    await walk
  })

  it('opens the whole path at once for a reader who asked for calm', async () => {
    // Fake timers with nothing advancing them: if the walk still waited,
    // this would never resolve. A zero-length timer would not pass either.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    stubMatchMedia(false)
    usePreferencesStore.setState({ reducedMotion: true })
    const { setExpandedNodes, order } = expansionRecorder()

    const { result } = renderHook(() =>
      useRevealSearchHit({
        setExpandedNodes,
        provider: makeProvider(),
      }),
    )

    const outcome = await result.current(HIT, SPINE)

    expect(order).toEqual([L1, L2, L3])
    expect(outcome.landedOn).toBe('hit')
  })

  it('honours the system setting when the app has no opinion', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    stubMatchMedia(true)
    usePreferencesStore.setState({ reducedMotion: false })
    const { setExpandedNodes, order } = expansionRecorder()

    const { result } = renderHook(() =>
      useRevealSearchHit({
        setExpandedNodes,
        provider: makeProvider(),
      }),
    )

    await result.current(HIT, SPINE)

    expect(order).toEqual([L1, L2, L3])
  })
})


// ---------------------------------------------------------------------------
// The warm-up
// ---------------------------------------------------------------------------

describe('usePrefetchSearchHitSpine', () => {
  it('primes exactly what the reveal primes: viaReveal nodes and the edges', async () => {
    const provider = makeProvider()
    const { result } = renderHook(() => usePrefetchSearchHitSpine(provider))

    await act(async () => { await result.current(HIT, SPINE) })

    expect(provider.getNodes).toHaveBeenCalledWith({ urns: [L2, L3, HIT] })
    expect(provider.getEdgesBetween).toHaveBeenCalledWith([L1, L2, L3, HIT], ['CONTAINS'])

    const { nodes, edges } = useCanvasStore.getState()
    // Without the flag the warmed child counts as a loaded page and the
    // NEXT page's offset skips a real sibling (useGraphHydration ~:898).
    expect(nodes.find((n) => n.id === HIT)?.data.viaReveal).toBe(true)
    expect(edges.map((e) => `${e.source}>${e.target}`)).toContain(`${L3}>${HIT}`)
  })

  it('asks for nothing at all once the spine is on the canvas', async () => {
    // It fires on every 150 ms rest of the highlight, so a second call
    // for the same row must cost a round trip of nothing.
    const provider = makeProvider()
    const { result } = renderHook(() => usePrefetchSearchHitSpine(provider))

    await act(async () => { await result.current(HIT, SPINE) })
    await act(async () => { await result.current(HIT, SPINE) })

    expect(provider.getNodes).toHaveBeenCalledTimes(1)
    expect(provider.getEdgesBetween).toHaveBeenCalledTimes(1)
  })

  it('asks for no edges when the hit is top-level (a one-URN spine has none)', async () => {
    const provider = makeProvider()
    const { result } = renderHook(() => usePrefetchSearchHitSpine(provider))

    await act(async () => { await result.current(HIT, []) })

    expect(provider.getEdgesBetween).not.toHaveBeenCalled()
  })
})


// ---------------------------------------------------------------------------
// What the opened level must NOT trigger
// ---------------------------------------------------------------------------

describe('a revealed level is not an empty container', () => {
  it('leaves every spine ancestor with a child, so the first-page auto-load skips it', async () => {
    // ContextViewCanvas auto-loads page 1 for an expanded node that has
    // NO loaded children — the per-view expanded-state restore needs it.
    // Its guard is `(childMap.get(nodeId)?.length ?? 0) > 0`
    // (ContextViewCanvas.tsx ~:2892), and the reveal's own containment
    // edges are what satisfy it: each opened level already holds its
    // spine child, so it draws that child plus its "N more · load" row
    // instead of pulling a page of siblings nobody asked for.
    const provider = makeProvider()
    const { result } = renderHook(() =>
      useRevealSearchHit({
        setExpandedNodes: vi.fn(),
        provider,
      }),
    )
    await act(async () => { await result.current(HIT, SPINE) })

    const { nodes, edges } = useCanvasStore.getState()
    const { result: hierarchy } = renderHook(() =>
      useContainmentHierarchy({
        nodes,
        edges,
        isContainmentEdge: (t) => t === 'CONTAINS',
      }),
    )
    const { childMap } = hierarchy.current

    for (const ancestor of SPINE) {
      expect(childMap.get(ancestor.urn)?.length ?? 0).toBeGreaterThan(0)
    }
    // …and the child it holds is the spine's own, not a page of siblings.
    expect(childMap.get(L3)).toEqual([HIT])
  })
})
