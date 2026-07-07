import { describe, it, expect } from 'vitest'
import type { ViewLayerConfig } from '@/types/schema'
import { appendLayer, renameLayer, removeLayer, reorderLayer } from './layerMutations'

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
