import { describe, it, expect } from 'vitest'
import { buildConnectionModel, EMPTY_CONNECTION_MODEL, type ConnectionBundle } from '../connectionModel'

const B = (overrides: Partial<ConnectionBundle> & { id: string }): ConnectionBundle => ({
  edgeCount: 1,
  types: [],
  ...overrides,
})

describe('buildConnectionModel', () => {
  it('a multi-type bundle counts once in the total and once in each type row', () => {
    const model = buildConnectionModel([B({ id: 'a', edgeCount: 5, types: ['FLOWS_TO', 'DERIVES_FROM'] })])
    expect(model.relationships).toBe(5)
    expect(model.typeCount).toBe(2)
    const byType = new Map(model.rows.map((r) => [r.type, r]))
    expect(byType.get('FLOWS_TO')?.relationships).toBe(5)
    expect(byType.get('DERIVES_FROM')?.relationships).toBe(5)
  })

  it('rows sort by relationships desc, ties broken by type name', () => {
    const model = buildConnectionModel([
      B({ id: 'a', edgeCount: 2, types: ['ZETA'] }),
      B({ id: 'b', edgeCount: 5, types: ['ALPHA'] }),
      B({ id: 'c', edgeCount: 2, types: ['ALPHA'] }),
    ])
    // ALPHA: bundles b (5) + c (2) = 7; ZETA: bundle a (2) = 2
    expect(model.rows.map((r) => r.type)).toEqual(['ALPHA', 'ZETA'])

    const tie = buildConnectionModel([
      B({ id: 'x', edgeCount: 3, types: ['BETA'] }),
      B({ id: 'y', edgeCount: 3, types: ['ALPHA'] }),
    ])
    expect(tie.rows.map((r) => r.type)).toEqual(['ALPHA', 'BETA'])
  })

  it('direction buckets: forward by default, backward on isReverseFlow, bidirectional on its own', () => {
    const model = buildConnectionModel([
      B({ id: 'fwd', edgeCount: 1, types: ['FLOWS_TO'] }),
      B({ id: 'back', edgeCount: 2, types: ['FLOWS_TO'], isReverseFlow: true }),
      B({ id: 'bidi', edgeCount: 3, types: ['FLOWS_TO'], isBidirectional: true }),
    ])
    const row = model.rows[0]
    expect(row.type).toBe('FLOWS_TO')
    expect(row.forward).toBe(1)
    expect(row.backward).toBe(2)
    expect(row.bidirectional).toBe(3)
    expect(row.relationships).toBe(6)
  })

  it('a bundle with no types lands in untyped and never invents a row', () => {
    const model = buildConnectionModel([B({ id: 'a', edgeCount: 4, types: [] })])
    expect(model.untyped).toBe(4)
    expect(model.rows).toHaveLength(0)
    expect(model.relationships).toBe(4)
  })

  it('a missing or non-positive edgeCount counts as one', () => {
    const model = buildConnectionModel([
      B({ id: 'a', edgeCount: undefined as unknown as number, types: ['FLOWS_TO'] }),
      B({ id: 'b', edgeCount: 0, types: ['FLOWS_TO'] }),
      B({ id: 'c', edgeCount: -3, types: ['FLOWS_TO'] }),
    ])
    expect(model.relationships).toBe(3)
    expect(model.rows[0].relationships).toBe(3)
  })

  it('type keys are uppercased and deduped within a bundle', () => {
    const model = buildConnectionModel([B({ id: 'a', edgeCount: 4, types: ['flows_to', 'FLOWS_TO'] })])
    expect(model.rows).toHaveLength(1)
    expect(model.rows[0].type).toBe('FLOWS_TO')
    expect(model.rows[0].relationships).toBe(4)
    expect(model.relationships).toBe(4)
  })

  it('bundleIds list every bundle carrying the type, in input order', () => {
    const model = buildConnectionModel([
      B({ id: 'a', edgeCount: 1, types: ['FLOWS_TO'] }),
      B({ id: 'b', edgeCount: 1, types: ['DERIVES_FROM'] }),
      B({ id: 'c', edgeCount: 1, types: ['FLOWS_TO'] }),
    ])
    const row = model.rows.find((r) => r.type === 'FLOWS_TO')!
    expect(row.bundleIds).toEqual(['a', 'c'])
    expect(row.bundles).toBe(2)
  })

  it('an empty input equals EMPTY_CONNECTION_MODEL', () => {
    expect(buildConnectionModel([])).toEqual(EMPTY_CONNECTION_MODEL)
  })
})
