import { describe, it, expect } from 'vitest'
import type { ViewLayerConfig } from '@/types/schema'
import { appendLayer, renameLayer, removeLayer, reorderLayer, setLayerNodeSortMode, setViewDefaultSortMode, clearLayerOrderKeys } from './layerMutations'

const L = (id: string, name: string, order: number): ViewLayerConfig => ({
  id,
  name,
  entityTypes: [],
  order,
})

const base = (): ViewLayerConfig[] => [L('a', 'Alpha', 0), L('b', 'Beta', 1), L('c', 'Gamma', 2)]

describe('appendLayer', () => {
  it('adds the new layer at the end with order = current length', () => {
    const out = appendLayer(base(), L('d', 'Delta', 999))
    expect(out.map((l) => l.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(out[3].order).toBe(3) // normalized to length, ignoring the passed-in order
  })
  it('does not mutate the input array', () => {
    const input = base()
    appendLayer(input, L('d', 'Delta', 3))
    expect(input).toHaveLength(3)
  })
  it('appends onto an empty list at order 0', () => {
    expect(appendLayer([], L('a', 'Alpha', 5))[0].order).toBe(0)
  })
})

describe('renameLayer', () => {
  it('renames only the matching layer, preserving order and the others', () => {
    const out = renameLayer(base(), 'b', 'Beta renamed')
    expect(out.map((l) => l.name)).toEqual(['Alpha', 'Beta renamed', 'Gamma'])
    expect(out.map((l) => l.order)).toEqual([0, 1, 2])
  })
  it('is a no-op when the id is not found', () => {
    expect(renameLayer(base(), 'zzz', 'Nope').map((l) => l.name)).toEqual(['Alpha', 'Beta', 'Gamma'])
  })
})

describe('removeLayer', () => {
  it('removes the matching layer and re-normalizes order to 0..n-1', () => {
    const out = removeLayer(base(), 'b')
    expect(out.map((l) => l.id)).toEqual(['a', 'c'])
    expect(out.map((l) => l.order)).toEqual([0, 1]) // Gamma re-numbered 2 -> 1
  })
  it('is a no-op when the id is not found', () => {
    expect(removeLayer(base(), 'zzz').map((l) => l.id)).toEqual(['a', 'b', 'c'])
  })
  it('can empty the list', () => {
    expect(removeLayer([L('a', 'Alpha', 0)], 'a')).toEqual([])
  })
})

describe('reorderLayer', () => {
  it('drags a layer RIGHT: lands after the drop target', () => {
    // a,b,c,d — drag a onto c → b,c,a,d (a lands after c)
    const out = reorderLayer([L('a', 'A', 0), L('b', 'B', 1), L('c', 'C', 2), L('d', 'D', 3)], 'a', 'c')
    expect(out.map((l) => l.id)).toEqual(['b', 'c', 'a', 'd'])
    expect(out.map((l) => l.order)).toEqual([0, 1, 2, 3]) // re-normalized
  })
  it('drags a layer LEFT: lands before the drop target', () => {
    // a,b,c,d — drag d onto b → a,d,b,c (d lands before b)
    const out = reorderLayer([L('a', 'A', 0), L('b', 'B', 1), L('c', 'C', 2), L('d', 'D', 3)], 'd', 'b')
    expect(out.map((l) => l.id)).toEqual(['a', 'd', 'b', 'c'])
  })
  it('is a no-op when dragged onto itself', () => {
    expect(reorderLayer(base(), 'b', 'b').map((l) => l.id)).toEqual(['a', 'b', 'c'])
  })
  it('is a no-op when either id is missing', () => {
    expect(reorderLayer(base(), 'a', 'zzz').map((l) => l.id)).toEqual(['a', 'b', 'c'])
    expect(reorderLayer(base(), 'zzz', 'a').map((l) => l.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('setLayerNodeSortMode', () => {
  const layout = (
    layers: ViewLayerConfig[],
    assignments: Record<string, { layerId: string; inheritsChildren: boolean; orderKey?: string }> = {},
  ) => ({ layers, assignments })

  it('sets and clears the per-layer override', () => {
    const withDesc = setLayerNodeSortMode(layout(base()), 'b', 'alpha-desc')
    expect(withDesc.layers.find((l) => l.id === 'b')?.nodeSortMode).toBe('alpha-desc')
    const cleared = setLayerNodeSortMode(withDesc, 'b', null)
    expect(cleared.layers.find((l) => l.id === 'b')?.nodeSortMode).toBeUndefined()
  })

  it('is a no-op (same layout) for an unknown layer or an unchanged mode', () => {
    const input = layout(base())
    expect(setLayerNodeSortMode(input, 'zzz', 'alpha-desc')).toBe(input)
    expect(setLayerNodeSortMode(input, 'a', null)).toBe(input)
  })

  it('entering custom seeds orderKeys for the layer\'s unkeyed entries in seed order', () => {
    const input = layout(base(), {
      'urn:x': { layerId: 'a', inheritsChildren: true },
      'urn:y': { layerId: 'a', inheritsChildren: true },
      'urn:other': { layerId: 'b', inheritsChildren: true },
    })
    const out = setLayerNodeSortMode(input, 'a', 'custom', ['urn:y', 'urn:x'])
    const ky = out.assignments['urn:y'].orderKey
    const kx = out.assignments['urn:x'].orderKey
    expect(ky && kx && ky < kx).toBe(true) // seeded following the given visual order
    expect(out.assignments['urn:other'].orderKey).toBeUndefined() // other layers untouched
  })

  it('re-entering custom keeps existing keys and appends new entries after them', () => {
    const input = layout(
      [{ ...base()[0], nodeSortMode: 'custom' as const }, base()[1], base()[2]],
      {
        'urn:x': { layerId: 'a', inheritsChildren: true, orderKey: 'a1' },
        'urn:new': { layerId: 'a', inheritsChildren: true },
      },
    )
    const out = setLayerNodeSortMode(input, 'a', 'custom', ['urn:new', 'urn:x'])
    expect(out.assignments['urn:x'].orderKey).toBe('a1') // untouched
    const kNew = out.assignments['urn:new'].orderKey
    expect(kNew && kNew > 'a1').toBe(true) // appended after the largest existing key
  })

  it('leaving custom keeps orderKeys (inert in alpha modes, restored on re-entry)', () => {
    const input = layout(
      [{ ...base()[0], nodeSortMode: 'custom' as const }, base()[1], base()[2]],
      { 'urn:x': { layerId: 'a', inheritsChildren: true, orderKey: 'a1' } },
    )
    const out = setLayerNodeSortMode(input, 'a', 'alpha-asc')
    expect(out.assignments['urn:x'].orderKey).toBe('a1')
  })
})

describe('setViewDefaultSortMode', () => {
  it('sets the default and clears asc/desc overrides but keeps custom layers', () => {
    const layers: ViewLayerConfig[] = [
      { ...L('a', 'Alpha', 0), nodeSortMode: 'alpha-asc' },
      { ...L('b', 'Beta', 1), nodeSortMode: 'custom' },
      L('c', 'Gamma', 2),
    ]
    const out = setViewDefaultSortMode({ layers, assignments: {} }, 'alpha-desc')
    expect(out.defaultNodeSortMode).toBe('alpha-desc')
    expect(out.layers.find((l) => l.id === 'a')?.nodeSortMode).toBeUndefined()
    expect(out.layers.find((l) => l.id === 'b')?.nodeSortMode).toBe('custom')
    expect(out.layers.find((l) => l.id === 'c')?.nodeSortMode).toBeUndefined()
  })
})

describe('clearLayerOrderKeys', () => {
  const entry = (layerId: string, orderKey?: string) => ({
    layerId,
    inheritsChildren: true,
    ...(orderKey ? { orderKey } : {}),
  })

  it('drops the layer\'s orderKeys and mode override, leaving other layers alone', () => {
    const out = clearLayerOrderKeys({
      layers: [{ ...L('a', 'Alpha', 0), nodeSortMode: 'custom' }, L('b', 'Beta', 1)],
      assignments: {
        'urn:x': entry('a', 'a1'),
        'urn:y': entry('a'),
        'urn:z': entry('b', 'a9'),
      },
    }, 'a')
    expect(out.layers.find(l => l.id === 'a')?.nodeSortMode).toBeUndefined()
    expect(out.assignments['urn:x'].orderKey).toBeUndefined()
    expect(out.assignments['urn:y']).toEqual(entry('a'))
    expect(out.assignments['urn:z'].orderKey).toBe('a9') // other layer untouched
  })

  it('is a no-op (same layout) when there is nothing to reset', () => {
    const input = { layers: base(), assignments: { 'urn:x': entry('b') } }
    expect(clearLayerOrderKeys(input, 'a')).toBe(input)
  })

  it('preserves defaultNodeSortMode', () => {
    const out = clearLayerOrderKeys({
      layers: [{ ...L('a', 'Alpha', 0), nodeSortMode: 'custom' }],
      assignments: {},
      defaultNodeSortMode: 'type-asc',
    }, 'a')
    expect(out.defaultNodeSortMode).toBe('type-asc')
  })
})

describe('setViewDefaultSortMode — widened modes', () => {
  it('accepts the property-derived modes as view defaults', () => {
    const out = setViewDefaultSortMode({ layers: base(), assignments: {} }, 'count-desc')
    expect(out.defaultNodeSortMode).toBe('count-desc')
  })
})
