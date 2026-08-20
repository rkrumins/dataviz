/**
 * traceViewModel — WIRES: the grain rule.
 *
 * The one question this suite answers: when the same flows can be stated at
 * two grains — a rollup between containers, and the raw hops between their
 * columns — WHICH ONE gets drawn? Drawing both is the double-draw that made
 * the old overlay unreadable; drawing neither loses the lineage.
 *
 * The rule, on the CFO estate: closed partners read as the AUTHORED
 * container-grain rollups (INTERMEDIATE_T2 → cfo, weight 2), and opening
 * both sides refines that into the raw field wires while the rollup that
 * summarised them steps aside.
 */
import { describe, it, expect } from 'vitest'
import { buildTraceView } from '../traceViewModel'
import { buildLedger, pairKey } from '../traceWireLedger'
import { cfoEstate } from '@/test/fixtures/traceEstates'
import type { TraceViewInputs, TraceWire } from '../traceViewModel'
import type { LensWalkModel } from '@/components/canvas/context-view/lens/closure-adapter'

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
  it('closed partners: rollup wires at card grain with weights; no raw leaks', () => {
    const v = view(['tableau', 'cfo'])
    const w = v.wires.map(desc).sort()
    expect(w).toEqual(['INTERMEDIATE_T2>cfo:rollup:2', 'REPORTING>cfo:rollup:1'].sort())
  })

  it('opening both sides refines to raw field wires and drops the rollup for that pair', () => {
    const v = view(HALF_OPEN)
    const kinds = new Set(v.wires.filter(x => x.source.startsWith('orders')).map(x => x.kind))
    expect(kinds).toEqual(new Set(['raw']))
    expect(v.wires.some(x => x.source === 'orders.channel' && x.target === 'aov.channel')).toBe(true)
    // The still-closed REPORTING side keeps its container-grain statement.
    expect(v.wires.map(desc)).toContain('REPORTING>cfo:rollup:1')
  })

  it('partial pair: raw + residual W−R', () => {
    const e = cfoEstate()
    const v = buildTraceView({ ...inputs(e, HALF_OPEN), completePairs: new Set() })
    const res = v.wires.filter(x => x.kind === 'residual')
    expect(res.length).toBeGreaterThan(0)
    // orders → aov is a weight-2 rollup and both its raw hops are drawn, but
    // the ledger will not vouch for the pair being fully loaded — so the
    // rollup stays on as a residual saying "there may be more". Its container
    // pair says the same about ITS grain: a flow from another dataset in
    // INTERMEDIATE_T2 into another chart on the dashboard is a thing only the
    // coarse residual can be hiding.
    expect(res.map(desc)).toEqual(['INTERMEDIATE_T2>cfo:residual:1', 'orders>aov:residual:1'])
    for (const w of res) expect(w.complete).toBe(false)
    // The raw wires are still there beside it, and the still-closed REPORTING
    // side — nothing drilled under it — keeps a plain rollup rather than a
    // residual.
    expect(v.wires.filter(x => x.kind === 'raw').map(desc).sort())
      .toEqual(['orders.channel>aov.channel:raw:1', 'orders.net>aov.avg:raw:1'])
    expect(v.wires.filter(x => x.kind === 'rollup').map(desc)).toEqual(['REPORTING>cfo:rollup:1'])
  })

  it('a complete pair drops the rollup instead of drawing a residual', () => {
    const v = view(HALF_OPEN)   // default completePairs = every pair complete
    expect(v.wires.some(x => x.kind === 'residual')).toBe(false)
    expect(v.wires.some(x => x.source === 'orders' && x.target === 'aov')).toBe(false)
  })

  it('count parity: Σ raw wire counts == raw edges between visible-scoped endpoints', () => {
    const e = cfoEstate()
    const rawEdges = e.model.lineageEdges.filter(x => x.kind !== 'rollup')

    // Fully drilled: every raw hop is its own wire, nothing bundled away,
    // nothing counted twice.
    const open = view(ALL_OPEN)
    const openRaw = open.wires.filter(w => w.kind === 'raw')
    expect(openRaw.reduce((n, w) => n + w.edgeCount, 0)).toBe(rawEdges.length)
    expect(new Set(openRaw.map(w => pairKey(w.source, w.target))))
      .toEqual(new Set(projectRaw(e.model, open.visible).keys()))
    for (const w of openRaw) expect(w.isBundled).toBe(false)

    // Half open: each raw wire still carries exactly the hops that project
    // onto its pair — a wire never invents or loses a hop.
    const half = view(HALF_OPEN)
    const projected = projectRaw(e.model, half.visible)
    for (const w of half.wires.filter(x => x.kind === 'raw')) {
      expect(w.edgeCount).toBe(projected.get(pairKey(w.source, w.target)))
    }
    expect(half.wires.filter(x => x.kind === 'raw').reduce((n, w) => n + w.edgeCount, 0))
      .toBeLessThanOrEqual(rawEdges.length)
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
    // Omitted entirely = Stage 1's "the model IS the fine closure".
    expect(buildLedger(e.model).state('orders', 'aov')).toBe('complete')
    expect(buildLedger(e.model).state('orders', 'rpt')).toBe('complete')
  })
})
