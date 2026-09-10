/**
 * useEdgeProjection — the drill-down must re-route edges on the INCREMENTAL
 * ancestorMap path, which is the one the real canvas takes.
 *
 * `useEdgeProjection.drilldown.test.ts` pins the same behaviour and admits in
 * its own header that it cannot fail: it builds a brand-new `nodesByLayer` Map
 * on every render, so `prevNodesByLayerRef.current !== nodesByLayer` is true
 * every time and the hook rebuilds the whole ancestorMap from scratch. The
 * incremental patch — the `expandedNodes` diff, `collapseSubtreeInMap`,
 * `expandNodeInMap`, and the cached `ancestorMapRef` they mutate — is never
 * executed there at all. This file holds `nodesByLayer` IDENTITY STABLE across
 * renders, which is the only way into that branch.
 *
 * Two realism corrections carry the guard, both taken from the canvas:
 *
 *   1. STABLE IDENTITY. `useLayerAssignment` memoizes `nodesByLayer`; an
 *      expand/collapse changes only `expandedNodes`, so the hook keeps its
 *      cached map and patches it. That is the branch that can go stale.
 *   2. urn ≠ id. Real graph edges name URNs; `displayMap` is keyed by node id.
 *      The sibling file sets `urn: id`, which makes the
 *      `displayMap.has(edge.source)` fallback resolve every endpoint on its
 *      own — a completely dead ancestorMap would still paint the right
 *      picture there. With distinct urns the ancestorMap is the ONLY thing
 *      that can route an edge, so a stale one shows up as the reported
 *      symptom: one line still on the container.
 *
 * On "children that arrive AFTER the expand": in the canvas that CANNOT reach
 * the incremental path, and the sibling file's plan to hold `nodesByLayer`
 * stable across a lazy child load does not describe the app. `displayFlat` and
 * `displayMap` are derived FROM `nodesByLayer` inside `useLayerAssignment`, so
 * children can never appear in one without a new identity for the other; a
 * lazy load always re-enters the FULL rebuild. That ordering is pinned here as
 * what it really is — a full rebuild that must honour the expand that already
 * happened — rather than as an incremental-path case it is not.
 */
import { renderHook } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { useEdgeProjection } from '../useEdgeProjection'
import type { HierarchyNode } from '@/types/hierarchy'

const DASHBOARDS = ['cfo', 'customer360', 'exec', 'sales']

/** id and urn are DIFFERENT, as they are on the canvas. */
const hNode = (id: string, children: HierarchyNode[] = []): HierarchyNode => ({
  id,
  typeId: 'entity',
  name: id,
  data: { urn: `urn:${id}`, type: 'entity', label: id },
  children,
  depth: 0,
  urn: `urn:${id}`,
  entityTypeOption: 'entity',
  tags: [],
})

/** A raw lineage edge, naming its endpoints by URN — as the graph does. */
const edge = (id: string, source: string, target: string) => ({
  id, source: `urn:${source}`, target: `urn:${target}`, data: { edgeType: 'FLOWS_TO' },
})

const flatten = (roots: HierarchyNode[]): HierarchyNode[] => {
  const out: HierarchyNode[] = []
  const stack = [...roots]
  while (stack.length > 0) {
    const n = stack.pop()!
    out.push(n)
    stack.push(...n.children)
  }
  return out
}

interface Props { byLayer: Map<string, HierarchyNode[]>; expanded: Set<string> }

/**
 * Drives the hook the way the canvas does: `displayFlat` / `displayMap` /
 * `urnToIdMap` are all derived from whatever `nodesByLayer` is handed in, and
 * `nodesByLayer` is passed through by identity so a caller can hold it stable.
 */
function project(initial: Props, edges: ReturnType<typeof edge>[]) {
  return renderHook(
    (p: Props) => {
      const flat = flatten([...p.byLayer.values()].flat())
      return useEdgeProjection({
        edges,
        aggregatedEdges: new Map(),
        nodesByLayer: p.byLayer,
        expandedNodes: p.expanded,
        displayFlat: flat,
        displayMap: new Map(flat.map(n => [n.id, n])),
        urnToIdMap: new Map(flat.map(n => [n.urn!, n.id])),
        showLineageFlow: true,
        isTracing: false,
        traceContextSet: new Set(),
        isContainmentEdge: () => false,
        hoveredNodeId: null,
      })
    },
    { initialProps: initial },
  )
}

const targetsOf = (res: { visibleLineageEdges: Array<{ target: string }> }) =>
  res.visibleLineageEdges.map(e => e.target).sort()

const estate = () => [hNode('snowflake'), hNode('tableau', DASHBOARDS.map(d => hNode(d)))]
const flows = () => DASHBOARDS.map((d, n) => edge(`e${n}`, 'snowflake', d))

describe('useEdgeProjection — the incremental ancestorMap follows the drill-down', () => {
  it('re-routes to the children on an expand that does NOT change nodesByLayer', () => {
    // ONE Map, reused. Every later render takes the incremental branch.
    const byLayer = new Map([['L1', estate()]])
    const { result, rerender } = project({ byLayer, expanded: new Set() }, flows())

    expect(targetsOf(result.current)).toEqual(['tableau'])

    rerender({ byLayer, expanded: new Set(['tableau']) })
    expect(targetsOf(result.current)).toEqual([...DASHBOARDS].sort())
    expect(result.current.unresolvedEdgeCount).toBe(0)
  })

  it('puts them back on collapse, and re-routes again on every later expand', () => {
    const byLayer = new Map([['L1', estate()]])
    const { result, rerender } = project({ byLayer, expanded: new Set() }, flows())

    // Three round trips. A patch that only ever fires once passes a single
    // expand and then leaves the board frozen for the rest of the session.
    for (let i = 0; i < 3; i++) {
      rerender({ byLayer, expanded: new Set(['tableau']) })
      expect(targetsOf(result.current)).toEqual([...DASHBOARDS].sort())

      rerender({ byLayer, expanded: new Set() })
      expect(targetsOf(result.current)).toEqual(['tableau'])
    }
  })

  it('re-routes a second level down — expanding a child of the expanded container', () => {
    // tableau ⊃ cfo ⊃ {revenue, margin}; the flow names the grandchildren.
    const grandkids = ['revenue', 'margin']
    const roots = [
      hNode('snowflake'),
      hNode('tableau', [hNode('cfo', grandkids.map(g => hNode(g))), hNode('exec')]),
    ]
    const byLayer = new Map([['L1', roots]])
    const edges = grandkids.map((g, n) => edge(`g${n}`, 'snowflake', g))
    const { result, rerender } = project({ byLayer, expanded: new Set() }, edges)

    expect(targetsOf(result.current)).toEqual(['tableau'])

    rerender({ byLayer, expanded: new Set(['tableau']) })
    expect(targetsOf(result.current)).toEqual(['cfo'])

    rerender({ byLayer, expanded: new Set(['tableau', 'cfo']) })
    expect(targetsOf(result.current)).toEqual([...grandkids].sort())
  })

  it('a collapse of the OUTER container still gathers the grandchildren back', () => {
    const grandkids = ['revenue', 'margin']
    const roots = [
      hNode('snowflake'),
      hNode('tableau', [hNode('cfo', grandkids.map(g => hNode(g)))]),
    ]
    const byLayer = new Map([['L1', roots]])
    const edges = grandkids.map((g, n) => edge(`g${n}`, 'snowflake', g))
    const { result, rerender } = project(
      { byLayer, expanded: new Set(['tableau', 'cfo']) }, edges,
    )
    expect(targetsOf(result.current)).toEqual([...grandkids].sort())

    // Only the outer one closes; `cfo` is still in `expandedNodes` but is no
    // longer on screen, so its children must roll all the way up to tableau.
    rerender({ byLayer, expanded: new Set(['cfo']) })
    expect(targetsOf(result.current)).toEqual(['tableau'])
  })

  it('children that land AFTER the expand arrive with a new nodesByLayer, and are routed to', () => {
    // The canvas's real ordering. `useLayerAssignment` derives displayFlat and
    // displayMap FROM nodesByLayer, so a lazy child load cannot show up in one
    // without a new identity for the other: this is the FULL-rebuild path, and
    // what it must honour is the expand that already happened.
    const collapsedTree = new Map([['L1', [hNode('snowflake'), hNode('tableau', [])]]])
    const { result, rerender } = project({ byLayer: collapsedTree, expanded: new Set() }, flows())

    // Expanded while empty. The dashboards are not on the canvas under any
    // name yet, so their flows are unresolvable rather than rolled up — the
    // hook counts them as hidden and paints nothing.
    const expanded = new Set(['tableau'])
    rerender({ byLayer: collapsedTree, expanded })
    expect(targetsOf(result.current)).toEqual([])
    expect(result.current.unresolvedEdgeCount).toBe(DASHBOARDS.length)

    // The page lands.
    rerender({ byLayer: new Map([['L1', estate()]]), expanded })
    expect(targetsOf(result.current)).toEqual([...DASHBOARDS].sort())
    expect(result.current.unresolvedEdgeCount).toBe(0)
  })
})
