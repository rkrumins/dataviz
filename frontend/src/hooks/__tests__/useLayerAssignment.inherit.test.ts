/**
 * useLayerAssignment — SCOPED relaxation of the "containment children inherit the
 * parent's layer" hard rule.
 *
 * Old rule: a containment child ALWAYS inherited its parent's layer, so a
 * mixed-type hierarchy collapsed into one column. New rule (scoped): a child
 * breaks out to its OWN layer ONLY when its TYPE maps — via THIS view's layer
 * config — to a DIFFERENT, existing layer than the parent's. In every other case
 * (type maps to the same layer, or to no distinct layer) it still inherits, EXACTLY
 * as before. These tests pin both the break-out and the two inherit regressions,
 * ontology-agnostically (types/layers are arbitrary names).
 */
import { renderHook } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { useLayerAssignment } from '../useLayerAssignment'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import type { ViewLayerConfig } from '@/types/schema'

type TestNode = { id: string; data: Record<string, unknown> }
const node = (id: string, type: string): TestNode => ({ id, data: { urn: id, type, label: id } })
const layer = (id: string, order: number, entityTypes: string[]): ViewLayerConfig => ({
  id, name: id, order, entityTypes,
})

// Open-scope view (no entityAssignments) so a ROOT parent is placed by its type
// rule; the child under test then inherits-or-breaks-out from there.
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

describe('useLayerAssignment — scoped inherit-break relaxation', () => {
  const twoLayers = () => [layer('L-parentType', 0, ['domain']), layer('L-childType', 1, ['table'])]

  it('a child whose TYPE maps to a DIFFERENT existing layer breaks out to its own column', () => {
    const { parentMap, childMap } = parentChild()
    const map = resolveHierarchy({
      nodes: [node('p', 'domain'), node('c', 'table')],
      sortedLayers: twoLayers(),
      parentMap,
      childMap,
    })
    expect(map.get('p')).toBe('L-parentType')
    expect(map.get('c')).toBe('L-childType') // broke out — did NOT inherit the parent's layer
  })

  it('REGRESSION: a child whose TYPE maps to the SAME layer as its parent still inherits', () => {
    const { parentMap, childMap } = parentChild()
    const map = resolveHierarchy({
      nodes: [node('p', 'domain'), node('c', 'domain')], // same type → same column
      sortedLayers: twoLayers(),
      parentMap,
      childMap,
    })
    expect(map.get('p')).toBe('L-parentType')
    expect(map.get('c')).toBe('L-parentType') // inherited, no break-out
  })

  it('REGRESSION: a child whose TYPE maps to NO layer still inherits the parent layer', () => {
    const { parentMap, childMap } = parentChild()
    const map = resolveHierarchy({
      nodes: [node('p', 'domain'), node('c', 'attribute')], // 'attribute' is in no layer
      sortedLayers: twoLayers(),
      parentMap,
      childMap,
    })
    expect(map.get('p')).toBe('L-parentType')
    expect(map.get('c')).toBe('L-parentType') // inherited (no distinct layer for its type)
  })

  it('deep chain: each level lands in its own type-column when types differ', () => {
    const map = resolveHierarchy({
      nodes: [node('a', 'domain'), node('b', 'table'), node('d', 'domain')],
      sortedLayers: twoLayers(),
      // a -> b -> d
      parentMap: new Map([['b', 'a'], ['d', 'b']]),
      childMap: new Map([['a', ['b']], ['b', ['d']]]),
    })
    expect(map.get('a')).toBe('L-parentType')
    expect(map.get('b')).toBe('L-childType')  // breaks out from a
    expect(map.get('d')).toBe('L-parentType') // breaks out again (domain != table)
  })
})
