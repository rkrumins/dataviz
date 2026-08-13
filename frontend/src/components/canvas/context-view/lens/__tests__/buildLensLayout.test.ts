/**
 * buildLensLayout — geometric invariants over realistic sessions.
 *
 * Fixtures are built by driving the real merges (never hand-assembled
 * state), so these tests break when the merge contract and the builder
 * drift apart. The invariants: columns are monotone in hop with no cap,
 * frames contain their members, nothing in a column overlaps, hidden
 * rows are counted pages (never silent drops), and every card at every
 * nesting depth carries both expansion gestures.
 */
import { describe, expect, it } from 'vitest'
import type { GraphEdge, GraphNode, TraceV2Result } from '@/providers/GraphDataProvider'
import {
  createLensSession,
  expansionKeyOf,
  mergeAncestors,
  mergeChildren,
  mergeDegrees,
  mergeDrill,
  mergeExpansion,
  mergeNodes,
  startDrill,
  type LensSessionState,
} from '../lensGraph'
import {
  buildLensLayout,
  lensCardId,
  lensColumnKey,
  lensFrameId,
  LENS_COLUMN_W,
  LENS_COL_GAP,
  LENS_CARD_W,
  LENS_FRAME_PAD,
} from '../buildLensLayout'

const OPTS = { containmentEdgeTypes: ['CONTAINS'] }

let seq = 0
const edge = (s: string, t: string, edgeType = 'FLOWS_TO', properties?: Record<string, unknown>): GraphEdge =>
  ({ id: `e${seq++}`, sourceUrn: s, targetUrn: t, edgeType, properties })
const node = (urn: string, entityType = 'dataset', displayName?: string): GraphNode =>
  ({ urn, entityType, displayName: displayName ?? `Name ${urn}`, properties: {} })

const trace = (overrides: Partial<TraceV2Result> = {}): TraceV2Result => ({
  nodes: [],
  edges: [],
  containmentEdges: [],
  upstreamUrns: new Set<string>(),
  downstreamUrns: new Set<string>(),
  focus: { urn: 'f', level: 1, entityType: 'app' },
  effectiveLevel: 1,
  isInherited: false,
  inheritedFromUrn: null,
  truncated: false,
  truncationReason: null,
  ...overrides,
})

const expand = (
  s: LensSessionState,
  dir: 'up' | 'down',
  urn: string,
  rawEdges: GraphEdge[],
  tr: TraceV2Result | null = null,
) => mergeExpansion(s, expansionKeyOf(dir, urn), urn, { rawEdges, rawTruncated: false, trace: tr }, OPTS)

/** Focal "Customer Portal" consuming two columns of dim_customer, one
 *  column of rpt_360, and the dataset gold_orders directly. */
function appFixture(): LensSessionState {
  let s = createLensSession('app')
  s = mergeNodes(s, [
    node('app', 'app', 'Customer Portal'),
    node('dim.c1', 'column'),
    node('dim.c2', 'column'),
    node('rpt.c1', 'column'),
    node('gold_orders', 'dataset', 'Gold Orders'),
    node('dim_customer', 'dataset', 'Dim Customer'),
    node('rpt_360', 'dataset', 'Rpt 360'),
  ])
  s = expand(
    s,
    'down',
    'app',
    [
      edge('app', 'dim.c1', 'CONSUMES'),
      edge('app', 'dim.c2', 'CONSUMES'),
      edge('app', 'rpt.c1', 'CONSUMES'),
      edge('app', 'gold_orders', 'CONSUMES'),
    ],
    trace({
      containmentEdges: [
        edge('dim_customer', 'dim.c1', 'CONTAINS'),
        edge('dim_customer', 'dim.c2', 'CONTAINS'),
        edge('rpt_360', 'rpt.c1', 'CONTAINS'),
      ],
    }),
  )
  s = expand(s, 'up', 'app', [])
  s = mergeAncestors(s, 'app', [node('domain', 'domain', 'Retail Domain')])
  return s
}

describe('first paint of a mixed-grain focal', () => {
  it('groups sibling columns into dataset frames and leaves singles standalone', () => {
    const layout = buildLensLayout(appFixture())
    // dim_customer holds two of the consumed columns → synthetic frame.
    const dimFrame = layout.frames.find(f => f.urn === 'dim_customer')
    expect(dimFrame).toBeDefined()
    expect(dimFrame!.label).toBe('Dim Customer')
    const framedCards = layout.cards.filter(c => c.parentFrameId === dimFrame!.id)
    expect(new Set(framedCards.map(c => c.urn))).toEqual(new Set(['dim.c1', 'dim.c2']))
    // rpt.c1 has no carded sibling — standalone with its parent named.
    const rpt = layout.cards.find(c => c.urn === 'rpt.c1')!
    expect(rpt.parentFrameId).toBeUndefined()
    expect(rpt.parentLabel).toBe('Rpt 360')
    // gold_orders consumed directly — a plain card.
    expect(layout.cards.find(c => c.urn === 'gold_orders')!.parentFrameId).toBeUndefined()
  })

  it('gives the focal its breadcrumb and every card both gestures', () => {
    const layout = buildLensLayout(appFixture())
    const focal = layout.cards.find(c => c.isFocal)!
    expect(focal.breadcrumb.map(b => b.urn)).toEqual(['domain'])
    for (const card of layout.cards) {
      expect(card.pills.up).toBeDefined()
      expect(card.pills.down).toBeDefined()
      expect(card.chevron).toBeDefined()
    }
  })

  it('emits pill hints only where a degree was measured', () => {
    let s = appFixture()
    s = mergeDegrees(s, { 'dim.c1': { in: 5, out: 1 } })
    const layout = buildLensLayout(s)
    const measured = layout.cards.find(c => c.urn === 'dim.c1')!
    // 5 measured upstream, 1 drawn (the CONSUMES record) → 4 more.
    expect(measured.pills.up.hint).toBe(4)
    const unknown = layout.cards.find(c => c.urn === 'dim.c2')!
    expect(unknown.pills.up.hint).toBeUndefined()
    expect(unknown.pills.up.exhausted).toBe(false)
  })
})

describe('coarse focal with rollup lineage', () => {
  it('draws drillable rollup edges with their bundled floor', () => {
    let s = createLensSession('domainA')
    s = expand(s, 'down', 'domainA', [], trace({
      edges: [edge('domainA', 'domainB', 'AGGREGATED', { weight: 12, sourceEdgeTypes: ['FLOWS_TO'] })],
      nodes: [node('domainB', 'domain')],
    }))
    const layout = buildLensLayout(s)
    expect(layout.cards.map(c => c.urn).sort()).toEqual(['domainA', 'domainB'])
    expect(layout.edges).toHaveLength(1)
    expect(layout.edges[0].drillable).toBe(true)
    expect(layout.edges[0].bundledCount).toBe(12)
  })
})

describe('walks', () => {
  it('lays out a 6-hop walk with monotone columns and no cap', () => {
    let s = createLensSession('f')
    const chain = ['f', 'a', 'b', 'c', 'd', 'e5', 'e6']
    for (let i = 0; i < chain.length - 1; i++) {
      s = expand(s, 'down', chain[i], [edge(chain[i], chain[i + 1])])
    }
    const layout = buildLensLayout(s)
    expect(layout.columns.map(c => c.hop)).toEqual([0, 1, 2, 3, 4, 5, 6])
    for (const col of layout.columns) {
      expect(col.x).toBe(col.hop * (LENS_COLUMN_W + LENS_COL_GAP))
    }
    // Every hop's ⊕ stayed available: the frontier card still has pills.
    const tip = layout.cards.find(c => c.urn === 'e6')!
    expect(tip.pills.down.state).toBe('idle')
  })

  it('renders a both-direction cycle as one card with two edges', () => {
    let s = createLensSession('f')
    s = expand(s, 'down', 'f', [edge('f', 'x')])
    s = expand(s, 'up', 'f', [edge('x', 'f')])
    const layout = buildLensLayout(s)
    expect(layout.cards.filter(c => c.urn === 'x')).toHaveLength(1)
    expect(layout.edges).toHaveLength(2)
  })
})

describe('nested containment opens', () => {
  function nested(): LensSessionState {
    let s = createLensSession('f')
    s = expand(s, 'down', 'f', [edge('f', 'partner')])
    const kidsPage = (parent: string, kids: string[]) => ({
      children: kids.map(k => node(k)),
      containmentEdges: kids.map(k => edge(parent, k, 'CONTAINS')),
      lineageEdges: [],
      totalChildren: kids.length,
      hasMore: false,
      nextCursor: null,
    })
    s = mergeChildren(s, 'f', kidsPage('f', ['c1']), OPTS)
    s = mergeChildren(s, 'c1', kidsPage('c1', ['c2']), OPTS)
    s = mergeChildren(s, 'c2', kidsPage('c2', ['c3']), OPTS)
    return s
  }

  it('nests frames three deep with the opened card as each frame header', () => {
    const layout = buildLensLayout(nested())
    const fFrame = layout.frames.find(f => f.urn === 'f')!
    const c1Frame = layout.frames.find(f => f.urn === 'c1')!
    const c2Frame = layout.frames.find(f => f.urn === 'c2')!
    expect(fFrame.headerCardId).toBe(lensCardId('f'))
    expect(c1Frame.parentFrameId).toBe(fFrame.id)
    expect(c2Frame.parentFrameId).toBe(c1Frame.id)
    const c3 = layout.cards.find(c => c.urn === 'c3')!
    expect(c3.parentFrameId).toBe(c2Frame.id)
    // The dual-axis requirement, three levels down: c3 still offers both.
    expect(c3.pills.down.state).toBe('idle')
    expect(c3.chevron.state).toBe('idle')
    // All at the focal's hop — opening containment never moves sideways.
    expect(c3.hop).toBe(0)
  })

  it('bounds every member inside its frame (absolute coordinates)', () => {
    const layout = buildLensLayout(nested())
    const byId = new Map(layout.frames.map(f => [f.id, f]))
    for (const card of layout.cards) {
      if (!card.parentFrameId) continue
      const frame = byId.get(card.parentFrameId)!
      expect(card.x).toBeGreaterThanOrEqual(frame.x)
      expect(card.y).toBeGreaterThanOrEqual(frame.y)
      expect(card.x + card.w).toBeLessThanOrEqual(frame.x + frame.w)
      expect(card.y + card.h).toBeLessThanOrEqual(frame.y + frame.h)
    }
    for (const frame of layout.frames) {
      if (!frame.parentFrameId) continue
      const parent = byId.get(frame.parentFrameId)!
      expect(frame.x).toBeGreaterThanOrEqual(parent.x)
      expect(frame.y).toBeGreaterThanOrEqual(parent.y)
      expect(frame.x + frame.w).toBeLessThanOrEqual(parent.x + parent.w)
      expect(frame.y + frame.h).toBeLessThanOrEqual(parent.y + parent.h)
    }
  })
})

describe('pagination', () => {
  it('pages a wide frame through a fixed window and counts the rest', () => {
    let s = createLensSession('f')
    s = expand(s, 'down', 'f', [edge('f', 'partner')])
    const kids = Array.from({ length: 20 }, (_, i) => `k${String(i).padStart(2, '0')}`)
    s = mergeChildren(s, 'f', {
      children: kids.map(k => node(k)),
      containmentEdges: kids.map(k => edge('f', k, 'CONTAINS')),
      lineageEdges: [],
      totalChildren: 20,
      hasMore: false,
      nextCursor: null,
    }, OPTS)

    const first = buildLensLayout(s)
    const frame1 = first.frames.find(f => f.urn === 'f')!
    expect(frame1.totalMembers).toBe(20)
    expect(frame1.shownMembers).toBe(8)
    expect(frame1.pageCount).toBe(3)

    const third = buildLensLayout(s, { pages: new Map([[lensFrameId('f'), 2]]) })
    const frame3 = third.frames.find(f => f.urn === 'f')!
    expect(frame3.page).toBe(2)
    expect(frame3.shownMembers).toBe(4)
    const shownUrns = third.cards.filter(c => c.parentFrameId === frame3.id && !c.isFocal).map(c => c.urn)
    expect(shownUrns).toEqual(['k16', 'k17', 'k18', 'k19'])
  })

  it('pages a crowded column and keeps edges honest about hidden cards', () => {
    let s = createLensSession('f')
    const partners = Array.from({ length: 30 }, (_, i) => `p${String(i).padStart(2, '0')}`)
    s = expand(s, 'down', 'f', partners.map(p => edge('f', p)))
    const layout = buildLensLayout(s)
    const col1 = layout.columns.find(c => c.hop === 1)!
    expect(col1.totalRoots).toBe(30)
    expect(col1.shownRoots).toBe(12)
    expect(col1.pageCount).toBe(3)
    // Edges only to rendered cards; hidden ones are counted, not drawn.
    expect(layout.edges).toHaveLength(12)
    const page2 = buildLensLayout(s, { pages: new Map([[lensColumnKey(1), 2]]) })
    expect(page2.columns.find(c => c.hop === 1)!.shownRoots).toBe(6)
  })
})

describe('column geometry invariants', () => {
  it('no vertical overlap among a column root entries', () => {
    const layout = buildLensLayout(appFixture())
    const rootsAt = (hop: number) => [
      ...layout.cards.filter(c => c.hop === hop && !c.parentFrameId),
      ...layout.frames.filter(f => f.hop === hop && !f.parentFrameId),
    ].sort((a, b) => a.y - b.y)
    for (const hop of layout.columns.map(c => c.hop)) {
      const roots = rootsAt(hop)
      for (let i = 1; i < roots.length; i++) {
        expect(roots[i].y).toBeGreaterThanOrEqual(roots[i - 1].y + roots[i - 1].h)
      }
    }
  })
})

describe('banners', () => {
  it('dedupes inherited banners and carries truncation reasons', () => {
    let s = createLensSession('f')
    const inherited = trace({ isInherited: true, inheritedFromUrn: 'parentDb' })
    s = expand(s, 'up', 'f', [], inherited)
    s = expand(s, 'down', 'f', [], inherited)
    s = mergeExpansion(
      s,
      expansionKeyOf('down', 'other'),
      'other',
      { rawEdges: [], rawTruncated: true, trace: null },
      OPTS,
    )
    const layout = buildLensLayout(s)
    expect(layout.banners.filter(b => b.kind === 'inherited')).toHaveLength(1)
    const truncated = layout.banners.filter(b => b.kind === 'truncated')
    expect(truncated).toHaveLength(1)
    expect(truncated[0].detail).toBe('fetch_limit')
  })
})

/** Focal domain f —AGG→ B, drilled at B into level-aligned constituents
 *  (true A-side endpoints live UNDER f and are not placed). */
function drilledFixture(): LensSessionState {
  let s = createLensSession('f')
  s = mergeNodes(s, [node('f', 'domain', 'Domain F'), node('B', 'domain', 'Domain B')])
  s = expand(s, 'down', 'f', [], trace({
    edges: [edge('f', 'B', 'AGGREGATED', { weight: 9, sourceEdgeTypes: ['FLOWS_TO'] })],
    nodes: [node('B', 'domain', 'Domain B')],
  }))
  const rollup = [...s.records.values()].find(r => r.aggregated)!
  s = startDrill(s, rollup.id, 'B')
  s = mergeDrill(s, rollup.id, trace({
    nodes: [node('App1', 'app', 'App One'), node('App2', 'app', 'App Two'), node('fApp', 'app', 'F App')],
    containmentEdges: [
      edge('B', 'App1', 'CONTAINS'),
      edge('B', 'App2', 'CONTAINS'),
      edge('f', 'fApp', 'CONTAINS'),
    ],
    edges: [
      edge('fApp', 'App1', 'AGGREGATED', { weight: 4 }),
      edge('fApp', 'App2', 'AGGREGATED', { weight: 5 }),
    ],
  }), OPTS, 'B')
  return s
}

describe('refined structure and wire resolution', () => {
  it('keeps the drilled partner framed and anchors wires on the whole side', () => {
    const layout = buildLensLayout(drilledFixture())
    // fApp (true source, under the focal) is NOT carded; B stays framed.
    expect(layout.cards.map(c => c.urn).sort()).toEqual(['App1', 'App2', 'B', 'f'])
    const bFrame = layout.frames.find(f => f.urn === 'B')!
    expect(bFrame.headerCardId).toBe(lensCardId('B'))
    expect(bFrame.mode).toBe('all')
    expect(bFrame.connectedCount).toBe(2)
    expect(bFrame.stripY).toBeDefined()
    // Both wires resolve their unplaced source to the focal card.
    expect(layout.edges).toHaveLength(2)
    for (const e of layout.edges) {
      expect(e.sourceCardId).toBe(lensCardId('f'))
    }
    // The refined rollup no longer draws.
    expect(layout.edges.some(e => e.targetCardId === lensCardId('B'))).toBe(false)
  })

  it('snaps wires to the true endpoint once opening the focal cards it', () => {
    let s = drilledFixture()
    s = mergeChildren(s, 'f', {
      children: [node('fApp', 'app', 'F App')],
      containmentEdges: [edge('f', 'fApp', 'CONTAINS')],
      lineageEdges: [],
      totalChildren: 1,
      hasMore: false,
      nextCursor: null,
    }, OPTS)
    const layout = buildLensLayout(s)
    expect(layout.cards.some(c => c.urn === 'fApp')).toBe(true)
    for (const e of layout.edges) {
      expect(e.sourceCardId).toBe(lensCardId('fApp'))
    }
  })

  it('merges records resolving to one card pair into a single wire', () => {
    let s = createLensSession('f')
    s = expand(s, 'down', 'f', [], trace({
      edges: [edge('f', 'B', 'AGGREGATED', { weight: 9 })],
      nodes: [node('B', 'domain', 'Domain B')],
    }))
    const rollup = [...s.records.values()].find(r => r.aggregated)!
    s = mergeDrill(s, rollup.id, trace({
      nodes: [node('App1', 'app'), node('fApp1', 'app'), node('fApp2', 'app')],
      containmentEdges: [
        edge('B', 'App1', 'CONTAINS'),
        edge('f', 'fApp1', 'CONTAINS'),
        edge('f', 'fApp2', 'CONTAINS'),
      ],
      edges: [
        edge('fApp1', 'App1', 'AGGREGATED', { weight: 4 }),
        edge('fApp2', 'App1', 'AGGREGATED', { weight: 5 }),
        // An edge internal to one still-whole side never draws.
        edge('fApp1', 'fApp2', 'AGGREGATED', { weight: 2 }),
      ],
    }), OPTS, 'B')
    const layout = buildLensLayout(s)
    expect(layout.edges).toHaveLength(1)
    const wire = layout.edges[0]
    expect(wire.recordIds).toHaveLength(2)
    expect(wire.bundledCount).toBe(9)
    expect(wire.sourceCardId).toBe(lensCardId('f'))
    expect(wire.targetCardId).toBe(lensCardId('App1'))
  })

  it('a done-empty drill leaves the wire drawn but no longer drillable', () => {
    let s = createLensSession('f')
    s = expand(s, 'down', 'f', [], trace({
      edges: [edge('f', 'B', 'AGGREGATED', { weight: 3 })],
      nodes: [node('B', 'domain')],
    }))
    const rollup = [...s.records.values()].find(r => r.aggregated)!
    s = mergeDrill(s, rollup.id, trace({ edges: [] }), OPTS, 'B')
    const layout = buildLensLayout(s)
    expect(layout.edges).toHaveLength(1)
    expect(layout.edges[0].drillable).toBe(false)
    expect(layout.edges[0].drillState).toBe('done')
  })

  it('counts column connections through resolution', () => {
    const layout = buildLensLayout(drilledFixture())
    expect(layout.columns.find(c => c.hop === 1)!.connections).toBe(2)
  })
})

describe('connected | all membership', () => {
  const withAllChildren = () => {
    let s = drilledFixture()
    s = mergeChildren(s, 'B', {
      children: [node('App3', 'app', 'App Three'), node('App1', 'app', 'App One'), node('App2', 'app', 'App Two')],
      containmentEdges: [
        edge('B', 'App3', 'CONTAINS'),
        edge('B', 'App1', 'CONTAINS'),
        edge('B', 'App2', 'CONTAINS'),
      ],
      lineageEdges: [],
      totalChildren: 3,
      hasMore: false,
      nextCursor: null,
    }, OPTS)
    return s
  }

  it('all mode shows everything, quiets the unconnected, leads with the connected', () => {
    const layout = buildLensLayout(withAllChildren())
    const bFrame = layout.frames.find(f => f.urn === 'B')!
    expect(bFrame.mode).toBe('all')
    expect(bFrame.totalMembers).toBe(3)
    expect(bFrame.connectedCount).toBe(2)
    expect(bFrame.containedTotal).toBe(3)
    const members = layout.cards
      .filter(c => c.parentFrameId === bFrame.id && c.id !== bFrame.headerCardId)
      .sort((a, b) => a.y - b.y)
    // Connected members lead despite App3 being first in server order.
    expect(members.map(m => m.urn)).toEqual(['App1', 'App2', 'App3'])
    expect(members.map(m => m.connected)).toEqual([true, true, false])
  })

  it('connected mode keeps unconnected contents off the board', () => {
    const layout = buildLensLayout(withAllChildren(), { connectedFrames: new Set(['B']) })
    const bFrame = layout.frames.find(f => f.urn === 'B')!
    expect(bFrame.mode).toBe('connected')
    expect(layout.cards.some(c => c.urn === 'App3')).toBe(false)
    expect(layout.cards.filter(c => c.parentFrameId === bFrame.id)).toHaveLength(3)
  })
})

describe('pass-through chain demotion', () => {
  it('folds a walked single-child chain into one frame with the path named', () => {
    let s = createLensSession('f')
    s = mergeNodes(s, [node('C', 'domain', 'Domain C')])
    s = expand(s, 'down', 'f', [], trace({
      edges: [edge('f', 'C', 'AGGREGATED', { weight: 6 })],
      nodes: [node('C', 'domain', 'Domain C')],
    }))
    const wave1 = [...s.records.values()].find(r => r.aggregated)!
    s = startDrill(s, wave1.id, 'C')
    s = mergeDrill(s, wave1.id, trace({
      nodes: [node('PROD', 'domain', 'PROD'), node('fApp', 'app', 'F App')],
      containmentEdges: [edge('C', 'PROD', 'CONTAINS'), edge('f', 'fApp', 'CONTAINS')],
      edges: [edge('fApp', 'PROD', 'AGGREGATED', { weight: 6 })],
    }), OPTS, 'C')
    const wave2 = [...s.records.values()].find(r => r.aggregated && r.target === 'PROD')!
    s = startDrill(s, wave2.id, 'PROD')
    s = mergeDrill(s, wave2.id, trace({
      nodes: [node('CURATED', 'domain', 'CURATED')],
      containmentEdges: [edge('PROD', 'CURATED', 'CONTAINS')],
      edges: [edge('fApp', 'CURATED', 'AGGREGATED', { weight: 6 })],
    }), OPTS, 'PROD')
    const wave3 = [...s.records.values()].find(r => r.aggregated && r.target === 'CURATED')!
    s = startDrill(s, wave3.id, 'CURATED')
    s = mergeDrill(s, wave3.id, trace({
      nodes: [node('app1', 'app', 'Consumer App')],
      containmentEdges: [edge('CURATED', 'app1', 'CONTAINS')],
      edges: [edge('fApp', 'app1', 'AGGREGATED', { weight: 6 })],
    }), OPTS, 'CURATED')

    const layout = buildLensLayout(s)
    // One frame — the walked intermediates fold into C's header path.
    expect(layout.frames.map(f => f.urn)).toEqual(['C'])
    const cFrame = layout.frames[0]
    expect(cFrame.walkPath).toEqual(['PROD', 'CURATED'])
    const app1 = layout.cards.find(c => c.urn === 'app1')!
    expect(app1.parentFrameId).toBe(cFrame.id)
    expect(layout.cards.some(c => c.urn === 'PROD' || c.urn === 'CURATED')).toBe(false)
    // The wire runs whole-side to deepest member.
    expect(layout.edges).toHaveLength(1)
    expect(layout.edges[0].sourceCardId).toBe(lensCardId('f'))
    expect(layout.edges[0].targetCardId).toBe(lensCardId('app1'))
    // The capped/branching end stays live: the last record is drillable.
    expect(layout.edges[0].drillable).toBe(true)
  })
})

describe('column widths under nesting', () => {
  it('grows a column for its deepest frame and shifts later columns', () => {
    let s = drilledFixture()
    // Drill App1 (anchor side) into a table — B ⊃ App1 ⊃ tbl, depth 2.
    const mid = [...s.records.values()].find(r => r.aggregated && r.target === 'App1')!
    s = startDrill(s, mid.id, 'App1')
    s = mergeDrill(s, mid.id, trace({
      nodes: [node('tbl', 'dataset', 'Orders')],
      containmentEdges: [edge('App1', 'tbl', 'CONTAINS')],
      edges: [edge('fApp', 'tbl', 'AGGREGATED', { weight: 4 })],
    }), OPTS, 'App1')
    // A hop-2 partner via App1's own expansion.
    s = expand(s, 'down', 'App1', [edge('App1', 'ext')])

    const layout = buildLensLayout(s)
    const col1 = layout.columns.find(c => c.hop === 1)!
    const col2 = layout.columns.find(c => c.hop === 2)!
    expect(col1.w).toBe(LENS_CARD_W + 4 * LENS_FRAME_PAD)
    expect(col1.w).toBeGreaterThan(LENS_COLUMN_W)
    expect(col2.x).toBe(col1.x + col1.w + LENS_COL_GAP)
    // Leaf cards never shrink below the base card width.
    const tbl = layout.cards.find(c => c.urn === 'tbl')!
    expect(tbl.w).toBeGreaterThanOrEqual(LENS_CARD_W)
  })
})
