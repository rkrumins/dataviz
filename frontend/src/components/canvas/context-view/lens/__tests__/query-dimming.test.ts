/**
 * The filter is a POST-PASS, not a rebuild (2026-08-22).
 *
 * MEASURED on the wide table (505 cards): every keystroke in "Filter
 * connections…" re-ran the whole layout — mean 325 ms of blocked main
 * thread per letter, worst 360 ms. But the filter only ever sets
 * `dimmed`: it changes no population, no geometry, no count. So the
 * board is laid out ONCE without it and the dimming applied over the
 * result, which is a pass over the drawn cards.
 *
 * The equivalence pin below is what makes that safe: laying out WITH a
 * query and dimming a query-less layout must produce the same board.
 */
import { describe, it, expect } from 'vitest'
import { applyQueryDimming } from '../query-dimming'
import { buildLensSubgraph } from '../lens-subgraph'
import { buildFocusLayout, initialLensViewState } from '../focus-layout'
import type { LensWalkNode } from '../closure-adapter'
import type { FocusCard, FocusEdge, FocusGraph } from '../focus-cards'

const card = (id: string, label: string, dimmed = false): FocusCard =>
  ({ id, nodeId: `urn:${id}`, label, dimmed }) as unknown as FocusCard
const edge = (id: string, source: string, target: string): FocusEdge =>
  ({ id, source, target, dimmed: false }) as unknown as FocusEdge
const graphOf = (cards: FocusCard[], edges: FocusEdge[] = []): FocusGraph =>
  ({ cards, edges, bundledWires: [] }) as unknown as FocusGraph

describe('applyQueryDimming', () => {
  it('an empty filter costs nothing — the very same graph comes back', () => {
    const g = graphOf([card('a', 'orders')], [])
    expect(applyQueryDimming(g, '')).toBe(g)
    expect(applyQueryDimming(g, '   ')).toBe(g)
  })

  it('dims what does not match, leaves what does, and never un-dims', () => {
    const g = graphOf([card('a', 'fact_orders'), card('b', 'customers'), card('c', 'ORDERS_RAW'), card('d', 'orders_x', true)])
    const out = applyQueryDimming(g, 'Orders')
    const by = new Map(out.cards.map(c => [c.id, c.dimmed]))
    expect(by.get('a')).toBe(false)          // matches, case-insensitively
    expect(by.get('b')).toBe(true)           // does not
    expect(by.get('c')).toBe(false)          // matches, whatever the case
    expect(by.get('d')).toBe(true)           // was dimmed by its frame's own Find — stays
  })

  it('a wire dims only when BOTH of its ends do — the answer keeps its connections', () => {
    const g = graphOf(
      [card('a', 'fact_orders'), card('b', 'customers'), card('c', 'invoices')],
      [edge('e1', 'a', 'b'), edge('e2', 'b', 'c')],
    )
    const out = applyQueryDimming(g, 'orders')
    const by = new Map(out.edges.map(e => [e.id, e.dimmed]))
    expect(by.get('e1')).toBe(false)         // touches the match
    expect(by.get('e2')).toBe(true)          // background
  })

  it('the members a bundle hides are dimmed the same way', () => {
    const g = {
      ...graphOf([card('a', 'fact_orders'), card('b', 'customers')], []),
      bundledWires: [edge('m1', 'a', 'b'), edge('m2', 'b', 'b')],
    } as FocusGraph
    const out = applyQueryDimming(g, 'zzz')
    expect(out.bundledWires.every(w => w.dimmed)).toBe(true)
  })
})

describe('the post-pass is what the layout used to do', () => {
  /** A focus table with columns, three partner tables with their own. */
  const estate = () => {
    const wnode = (urn: string, type: string, label: string, extra: Record<string, unknown> = {}): LensWalkNode => ({
      id: urn, type: 'generic', position: { x: 0, y: 0 }, data: { urn, label, type, ...extra }, urn, displayName: label, entityType: type, ...extra,
    }) as unknown as LensWalkNode
    const nodes = [wnode('F', 'dataset', 'fact_orders', { childCount: 3 })]
    const contains: Array<[string, string]> = []
    const hops: Array<{ id: string; sourceUrn: string; targetUrn: string; edgeType: string }> = []
    for (let i = 0; i < 3; i++) { nodes.push(wnode(`F.c${i}`, 'schemaField', `order_col_${i}`)); contains.push(['F', `F.c${i}`]) }
    let k = 0
    for (const [t, label] of [['t0', 'raw_orders'], ['t1', 'customers'], ['t2', 'invoices']] as const) {
      nodes.push(wnode(t, 'dataset', label, { childCount: 2 }))
      for (let i = 0; i < 2; i++) {
        nodes.push(wnode(`${t}.c${i}`, 'schemaField', `${label}_col_${i}`))
        contains.push([t, `${t}.c${i}`])
        hops.push({ id: `h${k++}`, sourceUrn: `${t}.c${i}`, targetUrn: `F.c${i % 3}`, edgeType: 'FLOWS_TO' })
      }
    }
    return buildLensSubgraph<LensWalkNode>({
      focusUrn: 'F', nodes, lineageEdges: hops,
      containmentEdges: contains.map(([s, t]) => ({ sourceUrn: s, targetUrn: t })),
      frontierUp: [], frontierDown: [],
    })
  }

  it('laying out WITH a query equals dimming a query-less layout — cards and wires alike', () => {
    const sg = estate()
    const view = initialLensViewState(sg)
    const base = { sg, view, hiddenTypes: new Set<string>(), extendStatus: new Map(), childrenAll: new Map(), childrenAllStatus: new Map(), walkStatus: 'done' as const }
    for (const query of ['orders', 'CUSTOM', 'nothing_matches_this', '']) {
      const withQuery = buildFocusLayout({ ...base, query })
      const dimmedAfter = applyQueryDimming(buildFocusLayout({ ...base, query: '' }), query)
      expect(withQuery.cards.map(c => `${c.id}:${c.dimmed}`)).toEqual(dimmedAfter.cards.map(c => `${c.id}:${c.dimmed}`))
      expect(withQuery.edges.map(e => `${e.id}:${e.dimmed}`)).toEqual(dimmedAfter.edges.map(e => `${e.id}:${e.dimmed}`))
    }
  })
})
