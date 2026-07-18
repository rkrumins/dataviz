/**
 * useEdgeProjection — silent-loss guards.
 *
 * 1. Drop counting: edges whose endpoints resolve to nothing on canvas
 *    are counted in `unresolvedEdgeCount` (any unresolved endpoint, not
 *    just both) so the canvas can surface "N connections not shown".
 * 2. Coverage-gated delegation: a rolled-up edge on an expanded,
 *    fully-loaded parent is only hidden (isDelegated) when finer
 *    child-level edges actually exist for the same pair. Container-own
 *    lineage with no finer substitute must stay visible.
 */
import { renderHook } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { useEdgeProjection } from '../useEdgeProjection'
import type { HierarchyNode } from '@/types/hierarchy'

const hNode = (id: string, children: HierarchyNode[] = [], data: Record<string, unknown> = {}): HierarchyNode => ({
  id,
  typeId: 'entity',
  name: id,
  data: { urn: id, type: 'entity', label: id, ...data },
  children,
  depth: 0,
  urn: id,
  entityTypeOption: 'entity',
  tags: [],
})

const edge = (id: string, source: string, target: string) => ({
  id, source, target, data: { edgeType: 'FLOWS_TO' },
})

function run(opts: {
  edges: ReturnType<typeof edge>[]
  roots: HierarchyNode[]
  expandedNodes?: Set<string>
  parentMap?: Map<string, string>
  hoveredNodeId?: string | null
}) {
  const flat: HierarchyNode[] = []
  const stack = [...opts.roots]
  while (stack.length > 0) {
    const n = stack.pop()!
    flat.push(n)
    stack.push(...n.children)
  }
  const displayMap = new Map(flat.map(n => [n.id, n]))
  const urnToIdMap = new Map(flat.map(n => [n.urn!, n.id]))
  const { result } = renderHook(() =>
    useEdgeProjection({
      edges: opts.edges,
      aggregatedEdges: new Map(),
      nodesByLayer: new Map([['L1', opts.roots]]),
      expandedNodes: opts.expandedNodes ?? new Set(),
      displayFlat: flat,
      displayMap,
      urnToIdMap,
      showLineageFlow: true,
      isTracing: false,
      traceContextSet: new Set(),
      isContainmentEdge: () => false,
      hoveredNodeId: opts.hoveredNodeId ?? null,
      browseBundleParentMap: opts.parentMap,
    }),
  )
  return result.current
}

describe('useEdgeProjection — unresolved endpoint counting', () => {
  it('projects resolvable edges and counts edges with ANY unresolved endpoint', () => {
    const res = run({
      roots: [hNode('a'), hNode('b')],
      edges: [
        edge('e1', 'a', 'b'),        // both resolve → projected
        edge('e2', 'a', 'ghost'),    // target unresolved → counted
        edge('e3', 'phantom', 'b'),  // source unresolved → counted
      ],
    })
    expect(res.visibleLineageEdges).toHaveLength(1)
    expect(res.unresolvedEdgeCount).toBe(2)
  })

  it('reports zero when everything resolves', () => {
    const res = run({
      roots: [hNode('a'), hNode('b')],
      edges: [edge('e1', 'a', 'b')],
    })
    expect(res.unresolvedEdgeCount).toBe(0)
  })
})

describe('useEdgeProjection — coverage-gated delegation', () => {
  // P is expanded and fully loaded (childCount 1, child c1 present).
  const buildRoots = () => {
    const c1 = hNode('c1')
    c1.depth = 1
    const p = hNode('p', [c1], { childCount: 1 })
    return { roots: [p, hNode('b')], parentMap: new Map([['c1', 'p']]) }
  }

  it('container-own edge with NO finer substitute stays visible (not delegated)', () => {
    const { roots, parentMap } = buildRoots()
    const res = run({
      roots,
      parentMap,
      expandedNodes: new Set(['p']),
      edges: [edge('e1', 'p', 'b')],
    })
    const pb = res.visibleLineageEdges.find((e: { source: string; target: string; isDelegated?: boolean }) => e.source === 'p' && e.target === 'b')
    expect(pb).toBeDefined()
    expect(pb.isDelegated).toBe(false)
  })

  it('parent edge WITH finer child-level coverage is delegated (hidden until hover)', () => {
    const { roots, parentMap } = buildRoots()
    const res = run({
      roots,
      parentMap,
      expandedNodes: new Set(['p']),
      edges: [edge('e1', 'p', 'b'), edge('e2', 'c1', 'b')],
    })
    const pb = res.visibleLineageEdges.find((e: { source: string; target: string; isDelegated?: boolean }) => e.source === 'p' && e.target === 'b')
    const cb = res.visibleLineageEdges.find((e: { source: string; target: string; isDelegated?: boolean }) => e.source === 'c1' && e.target === 'b')
    expect(pb?.isDelegated).toBe(true)
    expect(cb?.isDelegated).toBe(false)
  })

  it('delegated parent edge re-materializes on endpoint hover', () => {
    const { roots, parentMap } = buildRoots()
    const res = run({
      roots,
      parentMap,
      expandedNodes: new Set(['p']),
      hoveredNodeId: 'p',
      edges: [edge('e1', 'p', 'b'), edge('e2', 'c1', 'b')],
    })
    const pb = res.visibleLineageEdges.find((e: { source: string; target: string; isDelegated?: boolean }) => e.source === 'p' && e.target === 'b')
    expect(pb?.isDelegated).toBe(false)
  })
})
