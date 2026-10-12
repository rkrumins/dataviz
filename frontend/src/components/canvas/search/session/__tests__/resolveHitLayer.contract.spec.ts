/**
 * placeHit — a search hit's column under the One Placement Contract (placementContractEnabled):
 * the hit's ancestorPath is its parent chain, so the NEAREST entry wins, and the view's own scope
 * decides. The flag-off resolveHitLayer is pinned, unedited, by resolveHitLayer.spec.ts.
 */
import { describe, expect, it } from 'vitest'

import { compilePlacementSpec } from '@/lib/placement/placement'
import type { GraphNode } from '@/providers/GraphDataProvider'
import type { AncestorRef } from '@/types/search'

import { placeHit } from '../resolveHitLayer'

const ancestor = (urn: string, entityType = 'domain'): AncestorRef => ({ urn, entityType, displayName: urn }) as AncestorRef
const hit = (urn: string, entityType = 'dataset', extra: Partial<GraphNode> = {}): GraphNode =>
  ({ urn, entityType, displayName: urn, properties: {}, ...extra })
const layer = (id: string, order: number, extra: Record<string, unknown> = {}) => ({ id, name: id, order, entityTypes: [], ...extra })

const spec = (layers: unknown[], assignments: Record<string, unknown> = {}, scope?: 'all' | 'curated') =>
  compilePlacementSpec({ content: scope ? { entityScope: scope } : {}, layout: { referenceLayout: { layers, assignments } } })

describe('placeHit', () => {
  const layers = [layer('L1', 0), layer('L2', 1)]

  it('the nearest entry wins: the hit\'s own, then its closest ancestor\'s', () => {
    const s = spec(layers, { root: { layerId: 'L1' }, mid: { layerId: 'L2' } })
    const path = [ancestor('root'), ancestor('mid')]
    expect(placeHit(hit('h'), path, s)).toBe('L2')
    expect(placeHit(hit('h'), [ancestor('root')], s)).toBe('L1')
    expect(placeHit(hit('mid'), [ancestor('root')], s)).toBe('L2')
  })

  it('an ancestor\'s inheritsChildren:false stops the cascade — a curated view then has no column for the hit', () => {
    const s = spec(layers, { root: { layerId: 'L1', inheritsChildren: false } })
    expect(placeHit(hit('h'), [ancestor('root')], s)).toBeNull()
  })

  it('a view declared open places by rule even when it has entries', () => {
    const s = spec([layer('L1', 0), layer('L2', 1, { entityTypes: ['dataset'] })], { other: { layerId: 'L1' } }, 'all')
    expect(placeHit(hit('h'), [ancestor('root')], s)).toBe('L2')
  })

  it('a view declared curated with no entries places nothing', () => {
    const s = spec([layer('L1', 0, { entityTypes: ['dataset'] })], {}, 'curated')
    expect(placeHit(hit('h'), [], s)).toBeNull()
  })

  it('the first layer wins a type claimed twice, whatever its case', () => {
    const s = spec([layer('late', 1, { entityTypes: ['dataset'] }), layer('first', 0, { entityTypes: ['DataSet'] })])
    expect(placeHit(hit('h'), [], s)).toBe('first')
  })

  it('never returns a layer the view no longer has', () => {
    const s = spec(layers, { h: { layerId: 'deleted' } }, 'curated')
    expect(placeHit(hit('h'), [], s)).toBeNull()
    expect(placeHit(hit('h', 'dataset', { layerAssignment: 'deleted' }), [], spec(layers, {}, 'all'))).toBeNull()
  })

  it('reads the hit\'s own tags and properties; an ancestor is matched on its type alone', () => {
    const s = spec([
      layer('L1', 0, { rules: [{ id: 'pii', tags: ['pii'], priority: 1 }] }),
      layer('L2', 1, { entityTypes: ['domain'] }),
    ])
    expect(placeHit(hit('h', 'dataset', { tags: ['pii'] }), [], s)).toBe('L1')
    expect(placeHit(hit('h'), [ancestor('root', 'domain')], s)).toBe('L2')      // inherits its rule-placed parent
  })
})
