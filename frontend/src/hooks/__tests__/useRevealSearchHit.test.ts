/**
 * useRevealSearchHit — a hit that lives BEYOND its parent's first child page.
 *
 * `loadChildren` only ever fetches the first CHILDREN_PAGE_SIZE children of a
 * parent, so the 300th child never arrives through the spine walk: the hit is
 * primed as a node but has no containment edge to its parent, the row never
 * renders, and the hook falls back to selecting the deepest ancestor.
 *
 * Pinned here: after priming the missing spine the hook ALSO fetches the
 * spine's containment edges (`getEdgesBetween`) and commits them with the
 * nodes, marking the out-of-band nodes `viaReveal` so `useGraphHydration`
 * doesn't count them as a loaded page (see useGraphHydration.viaReveal.test).
 */
import { renderHook, act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

// `toCanvasNode` is re-exported from useGraphHydration, whose import chain
// reaches `@/main` (a real entrypoint with a module-load `createRoot`).
// Same dead-end stub as the sibling useRevealNode test.
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

import { useRevealSearchHit } from '../useRevealSearchHit'
import { useCanvasStore, type LineageNode } from '@/store/canvas'
import type { GraphDataProvider, GraphNode } from '@/providers/GraphDataProvider'
import type { AncestorRef } from '@/types/search'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROOT = 'urn:demo:database:R'
const PARENT = 'urn:demo:table:P'
const HIT = 'urn:demo:column:H'

const SPINE: AncestorRef[] = [
  { urn: ROOT, displayName: 'R', entityType: 'database' },
  { urn: PARENT, displayName: 'P', entityType: 'table' },
]

function makeLineageNode(id: string): LineageNode {
  return {
    id,
    position: { x: 0, y: 0 },
    data: { label: id, urn: id, type: 'generic' },
  } as LineageNode
}

function makeGraphNode(urn: string, entityType: string): GraphNode {
  return { urn, entityType, displayName: urn, properties: {} }
}

function makeProvider(): GraphDataProvider {
  return {
    getNodes: vi.fn(async () => [
      makeGraphNode(PARENT, 'table'),
      makeGraphNode(HIT, 'column'),
    ]),
    getEdgesBetween: vi.fn(async () => [
      { id: 'e:P>H', sourceUrn: PARENT, targetUrn: HIT, edgeType: 'CONTAINS' },
    ]),
  } as unknown as GraphDataProvider
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
  // Only the root is on the canvas — everything below it is lazy.
  useCanvasStore.setState({
    nodes: [makeLineageNode(ROOT)],
    edges: [],
    _nodeIndex: new Set([ROOT]),
    _edgeIndex: new Set(),
    visibleEdges: [],
    selectNode,
  })
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useRevealSearchHit — hit beyond the parent\'s first page', () => {
  it('primes the spine edges so the hit attaches, marks it viaReveal, selects it', async () => {
    const provider = makeProvider()
    // The real page-1 behaviour: the hit is the 300th child, so the page
    // this resolves carries siblings 1..100 — never the hit itself.
    const loadChildren = vi.fn().mockResolvedValue(undefined)
    const setExpandedNodes = vi.fn()

    const { result } = renderHook(() =>
      useRevealSearchHit({ setExpandedNodes, loadChildren, provider }),
    )

    await act(async () => {
      await result.current(HIT, SPINE)
    })

    expect(provider.getNodes).toHaveBeenCalledWith({ urns: [PARENT, HIT] })
    expect(provider.getEdgesBetween).toHaveBeenCalledWith(
      [ROOT, PARENT, HIT],
      ['CONTAINS'],
    )

    const { nodes, edges } = useCanvasStore.getState()
    expect(edges.map((e) => `${e.source}>${e.target}`)).toContain(`${PARENT}>${HIT}`)
    expect(nodes.find((n) => n.id === HIT)?.data.viaReveal).toBe(true)
    // Old behaviour selected the deepest reachable ancestor (PARENT).
    expect(selectNode).toHaveBeenCalledWith(HIT)
  })

  it('still primes the nodes when the edge fetch REJECTS', async () => {
    // A failed edge fetch costs the hit its attachment, not the whole
    // reveal: without the nodes the walk cannot even reach the parent.
    const provider = {
      getNodes: vi.fn(async () => [
        makeGraphNode(PARENT, 'table'),
        makeGraphNode(HIT, 'column'),
      ]),
      getEdgesBetween: vi.fn().mockRejectedValue(new Error('502')),
    } as unknown as GraphDataProvider
    const loadChildren = vi.fn().mockResolvedValue(undefined)

    const { result } = renderHook(() =>
      useRevealSearchHit({ setExpandedNodes: vi.fn(), loadChildren, provider }),
    )

    await act(async () => {
      await result.current(HIT, SPINE)
    })

    const { nodes, edges } = useCanvasStore.getState()
    expect(nodes.map((n) => n.id).sort()).toEqual([ROOT, PARENT, HIT].sort())
    expect(edges).toHaveLength(0)
    expect(selectNode).toHaveBeenCalledWith(HIT)
  })

  it('still reveals when the provider has no getEdgesBetween (harness stub)', async () => {
    const provider = {
      getNodes: vi.fn(async () => [makeGraphNode(PARENT, 'table')]),
    } as unknown as GraphDataProvider
    const loadChildren = vi.fn().mockResolvedValue(undefined)

    const { result } = renderHook(() =>
      useRevealSearchHit({ setExpandedNodes: vi.fn(), loadChildren, provider }),
    )

    await act(async () => {
      await result.current(HIT, SPINE)
    })

    // The node still commits, so the walk gets one level deeper than the
    // root: the fallback lands on the deepest REACHABLE ancestor.
    expect(useCanvasStore.getState()._nodeIndex.has(PARENT)).toBe(true)
    expect(selectNode).toHaveBeenCalledWith(PARENT)
  })
})
