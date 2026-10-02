/**
 * traceViewModel — a COMBINED trace: several seeds, one picture.
 *
 * The canvas walks each selected entity on its own and hands over the UNION.
 * Every seed is a focus in its own right — its side is role 'focus', never a
 * host — and every partner's hop is measured to its NEAREST seed, so a
 * partner one hop from seed 2 survives a depth of 1 exactly as one hop from
 * seed 1 does. Measured off the first seed alone (as it was), seed 2 read as
 * a host and dropped out, and its partners had no hop at all.
 */
import { describe, it, expect } from 'vitest'
import { buildTraceView, type TraceView, type TraceViewInputs } from '../traceViewModel'
import {
  twoSeedEstate, cfoEstate, tableEstate, rootsNodeEstate, coarseCellsEstate, coarseThenFineEstate, anchoredEstate,
} from '@/test/fixtures/traceEstates'

const two = twoSeedEstate()
const SEEDS = ['orders', 'sales']
const ALL_OPEN = ['RAW', 'orders', 'FIN', 'ledger', 'MART', 'sales', 'BI', 'dash', 'CRM']

const view = (over: Partial<TraceViewInputs> = {}): TraceView => buildTraceView({
  model: two.model, focusUrn: 'orders', focusUrns: SEEDS, layers: two.layers, assignments: two.assignments,
  viewIsCurated: true, traceExpansion: new Set(ALL_OPEN), showUpstream: true, showDownstream: true,
  depthUp: 1, depthDown: 1,
  ...over,
})
const cardOf = (v: TraceView, id: string) => v.lanes.flatMap(l => [...l.cards.values()]).find(c => c.id === id)
const wireKeys = (v: TraceView) => v.wires.map(w => `${w.source}>${w.target}:${w.kind}:${w.edgeCount}`).sort()

describe('buildTraceView — two disjoint seeds', () => {
  it('both seeds are role focus, and so is everything inside them', () => {
    const v = view()
    for (const id of ['orders', 'orders.amt', 'sales', 'sales.amt']) expect(cardOf(v, id)?.role).toBe('focus')
    expect(cardOf(v, 'sales')!.hop).toBe(0)
  })

  it('each seed’s partner is one hop away and survives a depth of 1', () => {
    const v = view()
    expect(cardOf(v, 'ledger.amt')).toMatchObject({ role: 'up', hop: 1 })     // seed 1's
    expect(cardOf(v, 'dash.amt')).toMatchObject({ role: 'down', hop: 1 })     // seed 2's
    // Seed 2's rollup-only partner too: its cell is accounted against seed 2.
    expect(cardOf(v, 'crm')).toMatchObject({ role: 'down', hop: 1, approx: 5 })
    // Two hops from its nearest seed: the depth scopes it away.
    expect(cardOf(v, 'audit.amt')).toBeUndefined()
    expect(v.counts).toEqual({ up: 1, down: 2 })

    expect(cardOf(view({ depthUp: 2 }), 'audit.amt')).toMatchObject({ role: 'up', hop: 2 })
  })

  it('the wires cover both seeds, at every grain the reader has open', () => {
    expect(wireKeys(view())).toEqual([
      'ledger.amt>orders.amt:raw:1',
      'sales.amt>dash.amt:raw:1',
      'sales>crm:rollup:5',
    ])
    // Everything shut: the same two flows, rolled up to the lane roots.
    expect(wireKeys(view({ traceExpansion: new Set() }))).toEqual(['FIN>RAW:raw:1', 'MART>BI:raw:1'])
  })

  it('measured off the first seed alone, seed 2 and its partners fall out — the bug this fixes', () => {
    const v = view({ focusUrns: undefined })
    expect(cardOf(v, 'sales')).toBeUndefined()
    expect(cardOf(v, 'dash.amt')).toBeUndefined()
    expect(cardOf(v, 'crm')).toBeUndefined()
  })
})

describe('buildTraceView — one seed is exactly what it always was', () => {
  const estates: Array<[string, { model: TraceViewInputs['model']; layers: TraceViewInputs['layers']; assignments: TraceViewInputs['assignments'] }, string[]]> = [
    ['cfo', cfoEstate(), ['tableau', 'cfo', 'INTERMEDIATE_T2']],
    ['table', tableEstate(), ['RAW', 'orders', 'MART']],
    ['roots ⊃ node', rootsNodeEstate(3), ['ROOT', 'a1']],
    ['coarse cells', coarseCellsEstate(), ['dept', 'ledger_db']],
    ['coarse then fine', coarseThenFineEstate(), ['dept', 'ledger_db', 'orders_db', 'orders', 'journal']],
    ['anchored', anchoredEstate(), []],
  ]
  for (const [name, e, open] of estates) {
    it(`${name}: focusUrns [focus] deep-equals focusUrns omitted`, () => {
      for (const depth of [1, 25]) {
        const inputs: TraceViewInputs = {
          model: e.model, focusUrn: e.model.focusUrn, layers: e.layers, assignments: e.assignments, viewIsCurated: true,
          traceExpansion: new Set(open), showUpstream: true, showDownstream: true, depthUp: depth, depthDown: depth,
        }
        expect(buildTraceView({ ...inputs, focusUrns: [e.model.focusUrn] })).toEqual(buildTraceView(inputs))
      }
    })
  }
})
