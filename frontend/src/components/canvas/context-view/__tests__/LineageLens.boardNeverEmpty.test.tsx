/**
 * T25 C2 — invariant (c), tested in isolation from invariant (a): even
 * if `applyCondensation` itself somehow returned a graph that excludes
 * the focal (a future regression in that function, or any other stage
 * between it and the board), `LineageLens`'s own last-line-of-defense
 * check must still recover a non-empty board. `applyCondensation` is
 * mocked here specifically so this test cannot pass merely because
 * invariant (a) already prevents the bad graph from arising — the two
 * invariants are independent layers, and this file proves the SECOND
 * one on its own. (T28 R3 — this used to mock `applyHopWindow`, the
 * pass that sat between condensation and the invariant stage; the
 * window is gone, so `applyCondensation`'s own output is now the
 * pipeline's last non-invariant stage, and the fallback `enforceLensInvariants`
 * recovers from is `buildFocusLayout`'s pre-condensation output.)
 */
import { render, screen, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { LineageLens } from '../LineageLens'
import { usePreferencesStore } from '@/store/preferences'
import type { WalkEntry } from '@/hooks/useLensWalk'
import type { LensWalkModel, LensWalkNode } from '../lens/closure-adapter'

vi.mock('@/components/canvas/context-view/lens/condensation', () => ({
  MIN_CONDENSE_RUN: 2,
  // A condensed graph that drops EVERYTHING, focal included — exactly
  // the shape a hypothetical regression in this pass would produce.
  // Ignores its real inputs entirely: this test exists to prove
  // `LineageLens`'s own fallback works no matter WHAT condensation
  // hands it back.
  applyCondensation: (graph: { cards: Array<{ kind: string }> }) => {
    mockCalled = true
    return { ...graph, cards: graph.cards.filter(c => c.kind !== 'focal' && c.kind !== 'entity') }
  },
}))
let mockCalled = false

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

describe('the rendered board is never empty while the model has the focus (T25 C2, invariant c)', () => {
  afterEach(() => cleanup())

  it('recovers the focal card even when the window pass itself returns an empty (focal-excluded) graph', () => {
    // The condensation stage only runs when the reader has asked for it
    // (the header's "Steps" control, off by default), and this test's
    // whole subject is recovering from THAT stage's output.
    usePreferencesStore.setState({ lensViewMode: 'graph', lensCondenseSteps: true })
    const walk: WalkEntry = {
      model: walkModel('F', {
        nodes: [wnode('F', 'dataset', 'shipments'), wnode('U', 'dataset', 'sensor_feed')],
        lineageEdges: [hop('U', 'F')],
        upstreamUrns: new Set(['U']),
      }),
      status: 'done', error: null, extendStatus: new Map(), depth: 1,
    }
    render(
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
    // The header ("Connections of shipments") is populated regardless —
    // this is the exact "populated header, blank board" shape reported.
    expect(screen.getByRole('dialog', { name: 'Connections of shipments' })).toBeTruthy()
    // The invariant: an ACTUAL entity card (not a band-label/whisper
    // decoration node, which carries the `.react-flow__node` class too
    // and would pass a weaker check regardless of whether anything real
    // is drawn) renders the focal's own name on the board — not just in
    // the surrounding chrome, which names the entity regardless of
    // whether anything is actually drawn (exactly what made the real
    // defect read as "fully populated").
    const focalCard = [...document.querySelectorAll('.react-flow__node')]
      .find(n => n.textContent?.includes('shipments'))
    expect(focalCard).toBeTruthy()
    expect(mockCalled).toBe(true)
  })
})
