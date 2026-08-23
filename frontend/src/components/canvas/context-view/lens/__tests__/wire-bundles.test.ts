/**
 * Wire bundles — what comes back for a hover or a selection (2026-08-22).
 * The layout's fold is pinned in focus-layout.test; this is the view's
 * half: which members to draw for which anchors.
 */
import { describe, it, expect } from 'vitest'
import { revealedWires } from '../wire-bundles'
import type { FocusEdge } from '../focus-cards'

const wire = (id: string, source: string, target: string, inBundle = 'b:U>F'): FocusEdge => ({
  id, source, target, count: 1, edgeTypeNorm: '', dimmed: false, cycleBack: false, cycleAnchor: false,
  labelVisible: false, labelT: 0.5, grainCoarse: false, sameAncestorFrame: null, inFrameLane: null, seamSlotted: false, inBundle,
})
// Rows u0..u2 live in frame U; rows c0..c1 in frame F.
const frames: Record<string, string[]> = { u0: ['U'], u1: ['U'], u2: ['U'], c0: ['F'], c1: ['F'] }
const chainOf = (id: string) => frames[id] ?? []
const members = [wire('e1', 'u0', 'c0'), wire('e2', 'u0', 'c1'), wire('e3', 'u1', 'c0'), wire('e4', 'u2', 'c1')]
const none = { cards: new Set<string>(), bundles: new Set<string>() }

describe('revealedWires', () => {
  it('nothing is revealed by default', () => {
    expect(revealedWires(members, none, chainOf)).toEqual([])
  })
  it('a row reveals its own wires', () => {
    const out = revealedWires(members, { ...none, cards: new Set(['u0']) }, chainOf)
    expect(out.map(w => w.id)).toEqual(['e1', 'e2'])
  })
  it('a frame reveals every wire of every row inside it', () => {
    const out = revealedWires(members, { ...none, cards: new Set(['F']) }, chainOf)
    expect(out.map(w => w.id)).toEqual(['e1', 'e2', 'e3', 'e4'])
  })
  it('a hovered bundle fans out into all of its members, and only its own', () => {
    const other = wire('x1', 'u0', 'z0', 'b:U>Z')
    const out = revealedWires([...members, other], { ...none, bundles: new Set(['b:U>F']) }, chainOf)
    expect(out.map(w => w.id)).toEqual(['e1', 'e2', 'e3', 'e4'])
  })
  it('an empty member list costs nothing', () => {
    expect(revealedWires([], { ...none, cards: new Set(['u0']) }, chainOf)).toEqual([])
  })
})
