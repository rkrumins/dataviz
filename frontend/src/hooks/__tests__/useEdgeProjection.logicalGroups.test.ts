/**
 * useEdgeProjection — lineage inside a logical group.
 *
 * Putting entities into a Group under a Layer made their lineage vanish.
 * Grouping makes `logical:<id>` the ROOT of its members in that layer, and
 * a collapsed root anchors everything beneath it to itself — so an edge
 * between two members of the same collapsed group arrives with
 * `sId === tId` and was discarded. Not merely hidden: the self-rollup
 * branch was excluded from the unresolved tally too, so nothing anywhere
 * said a connection had been dropped.
 *
 * Grouping related entities together is the whole reason to make a group,
 * so this hit exactly the users who used the feature as intended.
 */
import { renderHook } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { useEdgeProjection } from '../useEdgeProjection'
import type { HierarchyNode } from '@/types/hierarchy'

const hNode = (
  id: string,
  children: HierarchyNode[] = [],
  extra: Partial<HierarchyNode> = {},
): HierarchyNode => ({
  id,
  typeId: 'entity',
  name: id,
  data: { urn: id, type: 'entity', label: id },
  children,
  depth: 0,
  urn: id,
  entityTypeOption: 'entity',
  tags: [],
  ...extra,
})

/** A logical group wrapper, exactly as useLayerAssignment builds one. */
const group = (id: string, children: HierarchyNode[]): HierarchyNode =>
  hNode(`logical:${id}`, children, {
    data: { type: 'group', label: id, isLogical: true },
    urn: `logical:${id}`,
    isLogical: true,
  } as Partial<HierarchyNode>)

const edge = (id: string, source: string, target: string) => ({
  id, source, target, data: { edgeType: 'FLOWS_TO' },
})

function run(roots: HierarchyNode[], edges: ReturnType<typeof edge>[], expanded: Set<string>) {
  const flat: HierarchyNode[] = []
  const stack = [...roots]
  while (stack.length > 0) {
    const n = stack.pop()!
    flat.push(n)
    stack.push(...n.children)
  }
  const { result } = renderHook(() =>
    useEdgeProjection({
      edges,
      aggregatedEdges: new Map(),
      nodesByLayer: new Map([['L1', roots]]),
      expandedNodes: expanded,
      displayFlat: flat,
      displayMap: new Map(flat.map(n => [n.id, n])),
      urnToIdMap: new Map(flat.map(n => [n.urn!, n.id])),
      showLineageFlow: true,
      isTracing: false,
      traceContextSet: new Set(),
      isContainmentEdge: () => false,
    }),
  )
  return result.current
}

describe('lineage between two members of one logical group', () => {
  const members = () => {
    const a = hNode('a')
    const b = hNode('b')
    a.depth = 1
    b.depth = 1
    return [a, b]
  }

  it('renders when the group is open', () => {
    const [a, b] = members()
    const res = run([group('G', [a, b])], [edge('e1', 'a', 'b')], new Set(['logical:G']))

    expect(res.visibleLineageEdges).toHaveLength(1)
    expect(res.unresolvedEdgeCount).toBe(0)
  })

  it('is accounted for — never silently dropped — when the group is closed', () => {
    const [a, b] = members()
    const res = run([group('G', [a, b])], [edge('e1', 'a', 'b')], new Set())

    // Both endpoints collapse onto the wrapper, so there is no line to
    // draw. That is fine; vanishing without a word is not.
    expect(res.visibleLineageEdges).toHaveLength(0)
    expect(res.hiddenInsideCollapsedCount).toBe(1)
  })

  it('still draws an edge that LEAVES a closed group', () => {
    const [a, b] = members()
    const outside = hNode('z')
    const res = run(
      [group('G', [a, b]), outside],
      [edge('e1', 'a', 'z')],
      new Set(),
    )

    expect(res.visibleLineageEdges).toHaveLength(1)
    expect(res.visibleLineageEdges[0].source).toBe('logical:G')
    expect(res.visibleLineageEdges[0].target).toBe('z')
    expect(res.hiddenInsideCollapsedCount).toBe(0)
  })

  it('does not confuse a hidden-inside edge with an unresolvable one', () => {
    const [a, b] = members()
    const res = run(
      [group('G', [a, b])],
      [edge('e1', 'a', 'b'), edge('e2', 'a', 'nowhere')],
      new Set(),
    )

    expect(res.hiddenInsideCollapsedCount).toBe(1)
    expect(res.unresolvedEdgeCount).toBe(1)
  })
})
