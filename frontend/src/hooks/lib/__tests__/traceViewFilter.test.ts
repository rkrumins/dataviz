/**
 * traceViewFilter — the native trace's VIEW-side scope: which of the
 * walked nodes render, given the direction toggles and hop depths. The
 * walk always fetches the whole flow; this filter never refetches — it
 * answers "show me only 2 hops upstream and 3 downstream" instantly.
 *
 * Rules under test:
 *  - the focus and its own containment subtree always show;
 *  - a lineage participant shows iff its direction is on AND its hop
 *    distance (BFS over the model's lineage edges, from the focus's
 *    subtree) is within that direction's depth;
 *  - containment ANCESTORS show only while they host something visible —
 *    hiding a direction hides its whole branch, containers included;
 *  - a participant the BFS cannot reach falls back to hop 1 (never
 *    silently dropped by a distance we failed to compute).
 */
import { describe, it, expect } from 'vitest'
import { computeTraceVisibleUrns } from '../traceViewFilter'
import type { LensWalkModel, LensWalkNode } from '@/components/canvas/context-view/lens/closure-adapter'

const wnode = (urn: string, type = 'column'): LensWalkNode => ({
  id: urn, type: 'generic', position: { x: 0, y: 0 },
  data: { urn, label: urn, type },
  urn, displayName: urn, entityType: type,
}) as unknown as LensWalkNode

const hop = (source: string, target: string) =>
  ({ id: `e:${source}>${target}`, sourceUrn: source, targetUrn: target, edgeType: 'TRANSFORMS' })

const holds = (parent: string, child: string) => ({ sourceUrn: parent, targetUrn: child })

/**
 * The estate, at column grain (focus = table F with column f_c):
 *
 *   up2_c ─▶ up1_c ─▶ f_c ─▶ down1_c ─▶ down2_c ─▶ down3_c
 *
 * with containment: UP2⊃up2_c, UP1⊃up1_c, F⊃f_c, D1⊃down1_c,
 * D2⊃down2_c, D3⊃down3_c, and platform REP ⊃ {D2, D3}.
 */
function estate(): LensWalkModel {
  return {
    focusUrn: 'F',
    nodes: [
      wnode('F', 'dataset'), wnode('f_c'),
      wnode('UP1', 'dataset'), wnode('up1_c'), wnode('UP2', 'dataset'), wnode('up2_c'),
      wnode('D1', 'dataset'), wnode('down1_c'),
      wnode('REP', 'container'),
      wnode('D2', 'dataset'), wnode('down2_c'), wnode('D3', 'dataset'), wnode('down3_c'),
    ],
    lineageEdges: [
      hop('up2_c', 'up1_c'), hop('up1_c', 'f_c'),
      hop('f_c', 'down1_c'), hop('down1_c', 'down2_c'), hop('down2_c', 'down3_c'),
    ],
    containmentEdges: [
      holds('UP2', 'up2_c'), holds('UP1', 'up1_c'), holds('F', 'f_c'),
      holds('D1', 'down1_c'), holds('REP', 'D2'), holds('D2', 'down2_c'),
      holds('REP', 'D3'), holds('D3', 'down3_c'),
    ],
    upstreamUrns: new Set(['up1_c', 'UP1', 'up2_c', 'UP2']),
    downstreamUrns: new Set(['down1_c', 'D1', 'down2_c', 'D2', 'down3_c', 'D3', 'REP']),
    frontierUp: [], frontierDown: [],
    truncated: false, truncationReason: null, seedTruncated: false, seedCursor: null,
  }
}

const visible = (opts: Partial<Parameters<typeof computeTraceVisibleUrns>[0]> = {}) =>
  computeTraceVisibleUrns({
    model: estate(), focusUrn: 'F',
    showUpstream: true, showDownstream: true,
    upstreamDepth: Infinity, downstreamDepth: Infinity,
    ...opts,
  })

describe('computeTraceVisibleUrns', () => {
  it('both directions, unlimited depth: everything shows', () => {
    const v = visible()
    for (const n of estate().nodes) expect(v.has(n.urn), n.urn).toBe(true)
  })

  it('upstream only: every downstream node AND its containers disappear; focus subtree stays', () => {
    const v = visible({ showDownstream: false })
    expect([...v].sort()).toEqual(['F', 'UP1', 'UP2', 'f_c', 'up1_c', 'up2_c'])
  })

  it('downstream only: the upstream branch disappears', () => {
    const v = visible({ showUpstream: false })
    expect(v.has('up1_c')).toBe(false)
    expect(v.has('UP2')).toBe(false)
    expect(v.has('down3_c')).toBe(true)
    expect(v.has('REP')).toBe(true)
    expect(v.has('F')).toBe(true)
  })

  it('depth limits count HOPS: 1 up / 2 down keeps up1 and down1..2 but not up2/down3', () => {
    const v = visible({ upstreamDepth: 1, downstreamDepth: 2 })
    expect(v.has('up1_c')).toBe(true)
    expect(v.has('UP1')).toBe(true)
    expect(v.has('up2_c')).toBe(false)
    expect(v.has('UP2')).toBe(false)
    expect(v.has('down2_c')).toBe(true)
    expect(v.has('down3_c')).toBe(false)
    expect(v.has('D3')).toBe(false)
    // REP still hosts the visible D2 — stays; would drop with depth 0.
    expect(v.has('REP')).toBe(true)
  })

  it('a shared container drops only when NOTHING visible remains under it', () => {
    const v = visible({ downstreamDepth: 1 })
    // D2/D3 both out → REP hosts nothing visible → gone.
    expect(v.has('REP')).toBe(false)
    expect(v.has('down1_c')).toBe(true)
  })

  it('an unreachable participant defaults to hop 1 — shown, never silently dropped', () => {
    const m = estate()
    const withOrphan: LensWalkModel = {
      ...m,
      nodes: [...m.nodes, wnode('orphan_up')],
      upstreamUrns: new Set([...m.upstreamUrns, 'orphan_up']),
    }
    const v = computeTraceVisibleUrns({
      model: withOrphan, focusUrn: 'F',
      showUpstream: true, showDownstream: true,
      upstreamDepth: 1, downstreamDepth: Infinity,
    })
    expect(v.has('orphan_up')).toBe(true)
  })

  it('is cycle-safe on lineage and containment loops', () => {
    const m: LensWalkModel = {
      ...estate(),
      lineageEdges: [...estate().lineageEdges, hop('down1_c', 'f_c')],
      containmentEdges: [...estate().containmentEdges, holds('down1_c', 'D1')],
    }
    const v = computeTraceVisibleUrns({
      model: m, focusUrn: 'F',
      showUpstream: true, showDownstream: true,
      upstreamDepth: Infinity, downstreamDepth: Infinity,
    })
    expect(v.has('down1_c')).toBe(true)
  })
})
