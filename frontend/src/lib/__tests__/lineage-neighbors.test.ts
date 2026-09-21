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
    // folding it away must not lose that, nor the rollup styling, nor
    // the edge the server can actually drill into.
    expect(r.bundledCount).toBe(14)
    expect(r.aggregated).toBe(true)
    expect(r.rollupEdge?.id).toBe('agg1')
  })

  it('keeps a lone rollup — between coarse entities it is the only evidence', () => {
    const { incomingRecords } = derive([rollup('agg1', 'A', 'F', 9)])
    expect(incomingRecords).toHaveLength(1)
    expect(incomingRecords[0].edgeTypeNorm).toBe('AGGREGATED')
    expect(incomingRecords[0].bundledCount).toBe(9)
    expect(incomingRecords[0].alsoTypes).toEqual([])
  })

  it('collapses the same relationship arriving twice under different edge ids', () => {
    // The store and the projection can both carry ONE connection — the
    // weight is the larger of the two, not their sum, or a duplicate
    // would read as extra lineage.
    const { incomingRecords } = derive([
      edge('store-1', 'A', 'F'),
      edge('projected-1', 'A', 'F'),
    ])
    expect(incomingRecords).toHaveLength(1)
    expect(incomingRecords[0].bundledCount).toBe(1)
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
    // Deterministic host: most underlying flows first, then type name
    // ascending — so the same input never lands the rollup elsewhere.
    expect(absorbed[0].edgeTypeNorm).toBe('DERIVES_FROM')
    expect(absorbed[0].aggregated).toBe(true)
    // The other record is untouched — the weight is counted once.
    const other = incomingRecords.find(r => r.edgeTypeNorm === 'FLOWS_TO')!
    expect(other.bundledCount).toBe(1)
    expect(other.aggregated).toBe(false)
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


// ---------------------------------------------------------------------------
// One flow, listed once — not once per grain above it
// ---------------------------------------------------------------------------

/**
 * Reported from the app. A schema field `account_id` feeding one other field
 * listed FOUR connections: the partner field (TRANSFORMS, the real flow) and
 * then its dataset, its container and its platform, each an `AGGREGATED`
 * rollup of that same flow. The Focus Lens said "1 connection · immediate
 * lineage complete" for the same entity, and the Lens was right.
 *
 * The aggregation worker materialises a rollup cell at every level above a
 * real flow, which is the "5 in / 4 out on a column with two real
 * neighbours" the closure strips server-side.
 */
describe('deriveNeighborRecords — rollups of a flow already listed', () => {
  const FOCAL = 'urn:field:account_id_t1'
  const nodes = new Map<string, LineageNode>([
    [FOCAL, { id: FOCAL, position: { x: 0, y: 0 }, data: { label: 'account_id', urn: FOCAL, type: 'schemaField' } }],
    ['urn:field:account_id_t2', { id: 'urn:field:account_id_t2', position: { x: 0, y: 0 }, data: { label: 'account_id', urn: 'urn:field:account_id_t2', type: 'schemaField' } }],
    ['urn:dataset:t2', { id: 'urn:dataset:t2', position: { x: 0, y: 0 }, data: { label: 'int_clean_contacts_t2', urn: 'urn:dataset:t2', type: 'dataset' } }],
    ['urn:container:i2', { id: 'urn:container:i2', position: { x: 0, y: 0 }, data: { label: 'INTERMEDIATE_T2', urn: 'urn:container:i2', type: 'container' } }],
    ['urn:platform:snow', { id: 'urn:platform:snow', position: { x: 0, y: 0 }, data: { label: 'Snowflake', urn: 'urn:platform:snow', type: 'dataPlatform' } }],
  ] as never)

  /** dataPlatform ⊃ container ⊃ dataset ⊃ schemaField. */
  const closure = new Map<string, Set<string>>([
    ['DATAPLATFORM', new Set(['CONTAINER', 'DATASET', 'SCHEMAFIELD'])],
    ['CONTAINER', new Set(['DATASET', 'SCHEMAFIELD'])],
    ['DATASET', new Set(['SCHEMAFIELD'])],
  ])
  const grain = { closure, focalType: 'schemaField' }

  const edges = [
    { id: 'real', source: FOCAL, target: 'urn:field:account_id_t2', data: { edgeType: 'TRANSFORMS' } },
    { id: 'r1', source: FOCAL, target: 'urn:dataset:t2', data: { edgeType: 'AGGREGATED', isAggregated: true } },
    { id: 'r2', source: FOCAL, target: 'urn:container:i2', data: { edgeType: 'AGGREGATED', isAggregated: true } },
    { id: 'r3', source: FOCAL, target: 'urn:platform:snow', data: { edgeType: 'AGGREGATED', isAggregated: true } },
  ] as unknown as LineageEdge[]

  it('lists the real flow once, not once per grain above it', () => {
    const { outgoingRecords } = deriveNeighborRecords(FOCAL, edges, nodes, ['CONTAINS'], grain)

    expect(outgoingRecords.map(r => r.neighborId)).toEqual(['urn:field:account_id_t2'])
  })

  it('keeps every row when no grain context is supplied', () => {
    const { outgoingRecords } = deriveNeighborRecords(FOCAL, edges, nodes, ['CONTAINS'])
    expect(outgoingRecords).toHaveLength(4)
  })

  it('keeps a rollup that is the ONLY evidence of a connection', () => {
    // No concrete flow at all — between coarse entities the rollup is often
    // the only thing saying a connection exists.
    const rollupsOnly = edges.filter(e => e.id !== 'real')
    const { outgoingRecords } = deriveNeighborRecords(FOCAL, rollupsOnly, nodes, ['CONTAINS'], grain)

    expect(outgoingRecords).toHaveLength(3)
  })

  it('keeps a rollup to a partner that is NOT coarser than the focal', () => {
    const sibling = [
      edges[0]!,
      { id: 'peer', source: FOCAL, target: 'urn:field:account_id_t2', data: { edgeType: 'AGGREGATED', isAggregated: true } },
    ] as unknown as LineageEdge[]
    const { outgoingRecords } = deriveNeighborRecords(FOCAL, sibling, nodes, ['CONTAINS'], grain)

    // Same neighbour — folded into the concrete record by the existing rule,
    // which is a fold, not a drop.
    expect(outgoingRecords).toHaveLength(1)
    expect(outgoingRecords[0]!.aggregated).toBe(true)
  })
})
