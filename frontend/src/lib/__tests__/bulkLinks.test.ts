import { describe, expect, it } from 'vitest'
import type { RelationshipTypeSchema } from '@/types/schema'
import {
  BULK_LINK_CONFIRM_ABOVE,
  BULK_LINK_MAX,
  batchTypeOptions,
  expandPairs,
  judgePairs,
  type BulkLinkContext,
} from '../bulkLinks'

const rel = (id: string, sourceTypes: string[], targetTypes: string[], extra: Partial<RelationshipTypeSchema> = {}) =>
  ({
    id, name: id.replace(/_/g, ' ').toLowerCase(), sourceTypes, targetTypes,
    visual: { strokeColor: '#000', strokeWidth: 1, strokeStyle: 'solid', animated: false, animationSpeed: 'normal', arrowType: 'arrow' },
    bidirectional: false, showLabel: false, isLineage: true, ...extra,
  }) as RelationshipTypeSchema

// Tables feed tables and reports; a report feeds nothing. CONTAINS is
// containment, AGGREGATED the platform's rollup — neither is ever drawn.
const relationshipTypes = [
  rel('FLOWS_TO', ['table'], ['table', 'report']),
  rel('FEEDS_REPORT', ['table'], ['report']),
  rel('CONTAINS', ['*'], ['*'], { isContainment: true, isLineage: false }),
  rel('AGGREGATED', ['*'], ['*']),
]
const types: Record<string, string> = { t1: 'table', t2: 'table', t3: 'table', r1: 'report', r2: 'report' }

function ctx(existing: Array<{ source: string; target: string; edgeType: string }> = []): BulkLinkContext {
  return {
    typeOf: (urn) => types[urn] ?? null,
    relationshipTypes,
    containmentEdgeTypes: ['CONTAINS'],
    existingEdges: existing.map((e) => ({ source: e.source, target: e.target, data: { edgeType: e.edgeType } })),
  }
}

describe('expandPairs — the direction is the one stated, never click order', () => {
  it('the selection feeds the other side: N sources → 1 target', () => {
    expect(expandPairs(['t1', 't2', 't3'], ['r1'], 'selection-feeds')).toEqual([
      { source: 't1', target: 'r1' },
      { source: 't2', target: 'r1' },
      { source: 't3', target: 'r1' },
    ])
  })

  it('the other side feeds the selection: 1 source → N targets', () => {
    expect(expandPairs(['r1', 'r2'], ['t1'], 'feeds-selection')).toEqual([
      { source: 't1', target: 'r1' },
      { source: 't1', target: 'r2' },
    ])
  })

  it('N × M: every source to every target', () => {
    expect(expandPairs(['t1', 't2'], ['r1', 'r2'], 'selection-feeds')).toHaveLength(4)
  })

  it('never links an entity to itself, and lists each pair once', () => {
    expect(expandPairs(['t1', 't2', 't2'], ['t1', 't2'], 'selection-feeds')).toEqual([
      { source: 't1', target: 't2' },
      { source: 't2', target: 't1' },
    ])
  })
})

describe('judgePairs — every pair through the same gate as a hand-drawn link', () => {
  it('passes the pairs the ontology allows, in the direction given', () => {
    const verdicts = judgePairs(expandPairs(['t1', 't2'], ['r1'], 'selection-feeds'), 'FEEDS_REPORT', ctx())
    expect(verdicts.every((v) => v.ok)).toBe(true)
  })

  it('reversing the direction is judged as reversed: a report cannot feed a table', () => {
    const [v] = judgePairs(expandPairs(['t1'], ['r1'], 'feeds-selection'), 'FLOWS_TO', ctx())
    expect(v).toMatchObject({ source: 'r1', target: 't1', ok: false })
    expect(v.reason).toMatch(/can't be the source/)
  })

  it('skips a pair already joined by this relationship, and says so', () => {
    const verdicts = judgePairs(
      expandPairs(['t1', 't2'], ['r1'], 'selection-feeds'),
      'FLOWS_TO',
      ctx([{ source: 't1', target: 'r1', edgeType: 'FLOWS_TO' }]),
    )
    expect(verdicts.map((v) => v.ok)).toEqual([false, true])
    expect(verdicts[0].reason).toMatch(/already connected/)
  })

  it('a link of another relationship between the same pair does not block this one', () => {
    const verdicts = judgePairs([{ source: 't1', target: 'r1' }], 'FEEDS_REPORT', ctx([{ source: 't1', target: 'r1', edgeType: 'FLOWS_TO' }]))
    expect(verdicts[0].ok).toBe(true)
  })

  it('containment and the platform rollup are never drawn', () => {
    expect(judgePairs([{ source: 't1', target: 't2' }], 'CONTAINS', ctx())[0].ok).toBe(false)
    expect(judgePairs([{ source: 't1', target: 't2' }], 'AGGREGATED', ctx())[0].ok).toBe(false)
  })
})

describe('batchTypeOptions — one relationship for the batch, and how much of it fits', () => {
  it('offers the drawable lineage types that fit at least one pair, most-fitting first', () => {
    const pairs = expandPairs(['t1', 't2'], ['t3', 'r1'], 'selection-feeds')
    expect(batchTypeOptions(pairs, ctx()).map((o) => [o.edgeType, o.fits])).toEqual([
      ['FLOWS_TO', 4],
      ['FEEDS_REPORT', 2],
    ])
  })

  it('a pair already joined by a type does not count towards that type', () => {
    const pairs = expandPairs(['t1'], ['r1'], 'selection-feeds')
    const options = batchTypeOptions(pairs, ctx([{ source: 't1', target: 'r1', edgeType: 'FLOWS_TO' }]))
    expect(options.map((o) => o.edgeType)).toEqual(['FEEDS_REPORT'])
  })

  it('nothing fits: no options — the panel explains instead', () => {
    expect(batchTypeOptions(expandPairs(['r1'], ['r2'], 'selection-feeds'), ctx())).toEqual([])
  })
})

describe('limits', () => {
  it('asks before a large batch, and refuses an enormous one', () => {
    expect(BULK_LINK_CONFIRM_ABOVE).toBeLessThan(BULK_LINK_MAX)
    expect(BULK_LINK_MAX).toBeGreaterThan(0)
  })
})
