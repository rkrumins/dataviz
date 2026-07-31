/**
 * useLayerAssignment — containment inheritance vs explicit per-entity assignments.
 *
 * A containment child WITHOUT an explicit entry of its own inherits its parent's
 * layer, so a nested subtree renders together under its parent — even when the
 * child's TYPE maps to a different layer. (An earlier "auto-by-type break-out"
 * relaxation was reverted: breaking children out to their type-column flattened
 * the containment tree in the Context View's nested-tree rendering. Type rules
 * still never break children out.)
 *
 * A node's OWN explicit assignment (canonical `referenceLayout.assignments` or a
 * live session drag) wins at ANY depth: an entry naming a DIFFERENT layer than
 * the inherited one splits the node (and its entry-less subtree) into that
 * column as a visual root; an entry naming the SAME layer keeps it nested
 * (ensureSiblingOrderKeys mints exactly such carrier entries to hold orderKeys).
 */
import { renderHook } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { useLayerAssignment, type UseLayerAssignmentResult } from '../useLayerAssignment'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import type { LayerAssignmentEntry, ViewLayerConfig } from '@/types/schema'

type TestNode = { id: string; data: Record<string, unknown> }
const node = (id: string, type: string): TestNode => ({ id, data: { urn: id, type, label: id } })
const layer = (id: string, order: number, entityTypes: string[]): ViewLayerConfig => ({
  id, name: id, order, entityTypes,
})

// Open-scope view (no entityAssignments) so a ROOT parent is placed by its type
// rule; the child under test then inherits from there.
function resolveHierarchy(opts: {
  nodes: TestNode[]
  sortedLayers: ViewLayerConfig[]
  parentMap: Map<string, string>
  childMap: Map<string, string[]>
}): Map<string, string> {
  const nodeMap = new Map<string, TestNode>(opts.nodes.map(n => [n.id, n]))
  const { result } = renderHook(() =>
    useLayerAssignment({
      nodes: opts.nodes,
      sortedLayers: opts.sortedLayers,
      nodeEdgeFingerprint: opts.nodes.map(n => n.id).join(','),
      instanceAssignments: new Map(),
      effectiveAssignments: new Map(),
      nodeMap,
      childMap: opts.childMap,
      parentMap: opts.parentMap,
      branchCreatedUrns: new Set(),
    }),
  )
  return result.current.nodeLayerMap
}

// parent 'p' -> child 'c'
const parentChild = () => ({
  parentMap: new Map([['c', 'p']]),
  childMap: new Map([['p', ['c']]]),
})

beforeEach(() => {
  useStagedChangesStore.setState({ changes: [], _scopeKey: null, _byScope: {} } as never)
})

describe('useLayerAssignment — entry-less containment children inherit the parent layer', () => {
  const twoLayers = () => [layer('L-parentType', 0, ['domain']), layer('L-childType', 1, ['table'])]

  it('a child whose TYPE maps to a DIFFERENT layer STILL inherits the parent layer (tree stays nested)', () => {
    const { parentMap, childMap } = parentChild()
    const map = resolveHierarchy({
      nodes: [node('p', 'domain'), node('c', 'table')],
      sortedLayers: twoLayers(),
      parentMap,
      childMap,
    })
    expect(map.get('p')).toBe('L-parentType')
    expect(map.get('c')).toBe('L-parentType') // inherited — NOT broken out to L-childType
  })

  it('a child whose TYPE maps to the SAME layer as its parent inherits', () => {
    const { parentMap, childMap } = parentChild()
    const map = resolveHierarchy({
      nodes: [node('p', 'domain'), node('c', 'domain')],
      sortedLayers: twoLayers(),
      parentMap,
      childMap,
    })
    expect(map.get('p')).toBe('L-parentType')
    expect(map.get('c')).toBe('L-parentType')
  })

  it('a child whose TYPE maps to NO layer inherits the parent layer', () => {
    const { parentMap, childMap } = parentChild()
    const map = resolveHierarchy({
      nodes: [node('p', 'domain'), node('c', 'attribute')], // 'attribute' is in no layer
      sortedLayers: twoLayers(),
      parentMap,
      childMap,
    })
    expect(map.get('p')).toBe('L-parentType')
    expect(map.get('c')).toBe('L-parentType')
  })

  it('deep chain: every descendant inherits the root parent layer (whole subtree stays together)', () => {
    const map = resolveHierarchy({
      nodes: [node('a', 'domain'), node('b', 'table'), node('d', 'domain')],
      sortedLayers: twoLayers(),
      // a -> b -> d
      parentMap: new Map([['b', 'a'], ['d', 'b']]),
      childMap: new Map([['a', ['b']], ['b', ['d']]]),
    })
    expect(map.get('a')).toBe('L-parentType')
    expect(map.get('b')).toBe('L-parentType') // inherits a, no break-out
    expect(map.get('d')).toBe('L-parentType') // inherits down the chain
  })
})

// Curated-scope resolution with the canonical `assignments` map.
function resolveCurated(opts: {
  nodes: TestNode[]
  sortedLayers: ViewLayerConfig[]
  assignments: Record<string, LayerAssignmentEntry>
  parentMap: Map<string, string>
  childMap: Map<string, string[]>
  instanceAssignments?: Map<string, { layerId: string }>
}): UseLayerAssignmentResult {
  const nodeMap = new Map<string, TestNode>(opts.nodes.map(n => [n.id, n]))
  const { result } = renderHook(() =>
    useLayerAssignment({
      nodes: opts.nodes,
      sortedLayers: opts.sortedLayers,
      nodeEdgeFingerprint: opts.nodes.map(n => n.id).join(','),
      instanceAssignments: opts.instanceAssignments ?? new Map(),
      effectiveAssignments: new Map(),
      nodeMap,
      childMap: opts.childMap,
      parentMap: opts.parentMap,
      assignments: opts.assignments,
      branchCreatedUrns: new Set(),
    }),
  )
  return result.current
}

/** Ids of a layer's visual roots. */
const rootIds = (res: UseLayerAssignmentResult, layerId: string) =>
  (res.nodesByLayer.get(layerId) ?? []).map(n => n.id)

describe('useLayerAssignment — inheritsChildren gate (canonical assignments)', () => {
  const twoCols = () => [layer('A', 0, []), layer('B', 1, [])]
  const pc = () => ({ parentMap: new Map([['c', 'p']]), childMap: new Map([['p', ['c']]]) })

  it("a child's own explicit entry to a DIFFERENT layer wins (splits into that column)", () => {
    const { parentMap, childMap } = pc()
    const res = resolveCurated({
      nodes: [node('p', 'domain'), node('c', 'table')],
      sortedLayers: twoCols(),
      assignments: { p: { layerId: 'A', inheritsChildren: true }, c: { layerId: 'B', inheritsChildren: true } },
      parentMap,
      childMap,
    })
    expect(res.nodeLayerMap.get('p')).toBe('A')
    expect(res.nodeLayerMap.get('c')).toBe('B') // explicit B wins over inherited A
    expect(rootIds(res, 'B')).toContain('c')
    expect(res.nodesByLayer.get('A')![0].children).toHaveLength(0) // pruned from p's subtree
  })

  it('inheritsChildren:false lets the child take its OWN explicit assignment', () => {
    const { parentMap, childMap } = pc()
    const res = resolveCurated({
      nodes: [node('p', 'domain'), node('c', 'table')],
      sortedLayers: twoCols(),
      assignments: { p: { layerId: 'A', inheritsChildren: false }, c: { layerId: 'B', inheritsChildren: true } },
      parentMap,
      childMap,
    })
    expect(res.nodeLayerMap.get('p')).toBe('A')
    expect(res.nodeLayerMap.get('c')).toBe('B') // no longer forced to inherit A
  })

  it('inheritsChildren:false with no child entry: the child falls out in curated scope', () => {
    const { parentMap, childMap } = pc()
    const res = resolveCurated({
      nodes: [node('p', 'domain'), node('c', 'table')],
      sortedLayers: twoCols(),
      assignments: { p: { layerId: 'A', inheritsChildren: false } },
      parentMap,
      childMap,
    })
    expect(res.nodeLayerMap.get('p')).toBe('A')
    expect(res.nodeLayerMap.has('c')).toBe(false) // no explicit entry, no inheritance → dropped
  })
})

describe('useLayerAssignment — explicit assignment wins (wizard cross-level placement regression)', () => {
  const twoCols = () => [layer('A', 0, []), layer('B', 1, [])]
  const pc = () => ({ parentMap: new Map([['c', 'p']]), childMap: new Map([['p', ['c']]]) })

  it('parent→A + child→B (the wizard gesture): the child is a visual ROOT of B, not hidden under A', () => {
    const { parentMap, childMap } = pc()
    const res = resolveCurated({
      nodes: [node('p', 'layer'), node('c', 'object')],
      sortedLayers: twoCols(),
      assignments: { p: { layerId: 'A', inheritsChildren: true }, c: { layerId: 'B', inheritsChildren: true } },
      parentMap,
      childMap,
    })
    expect(rootIds(res, 'A')).toEqual(['p'])
    expect(rootIds(res, 'B')).toEqual(['c'])
    expect(res.nodesByLayer.get('A')![0].children).toHaveLength(0)
    expect(res.unassignedNodes).toHaveLength(0)
  })

  it('a SAME-layer child entry (orderKey carrier) stays nested — no split, no duplicate root', () => {
    const { parentMap, childMap } = pc()
    const res = resolveCurated({
      nodes: [node('p', 'layer'), node('c', 'object')],
      sortedLayers: twoCols(),
      assignments: { p: { layerId: 'A', inheritsChildren: true }, c: { layerId: 'A', inheritsChildren: true, orderKey: 'a0' } },
      parentMap,
      childMap,
    })
    expect(rootIds(res, 'A')).toEqual(['p'])
    expect(res.nodesByLayer.get('A')![0].children.map(n => n.id)).toEqual(['c'])
    expect(rootIds(res, 'B')).toHaveLength(0)
  })

  it('an entry naming an UNKNOWN layer is ignored: the child falls back to inheritance', () => {
    const { parentMap, childMap } = pc()
    const res = resolveCurated({
      nodes: [node('p', 'layer'), node('c', 'object')],
      sortedLayers: twoCols(),
      assignments: { p: { layerId: 'A', inheritsChildren: true }, c: { layerId: 'ghost', inheritsChildren: true } },
      parentMap,
      childMap,
    })
    expect(res.nodeLayerMap.get('c')).toBe('A') // inherited, not stranded on 'ghost'
    expect(res.nodesByLayer.get('A')![0].children.map(n => n.id)).toEqual(['c'])
  })

  it('a ROOT whose entry names an UNKNOWN layer drops to unassignedNodes in curated scope', () => {
    const res = resolveCurated({
      nodes: [node('p', 'layer'), node('x', 'object')],
      sortedLayers: twoCols(),
      assignments: { p: { layerId: 'A', inheritsChildren: true }, x: { layerId: 'ghost', inheritsChildren: true } },
      parentMap: new Map(),
      childMap: new Map(),
    })
    expect(res.nodeLayerMap.has('x')).toBe(false)
    expect(res.unassignedNodes.map(n => n.id)).toEqual(['x'])
  })

  it('a split child carries its entry-less subtree with it', () => {
    const res = resolveCurated({
      nodes: [node('a', 'layer'), node('b', 'object'), node('d', 'attribute')],
      sortedLayers: twoCols(),
      // a -> b -> d; only a and b have entries
      assignments: { a: { layerId: 'A', inheritsChildren: true }, b: { layerId: 'B', inheritsChildren: true } },
      parentMap: new Map([['b', 'a'], ['d', 'b']]),
      childMap: new Map([['a', ['b']], ['b', ['d']]]),
    })
    expect(rootIds(res, 'A')).toEqual(['a'])
    expect(rootIds(res, 'B')).toEqual(['b'])
    expect(res.nodesByLayer.get('B')![0].children.map(n => n.id)).toEqual(['d']) // d inherits b's B
    expect(res.nodesByLayer.get('A')![0].children).toHaveLength(0)
  })

  it('a live session drag (instanceAssignments) on a child wins over inheritance', () => {
    const { parentMap, childMap } = pc()
    const res = resolveCurated({
      nodes: [node('p', 'layer'), node('c', 'object')],
      sortedLayers: twoCols(),
      assignments: { p: { layerId: 'A', inheritsChildren: true } },
      parentMap,
      childMap,
      instanceAssignments: new Map([['c', { layerId: 'B' }]]),
    })
    expect(res.nodeLayerMap.get('c')).toBe('B')
    expect(rootIds(res, 'B')).toEqual(['c'])
  })
})
