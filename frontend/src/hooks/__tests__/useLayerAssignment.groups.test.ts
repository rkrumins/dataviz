/**
 * useLayerAssignment — a group holds what was put in it, across a reload.
 *
 * `assignmentMutations.assignEntities` stamps `logicalNodeId` onto the
 * canonical `referenceLayout.assignments` entry — the same record that
 * carries `layerId`. But the entity→group map was built only from the
 * LEGACY per-layer `entityAssignments` array and from `instanceAssignments`
 * (this session's drags), so a group's membership rendered while the drag
 * was still in memory and quietly came apart once the canonical record was
 * the only thing left.
 */
import { renderHook } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { useLayerAssignment } from '../useLayerAssignment'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import type { LayerAssignmentEntry, ViewLayerConfig } from '@/types/schema'

type TestNode = { id: string; data: Record<string, unknown> }
const node = (id: string): TestNode => ({ id, data: { urn: id, type: 'table', label: id } })

const entry = (layerId: string, logicalNodeId?: string): LayerAssignmentEntry => ({
  layerId,
  inheritsChildren: true,
  assignedBy: 'user',
  ...(logicalNodeId ? { logicalNodeId } : {}),
})

/** One layer that declares a single group. */
const LAYERS: ViewLayerConfig[] = [{
  id: 'L1',
  name: 'Raw',
  order: 0,
  entityTypes: [],
  logicalNodes: [{ id: 'G', name: 'Landing', type: 'group' }],
} as unknown as ViewLayerConfig]

function rootsOf(assignments: Record<string, LayerAssignmentEntry>, nodes: TestNode[]) {
  const { result } = renderHook(() =>
    useLayerAssignment({
      nodes,
      sortedLayers: LAYERS,
      nodeEdgeFingerprint: nodes.map(n => n.id).join(','),
      instanceAssignments: new Map(),
      effectiveAssignments: new Map(),
      nodeMap: new Map(nodes.map(n => [n.id, n])),
      childMap: new Map(),
      parentMap: new Map(),
      assignments,
      branchCreatedUrns: new Set(),
    }),
  )
  return result.current.nodesByLayer.get('L1') ?? []
}

beforeEach(() => {
  useStagedChangesStore.setState({ changes: [], _scopeKey: null, _byScope: {} } as never)
})

describe('logical group membership from the canonical assignments', () => {
  it('nests an entity under the group its canonical entry names', () => {
    const roots = rootsOf({ a: entry('L1', 'G'), b: entry('L1') }, [node('a'), node('b')])

    const wrapper = roots.find(r => r.id === 'logical:G')
    expect(wrapper).toBeDefined()
    expect(wrapper!.children.map(c => c.id)).toEqual(['a'])
    // 'b' has no group, so it stays a root of the column.
    expect(roots.some(r => r.id === 'b')).toBe(true)
  })

  it('leaves the column alone when no entry names a group', () => {
    const roots = rootsOf({ a: entry('L1'), b: entry('L1') }, [node('a'), node('b')])

    expect(roots.some(r => r.id === 'logical:G')).toBe(false)
    expect(roots.map(r => r.id).sort()).toEqual(['a', 'b'])
  })

  it('ignores an entry naming a group the layer does not declare', () => {
    const roots = rootsOf({ a: entry('L1', 'GHOST') }, [node('a')])

    // Not swallowed by a wrapper that does not exist — it stays visible.
    expect(roots.some(r => r.id === 'a')).toBe(true)
  })
})
