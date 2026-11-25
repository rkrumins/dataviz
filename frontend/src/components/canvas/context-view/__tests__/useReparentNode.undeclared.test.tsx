/**
 * Moving an entity in an ontology that declares NO hierarchy — what suggested and introspected
 * ontologies are: every type's "can contain" is empty. The server reads that as "may contain
 * anything", so a node nested in a node nested in a node can move to any other node. A drop must
 * not refuse it as "holds nothing", and "Choose a new parent…" must list the nodes. Where an
 * ontology DOES declare a hierarchy, a type left empty is still a leaf (useReparentNode.test.tsx).
 */
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const notify = vi.fn()

// One generic type, nested in itself; nothing declares what may contain what.
const ENTITY_TYPES = [{ id: 'node', name: 'Node', hierarchy: { canContain: [], canBeContainedBy: [] } }]
const REL_TYPES = [{ id: 'CONTAINS', name: 'Contains', sourceTypes: [], targetTypes: [], isContainment: true }]

vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))
vi.mock('@/store/schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/store/schema')>()
  return {
    ...actual,
    useEntityTypes: () => ENTITY_TYPES,
    useRootEntityTypes: () => ['node'],
    useEntityTypeHierarchyMap: () => ({ node: { canContain: [] } }),
    useRelationshipTypes: () => REL_TYPES,
    useContainmentEdgeTypes: () => ['CONTAINS'],
  }
})

import { useReparentNode } from '../useReparentNode'
import { useMoveTargets } from '@/components/panels/entity/useContainment'
import { useCanvasStore } from '@/store/canvas'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useBranchStore } from '@/store/branchStore'

const node = (id: string) => ({ id, type: 'generic', position: { x: 0, y: 0 }, data: { label: id, urn: id, type: 'node' } })
const has = (parent: string, child: string) =>
  ({ id: `c:${parent}>${child}`, source: parent, target: child, type: 'containment', data: { edgeType: 'CONTAINS' } })

// A ⊃ B ⊃ C, and a second root D.
const NODES = ['A', 'B', 'C', 'D'].map(node)
const EDGES = [has('A', 'B'), has('B', 'C')]

beforeEach(() => {
  notify.mockClear()
  useStagedChangesStore.setState({ changes: [], redoStack: [], _scopeKey: null, _byScope: {} })
  useBranchStore.setState({ currentBranchId: 'br_1' } as never)
  useCanvasStore.setState({
    nodes: NODES, edges: EDGES,
    _nodeIndex: new Set(NODES.map((n) => n.id)), _edgeIndex: new Set(EDGES.map((e) => e.id)),
  } as never)
})

describe('a node nested in a node, in an ontology that declares no hierarchy', () => {
  it('moves a deep node under another node: one move, not "holds nothing"', () => {
    const { result } = renderHook(() => useReparentNode())
    expect(result.current.verdict('C', 'D')).toEqual({ kind: 'data', edgeType: 'CONTAINS' })
    result.current.reparent('C', 'D')
    const moves = useStagedChangesStore.getState().changes.filter((c) => c.type === 'move_entity')
    expect(moves.map((c) => c.after)).toEqual([expect.objectContaining({ childId: 'C', parentId: 'D', edgeType: 'CONTAINS' })])
  })

  it('still refuses a node dropped into its own descendant', () => {
    const { result } = renderHook(() => useReparentNode())
    expect(result.current.verdict('A', 'C')).toMatchObject({ kind: 'blocked' })
  })

  it('"Choose a new parent…" lists every node outside its own subtree', () => {
    const { result } = renderHook(() => useMoveTargets('B', true))
    // Not B itself, nor C inside it, nor A (already its parent).
    expect(result.current.map((t) => t.id)).toEqual(['D'])
  })
})
