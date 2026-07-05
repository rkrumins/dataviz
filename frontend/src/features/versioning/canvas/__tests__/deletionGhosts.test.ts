import { describe, it, expect } from 'vitest'
import { synthesizeGhostNode, synthesizeGhostEdge, reconcileGhosts, isGhostNode, isGhostEdge } from '../deletionGhosts'
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

  it('adds ghosts for removed entities not on the canvas; not for live/optimistic-delete ones', () => {
    const cs = buildChangeSet([
      removedNode('urn:gone', { displayName: 'Gone', entityType: 'T' }),
      removedNode('urn:optimistic', { displayName: 'O', entityType: 'T' }),
    ])
    const optimistic = { ...liveNode('urn:optimistic'), data: { urn: 'urn:optimistic', isPending: 'delete' } }
    const { nodesToAdd, nodesToRemove } = reconcileGhosts(cs, [optimistic], [], false, CONTAINS)
    expect(nodesToAdd.map((n) => n.id)).toEqual(['urn:gone'])
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
