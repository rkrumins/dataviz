/**
 * Closed-scope layer-resolution tests for `useLayerAssignment` — specifically the
 * LEAK-SAFE branch-created-delta tier added for the "created-in-draft entity never
 * renders" bug.
 *
 * A Context Model view is CLOSED-SCOPE when it carries persisted
 * `entityAssignments`. In that mode the resolver deliberately IGNORES a node's
 * global `layerAssignment` property (honouring it blindly would leak in entities
 * this view never assigned). The fix adds ONE narrow exception: an entity CREATED
 * IN THIS BRANCH's draft (its urn is in the branch-created delta) may be placed by
 * its own durable, view-valid `layerAssignment`. This is leak-safe by
 * construction — only delta nodes qualify.
 *
 * These tests pin, in order:
 *  (b) delta node with valid layerAssignment  → resolves to that layer
 *  (c) LEAK-SAFETY: non-delta node with the SAME layerAssignment → NOT placed
 *  (d) persisted entityAssignments node        → unchanged
 *  (e) REGRESSION: EMPTY delta                  → identical to pre-change closed-scope
 *      (a node's global layerAssignment is ignored)
 *  + the valid-layer guard and the untouched open-scope path.
 */
import { renderHook } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { useLayerAssignment } from '../useLayerAssignment'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import type { ViewLayerConfig } from '@/types/schema'

type TestNode = { id: string; data: Record<string, unknown> }

const node = (id: string, type: string, layerAssignment?: string): TestNode => ({
  id,
  data: { urn: id, type, label: id, ...(layerAssignment ? { layerAssignment } : {}) },
})

const layer = (
  id: string,
  order: number,
  assignedEntityIds: string[] = [],
): ViewLayerConfig => ({
  id,
  name: id,
  order,
  entityTypes: [],
  entityAssignments: assignedEntityIds.map(entityId => ({
    entityId,
    layerId: id,
    inheritsChildren: false,
    priority: 1000,
  })),
})

function resolve(opts: {
  nodes: TestNode[]
  sortedLayers: ViewLayerConfig[]
  branchCreatedUrns?: Set<string>
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
      childMap: new Map(),
      parentMap: new Map(),
      branchCreatedUrns: opts.branchCreatedUrns,
    }),
  )
  return result.current.nodeLayerMap
}

// A closed-scope view: `concepts` has a persisted entityAssignment, so
// `viewHasExplicitAssignments` is true and the global-property path is skipped.
const closedScopeLayers = () => [
  layer('objects', 0),
  layer('concepts', 1, ['persisted']),
]

beforeEach(() => {
  // Empty the live delta so the option we pass in is the only delta in play.
  useStagedChangesStore.setState({ changes: [], _scopeKey: null, _byScope: {} })
})

describe('useLayerAssignment — closed-scope branch-created delta', () => {
  it('(b) places a branch-created node by its valid layerAssignment', () => {
    const map = resolve({
      nodes: [node('persisted', 'x'), node('created', 'obj', 'objects')],
      sortedLayers: closedScopeLayers(),
      branchCreatedUrns: new Set(['created']),
    })
    expect(map.get('created')).toBe('objects')
    expect(map.get('persisted')).toBe('concepts')
  })

  it('(c) LEAK-SAFETY: a non-delta node with the SAME layerAssignment is NOT placed', () => {
    const map = resolve({
      nodes: [
        node('persisted', 'x'),
        node('created', 'obj', 'objects'), // in delta → placed
        node('leaker', 'obj', 'objects'),  // identical global prop, NOT in delta
      ],
      sortedLayers: closedScopeLayers(),
      branchCreatedUrns: new Set(['created']),
    })
    expect(map.get('created')).toBe('objects')
    expect(map.has('leaker')).toBe(false)
  })

  it('(d) leaves a persisted entityAssignments node unchanged when a delta is present', () => {
    const map = resolve({
      nodes: [node('persisted', 'x')],
      sortedLayers: closedScopeLayers(),
      branchCreatedUrns: new Set(['created']), // present but irrelevant to this node
    })
    expect(map.get('persisted')).toBe('concepts')
  })

  it('(e) REGRESSION: with an EMPTY delta, a node global layerAssignment is ignored (pre-change closed-scope)', () => {
    const map = resolve({
      nodes: [node('persisted', 'x'), node('hasGlobalProp', 'obj', 'objects')],
      sortedLayers: closedScopeLayers(),
      branchCreatedUrns: new Set(),
    })
    expect(map.get('persisted')).toBe('concepts')
    expect(map.has('hasGlobalProp')).toBe(false)
  })

  it('does not place a delta node whose layerAssignment names a non-existent layer (valid-layer guard)', () => {
    const map = resolve({
      nodes: [node('persisted', 'x'), node('created', 'obj', 'ghostLayer')],
      sortedLayers: closedScopeLayers(),
      branchCreatedUrns: new Set(['created']),
    })
    expect(map.has('created')).toBe(false)
  })

  it('closed-scope: an explicit entityAssignment still wins over the delta layerAssignment', () => {
    // `created` is both in the delta (layerAssignment objects) AND persisted to concepts.
    const map = resolve({
      nodes: [node('created', 'obj', 'objects')],
      sortedLayers: [layer('objects', 0), layer('concepts', 1, ['created'])],
      branchCreatedUrns: new Set(['created']),
    })
    expect(map.get('created')).toBe('concepts')
  })

  it('open-scope (no persisted assignments) still honors a node layerAssignment regardless of delta', () => {
    const map = resolve({
      nodes: [node('n', 'obj', 'objects')],
      sortedLayers: [layer('objects', 0), layer('concepts', 1)], // no entityAssignments → open-scope
      branchCreatedUrns: new Set(),
    })
    expect(map.get('n')).toBe('objects')
  })
})
