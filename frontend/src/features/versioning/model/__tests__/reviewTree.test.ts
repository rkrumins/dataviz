/**
 * Review & Save top-down: each staged change under its container — where a change puts it (a create,
 * a move), else where the canvas has it (its parent, or the containers its feed named), a
 * relationship under its source — counted up every container above it; what the canvas has not
 * loaded under "Elsewhere in the graph", the view's layout under its own heading.
 */
import { describe, expect, it } from 'vitest'
import type { StagedChange } from '@/store/stagedChangesStore'
import { buildReviewGroups } from '../reviewModel'
import { buildReviewTree, ELSEWHERE, LAYOUT, pathOf, TOP, type Placement } from '../reviewTree'

const change = (id: string, type: StagedChange['type'], targetUrn: string, after: Record<string, unknown> = {}, before?: Record<string, unknown>): StagedChange =>
  ({ id, type, targetId: targetUrn, targetUrn, timestamp: 0, summary: id, after, before } as StagedChange)

// The canvas: warehouse › sales › orders, and refunds on its feed's path only.
const CANVAS: Record<string, { parent: string | null; name: string }> = {
  'urn:db': { parent: null, name: 'warehouse' },
  'urn:sales': { parent: 'urn:db', name: 'sales' },
  'urn:orders': { parent: 'urn:sales', name: 'orders' },
  'urn:amount': { parent: 'urn:orders', name: 'amount' },
}
const place: Placement = {
  parentOf: (id) => (id in CANVAS ? CANVAS[id].parent : undefined),
  keyOf: (id) => id,
  nameOf: (id) => CANVAS[id]?.name ?? id,
  typeOf: () => undefined,
}
const lookup = { nameOf: (id: string) => CANVAS[id]?.name ?? id }

describe('buildReviewTree', () => {
  const groups = buildReviewGroups([
    change('c1', 'update_entity', 'urn:amount', { displayName: 'amount' }),
    change('c2', 'create_entity', 'urn:new', { displayName: 'refunds', parentUrn: 'urn:sales' }),
    change('c3', 'delete_entity', 'urn:orders'),
    change('c4', 'update_entity', 'urn:far', { displayName: 'far away' }),
    change('c5', 'create_edge', 'e1', { source: 'urn:orders', target: 'urn:new', edgeType: 'FEEDS' }),
    change('c6', 'layer_config', 'view', {}),
  ], lookup)
  const tree = buildReviewTree(groups, place)

  it('places each change under its container, top-down', () => {
    expect(tree.children.get(TOP)).toEqual(['urn:db', ELSEWHERE, LAYOUT])
    expect(tree.children.get('urn:db')).toEqual(['urn:sales'])
    // Most changed first: orders holds the column and the relationship.
    expect(tree.children.get('urn:sales')).toEqual(['urn:orders', 'urn:new'])
    expect(tree.children.get('urn:orders')).toEqual(['urn:amount', 'edge:e1'])
    expect(tree.children.get(ELSEWHERE)).toEqual(['urn:far'])
    expect(tree.children.get(LAYOUT)).toHaveLength(1)
  })

  it('counts every change in each container above it', () => {
    expect(tree.rollup.get('urn:db')).toEqual([2, 1, 1])
    expect(tree.rollup.get('urn:orders')).toEqual([1, 1, 0])
    expect(tree.rollup.get(ELSEWHERE)).toEqual([0, 1, 0])
  })

  it('names containers as the canvas does, and finds the way down to any change', () => {
    expect(pathOf(tree, 'urn:amount').map(tree.nameOf)).toEqual(['warehouse', 'sales', 'orders'])
    expect(tree.nameOf(ELSEWHERE)).toBe('Elsewhere in the graph')
    expect(tree.rank.get('urn:new')).toBe(1)
  })

  it('a move puts its entity where it goes; a cycle in bad data still ends', () => {
    const moved = buildReviewTree(buildReviewGroups([
      change('m1', 'move_entity', 'urn:amount', { childId: 'urn:amount', parentId: 'urn:db' }),
    ], lookup), place)
    expect(pathOf(moved, 'urn:amount')).toEqual(['urn:db'])
    const loop: Placement = { ...place, parentOf: (id) => (id === 'urn:a' ? 'urn:b' : id === 'urn:b' ? 'urn:a' : undefined) }
    const looped = buildReviewTree(buildReviewGroups([change('x', 'update_entity', 'urn:a', { displayName: 'a' })], lookup), loop)
    expect(pathOf(looped, 'urn:a').length).toBeLessThanOrEqual(64)
  })
})
