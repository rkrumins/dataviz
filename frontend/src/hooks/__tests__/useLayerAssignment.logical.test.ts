/**
 * useLayerAssignment — logical-group wrapping from the CANONICAL assignments map.
 *
 * The wizard persists a drop into a logical group as
 * `referenceLayout.assignments[urn].logicalNodeId` (normalizeReferenceLayout
 * strips the legacy per-layer `entityAssignments`, so for persisted views the
 * canonical entry is the ONLY place the placement exists). These tests pin that
 * the canvas reads it — and that the legacy path still works, with canonical
 * winning on collision.
 */
import { renderHook } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { useLayerAssignment, type UseLayerAssignmentResult } from '../useLayerAssignment'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import type { LayerAssignmentEntry, ViewLayerConfig } from '@/types/schema'

type TestNode = { id: string; data: Record<string, unknown> }
const node = (id: string, type: string): TestNode => ({ id, data: { urn: id, type, label: id } })

const layerWithGroups = (overrides?: Partial<ViewLayerConfig>): ViewLayerConfig => ({
  id: 'l1',
  name: 'l1',
  order: 0,
  entityTypes: [],
  logicalNodes: [
    { id: 'g1', name: 'Group 1', type: 'group' },
    { id: 'g2', name: 'Group 2', type: 'group' },
  ],
  ...overrides,
})

function resolve(opts: {
  nodes: TestNode[]
  sortedLayers: ViewLayerConfig[]
  assignments: Record<string, LayerAssignmentEntry>
}): UseLayerAssignmentResult {
  const nodeMap = new Map<string, TestNode>(opts.nodes.map(n => [n.id, n]))
  const { result } = renderHook(() =>
    useLayerAssignment({
      nodes: opts.nodes,
      sortedLayers: opts.sortedLayers,
      nodeEdgeFingerprint: opts.nodes.map(n => n.id).join(','),
      instanceAssignments: new Map(),
      effectiveAssignments: new Map(),
      nodeMap,
      childMap: new Map(),
      parentMap: new Map(),
      assignments: opts.assignments,
      branchCreatedUrns: new Set(),
    }),
  )
  return result.current
}

beforeEach(() => {
  useStagedChangesStore.setState({ changes: [], _scopeKey: null, _byScope: {} } as never)
})

describe('useLayerAssignment — canonical logicalNodeId wraps entities into logical groups', () => {
  it('an assignment with logicalNodeId renders the entity inside its group wrapper', () => {
    const res = resolve({
      nodes: [node('e1', 'object')],
      sortedLayers: [layerWithGroups()],
      assignments: { e1: { layerId: 'l1', inheritsChildren: true, logicalNodeId: 'g1' } },
    })
    const roots = res.nodesByLayer.get('l1') ?? []
    expect(roots.map(n => n.id)).toEqual(['logical:g1'])
    expect(roots[0].isLogical).toBe(true)
    expect(roots[0].children.map(n => n.id)).toEqual(['e1'])
  })

  it('canonical logicalNodeId wins over a legacy entityAssignments entry', () => {
    const res = resolve({
      nodes: [node('e1', 'object')],
      sortedLayers: [
        layerWithGroups({
          entityAssignments: [{ entityId: 'e1', layerId: 'l1', logicalNodeId: 'g2', inheritsChildren: true, priority: 0 }],
        }),
      ],
      assignments: { e1: { layerId: 'l1', inheritsChildren: true, logicalNodeId: 'g1' } },
    })
    const roots = res.nodesByLayer.get('l1') ?? []
    expect(roots.map(n => n.id)).toEqual(['logical:g1'])
    expect(roots[0].children.map(n => n.id)).toEqual(['e1'])
  })

  it('a legacy-only entityAssignments logicalNodeId still wraps (untouched path)', () => {
    const res = resolve({
      nodes: [node('e1', 'object')],
      sortedLayers: [
        layerWithGroups({
          entityAssignments: [{ entityId: 'e1', layerId: 'l1', logicalNodeId: 'g1', inheritsChildren: true, priority: 0 }],
        }),
      ],
      assignments: { e1: { layerId: 'l1', inheritsChildren: true } },
    })
    const roots = res.nodesByLayer.get('l1') ?? []
    expect(roots.map(n => n.id)).toEqual(['logical:g1'])
    expect(roots[0].children.map(n => n.id)).toEqual(['e1'])
  })
})
