/**
 * useEdgeProjection — edges must follow a drill-down.
 *
 * Reported symptom: with the source side collapsed and `Tableau` expanded to
 * show four dashboards, ONE edge kept pointing at Tableau instead of four
 * pointing at the dashboards. "Nothing is redrawn as drill down happens."
 *
 * These pin the BEHAVIOUR the user requires: an edge follows the drill-down.
 * They do NOT yet reproduce the reported failure — all four pass against the
 * code that fails in the browser, because this harness hands the hook a fresh
 * `nodesByLayer` each render and so always takes the full-rebuild path, while
 * the real canvas memoizes it. Reproducing it needs a stable `nodesByLayer`
 * identity across a lazy child load; until that exists, treat these as a
 * contract, not as the regression guard.
 *
 */
import { renderHook } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { useEdgeProjection } from '../useEdgeProjection'
import type { HierarchyNode } from '@/types/hierarchy'

const hNode = (id: string, children: HierarchyNode[] = []): HierarchyNode => ({
  id,
  typeId: 'entity',
  name: id,
  data: { urn: id, type: 'entity', label: id },
  children,
  depth: 0,
  urn: id,
  entityTypeOption: 'entity',
  tags: [],
})

const edge = (id: string, source: string, target: string) => ({
  id, source, target, data: { edgeType: 'FLOWS_TO' },
})

const DASHBOARDS = ['cfo', 'customer360', 'exec', 'sales']

/** Inputs the canvas derives from the hierarchy, exactly as the canvas does. */
function inputsFor(roots: HierarchyNode[], expanded: Set<string>) {
  const flat: HierarchyNode[] = []
  const stack = [...roots]
  while (stack.length > 0) {
    const n = stack.pop()!
    flat.push(n)
    stack.push(...n.children)
  }
  return {
    // A NEW Map each time, as the canvas's own memo produces.
    nodesByLayer: new Map([['L1', roots]]),
    displayFlat: flat,
    displayMap: new Map(flat.map(n => [n.id, n])),
    urnToIdMap: new Map(flat.map(n => [n.urn!, n.id])),
    expandedNodes: expanded,
  }
}

function project(roots: HierarchyNode[], expanded: Set<string>, edges: ReturnType<typeof edge>[]) {
  return renderHook(
    (p: { roots: HierarchyNode[]; expanded: Set<string> }) => {
      const inp = inputsFor(p.roots, p.expanded)
      return useEdgeProjection({
        edges,
        aggregatedEdges: new Map(),
        nodesByLayer: inp.nodesByLayer,
        expandedNodes: inp.expandedNodes,
        displayFlat: inp.displayFlat,
        displayMap: inp.displayMap,
        urnToIdMap: inp.urnToIdMap,
        showLineageFlow: true,
        isTracing: false,
        traceContextSet: new Set(),
        isContainmentEdge: () => false,
        hoveredNodeId: null,
      })
    },
    { initialProps: { roots, expanded } },
  )
}

/** Where each painted edge lands. */
const targetsOf = (res: { visibleLineageEdges: Array<{ target: string }> }) =>
  res.visibleLineageEdges.map(e => e.target).sort()

describe('useEdgeProjection — a drill-down re-routes its edges', () => {
  it('pins edges to the container while it is collapsed', () => {
    const roots = [hNode('snowflake'), hNode('tableau', DASHBOARDS.map(d => hNode(d)))]
    const edges = DASHBOARDS.map((d, n) => edge(`e${n}`, 'snowflake', d))
    const { result } = project(roots, new Set(), edges)

    // Collapsed: four flows, one line, landing on the container.
    expect(targetsOf(result.current)).toEqual(['tableau'])
  })

  it('re-routes to each child when the container is expanded', () => {
    const roots = [hNode('snowflake'), hNode('tableau', DASHBOARDS.map(d => hNode(d)))]
    const edges = DASHBOARDS.map((d, n) => edge(`e${n}`, 'snowflake', d))
    const { result } = project(roots, new Set(['tableau']), edges)

    expect(targetsOf(result.current)).toEqual([...DASHBOARDS].sort())
  })

  it('re-routes when the children arrive AFTER the expand — the real drill-down order', () => {
    // 1. Tableau is collapsed and its children are not loaded yet.
    const empty = [hNode('snowflake'), hNode('tableau', [])]
    const edges = DASHBOARDS.map((d, n) => edge(`e${n}`, 'snowflake', d))
    const { result, rerender } = project(empty, new Set(), edges)

    // 2. The user expands it. The children have not arrived, so there is
    //    nothing to route to yet and the edge stays on the container.
    rerender({ roots: empty, expanded: new Set(['tableau']) })

    // 3. The children land. `displayFlat`/`nodeIndex` change; `nodesByLayer`
    //    does not change CONTENTS, and `expandedNodes` is untouched — which is
    //    exactly the combination the stale cache used to survive.
    const loaded = [hNode('snowflake'), hNode('tableau', DASHBOARDS.map(d => hNode(d)))]
    rerender({ roots: loaded, expanded: new Set(['tableau']) })

    expect(targetsOf(result.current)).toEqual([...DASHBOARDS].sort())
  })

  it('collapsing again puts the edges back on the container', () => {
    const roots = [hNode('snowflake'), hNode('tableau', DASHBOARDS.map(d => hNode(d)))]
    const edges = DASHBOARDS.map((d, n) => edge(`e${n}`, 'snowflake', d))
    const { result, rerender } = project(roots, new Set(['tableau']), edges)
    expect(targetsOf(result.current)).toEqual([...DASHBOARDS].sort())

    rerender({ roots, expanded: new Set() })
    expect(targetsOf(result.current)).toEqual(['tableau'])

    // And expanding a SECOND time still works — a cache that only patches once
    // would pass every single-shot test above and still fail the user.
    rerender({ roots, expanded: new Set(['tableau']) })
    expect(targetsOf(result.current)).toEqual([...DASHBOARDS].sort())
  })
})
