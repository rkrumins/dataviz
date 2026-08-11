/**
 * deriveNeighborRecords — one card per CONNECTION, not per edge.
 *
 * The platform's synthetic AGGREGATED rollup is declared `is_lineage`
 * and injected into every ontology, so it arrives looking like an
 * ordinary business relationship, and the backend returns it alongside
 * the raw edge for the same pair (it dedupes by relationship id, never
 * by pair). Left alone that renders the same entity twice — once as
 * "Flows To", once as "Aggregated". These pin the collapse, and just as
 * importantly pin what must NOT collapse.
 */
import { describe, it, expect } from 'vitest'
import { deriveNeighborRecords } from '../lineage-neighbors'
import type { LineageNode, LineageEdge } from '@/store/canvas'

const node = (id: string): LineageNode => ({
  id, type: 'custom', position: { x: 0, y: 0 },
  data: { label: `label-${id}`, type: 'dataset', urn: id },
} as unknown as LineageNode)

const edge = (
  id: string, source: string, target: string,
  edgeType = 'FLOWS_TO',
  data: Record<string, unknown> = {},
): LineageEdge => ({
  id, source, target, data: { edgeType, ...data },
} as unknown as LineageEdge)

/** The shape the projection stamps on a rollup edge. */
const rollup = (id: string, source: string, target: string, count = 14): LineageEdge =>
  edge(id, source, target, 'AGGREGATED', { isAggregated: true, edgeCount: count })

const nodeMap = new Map([['F', node('F')], ['A', node('A')], ['B', node('B')]])
const derive = (edges: LineageEdge[]) => deriveNeighborRecords('F', edges, nodeMap, ['CONTAINS'])

describe('deriveNeighborRecords — collapsing synthetic rollups', () => {
  it('folds an AGGREGATED rollup into the concrete relationship to the same neighbour', () => {
    const { incomingRecords } = derive([
      edge('e1', 'A', 'F'),
      rollup('agg1', 'A', 'F', 14),
    ])
    expect(incomingRecords).toHaveLength(1)
    const [r] = incomingRecords
    // The concrete relationship is what the card names.
    expect(r.edgeTypeNorm).toBe('FLOWS_TO')
    expect(r.alsoTypes).toEqual(['AGGREGATED'])
    // The rollup knew about 14 underlying flows the raw edge doesn't —
    // folding it away must not lose that.
    expect(r.bundledCount).toBe(14)
  })

  it('keeps a lone rollup — between coarse entities it is the only evidence', () => {
    const { incomingRecords } = derive([rollup('agg1', 'A', 'F', 9)])
    expect(incomingRecords).toHaveLength(1)
    expect(incomingRecords[0].edgeTypeNorm).toBe('AGGREGATED')
    expect(incomingRecords[0].bundledCount).toBe(9)
    expect(incomingRecords[0].alsoTypes).toEqual([])
  })

  it('collapses the same relationship arriving twice under different edge ids', () => {
    // The store and the projection can both carry one connection.
    const { incomingRecords } = derive([
      edge('store-1', 'A', 'F'),
      edge('projected-1', 'A', 'F'),
    ])
    expect(incomingRecords).toHaveLength(1)
    expect(incomingRecords[0].bundledCount).toBe(2)
  })

  it('keeps genuinely different business relationships apart', () => {
    const { incomingRecords } = derive([
      edge('e1', 'A', 'F', 'FLOWS_TO'),
      edge('e2', 'A', 'F', 'DERIVES_FROM'),
    ])
    expect(incomingRecords.map(r => r.edgeTypeNorm)).toEqual(['FLOWS_TO', 'DERIVES_FROM'])
  })

  it('absorbs a rollup into exactly ONE concrete record, never several', () => {
    const { incomingRecords } = derive([
      edge('e1', 'A', 'F', 'FLOWS_TO'),
      edge('e2', 'A', 'F', 'DERIVES_FROM'),
      rollup('agg1', 'A', 'F', 20),
    ])
    expect(incomingRecords).toHaveLength(2)
    const absorbed = incomingRecords.filter(r => r.alsoTypes.includes('AGGREGATED'))
    expect(absorbed).toHaveLength(1)
    expect(absorbed[0].edgeTypeNorm).toBe('FLOWS_TO')
    // The other record is untouched — the weight is counted once.
    const other = incomingRecords.find(r => r.edgeTypeNorm === 'DERIVES_FROM')!
    expect(other.bundledCount).toBe(1)
  })

  it('collapses per direction — the same entity on both sides is two connections', () => {
    const { incomingRecords, outgoingRecords } = derive([
      edge('e1', 'A', 'F'),
      rollup('agg1', 'A', 'F'),
      edge('e2', 'F', 'A'),
    ])
    expect(incomingRecords).toHaveLength(1)
    expect(outgoingRecords).toHaveLength(1)
    expect(outgoingRecords[0].neighborId).toBe('A')
  })

  it('keeps distinct neighbours distinct, and still drops containment', () => {
    const { incomingRecords } = derive([
      edge('e1', 'A', 'F'),
      edge('e2', 'B', 'F'),
      edge('c1', 'B', 'F', 'CONTAINS'),
    ])
    expect(incomingRecords.map(r => r.neighborId)).toEqual(['A', 'B'])
  })
})
