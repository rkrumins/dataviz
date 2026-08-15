/**
 * T26 R2 — the invariant stage's (c)/(d) checks, proven through the
 * FULL pipeline (buildFocusLayout → applyCondensation →
 * enforceLensInvariants — T28 R3 removed the window stage that used to
 * sit between the last two), not just against the pure function in
 * isolation (see invariants.test.ts for that). `applyCondensation` is
 * mocked to hand back a "condensed set referencing gone cards" — the
 * brief's own named hostile shape — so this cannot pass merely because
 * `buildFocusLayout` itself would never produce a dangling reference;
 * it proves the LAST stage catches a bad one arriving from ANY earlier
 * pass, exactly the way `LineageLens.boardNeverEmpty.test.tsx` proves
 * invariant (a)/(b) the same way for condensation's own output.
 */
import { render, screen, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { LineageLens } from '../LineageLens'
import { usePreferencesStore } from '@/store/preferences'
import type { WalkEntry } from '@/hooks/useLensWalk'
import type { LensWalkModel, LensWalkNode } from '../lens/closure-adapter'
import type { FocusGraph } from '../lens/focus-cards'

let injectedEdge: FocusGraph['edges'][number] | null = null
let injectFrameId: string | null = null

vi.mock('@/components/canvas/context-view/lens/condensation', () => ({
  MIN_CONDENSE_RUN: 2,
  // A "condensed set referencing gone cards" — the brief's own named
  // hostile shape: hands back an edge/frameId pointing at a card id
  // that was never drawn, exactly what a buggy condensation pass could
  // leave behind. Ignores its real inputs otherwise.
  applyCondensation: (graph: FocusGraph) => {
    let cards = graph.cards
    const edges = injectedEdge ? [...graph.edges, injectedEdge] : graph.edges
    if (injectFrameId) {
      cards = cards.map(c => (c.kind === 'entity' && !c.frameId ? { ...c, frameId: injectFrameId } : c))
    }
    return { ...graph, cards, edges }
  },
}))

const wnode = (urn: string, type = 'dataset', label = urn): LensWalkNode => ({
  id: urn, type: 'generic', position: { x: 0, y: 0 }, data: { urn, label, type },
  urn, displayName: label, entityType: type,
}) as unknown as LensWalkNode

const hop = (source: string, target: string) => ({ id: `h:${source}>${target}`, sourceUrn: source, targetUrn: target, edgeType: 'DERIVES_FROM' })

function walkModel(focusUrn: string, parts: Partial<Omit<LensWalkModel, 'focusUrn'>>): LensWalkModel {
  return {
    focusUrn, nodes: [], lineageEdges: [], containmentEdges: [], upstreamUrns: new Set(), downstreamUrns: new Set(),
    frontierUp: [], frontierDown: [], truncated: false, truncationReason: null, seedTruncated: false, ...parts,
  }
}

function renderWalk() {
  usePreferencesStore.setState({ lensViewMode: 'graph' })
  const walk: WalkEntry = {
    model: walkModel('F', {
      nodes: [wnode('F', 'dataset', 'shipments'), wnode('U', 'dataset', 'sensor_feed')],
      lineageEdges: [hop('U', 'F')],
      upstreamUrns: new Set(['U']),
    }),
    status: 'done', error: null, extendStatus: new Map(), depth: 1,
  }
  return render(
    <LineageLens
      history={{ entries: ['F'], cursor: 0 }}
      walk={walk}
      walkApi={{ extend: () => {}, page: () => {}, retry: () => {} }}
      onRecenter={() => {}}
      onBack={() => {}}
      onForward={() => {}}
      onClose={() => {}}
    />,
  )
}

describe('the pipeline recovers from a hostile condensation output (T26 R2, invariants c/d)', () => {
  afterEach(() => { cleanup(); injectedEdge = null; injectFrameId = null; vi.restoreAllMocks() })

  it('(c) a dangling edge from condensation never reaches the board — the focal still renders, dev-asserts', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    injectedEdge = { id: 'ghost', source: 'F', target: 'NEVER_DRAWN', count: 1, edgeTypeNorm: '', dimmed: false, cycleBack: false, cycleAnchor: false, labelVisible: false, labelT: 0.5, grainCoarse: false, sameAncestorFrame: null, seamSlotted: false }
    renderWalk()
    expect(screen.getByRole('dialog', { name: 'Connections of shipments' })).toBeTruthy()
    const focalCard = [...document.querySelectorAll('.react-flow__node')].find(n => n.textContent?.includes('shipments'))
    expect(focalCard).toBeTruthy()
    expect(spy.mock.calls.some(c => String(c[0]).includes('dangling-edge'))).toBe(true)
  })

  it('(d) a dangling frameId from condensation does not drop the card — it is promoted to top-level, dev-asserts', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    injectFrameId = 'NEVER_DRAWN_FRAME'
    renderWalk()
    // The upstream card ('sensor_feed') survives on the board rather
    // than vanishing because its claimed frame was never drawn.
    const upstreamCard = [...document.querySelectorAll('.react-flow__node')].find(n => n.textContent?.includes('sensor_feed'))
    expect(upstreamCard).toBeTruthy()
    expect(spy.mock.calls.some(c => String(c[0]).includes('dangling-frame'))).toBe(true)
  })
})
