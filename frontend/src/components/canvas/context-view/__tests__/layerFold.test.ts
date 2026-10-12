import { describe, expect, it } from 'vitest'

import {
  computeLayerFold,
  SPINE_MAX_WIDTH_PX,
  SPINE_MIN_WIDTH_PX,
  type LayerFoldInput,
} from '../layerFold'

const layers = (count: number, width = 320) =>
  Array.from({ length: count }, (_, i) => ({ id: `l${i}`, width }))

const fold = (input: Partial<LayerFoldInput> & Pick<LayerFoldInput, 'layers' | 'available'>) =>
  computeLayerFold({ anchor: null, keepOpenId: null, userFolded: new Set(), ...input })

const openIds = (result: ReturnType<typeof computeLayerFold>, count: number) =>
  Array.from({ length: count }, (_, i) => `l${i}`).filter(id => !result.folded.has(id))

describe('computeLayerFold', () => {
  it('folds nothing when every layer fits', () => {
    const result = fold({ layers: layers(3), available: 1200 })
    expect(result.folded.size).toBe(0)
    expect(result.overflows).toBe(false)
    expect([result.first, result.last]).toEqual([0, 2])
  })

  it('folds nothing before the canvas has been measured', () => {
    const result = fold({ layers: layers(12), available: 0 })
    expect(result.folded.size).toBe(0)
    expect(result.overflows).toBe(false)
  })

  it('opens from the first layer as far as the width allows and folds the rest', () => {
    const result = fold({ layers: layers(6), available: 1200 })
    expect(openIds(result, 6)).toEqual(['l0', 'l1'])
    expect([...result.folded]).toEqual(['l2', 'l3', 'l4', 'l5'])
    expect(result.overflows).toBe(true)
    expect(result.spineWidth).toBe(SPINE_MAX_WIDTH_PX)
  })

  it('opens rightward from a start anchor, and back leftward when it runs out of layers', () => {
    const fromMiddle = fold({ layers: layers(6), available: 1200, anchor: { layerId: 'l2', align: 'start' } })
    expect(openIds(fromMiddle, 6)).toEqual(['l2', 'l3'])

    const fromLast = fold({ layers: layers(6), available: 1200, anchor: { layerId: 'l5', align: 'start' } })
    expect(openIds(fromLast, 6)).toEqual(['l4', 'l5'])
  })

  it('centres the window on a centre anchor', () => {
    const result = fold({ layers: layers(8), available: 1500, anchor: { layerId: 'l4', align: 'center' } })
    expect(openIds(result, 8)).toEqual(['l3', 'l4', 'l5'])
    expect([result.first, result.last]).toEqual([3, 5])
  })

  it('slides the least that keeps a kept layer open — it becomes the near edge', () => {
    const right = fold({ layers: layers(6), available: 1200, keepOpenId: 'l3' })
    expect(openIds(right, 6)).toEqual(['l2', 'l3'])

    const left = fold({
      layers: layers(6), available: 1200,
      anchor: { layerId: 'l4', align: 'start' }, keepOpenId: 'l1',
    })
    expect(openIds(left, 6)).toEqual(['l1', 'l2'])
  })

  it('leaves the window alone when the kept layer is already open', () => {
    const result = fold({ layers: layers(6), available: 1200, keepOpenId: 'l1' })
    expect(openIds(result, 6)).toEqual(['l0', 'l1'])
  })

  it('keeps a hand-folded layer a spine and runs the window past it', () => {
    const result = fold({ layers: layers(6), available: 1200, userFolded: new Set(['l1']) })
    expect(openIds(result, 6)).toEqual(['l0', 'l2'])
    expect(result.folded.has('l1')).toBe(true)
  })

  it('still folds a hand-folded layer when everything else fits', () => {
    const result = fold({ layers: layers(3), available: 1200, userFolded: new Set(['l1']) })
    expect([...result.folded]).toEqual(['l1'])
    expect(result.overflows).toBe(false)
  })

  it('never folds the anchor layer, even when it alone is wider than the canvas', () => {
    const result = fold({ layers: layers(6), available: 300 })
    expect(openIds(result, 6)).toEqual(['l0'])
    expect(result.spineWidth).toBe(SPINE_MIN_WIDTH_PX)
  })

  it('narrows the spines as layers are added, and fits dozens of them', () => {
    const many = fold({ layers: layers(30), available: 1344 })
    expect(many.spineWidth).toBeLessThan(SPINE_MAX_WIDTH_PX)
    expect(many.spineWidth).toBeGreaterThanOrEqual(SPINE_MIN_WIDTH_PX)
    expect(openIds(many, 30)).toEqual(['l0'])
  })

  it('gives every spine the same width wherever the window is', () => {
    const a = fold({ layers: layers(10), available: 1300 })
    const b = fold({ layers: layers(10), available: 1300, anchor: { layerId: 'l7', align: 'center' } })
    expect(a.spineWidth).toBe(b.spineWidth)
  })

  it('treats an anchor that no longer exists as no anchor', () => {
    const result = fold({ layers: layers(6), available: 1200, anchor: { layerId: 'gone', align: 'center' } })
    expect(openIds(result, 6)).toEqual(['l0', 'l1'])
  })

  it('counts a wide column at its own width', () => {
    const wide = [{ id: 'l0', width: 900 }, ...layers(5).slice(1)]
    const result = fold({ layers: wide, available: 1200 })
    expect(openIds(result, 5)).toEqual(['l0'])
  })
})

describe('computeLayerFold — open columns before wide spines', () => {
  it('narrows the spines to open one more layer rather than stretch the open ones', () => {
    // Five default columns on a 1,344px canvas (1,220 after the gutters):
    // spines at their widest leave room for two layers, 2px short of three.
    const result = fold({ layers: layers(5), available: 1220 })
    expect(openIds(result, 5)).toEqual(['l0', 'l1', 'l2'])
    expect(result.spineWidth).toBeLessThan(SPINE_MAX_WIDTH_PX)
    expect(result.spineWidth).toBeGreaterThanOrEqual(SPINE_MIN_WIDTH_PX)
  })
})
