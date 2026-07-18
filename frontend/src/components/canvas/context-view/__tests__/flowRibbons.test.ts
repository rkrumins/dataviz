/**
 * aggregateFlowRibbons — macro (layer → layer) volume aggregation.
 */
import { describe, it, expect } from 'vitest'
import { aggregateFlowRibbons, formatRibbonCount } from '../flowRibbons'

const layerMap = new Map([
  ['a1', 'L1'], ['a2', 'L1'],
  ['b1', 'L2'],
  ['c1', 'L3'],
])
const order = ['L1', 'L2', 'L3']

describe('aggregateFlowRibbons', () => {
  it('sums bundle weights per layer pair', () => {
    const ribbons = aggregateFlowRibbons(
      [
        { source: 'a1', target: 'b1', edgeCount: 100 },
        { source: 'a2', target: 'b1', edgeCount: 50 },
        { source: 'b1', target: 'c1' },              // no edgeCount → weight 1
      ],
      layerMap, order,
    )
    expect(ribbons).toEqual([
      { sourceLayerId: 'L1', targetLayerId: 'L2', count: 150 },
      { sourceLayerId: 'L2', targetLayerId: 'L3', count: 1 },
    ])
  })

  it('drops same-layer edges and unknown endpoints', () => {
    const ribbons = aggregateFlowRibbons(
      [
        { source: 'a1', target: 'a2', edgeCount: 10 },  // intra-layer
        { source: 'a1', target: 'ghost', edgeCount: 5 }, // unknown endpoint
      ],
      layerMap, order,
    )
    expect(ribbons).toHaveLength(0)
  })

  it('keeps the strongest pairs and orders them left-to-right', () => {
    const edges = [
      { source: 'a1', target: 'c1', edgeCount: 5 },
      { source: 'a1', target: 'b1', edgeCount: 90 },
      { source: 'b1', target: 'c1', edgeCount: 40 },
    ]
    const ribbons = aggregateFlowRibbons(edges, layerMap, order, 2)
    expect(ribbons.map(r => `${r.sourceLayerId}->${r.targetLayerId}`))
      .toEqual(['L1->L2', 'L2->L3'])   // top 2 by count, presented in column order
  })
})

describe('formatRibbonCount', () => {
  it('formats compactly', () => {
    expect(formatRibbonCount(950)).toBe('950')
    expect(formatRibbonCount(12431)).toBe('12.4k')
    expect(formatRibbonCount(204000)).toBe('204k')
  })
})
