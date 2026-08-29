/**
 * The reveal versus the canvas's first-page auto-loader.
 *
 * `ContextViewCanvas` auto-loads page 1 for any expanded node that has a
 * `childCount` but no loaded children — the per-view expanded-state restore
 * needs it, or a restored container renders empty. Its only guard is
 *
 *     if ((childMap.get(nodeId)?.length ?? 0) > 0) continue
 *
 * and the path-only reveal's whole promise rests on that guard holding for
 * a level whose one child arrived out of band, `viaReveal`.
 *
 * Live evidence says it does NOT hold: revealing a hit three levels deep
 * issued `children-with-edges` ×3, one per spine ancestor. This file
 * reproduces the effect against the REAL reveal, the REAL store and the
 * REAL `useContainmentHierarchy`, with the stagger actually running — the
 * timing between levels is the thing under suspicion, and a test that
 * skips the wait cannot see it.
 */
import { render, waitFor, act } from '@testing-library/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/queryClient', () => ({ getQueryClient: () => ({}) }))
vi.mock('@/hooks/useViewSchema', () => ({
  useViewContainmentEdgeTypes: () => ['CONTAINS'],
  useViewLineageEdgeTypes: () => ['FLOWS_TO'],
  useViewRootEntityTypes: () => ['database'],
  useViewEntityTypes: () => [],
  useViewSchemaIsReady: () => true,
}))

import { useRevealSearchHit } from '../useRevealSearchHit'
import { useContainmentHierarchy } from '../useContainmentHierarchy'
import { useCanvasStore, useCanvasVersion, type LineageNode } from '@/store/canvas'
import { usePreferencesStore } from '@/store/preferences'
import type { GraphDataProvider, GraphNode } from '@/providers/GraphDataProvider'
import type { AncestorRef } from '@/types/search'

const L1 = 'urn:snowflake'
const L2 = 'urn:silver'
const L3 = 'urn:clean_ecomm_customers'
const HIT = 'urn:customer_id'

const SPINE: AncestorRef[] = [
  { urn: L1, displayName: 'Snowflake', entityType: 'database' },
  { urn: L2, displayName: 'SILVER', entityType: 'schema' },
  { urn: L3, displayName: 'clean_ecomm_customers', entityType: 'table' },
]

function storeNode(id: string, childCount: number): LineageNode {
  return {
    id,
    position: { x: 0, y: 0 },
    data: { label: id, urn: id, type: 'generic', childCount },
  } as LineageNode
}

function graphNode(urn: string, childCount: number): GraphNode {
  return { urn, entityType: 'generic', displayName: urn, properties: {}, childCount } as GraphNode
}

/** The spine's own containment edges — what `/edges/between` answers. */
const SPINE_EDGES = [
  { id: `c:${L1}>${L2}`, sourceUrn: L1, targetUrn: L2, edgeType: 'CONTAINS' },
  { id: `c:${L2}>${L3}`, sourceUrn: L2, targetUrn: L3, edgeType: 'CONTAINS' },
  { id: `c:${L3}>${HIT}`, sourceUrn: L3, targetUrn: HIT, edgeType: 'CONTAINS' },
]

function makeProvider(): GraphDataProvider {
  return {
    // Every ancestor is a big container — exactly the case the auto-loader
    // is armed for.
    getNodes: vi.fn(async () => [
      graphNode(L2, 400), graphNode(L3, 300), graphNode(HIT, 0),
    ]),
    getEdgesBetween: vi.fn(async () => SPINE_EDGES),
  } as unknown as GraphDataProvider
}

/** matchMedia the reveal can ask, so the 80 ms stagger actually runs. */
function stubMatchMedia(matches: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true, configurable: true,
    value: vi.fn(() => ({
      matches, media: '', addEventListener: () => {}, removeEventListener: () => {},
    })),
  })
}

/**
 * The canvas's auto-loader, wired to the same inputs it has in
 * `ContextViewCanvas` (~:2876-2897): the store's nodes and edges, the real
 * containment hierarchy over them, and canvas-local expansion state.
 */
function Canvas({ provider, onAutoLoad, revealRef }: {
  provider: GraphDataProvider
  onAutoLoad: (nodeId: string) => void
  revealRef: { current: ((urn: string, path: AncestorRef[]) => Promise<unknown>) | null }
}) {
  const nodes = useCanvasStore((s) => s.nodes)
  const edges = useCanvasStore((s) => s.edges)
  const canvasVersion = useCanvasVersion()
  const { childMap } = useContainmentHierarchy({
    nodes,
    edges,
    isContainmentEdge: (t) => t === 'CONTAINS',
    fingerprint: `v:${canvasVersion}`,
  })
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set())
  const displayMap = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])

  const autoLoadedFirstPageRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (expandedNodes.size === 0) return
    for (const nodeId of expandedNodes) {
      if (autoLoadedFirstPageRef.current.has(nodeId)) continue
      const node = displayMap.get(nodeId)
      if (!node) continue
      const childCount = (node.data?.childCount as number) ?? 0
      if (childCount === 0) continue
      // The guard the path-only reveal depends on.
      if ((childMap.get(nodeId)?.length ?? 0) > 0) continue
      autoLoadedFirstPageRef.current.add(nodeId)
      onAutoLoad(nodeId)
    }
  }, [expandedNodes, displayMap, childMap, onAutoLoad])

  revealRef.current = useRevealSearchHit({ setExpandedNodes, provider })
  return null
}

beforeEach(() => {
  usePreferencesStore.setState({ reducedMotion: false })
  useCanvasStore.setState({
    nodes: [storeNode(L1, 500)],
    edges: [],
    _nodeIndex: new Set([L1]),
    _edgeIndex: new Set(),
    visibleEdges: [],
    selectNode: vi.fn(),
  })
})

afterEach(() => {
  delete (window as { matchMedia?: unknown }).matchMedia
})


describe('a revealed level does not pull its first page', () => {
  it('pages no ancestor of the spine, with the stagger running', async () => {
    stubMatchMedia(false)   // motion is ON: the levels open 80 ms apart
    const provider = makeProvider()
    const onAutoLoad = vi.fn()
    const revealRef: { current: ((urn: string, path: AncestorRef[]) => Promise<unknown>) | null } = { current: null }

    render(<Canvas provider={provider} onAutoLoad={onAutoLoad} revealRef={revealRef} />)

    await act(async () => { await revealRef.current!(HIT, SPINE) })
    // The effect chases the last expansion by a commit; give it one.
    await waitFor(() => expect(useCanvasStore.getState().nodes).toHaveLength(4))
    await act(async () => { await new Promise((r) => setTimeout(r, 50)) })

    expect(onAutoLoad.mock.calls.map((c) => c[0])).toEqual([])
  })

  it('pages no ancestor under reduced motion either', async () => {
    stubMatchMedia(true)
    const provider = makeProvider()
    const onAutoLoad = vi.fn()
    const revealRef: { current: ((urn: string, path: AncestorRef[]) => Promise<unknown>) | null } = { current: null }

    render(<Canvas provider={provider} onAutoLoad={onAutoLoad} revealRef={revealRef} />)

    await act(async () => { await revealRef.current!(HIT, SPINE) })
    await act(async () => { await new Promise((r) => setTimeout(r, 50)) })

    expect(onAutoLoad.mock.calls.map((c) => c[0])).toEqual([])
  })

  // THE LIVE MECHANISM, characterised. Nothing above is wrong; the
  // precondition is. Take the spine's containment edges away — a failed,
  // shed, empty or never-issued `/edges/between` — and the levels have no
  // child to hold, so the auto-loader pages every one of them: the exact
  // shape of the live capture (`children-with-edges` x3, one per ancestor,
  // three "Child entities loaded" toasts).
  //
  // This is the CORRECT fallback, not a bug in the guard: a level with no
  // child and no page would render empty, which is what the auto-loader
  // exists to prevent. The defect is upstream — the edges are not
  // arriving — and no change to this effect can fix it.
  it('pages every level when the spine edges never arrive (the live shape)', async () => {
    stubMatchMedia(false)
    const provider = {
      getNodes: vi.fn(async () => [
        graphNode(L2, 400), graphNode(L3, 300), graphNode(HIT, 0),
      ]),
      getEdgesBetween: vi.fn(async () => []),
    } as unknown as GraphDataProvider
    const onAutoLoad = vi.fn()
    const revealRef: { current: ((urn: string, path: AncestorRef[]) => Promise<unknown>) | null } = { current: null }

    render(<Canvas provider={provider} onAutoLoad={onAutoLoad} revealRef={revealRef} />)

    await act(async () => { await revealRef.current!(HIT, SPINE) })
    await act(async () => { await new Promise((r) => setTimeout(r, 50)) })

    expect(onAutoLoad.mock.calls.map((c) => c[0])).toEqual([L1, L2, L3])
  })
})
