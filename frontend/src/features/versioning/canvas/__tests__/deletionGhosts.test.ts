import { describe, it, expect } from 'vitest'
import { synthesizeGhostNode, synthesizeGhostEdge, reconcileGhosts, buildRestoreChange, buildRestoreSubtree, isGhostNode, isGhostEdge } from '../deletionGhosts'
import { buildChangeSet, type GraphChange } from '../../model/changeModel'

const removedNode = (urn: string, before: Record<string, unknown>): GraphChange => ({
  entityId: urn, kind: 'node', status: 'removed', label: (before.displayName as string) ?? urn,
  before, origin: { source: 'branch', branchId: 'b' },
})
const removedEdge = (id: string, before: Record<string, unknown>): GraphChange => ({
  entityId: id, kind: 'edge', status: 'removed', label: id, before, origin: { source: 'branch', branchId: 'b' },
})

const liveNode = (id: string) => ({ id, type: 'generic', position: { x: 0, y: 0 }, data: { urn: id } }) as any
const CONTAINS = (t?: string) => (t ?? '').toUpperCase() === 'CONTAINS'

describe('deletionGhosts — nodes', () => {
  it('synthesizes a read-only ghost node from a removed change (id=urn, isGhost, original layer)', () => {
    const g = synthesizeGhostNode(removedNode('urn:x', {
      displayName: 'X', entityType: 'Table', layerAssignment: 'warehouse', tags: ['pii'], childCount: 2,
    }))
    expect(g.id).toBe('urn:x')
    expect(g.data.layerAssignment).toBe('warehouse')
    expect(isGhostNode(g)).toBe(true)
    expect(g.data.isPending).toBeUndefined()
  })

  it('ghosts off-canvas deletions AND converts a just-saved optimistic-delete node to a ghost (no refresh)', () => {
    const cs = buildChangeSet([
      removedNode('urn:gone', { displayName: 'Gone', entityType: 'T' }),
      removedNode('urn:optimistic', { displayName: 'O', entityType: 'T' }),
    ])
    // urn:optimistic is the node the canvas keeps after delete+save (isPending:'delete') — now committed.
    const optimistic = { ...liveNode('urn:optimistic'), data: { urn: 'urn:optimistic', isPending: 'delete' } }
    const { nodesToAdd, nodesToRemove } = reconcileGhosts(cs, [optimistic], [], false, CONTAINS)
    expect(nodesToAdd.map((n) => n.id).sort()).toEqual(['urn:gone', 'urn:optimistic'])  // both become ghosts
    expect(nodesToRemove).toEqual(['urn:optimistic'])   // its optimistic node is swapped out for the ghost
  })

  it('leaves a STAGED (uncommitted) delete as its optimistic node — only COMMITTED deletions ghost', () => {
    const staged = { ...liveNode('urn:staged'), data: { urn: 'urn:staged', isPending: 'delete' } }
    const { nodesToAdd, nodesToRemove } = reconcileGhosts(buildChangeSet([]), [staged], [], false, CONTAINS)
    expect(nodesToAdd).toEqual([])
    expect(nodesToRemove).toEqual([])
  })

  it('removes ghosts no longer removed (merged/restored) + all when the committed diff is hidden', () => {
    const stale = synthesizeGhostNode(removedNode('urn:stale', { displayName: 'S', entityType: 'T' }))
    expect(reconcileGhosts(buildChangeSet([]), [stale, liveNode('urn:live')], [], false, CONTAINS).nodesToRemove)
      .toEqual(['urn:stale'])
    const cs = buildChangeSet([removedNode('urn:g', { displayName: 'G', entityType: 'T' })])
    const g = synthesizeGhostNode(removedNode('urn:g', { displayName: 'G', entityType: 'T' }))
    expect(reconcileGhosts(cs, [g], [], true, CONTAINS).nodesToRemove).toEqual(['urn:g'])
  })
})

describe('deletionGhosts — edges (containment nesting)', () => {
  it('synthesizes a containment ghost edge from a removed edge; type from the ontology predicate', () => {
    const e = synthesizeGhostEdge(removedEdge('e1', {
      sourceEntityId: 'urn:parent', targetEntityId: 'urn:child', edgeType: 'CONTAINS',
    }), CONTAINS)!
    expect(e.id).toBe('e1')
    expect(e.source).toBe('urn:parent')
    expect(e.target).toBe('urn:child')
    expect(e.type).toBe('containment')       // so useContainmentHierarchy nests the child
    expect(e.data.edgeType).toBe('CONTAINS')
    expect(isGhostEdge(e)).toBe(true)
  })

  it('nests a deleted child under its LIVE parent by re-adding the removed containment edge', () => {
    // parent still live; the child + its containment edge were deleted (a nested deletion).
    const cs = buildChangeSet([
      removedNode('urn:child', { displayName: 'C', entityType: 'Column', layerAssignment: 'L' }),
      removedEdge('contains-p-c', { sourceEntityId: 'urn:parent', targetEntityId: 'urn:child', edgeType: 'CONTAINS' }),
    ])
    const { nodesToAdd, edgesToAdd } = reconcileGhosts(cs, [liveNode('urn:parent')], [], false, CONTAINS)
    expect(nodesToAdd.map((n) => n.id)).toEqual(['urn:child'])
    expect(edgesToAdd.map((e) => e.id)).toEqual(['contains-p-c'])   // edge re-added → child nests under live parent
    expect(edgesToAdd[0].source).toBe('urn:parent')
    expect(edgesToAdd[0].target).toBe('urn:child')
  })

  it('does NOT re-add an edge whose endpoint is neither live nor a ghost (would dangle)', () => {
    const cs = buildChangeSet([
      removedEdge('e', { sourceEntityId: 'urn:offscreen', targetEntityId: 'urn:alsoGone', edgeType: 'CONTAINS' }),
    ])
    expect(reconcileGhosts(cs, [], [], false, CONTAINS).edgesToAdd).toEqual([])
  })

  it('marks lineage (non-containment) removed edges as type lineage, and removes stale ghost edges', () => {
    const line = synthesizeGhostEdge(removedEdge('lin', {
      sourceEntityId: 'urn:a', targetEntityId: 'urn:b', edgeType: 'FLOWS_TO',
    }), CONTAINS)!
    expect(line.type).toBe('lineage')
    // stale ghost edge no longer in the removed set → removed
    const { edgesToRemove } = reconcileGhosts(buildChangeSet([]), [], [line], false, CONTAINS)
    expect(edgesToRemove).toEqual(['lin'])
  })
})

describe('deletionGhosts — restore', () => {
  const cs = () => buildChangeSet([
    removedNode('urn:child', { displayName: 'C', entityType: 'Column', layerAssignment: 'L', tags: ['t'] }),
    removedEdge('e', { sourceEntityId: 'urn:parent', targetEntityId: 'urn:child', edgeType: 'CONTAINS' }),
  ])

  it('resurrects by original urn and re-nests under a LIVE parent', () => {
    const r = buildRestoreChange('urn:child', cs(), new Set(['urn:parent']), CONTAINS)!
    expect(r.type).toBe('create_entity')
    expect(r.targetUrn).toBe('urn:child')
    expect(r.after.urn).toBe('urn:child')          // → create-over-tombstone resurrect
    expect(r.after.entityType).toBe('Column')
    expect(r.after.layerAssignment).toBe('L')      // full snapshot preserved — no data loss
    expect(r.after.tags).toEqual(['t'])
    expect(r.after.parentUrn).toBe('urn:parent')   // re-nests
    expect(r.after.containmentEdgeType).toBe('CONTAINS')
  })

  it('restores at the root when the parent is still deleted (not live) — restore the parent first', () => {
    const r = buildRestoreChange('urn:child', cs(), new Set(), CONTAINS)!  // parent NOT live
    expect(r.after.urn).toBe('urn:child')
    expect(r.after.parentUrn).toBeUndefined()
    expect(r.after.containmentEdgeType).toBeUndefined()
  })

  it('returns null when the urn is not a committed deletion', () => {
    expect(buildRestoreChange('urn:notdeleted', cs(), new Set(), CONTAINS)).toBeNull()
  })

  it('restores a whole deleted subtree parent-first, nesting descendants under their restored parents', () => {
    const cs2 = buildChangeSet([
      removedNode('urn:p', { displayName: 'P', entityType: 'Table' }),
      removedNode('urn:c1', { displayName: 'C1', entityType: 'Column' }),
      removedNode('urn:c2', { displayName: 'C2', entityType: 'Column' }),
      removedEdge('e-root', { sourceEntityId: 'urn:live', targetEntityId: 'urn:p', edgeType: 'CONTAINS' }),
      removedEdge('e1', { sourceEntityId: 'urn:p', targetEntityId: 'urn:c1', edgeType: 'CONTAINS' }),
      removedEdge('e2', { sourceEntityId: 'urn:p', targetEntityId: 'urn:c2', edgeType: 'CONTAINS' }),
    ])
    const subtree = buildRestoreSubtree('urn:p', cs2, new Set(['urn:live']), CONTAINS)
    expect(subtree.map((r) => r.targetUrn)).toEqual(['urn:p', 'urn:c1', 'urn:c2'])  // parent-first
    expect(subtree[0].after.parentUrn).toBe('urn:live')  // root re-nests under its live parent
    expect(subtree[1].after.parentUrn).toBe('urn:p')     // child re-nests under its (restored) parent
    expect(subtree[2].after.parentUrn).toBe('urn:p')
  })
})
