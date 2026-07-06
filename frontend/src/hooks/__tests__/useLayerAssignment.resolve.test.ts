/**
 * Closed-scope layer-resolution tests for `useLayerAssignment` — specifically the
 * LEAK-SAFE branch-created-delta tier added for the "created-in-draft entity never
 * renders" bug.
 *
 * A Context View is CURATED (closed-scope) when its canonical `referenceLayout.assignments`
 * map is non-empty (or `entityScope: 'curated'` is set explicitly). In that mode the resolver
 * deliberately IGNORES a node's global `layerAssignment` property (honouring it blindly would
 * leak in entities this view never assigned). The fix adds ONE narrow exception: an entity
 * CREATED IN THIS BRANCH's draft (its urn is in the branch-created delta) may be placed by its
 * own durable, view-valid `layerAssignment`. This is leak-safe by construction — only delta
 * nodes qualify.
 *
 * These tests pin, in order:
 *  (b) delta node with valid layerAssignment  → resolves to that layer
 *  (c) LEAK-SAFETY: non-delta node with the SAME layerAssignment → NOT placed
 *  (d) canonical-assignment node               → unchanged
 *  (e) REGRESSION: EMPTY delta                  → identical to pre-change closed-scope
 *      (a node's global layerAssignment is ignored)
 *  + the valid-layer guard and the untouched open-scope path.
 */
import { renderHook } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { useLayerAssignment } from '../useLayerAssignment'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import type { LayerAssignmentEntry, ViewLayerConfig } from '@/types/schema'

type TestNode = { id: string; data: Record<string, unknown> }

const node = (id: string, type: string, layerAssignment?: string): TestNode => ({
  id,
  data: { urn: id, type, label: id, ...(layerAssignment ? { layerAssignment } : {}) },
})

const layer = (id: string, order: number): ViewLayerConfig => ({
  id,
  name: id,
  order,
  entityTypes: [],
})

/** Canonical assignment entry keyed by urn (=== node id in a Context View). */
const assign = (layerId: string): LayerAssignmentEntry => ({ layerId, inheritsChildren: false })

function resolve(opts: {
  nodes: TestNode[]
  sortedLayers: ViewLayerConfig[]
  assignments?: Record<string, LayerAssignmentEntry>
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
      assignments: opts.assignments,
      branchCreatedUrns: opts.branchCreatedUrns,
    }),
  )
  return result.current.nodeLayerMap
}

const twoLayers = () => [layer('objects', 0), layer('concepts', 1)]
// A closed-scope view: `persisted` has a canonical assignment, so the view is
// curated and the global-property path is skipped for non-delta nodes.
const persistedAssignments = () => ({ persisted: assign('concepts') })

beforeEach(() => {
  // Empty the live delta so the option we pass in is the only delta in play.
  useStagedChangesStore.setState({ changes: [], _scopeKey: null, _byScope: {} })
})

describe('useLayerAssignment — closed-scope branch-created delta', () => {
  it('(b) places a branch-created node by its valid layerAssignment', () => {
    const map = resolve({
      nodes: [node('persisted', 'x'), node('created', 'obj', 'objects')],
      sortedLayers: twoLayers(),
      assignments: persistedAssignments(),
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
      sortedLayers: twoLayers(),
      assignments: persistedAssignments(),
      branchCreatedUrns: new Set(['created']),
    })
    expect(map.get('created')).toBe('objects')
    expect(map.has('leaker')).toBe(false)
  })

  it('(d) leaves a canonical-assignment node unchanged when a delta is present', () => {
    const map = resolve({
      nodes: [node('persisted', 'x')],
      sortedLayers: twoLayers(),
      assignments: persistedAssignments(),
      branchCreatedUrns: new Set(['created']), // present but irrelevant to this node
    })
    expect(map.get('persisted')).toBe('concepts')
  })

  it('(e) REGRESSION: with an EMPTY delta, a node global layerAssignment is ignored (curated)', () => {
    const map = resolve({
      nodes: [node('persisted', 'x'), node('hasGlobalProp', 'obj', 'objects')],
      sortedLayers: twoLayers(),
      assignments: persistedAssignments(),
      branchCreatedUrns: new Set(),
    })
    expect(map.get('persisted')).toBe('concepts')
    expect(map.has('hasGlobalProp')).toBe(false)
  })

  it('does not place a delta node whose layerAssignment names a non-existent layer (valid-layer guard)', () => {
    const map = resolve({
      nodes: [node('persisted', 'x'), node('created', 'obj', 'ghostLayer')],
      sortedLayers: twoLayers(),
      assignments: persistedAssignments(),
      branchCreatedUrns: new Set(['created']),
    })
    expect(map.has('created')).toBe(false)
  })

  it('closed-scope: a canonical assignment still wins over the delta layerAssignment', () => {
    // `created` is both in the delta (layerAssignment objects) AND assigned to concepts.
    const map = resolve({
      nodes: [node('created', 'obj', 'objects')],
      sortedLayers: twoLayers(),
      assignments: { created: assign('concepts') },
      branchCreatedUrns: new Set(['created']),
    })
    expect(map.get('created')).toBe('concepts')
  })

  it('open-scope (no canonical assignments) still honors a node layerAssignment regardless of delta', () => {
    const map = resolve({
      nodes: [node('n', 'obj', 'objects')],
      sortedLayers: twoLayers(), // no assignments → open-scope
      branchCreatedUrns: new Set(),
    })
    expect(map.get('n')).toBe('objects')
  })
})
