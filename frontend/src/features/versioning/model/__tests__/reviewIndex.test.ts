import { describe, expect, it } from 'vitest'
import type { StagedChange } from '@/store/stagedChangesStore'
import { buildReviewIndex, filterRows, headingLabel, headingOf, NO_FILTER, isNarrowed } from '../reviewIndex'

const lookup = { nameOf: (id: string) => id.replace('urn:', ''), typeOf: (id: string) => (id.includes('col') ? 'Column' : 'Table') }
let n = 0
const change = (over: Partial<StagedChange>): StagedChange => ({
  id: `c${n++}`, type: 'update_entity', targetId: 'urn:a', targetUrn: 'urn:a', after: {}, summary: 'edit', timestamp: 0, ...over,
})

describe('buildReviewIndex', () => {
  const changes = [
    change({ targetUrn: 'urn:orders', targetId: 'urn:orders' }),
    change({ targetUrn: 'urn:orders', targetId: 'urn:orders', summary: 'second edit' }),
    change({ type: 'create_entity', targetUrn: 'urn:col1', targetId: 'urn:col1', after: { displayName: 'amount' } }),
    change({ type: 'delete_entity', targetUrn: 'urn:sales', targetId: 'urn:sales', error: 'refused' }),
    change({ type: 'create_edge', targetId: 'e1', targetUrn: undefined, after: { source: 'urn:orders', target: 'urn:sales' } }),
    change({ type: 'layer_config', targetId: 'l1', targetUrn: undefined }),
  ]
  const index = buildReviewIndex(changes, lookup)

  it('groups once per list and counts what the filter bar shows', () => {
    expect(buildReviewIndex(changes, lookup)).toBe(index)
    expect(index.groups).toHaveLength(5)
    expect(index.facets.status).toEqual({ added: 2, modified: 1, removed: 1 })
    expect(index.facets.kind).toEqual({ node: 3, edge: 1, layout: 1 })
    expect(index.facets.types).toEqual([{ type: 'Table', n: 2 }, { type: 'Column', n: 1 }])
    expect(index.groupOf.get(changes[1].id)).toBe(0)
  })

  it('filters by status, kind, type, search and attention', () => {
    const names = (f: Partial<typeof NO_FILTER>) => filterRows(index, { ...NO_FILTER, ...f }).map((i) => index.groups[i].name)
    expect(names({})).toHaveLength(5)
    expect(names({ statuses: ['added'] })).toEqual(['amount', 'orders → sales'])
    expect(names({ kind: 'edge' })).toEqual(['orders → sales'])
    expect(names({ type: 'Column' })).toEqual(['amount'])
    expect(names({ q: 'SECOND' })).toEqual(['orders'])
    expect(names({ attention: true })).toEqual(['sales'])
    expect(isNarrowed(NO_FILTER)).toBe(false)
    expect(isNarrowed({ ...NO_FILTER, q: ' x ' })).toBe(true)
  })

  it('lists entities, then relationships, then layout — each by type, the most changed first', () => {
    const mixed = [
      change({ targetUrn: 'urn:col1', targetId: 'urn:col1' }),
      change({ type: 'create_edge', targetId: 'e9', targetUrn: undefined, after: { source: 'urn:a', target: 'urn:b', edgeType: 'FEEDS' } }),
      change({ targetUrn: 'urn:t1', targetId: 'urn:t1' }),
      change({ type: 'layer_config', targetId: 'l9', targetUrn: undefined }),
      change({ targetUrn: 'urn:t2', targetId: 'urn:t2' }),
      change({ targetUrn: 'urn:col2', targetId: 'urn:col2' }),
      change({ targetUrn: 'urn:t3', targetId: 'urn:t3' }),
    ]
    const ix = buildReviewIndex(mixed, lookup)
    const order = filterRows(ix, NO_FILTER).map((i) => ix.groups[i])
    expect(order.map((g) => (g.kind === 'layout' ? 'layout' : g.key))).toEqual(['urn:t1', 'urn:t2', 'urn:t3', 'urn:col1', 'urn:col2', 'e9', 'layout'])
    expect(order.map((g) => headingLabel(headingOf(g)))).toEqual(
      ['Table', 'Table', 'Table', 'Column', 'Column', 'FEEDS relationships', 'View layout'])
  })

  it('indexes and filters 50,000 staged changes within a frame budget', () => {
    const many: StagedChange[] = Array.from({ length: 50_000 }, (_, i) => change({
      targetUrn: `urn:e${i}`, targetId: `urn:e${i}`,
      before: { label: `e${i}`, properties: { a: 1 } }, after: { label: `e${i}`, properties: { a: 2 } },
    }))
    const t = performance.now()
    const big = buildReviewIndex(many, lookup)
    const rows = filterRows(big, { ...NO_FILTER, q: 'e4999' })
    const ms = performance.now() - t
    expect(big.groups).toHaveLength(50_000)
    expect(rows.length).toBe(11)
    expect(ms).toBeLessThan(1500)
  })
})
