import { describe, it, expect } from 'vitest'
import { synthesizeGhostNode, synthesizeGhostEdge, reconcileGhosts, buildRestoreChange, buildRestoreSubtree, buildRestoreLinks, indexRemovals, pickGhosts, deletedChain, restoreNeeds, isGhostNode, isGhostEdge } from '../deletionGhosts'
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

describe('deletionGhosts — entity ids that are not urns', () => {
  // An imported entity's id (`ent_X`) is not the urn the canvas names it by (`urn:X`), and an edge's
  // `before` names its ends by entity id. The ghosts, and their restore, use the canvas's names.
  const cs = () => buildChangeSet([
    { ...removedNode('ent_X', { displayName: 'X', entityType: 'Column' }), urn: 'urn:X' },
    { ...removedEdge('edge_1', { sourceEntityId: 'ent_P', targetEntityId: 'ent_X', edgeType: 'CONTAINS' }),
      sourceUrn: 'urn:P', targetUrn: 'urn:X' },
  ])

  it('ghosts the node under its urn and nests it under its live parent, by urn', () => {
    const optimistic = { ...liveNode('urn:X'), data: { urn: 'urn:X', isPending: 'delete' } }
    const { nodesToAdd, nodesToRemove, edgesToAdd } = reconcileGhosts(cs(), [liveNode('urn:P'), optimistic], [], false, CONTAINS)
    expect(nodesToAdd.map((n) => [n.id, n.data.urn])).toEqual([['urn:X', 'urn:X']])
    expect(nodesToRemove).toEqual(['urn:X'])    // the optimistic delete becomes the ghost
    expect(edgesToAdd.map((e) => [e.id, e.source, e.target])).toEqual([['edge_1', 'urn:P', 'urn:X']])
  })

  it('keeps a ghost already drawn under its urn, rather than ghosting it again', () => {
    const ghost = synthesizeGhostNode(cs().changes[0])
    const { nodesToAdd, nodesToRemove } = reconcileGhosts(cs(), [liveNode('urn:P'), ghost], [], false, CONTAINS)
    expect(nodesToAdd).toEqual([])
    expect(nodesToRemove).toEqual([])
  })

  it('restores it by urn, re-nested under its parent by urn', () => {
    const [r] = buildRestoreSubtree('urn:X', cs(), new Set(['urn:P']), CONTAINS)
    expect(r).toMatchObject({ targetId: 'urn:X', targetUrn: 'urn:X' })
    expect(r.after).toMatchObject({ urn: 'urn:X', parentUrn: 'urn:P', containmentEdgeType: 'CONTAINS' })
  })
})

describe('deletionGhosts — restoring a large deleted subtree', () => {
  it('restores 20,000 deleted children parent-first, in time linear in the change set', () => {
    // Each restored node used to scan every change, twice, and each parent's child list was copied
    // on every append: 20,000 children were billions of steps.
    const n = 20_000
    const changes: GraphChange[] = [removedNode('urn:root', { displayName: 'Root', entityType: 'Schema' })]
    for (let i = 0; i < n; i++) {
      changes.push(removedNode(`urn:c${i}`, { displayName: `c${i}`, entityType: 'Table' }))
      changes.push(removedEdge(`e${i}`, { edgeType: 'CONTAINS', sourceEntityId: 'urn:root', targetEntityId: `urn:c${i}` }))
    }
    const started = performance.now()
    const restore = buildRestoreSubtree('urn:root', buildChangeSet(changes), new Set(['urn:db']), CONTAINS)
    expect(performance.now() - started).toBeLessThan(2000)
    expect(restore).toHaveLength(n + 1)
    expect(restore[0].targetUrn).toBe('urn:root')
    expect(restore[1].after).toMatchObject({ parentUrn: 'urn:root', containmentEdgeType: 'CONTAINS' })
  })
})


describe('deletionGhosts — which deletions a canvas draws', () => {
  const contains = (id: string, parent: string, child: string) =>
    removedEdge(id, { sourceEntityId: parent, targetEntityId: child, edgeType: 'CONTAINS' })
  const changes = [
    removedNode('urn:root-gone', { displayName: 'Root gone', entityType: 'T' }),                  // had no parent
    removedNode('urn:t1', { displayName: 'T1', entityType: 'T' }), contains('k1', 'urn:db', 'urn:t1'),
    removedNode('urn:c1', { displayName: 'C1', entityType: 'T' }), contains('k2', 'urn:t1', 'urn:c1'),
    removedNode('urn:far', { displayName: 'Far', entityType: 'T' }), contains('k3', 'urn:not-loaded', 'urn:far'),
  ]
  const removals = indexRemovals(changes, CONTAINS)

  it('draws those under a parent on the canvas, and those that had none — parent first', () => {
    expect(pickGhosts(removals, new Set(['urn:db']))).toEqual(['urn:root-gone', 'urn:t1', 'urn:c1'])
  })

  it('leaves out one whose parent is not loaded: at its layer top it would read as elsewhere', () => {
    expect(pickGhosts(removals, new Set(['urn:db']))).not.toContain('urn:far')
    expect(pickGhosts(removals, new Set(['urn:db', 'urn:not-loaded']))).toContain('urn:far')
  })

  it('draws at most the cap, breadth first', () => {
    expect(pickGhosts(removals, new Set(['urn:db']), 2)).toEqual(['urn:root-gone', 'urn:t1'])
    const many = Array.from({ length: 900 }, (_, i) => removedNode(`urn:n${i}`, { displayName: `n${i}`, entityType: 'T' }))
    const cs = buildChangeSet(many)
    expect(reconcileGhosts(cs, [], [], false, CONTAINS).nodesToAdd).toHaveLength(500)
  })

  it("never re-adds a moved child's old parent link: it would have two parents", () => {
    // urn:moved is live (moved to another parent); its link to its old parent was removed.
    const cs = buildChangeSet([contains('k-old', 'urn:old-parent', 'urn:moved')])
    const { edgesToAdd } = reconcileGhosts(cs, [liveNode('urn:old-parent'), liveNode('urn:moved')], [], false, CONTAINS)
    expect(edgesToAdd).toEqual([])
  })

  it('brings a deleted child in once its parent is loaded', () => {
    const cs = buildChangeSet(changes)
    expect(reconcileGhosts(cs, [], [], false, CONTAINS).nodesToAdd.map((n) => n.id)).toEqual(['urn:root-gone'])
    expect(reconcileGhosts(cs, [liveNode('urn:db')], [], false, CONTAINS).nodesToAdd.map((n) => n.id))
      .toEqual(['urn:root-gone', 'urn:t1', 'urn:c1'])
  })
})

describe('deletionGhosts — deletions someone asked to see, past the cap', () => {
  const contains = (id: string, parent: string, child: string) =>
    removedEdge(id, { sourceEntityId: parent, targetEntityId: child, edgeType: 'CONTAINS' })
  const t = (urn: string) => removedNode(urn, { displayName: urn.slice(4), entityType: 'T' })
  // urn:db is live. Deleted under it: t1 (holding c1 and c2), t2 and t3. urn:far sat under a parent
  // the canvas hasn't loaded, and urn:root-gone had no parent.
  const changes = [
    t('urn:t1'), contains('k1', 'urn:db', 'urn:t1'),
    t('urn:c1'), contains('k2', 'urn:t1', 'urn:c1'),
    t('urn:c2'), contains('k3', 'urn:t1', 'urn:c2'),
    t('urn:t2'), contains('k4', 'urn:db', 'urn:t2'),
    t('urn:t3'), contains('k5', 'urn:db', 'urn:t3'),
    t('urn:far'), contains('k6', 'urn:not-loaded', 'urn:far'),
    t('urn:root-gone'),
  ]
  const removals = indexRemovals(changes, CONTAINS)
  const db = new Set(['urn:db'])

  it('walks a deletion up through the deletions above it, to what it hung from', () => {
    expect(deletedChain(removals, 'urn:c2')).toEqual({ chain: ['urn:t1', 'urn:c2'], anchor: 'urn:db' })
    expect(deletedChain(removals, 'urn:root-gone')).toEqual({ chain: ['urn:root-gone'], anchor: undefined })
    expect(deletedChain(removals, 'urn:db').chain).toEqual([])                  // not a deletion
  })

  it('draws a pinned deletion with the deletions above it, outside the cap', () => {
    expect(pickGhosts(removals, db, 1)).toEqual(['urn:t1'])
    // c2 and the t1 it sat in, then the walk's one: the cap is for the walk alone.
    expect(pickGhosts(removals, db, 1, ['urn:c2'])).toEqual(['urn:t1', 'urn:c2', 'urn:t2'])
  })

  it('leaves out a pin whose chain hangs from something the canvas has not loaded', () => {
    expect(pickGhosts(removals, db, 0, ['urn:far'])).toEqual([])
    expect(pickGhosts(removals, new Set(['urn:db', 'urn:not-loaded']), 0, ['urn:far'])).toEqual(['urn:far'])
  })

  it('draws a pin that had no parent at the top, and ignores one that is no deletion here', () => {
    expect(pickGhosts(removals, new Set(), 0, ['urn:root-gone', 'urn:elsewhere'])).toEqual(['urn:root-gone'])
  })

  it('still walks what a pinned entity held, within the cap', () => {
    expect(pickGhosts(removals, db, 4, ['urn:t1'])).toEqual(['urn:t1', 'urn:t2', 'urn:t3', 'urn:root-gone', 'urn:c1'])
  })

  it('says, for each parent on the canvas, how many deletions under it are not drawn', () => {
    const cs = buildChangeSet(changes)
    const drawnByCap = reconcileGhosts(cs, [liveNode('urn:db')], [], false, CONTAINS, 2)
    expect(drawnByCap.nodesToAdd.map((n) => n.id)).toEqual(['urn:t1', 'urn:t2'])
    // t3 under db, and both of the drawn t1's columns. Not urn:far: its parent isn't on the canvas.
    expect(Object.fromEntries(drawnByCap.hiddenByParent)).toEqual({ 'urn:db': 1, 'urn:t1': 2 })

    const asked = reconcileGhosts(cs, [liveNode('urn:db')], [], false, CONTAINS, 2, undefined, ['urn:c2'])
    expect(asked.nodesToAdd.map((n) => n.id)).toEqual(['urn:t1', 'urn:c2', 'urn:t2', 'urn:t3'])
    expect(Object.fromEntries(asked.hiddenByParent)).toEqual({ 'urn:t1': 1 })
    expect([asked.drawn, asked.total]).toEqual([4, 7])
  })
})

describe('deletionGhosts — a restore brings links back under their ids', () => {
  const flow = (id: string, s: string, t: string) =>
    removedEdge(id, { sourceEntityId: s, targetEntityId: t, edgeType: 'FLOWS_TO', properties: { job: 'nightly' } })
  const changes = [
    removedNode('urn:t1', { displayName: 'T1', entityType: 'T' }),
    removedEdge('k1', { sourceEntityId: 'urn:db', targetEntityId: 'urn:t1', edgeType: 'CONTAINS' }),
    removedNode('urn:t2', { displayName: 'T2', entityType: 'T' }),
    flow('f-live', 'urn:t1', 'urn:report'),       // the other end is live
    flow('f-gone', 'urn:t1', 'urn:t2'),           // the other end is deleted, and not restored
    removedEdge('k-other', { sourceEntityId: 'urn:t1', targetEntityId: 'urn:x', edgeType: 'CONTAINS' }),
  ]
  const cs = buildChangeSet(changes)

  it("nests the entity under its parent by the parent link's own id", () => {
    expect(buildRestoreChange('urn:t1', cs, new Set(['urn:db']), CONTAINS)?.after).toMatchObject({
      parentUrn: 'urn:db', containmentEdgeType: 'CONTAINS', containmentEdgeId: 'k1',
    })
  })

  it('restores the links whose other end will be there, and no parent link', () => {
    const restored = buildRestoreSubtree('urn:t1', cs, new Set(['urn:db']), CONTAINS)
    const links = buildRestoreLinks(restored, changes, (u) => u !== 'urn:t2', CONTAINS)
    expect(links).toEqual([expect.objectContaining({
      type: 'create_edge', targetId: 'f-live',
      after: expect.objectContaining({ restoreOf: 'f-live', edgeType: 'FLOWS_TO', properties: { job: 'nightly' },
        source: 'urn:t1', target: 'urn:report' }),
      summary: "Restore link FLOWS_TO: 'T1' → 'urn:report'",
    })])
  })

  it('restores a link between two entities restored together', () => {
    const both = [...buildRestoreSubtree('urn:t1', cs, new Set(['urn:db']), CONTAINS),
      ...buildRestoreSubtree('urn:t2', cs, new Set(), CONTAINS)]
    const ids = buildRestoreLinks(both, changes, () => false, CONTAINS).map((l) => l.targetId)
    expect(ids).toEqual(['f-gone'])
  })
})

describe('deletionGhosts — a compact change list, without payloads', () => {
  // As /diff/index answers: a removed node with no `before`, its parent link with type and ends only.
  const bare = (urn: string): GraphChange => ({ entityId: urn, urn, kind: 'node', status: 'removed', label: urn, origin: { source: 'compare', fromSeq: 1, toSeq: 9 } })
  const link = (id: string, s: string, t: string, edgeType: string): GraphChange => ({
    entityId: id, kind: 'edge', status: 'removed', label: edgeType, origin: { source: 'compare', fromSeq: 1, toSeq: 9 },
    before: { edgeType, sourceEntityId: s, targetEntityId: t },
  })
  const changes = [bare('urn:t1'), link('k1', 'urn:db', 'urn:t1', 'CONTAINS'), bare('urn:c1'), link('k2', 'urn:t1', 'urn:c1', 'CONTAINS'),
    link('f1', 'urn:c1', 'urn:report', 'FLOWS_TO')]

  it('says which deletions to fetch before drawing them, and draws them once fetched', () => {
    const cs = buildChangeSet(changes)
    const first = reconcileGhosts(cs, [liveNode('urn:db')], [], false, CONTAINS)
    expect(first.missing).toEqual(['urn:t1', 'urn:c1'])
    expect(first.nodesToAdd).toEqual([])
    expect([first.drawn, first.total]).toEqual([0, 2])
    const befores = new Map([['urn:t1', { displayName: 'T1', entityType: 'T' }], ['urn:c1', { displayName: 'C1', entityType: 'T' }]])
    const then = reconcileGhosts(cs, [liveNode('urn:db')], [], false, CONTAINS, undefined, befores)
    expect(then.missing).toEqual([])
    expect(then.nodesToAdd.map((n) => n.id)).toEqual(['urn:t1', 'urn:c1'])
    expect([then.drawn, then.total]).toEqual([2, 2])
  })

  it('knows what a restore must fetch, and refuses past its caps', () => {
    const removals = indexRemovals(changes, CONTAINS)
    expect(restoreNeeds(removals, changes, 'urn:t1', CONTAINS, 10, 10)).toEqual({ nodeIds: ['urn:t1', 'urn:c1'], linkIds: ['f1'] })
    expect(restoreNeeds(removals, changes, 'urn:t1', CONTAINS, 1, 10)).toBeNull()
    expect(restoreNeeds(removals, changes, 'urn:t1', CONTAINS, 10, 0)).toBeNull()
  })
})
