/**
 * The inner-first accounting of rollup cells, as ONE rule for both boards
 * (Part G, 2026-08-21): `accountRollups` is the loop `buildTraceWires`
 * always ran, extracted so the Lens can run it over a whole model; and
 * `rollupResiduals` is the card-vs-host question — an endpoint whose cells
 * are fully stated by cells strictly inside it (or by raw evidence) is a
 * host, not a partner.
 *
 * Estate (the coarse page a table gets back): the focus `tbl` with cells to
 * `t1` (30), `t2` (10), their database `db` (40) and its department `dept`
 * (40) — as the aggregation worker stamps them, per containment-level pair.
 */
import { describe, it, expect } from 'vitest'
import { accountRollups, buildLedger, pairKey, rollupResiduals } from '../traceWireLedger'
import { accountedLineageEdges } from '@/components/canvas/context-view/lens/rollup-accounting'
import type { LensWalkModel, LensWalkNode } from '@/components/canvas/context-view/lens/closure-adapter'

const wn = (urn: string): LensWalkNode => ({
  id: urn, type: 'default', position: { x: 0, y: 0 },
  data: { urn, label: urn, type: 'Node' }, urn, displayName: urn, entityType: 'Node',
}) as unknown as LensWalkNode
const cell = (s: string, t: string, w: number) => ({ id: `agg:${s}>${t}`, sourceUrn: s, targetUrn: t, edgeType: 'AGGREGATED', kind: 'rollup' as const, weight: w })
const raw = (s: string, t: string, i: number) => ({ id: `r${i}:${s}>${t}`, sourceUrn: s, targetUrn: t, edgeType: 'FLOWS_TO', kind: 'raw' as const, weight: null })
const has = (p: string, c: string) => ({ sourceUrn: p, targetUrn: c })

function coarseEstate(rawHops: Array<ReturnType<typeof raw>> = []): LensWalkModel {
  return {
    focusUrn: 'tbl',
    nodes: ['dept', 'db', 't1', 't2', 'fdb', 'tbl', 'c0', 'c1', 't1a', 't2a'].map(wn),
    lineageEdges: [cell('tbl', 't1', 30), cell('tbl', 't2', 10), cell('tbl', 'db', 40), cell('tbl', 'dept', 40), ...rawHops],
    containmentEdges: [has('dept', 'db'), has('db', 't1'), has('db', 't2'), has('t1', 't1a'), has('t2', 't2a'), has('fdb', 'tbl'), has('tbl', 'c0'), has('tbl', 'c1')],
    upstreamUrns: new Set(), downstreamUrns: new Set(),
    coarseUpstreamUrns: new Set(), coarseDownstreamUrns: new Set(['t1', 't2', 'db', 'dept']),
    frontierUp: [], frontierDown: [], truncated: false, truncationReason: null, seedTruncated: false, seedCursor: null,
  }
}
const parentOf = (m: LensWalkModel) => {
  const p = new Map(m.containmentEdges.map(c => [c.targetUrn, c.sourceUrn]))
  return (urn: string) => p.get(urn) ?? null
}

describe('accountRollups — the finest cone speaks first', () => {
  it('with no raw evidence the tables say 30 and 10, and the database and department say nothing', () => {
    const m = coarseEstate()
    const cells = m.lineageEdges.filter(e => e.kind === 'rollup').map(e => ({ source: e.sourceUrn, target: e.targetUrn, weight: e.weight! }))
    const out = accountRollups(cells, buildLedger(m), parentOf(m))
    expect([...out.values()].map(w => `${w.target}:${w.kind}:${w.count}`).sort()).toEqual(['t1:rollup:30', 't2:rollup:10'])
  })

  it('raw evidence under a pair replaces its cell when the ledger vouches for the pair', () => {
    const m = coarseEstate([raw('c0', 't1a', 1), raw('c1', 't1a', 2)])
    const cells = m.lineageEdges.filter(e => e.kind === 'rollup').map(e => ({ source: e.sourceUrn, target: e.targetUrn, weight: e.weight! }))
    const vouched = accountRollups(cells, buildLedger(m), parentOf(m))          // default ledger vouches every raw-backed pair
    expect([...vouched.keys()].sort()).toEqual([pairKey('tbl', 't2')])          // t1 is the raw wires' business now
    const walking = accountRollups(cells, buildLedger(m, new Set()), parentOf(m), { floor: false })
    expect(walking.get(pairKey('tbl', 't1'))).toMatchObject({ kind: 'residual', count: 28 })   // 30 − 2 raw, still walking
  })
})

describe('rollupResiduals — card or host', () => {
  it('an endpoint whose cells are fully stated inside it is a host; the others are cards with their residual', () => {
    expect(Object.fromEntries(rollupResiduals(coarseEstate()))).toEqual({ t1: 30, t2: 10 })
  })

  it('cells onto the focus itself or its own ancestors are internal — never a partner', () => {
    const m = coarseEstate()
    const withInternal = { ...m, lineageEdges: [...m.lineageEdges, cell('tbl', 'fdb', 5), cell('c0', 'tbl', 2)] }
    expect(Object.fromEntries(rollupResiduals(withInternal))).toEqual({ t1: 30, t2: 10 })
  })
})

describe('accountedLineageEdges — what the Lens builds its board from', () => {
  it('keeps every raw hop and only the cells that still say something, weighted by what they say', () => {
    const edges = accountedLineageEdges(coarseEstate([raw('c0', 't2a', 1)]), { vouchAll: false })
    const byId = Object.fromEntries(edges.map(e => [e.id, e]))
    expect(byId['r1:c0>t2a']).toMatchObject({ kind: 'raw' })
    expect(byId['agg:tbl>t1']).toMatchObject({ kind: 'rollup', weight: 30 })
    expect(byId['agg:tbl>t2']).toMatchObject({ kind: 'rollup', weight: 9 })      // 10 − 1 raw seen so far
    expect(byId['agg:tbl>db']).toBeUndefined()
    expect(byId['agg:tbl>dept']).toBeUndefined()
  })

  it('once the walk is done, every raw-backed cell is dropped — raw evidence wins', () => {
    const edges = accountedLineageEdges(coarseEstate([raw('c0', 't2a', 1)]), { vouchAll: true })
    expect(edges.map(e => e.id).sort()).toEqual(['agg:tbl>t1', 'r1:c0>t2a'])
  })

  it('a model without cells is handed back as it is', () => {
    const m = { ...coarseEstate(), lineageEdges: [raw('c0', 't1a', 1)] }
    expect(accountedLineageEdges(m, { vouchAll: false })).toBe(m.lineageEdges)
  })
})
