/**
 * buildTypeLayerMapFromContract — Build Mode's type → column map under the One Placement Contract
 * (placementContractEnabled). The flag-off buildTypeLayerMap is pinned by resolveRowLayer.test.ts.
 */
import { describe, expect, it } from 'vitest'

import { compilePlacementSpec } from '@/lib/placement/placement'

import { buildTypeLayerMapFromContract, resolveRowLayer } from '../resolveRowLayer'

const layer = (id: string, order: number, extra: Record<string, unknown> = {}) => ({ id, name: id, order, entityTypes: [], ...extra })
const spec = (layers: unknown[]) => compilePlacementSpec({ layout: { referenceLayout: { layers } } })

describe('buildTypeLayerMapFromContract', () => {
  it('a type claimed by two layers maps to the first, keyed lower-case', () => {
    const map = buildTypeLayerMapFromContract(spec([layer('later', 1, { entityTypes: ['Table'] }), layer('first', 0, { entityTypes: ['TABLE'] })]))
    expect([...map]).toEqual([['table', 'first']])
    expect(resolveRowLayer({ typeId: 'Table' }, { typeLayerMap: map })).toBe('first')
  })

  it('an authored rule\'s priority beats a layer\'s entityTypes', () => {
    const map = buildTypeLayerMapFromContract(spec([
      layer('a', 0, { entityTypes: ['dataset'] }),
      layer('b', 1, { rules: [{ id: 'r', entityTypes: ['dataset'], priority: 5 }] }),
    ]))
    expect(map.get('dataset')).toBe('b')
  })

  it('a rule that needs more than a type (a tag, a URN) claims no type on its own', () => {
    const map = buildTypeLayerMapFromContract(spec([
      layer('a', 0, { rules: [{ id: 'pii', entityTypes: ['dataset'], tags: ['pii'], priority: 5 }] }),
      layer('b', 1, { entityTypes: ['dataset'] }),
      layer('c', 2, { rules: [{ id: 'g', entityTypes: ['chart'], urnPattern: 'urn:x:*', priority: 1 }] }),
    ]))
    expect(map.get('dataset')).toBe('b')
    expect(map.has('chart')).toBe(false)
  })
})
