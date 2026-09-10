/**
 * useEdgeProjection — edges must follow a drill-down.
 *
 * Reported symptom: with the source side collapsed and `Tableau` expanded to
 * show four dashboards, ONE edge kept pointing at Tableau instead of four
 * pointing at the dashboards. "Nothing is redrawn as drill down happens."
 *
 * These pin the BEHAVIOUR the user requires: an edge follows the drill-down.
 * They do NOT catch the regression. A fresh `nodesByLayer` Map is built on
 * every render here, so the hook's `prevNodesByLayerRef` check always fires
 * and every case takes the FULL-rebuild path; the incremental patch — the
 * `expandedNodes` diff and the cached `ancestorMapRef` it mutates, which is
 * what the memoizing canvas actually runs — is never executed by this file.
 * Measured: breaking the incremental branch outright (return the cached map
 * and never patch it) leaves all six of these green.
 *
 * The guard lives in `useEdgeProjection.incremental.test.ts`, which holds
 * `nodesByLayer` identity stable so the incremental branch is the one under
 * test, and gives nodes urns distinct from their ids so the ancestorMap is
 * the only thing that can route an edge. (The `urn: id` shortcut below lets
 * the `displayMap` fallback resolve every endpoint by itself, which is the
 * second reason a dead ancestorMap goes unnoticed here.) Treat this file as
 * the contract; treat that one as the regression guard.
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

function project(
  roots: HierarchyNode[],
  expanded: Set<string>,
  edges: ReturnType<typeof edge>[],
  aggregated?: (expanded: boolean) => Map<string, unknown>,
) {
  return renderHook(
    (p: { roots: HierarchyNode[]; expanded: Set<string> }) => {
      const inp = inputsFor(p.roots, p.expanded)
      return useEdgeProjection({
        edges,
        aggregatedEdges: (aggregated?.(p.expanded.has('tableau')) ?? new Map()) as Map<string, unknown>,
        // Containment parents — what lets a container-level roll-up be marked
        // `isDelegated` once its children carry the same flow.
        browseBundleParentMap: aggregated
          ? new Map(DASHBOARDS.map(d => [d, 'tableau']))
          : undefined,
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

/**
 * The channel that actually carried the live failure.
 *
 * `children-with-edges` returns only the lineage BETWEEN a container's
 * children, so `POST /graph/edges/aggregated` is the sole way lineage from
 * OUTSIDE the container reaches the children an expand just revealed. These
 * drive the hook with what that call answers for each visible set — one coarse
 * `snowflake -> tableau` cell while collapsed, plus one cell per dashboard once
 * expanded — and pin that the board follows.
 */
const aggCell = (source: string, target: string, edgeCount: number) =>
  [`${source}->${target}`, {
    aggregated: {
      id: `agg-${source}-${target}`,
      sourceUrn: source,
      targetUrn: target,
      edgeCount,
      edgeTypes: ['FLOWS_TO'],
      confidence: 1,
      sourceEdgeIds: [],
    },
    state: 'collapsed',
    detailedEdges: [],
  }] as const

/** What the server answers for the visible set at each toggle position. */
const rollupsFor = (isExpanded: boolean) =>
  new Map<string, unknown>(
    isExpanded
      ? [aggCell('snowflake', 'tableau', 4), ...DASHBOARDS.map(d => aggCell('snowflake', d, 1))]
      : [aggCell('snowflake', 'tableau', 4)],
  )

/** Lines the canvas actually paints — a delegated roll-up is not drawn. */
const paintedTargets = (res: {
  visibleLineageEdges: Array<{ target: string; isDelegated?: boolean }>
}) => res.visibleLineageEdges.filter(e => !e.isDelegated).map(e => e.target).sort()

describe('useEdgeProjection — roll-ups follow the drill-down too', () => {
  const roots = () => [hNode('snowflake'), hNode('tableau', DASHBOARDS.map(d => hNode(d)))]

  it('paints one line into each visible child, and stands the container line down', () => {
    const { result } = project(roots(), new Set(['tableau']), [], rollupsFor)

    expect(paintedTargets(result.current)).toEqual([...DASHBOARDS].sort())
    // The coarse cell is still projected — it just defers to the four finer
    // ones rather than double-drawing over them.
    const container = result.current.visibleLineageEdges.find(e => e.target === 'tableau')
    expect(container?.isDelegated).toBe(true)
    expect(container?.edgeCount).toBe(4)
    expect(result.current.unresolvedEdgeCount).toBe(0)
  })

  it('redraws on every expand → collapse → expand', () => {
    const { result, rerender } = project(roots(), new Set(), [], rollupsFor)
    expect(paintedTargets(result.current)).toEqual(['tableau'])

    for (let i = 0; i < 3; i++) {
      rerender({ roots: roots(), expanded: new Set(['tableau']) })
      expect(paintedTargets(result.current)).toEqual([...DASHBOARDS].sort())

      rerender({ roots: roots(), expanded: new Set() })
      expect(paintedTargets(result.current)).toEqual(['tableau'])
    }
  })
})
