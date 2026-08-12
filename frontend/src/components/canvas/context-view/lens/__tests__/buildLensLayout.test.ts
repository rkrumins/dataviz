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
  mergeExpansion,
  mergeNodes,
  type LensSessionState,
} from '../lensGraph'
import {
  buildLensLayout,
  lensCardId,
  lensColumnKey,
  lensFrameId,
  LENS_COLUMN_W,
  LENS_COL_GAP,
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

  it('sizes every frame to contain its members', () => {
    const layout = buildLensLayout(nested())
    const byId = new Map(layout.frames.map(f => [f.id, f]))
    for (const card of layout.cards) {
      if (!card.parentFrameId) continue
      const frame = byId.get(card.parentFrameId)!
      expect(card.y + card.h).toBeLessThanOrEqual(frame.h)
      expect(card.x + card.w).toBeLessThanOrEqual(frame.w)
    }
    for (const frame of layout.frames) {
      if (!frame.parentFrameId) continue
      const parent = byId.get(frame.parentFrameId)!
      expect(frame.y + frame.h).toBeLessThanOrEqual(parent.h)
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
