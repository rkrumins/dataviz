/**
 * traceViewModel — WIRES: the grain rule.
 *
 * The one question this suite answers: when the same flows can be stated at
 * two grains — a rollup between containers, and the raw hops between their
 * columns — WHICH ONE gets drawn? Drawing both is the double-draw that made
 * the old overlay unreadable; drawing neither loses the lineage.
 *
 * RAW EVIDENCE WINS. On the CFO estate the wire lands on the chart the reader
 * opened the dashboard to see, re-anchored up to whatever is closed on the
 * other side, and refines as they open more. The authored rollups draw only
 * where raw hops cannot speak: a pair with none under it at all, or one the
 * ledger will not vouch for (then, as a residual, for the difference).
 */
import { describe, it, expect } from 'vitest'
import { buildTraceView } from '../traceViewModel'
import { buildLedger, pairKey } from '../traceWireLedger'
import { cfoEstate } from '@/test/fixtures/traceEstates'
import type { TraceViewInputs, TraceWire } from '../traceViewModel'
import type { LensWalkModel, LensWalkNode } from '@/components/canvas/context-view/lens/closure-adapter'
import { buildLensSubgraph, projectLensEdges } from '@/components/canvas/context-view/lens/lens-subgraph'

type Estate = ReturnType<typeof cfoEstate>

const inputs = (e: Estate, expansion: string[]): TraceViewInputs => ({
  model: e.model, focusUrn: 'cfo', layers: e.layers, assignments: e.assignments, viewIsCurated: true,
  traceExpansion: new Set(expansion), showUpstream: true, showDownstream: true, depthUp: 25, depthDown: 25,
})
const view = (expansion: string[], over: Partial<TraceViewInputs> = {}) =>
  buildTraceView({ ...inputs(cfoEstate(), expansion), ...over })
const desc = (w: TraceWire) => `${w.source}>${w.target}:${w.kind}:${w.edgeCount}`

/** Fully drilled: every container on both sides open. */
const ALL_OPEN = ['tableau', 'cfo', 'aov', 'INTERMEDIATE_T2', 'orders', 'REPORTING', 'rpt']
/** The warehouse side half-open: orders drilled, REPORTING still closed. */
const HALF_OPEN = ['tableau', 'cfo', 'aov', 'INTERMEDIATE_T2', 'orders']

/** The projection the wires must agree with, recomputed here from the MODEL
 *  so the assertion does not lean on the code under test. */
const projectRaw = (model: LensWalkModel, visible: ReadonlySet<string>): Map<string, number> => {
  const parentOf = new Map(model.containmentEdges.map(c => [c.targetUrn, c.sourceUrn]))
  const nearestVisible = (urn: string): string | null => {
    let cursor: string | undefined = urn
    while (cursor) {
      if (visible.has(cursor)) return cursor
      cursor = parentOf.get(cursor)
    }
    return null
  }
  const pairs = new Map<string, number>()
  for (const e of model.lineageEdges) {
    if (e.kind === 'rollup') continue
    const s = nearestVisible(e.sourceUrn)
    const t = nearestVisible(e.targetUrn)
    if (!s || !t || s === t) continue
    pairs.set(pairKey(s, t), (pairs.get(pairKey(s, t)) ?? 0) + 1)
  }
  return pairs
}

/** No summary wire restates another one level up: for any two rollup or
 *  residual wires, neither sits inside the other on BOTH ends. */
const expectNoNestedGrain = (model: LensWalkModel, wires: readonly TraceWire[]): void => {
  const within = (inner: string, outer: string) => inner === outer || isAncestorOf(model, outer, inner)
  const summaries = wires.filter(w => w.kind !== 'raw')
  for (const a of summaries) {
    for (const b of summaries) {
      if (a === b) continue
      expect(within(b.source, a.source) && within(b.target, a.target)).toBe(false)
    }
  }
}

const isAncestorOf = (model: LensWalkModel, ancestor: string, urn: string): boolean => {
  const parentOf = new Map(model.containmentEdges.map(c => [c.targetUrn, c.sourceUrn]))
  let cursor = parentOf.get(urn)
  while (cursor) {
    if (cursor === ancestor) return true
    cursor = parentOf.get(cursor)
  }
  return false
}

describe('buildTraceView — wires, grain rule', () => {
  it('closed partners: raw bundles re-anchored to the visible chart; authored rollups covered → dropped', () => {
    const v = view(['tableau', 'cfo'])
    const w = v.wires.map(desc).sort()
    // The reader opened the dashboard to see where the lineage lands, so it
    // lands on `aov` — not on `cfo`, which they have already opened past.
    // The rollups INTERMEDIATE_T2→cfo / REPORTING→cfo say the same flows one
    // level coarser and are dropped rather than drawn beside them.
    expect(w).toEqual(['INTERMEDIATE_T2>aov:raw:2', 'REPORTING>aov:raw:1'].sort())
    // Re-anchored, so each line is a bundle rather than the hop itself.
    for (const x of v.wires) expect(x.isBundled).toBe(true)
  })

  it('coarse-only estate: with no raw hops at all, the authored rollups ARE the lineage', () => {
    // The coarse phase of a walk, or an estate whose lineage only ever
    // materialises as :AGGREGATED. Nothing finer exists to draw, so the
    // rollups draw — at their authored endpoints, with their own weights.
    const e = cfoEstate()
    const model: LensWalkModel = { ...e.model, lineageEdges: e.model.lineageEdges.filter(x => x.kind === 'rollup') }
    const v = buildTraceView(inputs({ ...e, model }, ['tableau', 'cfo']))
    expect(v.wires.map(desc)).toEqual(['INTERMEDIATE_T2>cfo:rollup:2', 'REPORTING>cfo:rollup:1'])
  })

  it('rollups draw at the FINEST visible grain per cone, never twice a level apart', () => {
    // Rollups are materialised per containment-level pair, so orders→aov and
    // INTERMEDIATE_T2→cfo are the same flows one level apart. Open everything
    // and the inner pair — the one the reader drilled for — is the only one
    // that draws.
    const e = cfoEstate()
    const model: LensWalkModel = { ...e.model, lineageEdges: e.model.lineageEdges.filter(x => x.kind === 'rollup') }
    const v = buildTraceView(inputs({ ...e, model }, ALL_OPEN))
    expect(v.wires.map(desc)).toEqual(['orders>aov:rollup:2', 'rpt>aov:rollup:1'])
    expectNoNestedGrain(model, v.wires)
    // Closed, the same model draws the container pairs — grain follows what
    // the reader has opened, not what the model happens to hold.
    expect(buildTraceView(inputs({ ...e, model }, ['tableau', 'cfo'])).wires.map(desc))
      .toEqual(['INTERMEDIATE_T2>cfo:rollup:2', 'REPORTING>cfo:rollup:1'])
  })

  it('opening both sides refines to raw field wires and drops the rollup for that pair', () => {
    const v = view(HALF_OPEN)
    const kinds = new Set(v.wires.filter(x => x.source.startsWith('orders')).map(x => x.kind))
    expect(kinds).toEqual(new Set(['raw']))
    expect(v.wires.some(x => x.source === 'orders.channel' && x.target === 'aov.channel')).toBe(true)
    // The still-closed REPORTING side is re-anchored onto the container, and
    // still raw: its hop into aov.avg is loaded, so its rollup is redundant.
    expect(v.wires.map(desc)).toContain('REPORTING>aov.avg:raw:1')
    expect(v.wires.every(x => x.kind === 'raw')).toBe(true)
  })

  it('partial pair: raw + residual W−R', () => {
    const e = cfoEstate()
    const v = buildTraceView({ ...inputs(e, HALF_OPEN), completePairs: new Set() })
    const res = v.wires.filter(x => x.kind === 'residual')
    expect(res.length).toBeGreaterThan(0)
    // Each cone holds raw hops (W flows, R of them in the model) and the
    // ledger vouches for none of them, so each says what the raw wires
    // cannot: "there may be more here" — ONCE per cone. orders→aov is
    // weight 2 over 2 loaded hops, and the floor keeps it at 1 rather than
    // claiming the pair is settled; INTERMEDIATE_T2→cfo is that same cone one
    // level up and does not repeat it.
    expect(res.map(desc)).toEqual(['REPORTING>cfo:residual:1', 'orders>aov:residual:1'])
    for (const w of res) expect(w.complete).toBe(false)
    expectNoNestedGrain(e.model, v.wires)
    // The raw wires are all still there beside them, none of them vouched for.
    expect(v.wires.filter(x => x.kind === 'raw').map(desc).sort())
      .toEqual(['REPORTING>aov.avg:raw:1', 'orders.channel>aov.channel:raw:1', 'orders.net>aov.avg:raw:1'].sort())
    for (const w of v.wires.filter(x => x.kind === 'raw')) expect(w.complete).toBe(false)
  })

  it('residual counts what the raw wires do NOT show: W − R', () => {
    // Same estate, but the graph says orders → aov summarises FIVE flows
    // while the model holds two of them. The residual is the other three.
    const e = cfoEstate()
    const model: LensWalkModel = {
      ...e.model,
      lineageEdges: e.model.lineageEdges.map(x =>
        x.kind === 'rollup' && x.sourceUrn === 'orders' && x.targetUrn === 'aov' ? { ...x, weight: 5 } : x),
    }
    const v = buildTraceView({ ...inputs({ ...e, model }, HALF_OPEN), completePairs: new Set() })
    expect(v.wires.filter(x => x.kind === 'residual').map(desc)).toContain('orders>aov:residual:3')
  })

  it('a complete pair drops the rollup instead of drawing a residual', () => {
    const v = view(HALF_OPEN)   // default completePairs = every pair complete
    expect(v.wires.some(x => x.kind === 'residual')).toBe(false)
    expect(v.wires.some(x => x.source === 'orders' && x.target === 'aov')).toBe(false)
    for (const w of v.wires) expect(w.complete).toBe(true)
  })

  it('count parity: Σ raw wire counts == raw edges between visible-scoped endpoints', () => {
    const e = cfoEstate()
    const rawEdges = e.model.lineageEdges.filter(x => x.kind !== 'rollup')

    // However far the tree is open, every raw hop lands in exactly one wire:
    // each wire carries the hops that project onto its pair, no hop is
    // invented, none is dropped, none is counted twice.
    for (const expansion of [['tableau', 'cfo'], HALF_OPEN, ALL_OPEN]) {
      const v = view(expansion)
      const raw = v.wires.filter(w => w.kind === 'raw')
      const projected = projectRaw(e.model, v.visible)
      expect(new Set(raw.map(w => pairKey(w.source, w.target)))).toEqual(new Set(projected.keys()))
      for (const w of raw) expect(w.edgeCount).toBe(projected.get(pairKey(w.source, w.target)))
      expect(raw.reduce((n, w) => n + w.edgeCount, 0)).toBe(rawEdges.length)
    }

    // Fully drilled, each wire IS its hop — nothing bundled.
    for (const w of view(ALL_OPEN).wires) expect(w.isBundled).toBe(false)
    // Closed, the same three hops arrive as two re-anchored bundles.
    expect(view(['tableau', 'cfo']).wires.every(w => w.isBundled)).toBe(true)
  })

  it('no wire is ancestor↔descendant and every endpoint is a visible card', () => {
    const e = cfoEstate()
    for (const expansion of [['tableau', 'cfo'], HALF_OPEN, ALL_OPEN]) {
      const v = view(expansion)
      for (const w of v.wires) {
        expect(v.visible.has(w.source)).toBe(true)
        expect(v.visible.has(w.target)).toBe(true)
        expect(w.source).not.toBe(w.target)
        expect(isAncestorOf(e.model, w.source, w.target)).toBe(false)
        expect(isAncestorOf(e.model, w.target, w.source)).toBe(false)
      }
    }
  })

  it('a hop that would land on its own container is never drawn as a wire', () => {
    // A raw hop out of the focus's own column into the platform ABOVE it:
    // projected, it reads aov → tableau, a card wired to its own ancestor.
    // There is no such line to draw — the target contains the source.
    const e = cfoEstate()
    const model: LensWalkModel = {
      ...e.model,
      lineageEdges: [...e.model.lineageEdges,
        { id: 'r:aov.avg>tableau', sourceUrn: 'aov.avg', targetUrn: 'tableau', edgeType: 'TRANSFORMS', kind: 'raw' as const, weight: null }],
    }
    const v = buildTraceView({ ...inputs({ ...e, model }, ['tableau', 'cfo']) })
    expect(v.wires.some(w => w.source === 'aov' && w.target === 'tableau')).toBe(false)
  })

  it('direction scope: a hidden branch contributes no wires', () => {
    const v = view(['tableau', 'cfo'], { showUpstream: false })
    expect(v.visible.has('cfo')).toBe(true)      // the focus side stays
    expect(v.wires).toEqual([])                   // every partner left, so every wire did
  })

  it('is deterministic and id-ordered', () => {
    const a = view(HALF_OPEN)
    const b = view(HALF_OPEN)
    expect(JSON.stringify(a.wires)).toBe(JSON.stringify(b.wires))
    expect(a.wires.map(w => w.id)).toEqual([...a.wires.map(w => w.id)].sort())
    for (const w of a.wires) expect(w.id).toBe(`bundle:${w.source}>${w.target}:${w.kind}`)
  })
})

/**
 * The reviewer's case for inner-first accounting: a container with a sibling
 * the fine rollup says nothing about. C ⊃ {d1, d2}, d1 ⊃ d1.c, X ⊃ X.c, one
 * raw hop d1.c → X.c, and rollups d1 → X (weight 1) and C → X (weight 3).
 * With C open and d1/X closed, the visible cards are exactly C, d1, d2, X.
 */
const siblingEstate = (opts: { raw: boolean }) => {
  const node = (urn: string, type: string, childCount = 0): LensWalkNode => ({
    id: urn, type: 'default', position: { x: 0, y: 0 },
    data: { urn, label: urn, type, childCount }, urn, displayName: urn, entityType: type,
  }) as unknown as LensWalkNode
  const rawEdge = { id: 'r:d1.c>X.c', sourceUrn: 'd1.c', targetUrn: 'X.c', edgeType: 'TRANSFORMS', kind: 'raw' as const, weight: null }
  const model: LensWalkModel = {
    focusUrn: 'X',
    nodes: [node('C', 'container', 2), node('d1', 'dataset', 1), node('d2', 'dataset', 0),
      node('d1.c', 'schemaField'), node('X', 'dataset', 1), node('X.c', 'schemaField')],
    containmentEdges: [
      { sourceUrn: 'C', targetUrn: 'd1' }, { sourceUrn: 'C', targetUrn: 'd2' },
      { sourceUrn: 'd1', targetUrn: 'd1.c' }, { sourceUrn: 'X', targetUrn: 'X.c' },
    ],
    lineageEdges: [
      ...(opts.raw ? [rawEdge] : []),
      { id: 'g:d1>X', sourceUrn: 'd1', targetUrn: 'X', edgeType: 'AGGREGATED', kind: 'rollup' as const, weight: 1 },
      { id: 'g:C>X', sourceUrn: 'C', targetUrn: 'X', edgeType: 'AGGREGATED', kind: 'rollup' as const, weight: 3 },
    ],
    upstreamUrns: new Set(['C', 'd1', 'd2', 'd1.c']),
    downstreamUrns: new Set(), frontierUp: [], frontierDown: [], truncated: false, truncationReason: null,
    seedTruncated: false, seedCursor: null,
  }
  const base: TraceViewInputs = {
    model, focusUrn: 'X',
    layers: [{ id: 'src', name: 'Source', order: 0, entityTypes: [] }, { id: 'dst', name: 'Dest', order: 1, entityTypes: [] }],
    assignments: { C: { layerId: 'src' }, X: { layerId: 'dst' } },
    viewIsCurated: true, traceExpansion: new Set(['C']),
    showUpstream: true, showDownstream: true, depthUp: 25, depthDown: 25,
  }
  return base
}

describe('inner-first accounting — the sibling a fine rollup says nothing about', () => {
  it('vouched raw detail wins the whole cone; a stale W is not a flow', () => {
    const v = buildTraceView(siblingEstate({ raw: true }))
    expect([...v.visible].sort()).toEqual(['C', 'X', 'd1', 'd2'])
    // d1→X (W1) and C→X (W3) both hold the one raw hop, and the default
    // ledger vouches for it, so both are dropped: W=3 over one loaded flow
    // is aggregation staleness, not two flows d2 is hiding.
    expect(v.wires.map(desc)).toEqual(['d1>X:raw:1'])
  })

  it('coarse-only: the outer cone reports what the inner one did not', () => {
    const v = buildTraceView(siblingEstate({ raw: false }))
    // d1→X states 1. C→X counts 3 and 1 is already stated, so it draws the
    // OTHER 2 — the flows through d2, which no finer rollup mentions.
    expect(v.wires.map(desc)).toEqual(['C>X:residual:2', 'd1>X:rollup:1'])
  })

  it('partial: the floor applies at the finest grain, the remainder above it', () => {
    const v = buildTraceView({ ...siblingEstate({ raw: true }), completePairs: new Set() })
    // d1→X: R=1, nothing stated inside → max(1, 1−1) = 1. C→X: R=1 plus the
    // 1 just stated = 2 of its 3, so 1 remains.
    expect(v.wires.map(desc)).toEqual(['C>X:residual:1', 'd1>X:raw:1', 'd1>X:residual:1'])
  })
})

describe('Lineage Lens parity — the trace draws the lineage the Lens would', () => {
  /** What the Lens itself draws for this model at a given visible set: its
   *  own subgraph over raw hops, its own projector. The canvas trace anchors
   *  cards by the VIEW's layers rather than by system, but the wires it
   *  draws for raw evidence must be the Lens's projection, line for line. */
  const lensWires = (model: LensWalkModel, focusUrn: string, visible: ReadonlySet<string>): string[] => {
    const sg = buildLensSubgraph({
      focusUrn, nodes: model.nodes,
      lineageEdges: model.lineageEdges.filter(e => e.kind !== 'rollup'),
      containmentEdges: model.containmentEdges, frontierUp: [], frontierDown: [],
    })
    return projectLensEdges(sg, new Set(sg.nodes.keys()), visible)
      .map(e => `${e.sourceUrn}>${e.targetUrn}:raw:${e.weight}`)
      .sort()
  }

  for (const [name, expansion] of [['closed partners', ['tableau', 'cfo']], ['half open', HALF_OPEN], ['fully open', ALL_OPEN]] as const) {
    it(`${name}: raw wires == the Lens projection at the same visible set`, () => {
      const v = view([...expansion])
      const ours = v.wires.filter(w => w.kind === 'raw').map(desc).sort()
      expect(ours).toEqual(lensWires(cfoEstate().model, 'cfo', v.visible))
    })
  }

  it('fully open: both are exactly the raw hops at leaf grain — every path, every column', () => {
    const e = cfoEstate()
    const v = view(ALL_OPEN)
    const leafHops = e.model.lineageEdges.filter(x => x.kind !== 'rollup').map(x => `${x.sourceUrn}>${x.targetUrn}:raw:1`).sort()
    expect(v.wires.map(desc).sort()).toEqual(leafHops)
    expect(lensWires(e.model, 'cfo', v.visible)).toEqual(leafHops)
  })
})

describe('buildLedger', () => {
  const e = cfoEstate()

  it('keys pairs source>target, directionally', () => {
    expect(pairKey('a', 'b')).toBe('a>b')
    expect(pairKey('a', 'b')).not.toBe(pairKey('b', 'a'))
  })

  it('rawCount counts the raw hops INSIDE a pair, containment included', () => {
    const l = buildLedger(e.model)
    expect(l.rawCount('orders', 'aov')).toBe(2)                  // channel + net
    expect(l.rawCount('INTERMEDIATE_T2', 'cfo')).toBe(2)         // the same two, one level up
    expect(l.rawCount('orders.channel', 'aov.channel')).toBe(1)  // the hop itself
    expect(l.rawCount('REPORTING', 'cfo')).toBe(1)
    expect(l.rawCount('aov', 'orders')).toBe(0)                  // direction matters
  })

  it('state: complete when the ledger vouches for the pair, partial when raw evidence exists, else none', () => {
    const none = buildLedger(e.model, new Set())
    expect(none.state('orders', 'aov')).toBe('partial')
    expect(none.state('orders', 'rpt')).toBe('none')             // no raw hops between them
    const some = buildLedger(e.model, new Set([pairKey('orders', 'aov')]))
    expect(some.state('orders', 'aov')).toBe('complete')
    expect(some.state('REPORTING', 'cfo')).toBe('partial')
    // Omitted entirely = Stage 1's "the model IS the fine closure", so what
    // is vouched for is exactly what HAS raw detail. A pair with none is
    // 'none' rather than 'complete': vouching for it would let a rollup be
    // dropped as redundant against evidence that does not exist.
    expect(buildLedger(e.model).state('orders', 'aov')).toBe('complete')
    expect(buildLedger(e.model).state('orders', 'rpt')).toBe('none')
  })

  it('counts the edges it is given, so the ledger and the projection agree', () => {
    // A dangling hop the subgraph would drop must not inflate the cone.
    const withDangling: LensWalkModel = {
      ...e.model,
      lineageEdges: [...e.model.lineageEdges,
        { id: 'r:ghost>aov.avg', sourceUrn: 'ghost', targetUrn: 'aov.avg', edgeType: 'TRANSFORMS', kind: 'raw' as const, weight: null }],
    }
    const raw = withDangling.lineageEdges.filter(x => x.kind !== 'rollup')
    expect(buildLedger(withDangling).rawCount('ghost', 'aov')).toBe(1)
    expect(buildLedger(withDangling, undefined, raw.filter(x => x.sourceUrn !== 'ghost')).rawCount('ghost', 'aov')).toBe(0)
  })
})
