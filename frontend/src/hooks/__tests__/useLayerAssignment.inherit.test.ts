/**
 * useLayerAssignment — "containment children inherit the parent's layer" HARD RULE.
 *
 * A containment child ALWAYS inherits its parent's layer, so a nested subtree
 * renders together under its parent and the containment tree stays intact — even
 * when the child's TYPE maps to a different layer. (An earlier "auto-by-type
 * break-out" relaxation was reverted: breaking children out to their type-column
 * flattened the containment tree in the Context View's nested-tree rendering.)
 * These tests pin the hard-inherit rule, ontology-agnostically.
 */
import { renderHook } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { useLayerAssignment } from '../useLayerAssignment'
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

describe('useLayerAssignment — containment children inherit the parent layer (hard rule)', () => {
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

// Curated-scope resolution with the canonical `assignments` map: `inheritsChildren: false`
// is the ONLY escape from the hard-inherit rule.
function resolveCurated(opts: {
  nodes: TestNode[]
  sortedLayers: ViewLayerConfig[]
  assignments: Record<string, LayerAssignmentEntry>
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
      assignments: opts.assignments,
      branchCreatedUrns: new Set(),
    }),
  )
  return result.current.nodeLayerMap
}

describe('useLayerAssignment — inheritsChildren gate (canonical assignments)', () => {
  const twoCols = () => [layer('A', 0, []), layer('B', 1, [])]
  const pc = () => ({ parentMap: new Map([['c', 'p']]), childMap: new Map([['p', ['c']]]) })

  it('DEFAULT (inheritsChildren true): child hard-inherits the parent, ignoring its own explicit entry', () => {
    const { parentMap, childMap } = pc()
    const map = resolveCurated({
      nodes: [node('p', 'domain'), node('c', 'table')],
      sortedLayers: twoCols(),
      assignments: { p: { layerId: 'A', inheritsChildren: true }, c: { layerId: 'B', inheritsChildren: true } },
      parentMap,
      childMap,
    })
    expect(map.get('p')).toBe('A')
    expect(map.get('c')).toBe('A') // hard-inherit wins over c's own explicit B
  })

  it('inheritsChildren:false lets the child take its OWN explicit assignment', () => {
    const { parentMap, childMap } = pc()
    const map = resolveCurated({
      nodes: [node('p', 'domain'), node('c', 'table')],
      sortedLayers: twoCols(),
      assignments: { p: { layerId: 'A', inheritsChildren: false }, c: { layerId: 'B', inheritsChildren: true } },
      parentMap,
      childMap,
    })
    expect(map.get('p')).toBe('A')
    expect(map.get('c')).toBe('B') // no longer forced to inherit A
  })

  it('inheritsChildren:false with no child entry: the child falls out in curated scope', () => {
    const { parentMap, childMap } = pc()
    const map = resolveCurated({
      nodes: [node('p', 'domain'), node('c', 'table')],
      sortedLayers: twoCols(),
      assignments: { p: { layerId: 'A', inheritsChildren: false } },
      parentMap,
      childMap,
    })
    expect(map.get('p')).toBe('A')
    expect(map.has('c')).toBe(false) // no explicit entry, no inheritance → dropped
  })
})
